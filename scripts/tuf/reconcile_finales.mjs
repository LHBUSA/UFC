#!/usr/bin/env node
/**
 * Match TUF seasons to the finale cards we already hold.
 *
 *   node scripts/tuf/reconcile_finales.mjs            resume; only unresolved seasons
 *   node scripts/tuf/reconcile_finales.mjs --all      re-check everything
 *   node scripts/tuf/reconcile_finales.mjs --write    write findings into seasons.json
 *
 * Why this exists rather than a name match.
 *
 * Matching on the string "Finale" reported seven seasons as missing whose
 * cards we already held. Modern seasons and every international edition put
 * their tournament finals on an ordinary UFC card — TUF 31's finals were on
 * UFC 292, TUF Latin America 1's were on UFC 180 — and no amount of string
 * matching finds those. So a season is matched by its PARTICIPANTS instead:
 * find the events where the season's champions fought inside its window, and
 * a card carrying more than one of them is the finale.
 *
 * READ-ONLY against the fight database. It never writes to a ufc_* table, so
 * it cannot compete with the historical backfill or duplicate anything the
 * backfill is loading. The only thing it writes is the season inventory in
 * this repository, and only with --write.
 *
 * Resumable by construction: state lives in scripts/tuf/.reconcile-state.json,
 * every season is independent, and a re-run skips what is already resolved
 * unless --all is passed. Interrupting it loses at most one season's lookup.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INVENTORY = path.join(ROOT, "web", "data", "tuf", "seasons.json");
const STATE = path.join(ROOT, "scripts", "tuf", ".reconcile-state.json");

const argv = new Set(process.argv.slice(2));
const ALL = argv.has("--all");
const WRITE = argv.has("--write");

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const log = (...a) => console.log(...a);

async function rest(pathAndQuery) {
  if (!URL_ || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for a live run.");
  const res = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`supabase ${res.status} on ${pathAndQuery.split("?")[0]}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { resolved: {}, checked: {} });
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");

/**
 * The events a season's champions fought on, inside its window.
 *
 * A card that carries two or more of a season's champions is a confident
 * match; one champion is a candidate and is reported rather than applied,
 * because a single fighter appearing on a card in the right year is a
 * coincidence that happens often.
 */
async function candidatesFor(season) {
  const names = (season.winners ?? []).map((w) => w.fighter);
  if (!names.length) return { confident: null, candidates: [], reason: "no champion recorded to search by" };

  const inList = names.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
  const fighters = await rest(`ufc_fighters?select=id,name&name=in.(${encodeURIComponent(inList)})`);
  if (!fighters.length) return { confident: null, candidates: [], reason: "no champion resolves to a fighter row" };

  const from = `${season.year}-01-01`;
  const to = `${season.year + 1}-12-31`;
  const byEvent = new Map();

  for (const f of fighters) {
    const bouts = await rest(
      `ufc_bouts?select=event_id,ufc_events!inner(id,name,event_date)&or=(fighter_a_id.eq.${f.id},fighter_b_id.eq.${f.id})` +
        `&ufc_events.event_date=gte.${from}&ufc_events.event_date=lte.${to}`,
    );
    for (const b of bouts) {
      const e = b.ufc_events;
      if (!e) continue;
      const key = `${e.name}|${e.event_date}`;
      if (!byEvent.has(key)) byEvent.set(key, { name: e.name, date: e.event_date, champions: new Set() });
      byEvent.get(key).champions.add(f.name);
    }
  }

  const ranked = [...byEvent.values()]
    .map((e) => ({ ...e, champions: [...e.champions] }))
    .sort((a, b) => b.champions.length - a.champions.length || a.date.localeCompare(b.date));

  const top = ranked[0];
  /* Two champions on one card is the signature of a finale. One is not. */
  const confident = top && (top.champions.length > 1 || names.length === 1) ? top : null;
  return { confident, candidates: ranked.slice(0, 5), reason: confident ? null : "no card carries more than one champion" };
}

const main = async () => {
  const inv = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
  const state = loadState();

  const todo = inv.seasons.filter((s) => ALL || (!s.finale_event && !state.resolved[s.slug]));
  log(`TUF finale reconciliation — ${todo.length} season(s) to check of ${inv.seasons.length}`);
  log(`already resolved in the inventory: ${inv.seasons.filter((s) => s.finale_event).length}\n`);
  if (!todo.length) {
    log("Nothing to do. Pass --all to re-check every season.");
    return;
  }

  let applied = 0;
  for (const s of todo) {
    let out;
    try {
      out = await candidatesFor(s);
    } catch (e) {
      /* One season failing must not lose the run's progress. */
      log(`  ${s.slug.padEnd(16)} ERROR ${String(e.message).slice(0, 90)}`);
      saveState(state);
      continue;
    }
    state.checked[s.slug] = new Date().toISOString();

    if (out.confident) {
      state.resolved[s.slug] = {
        event: out.confident.name,
        date: out.confident.date,
        champions_on_card: out.confident.champions,
        at: new Date().toISOString(),
      };
      log(`  ${s.slug.padEnd(16)} MATCH  ${out.confident.name} (${out.confident.date}) via ${out.confident.champions.join(", ")}`);
      if (WRITE) {
        s.finale_event = out.confident.name;
        s.finale_date = out.confident.date;
        s.finale_link_basis =
          "Resolved by participant and date against our own ufc_events, not by name. Corroborated by " +
          out.confident.champions.join(" and ") + " appearing on that card within the season's window.";
        applied += 1;
      }
    } else {
      log(`  ${s.slug.padEnd(16)} none   ${out.reason}`);
      for (const c of out.candidates) log(`      candidate: ${c.name} (${c.date}) — ${c.champions.join(", ")}`);
    }
    saveState(state);
  }

  if (WRITE && applied) {
    fs.writeFileSync(INVENTORY, JSON.stringify(inv, null, 2) + "\n");
    log(`\n${applied} season(s) written into the inventory.`);
  } else if (!WRITE) {
    log("\nNothing written. Pass --write to apply the matches above.");
  }
  log("No ufc_* table was written to, so this cannot collide with the historical backfill.");
};

/* Importable for tests without running. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exitCode = 1;
  });
}
export { candidatesFor };
