#!/usr/bin/env node
/**
 * Match TUF seasons to the finale cards we already hold.
 *
 *   node scripts/tuf/reconcile_finales.mjs            resume; only unresolved seasons
 *   node scripts/tuf/reconcile_finales.mjs --all      re-check everything
 *   node scripts/tuf/reconcile_finales.mjs --write    write findings into seasons.json
 *
 * Why this exists rather than a name match, and why the first version of it
 * was wrong.
 *
 * Matching on the string "Finale" misses every modern and international
 * season, because those put their tournament finals on an ordinary UFC card:
 * TUF 31's finals were on UFC 292, TUF Latin America 1's on UFC 180.
 *
 * The first fix was to match on a CHAMPION APPEARING on a card inside the
 * season's window. That is not evidence and it produced two false positives.
 * Chad Laprise appeared on UFC Fight Night: MacDonald vs Saffiedine — fighting
 * Yosdenis Cedeno, not his tournament final. Zhang Lipeng appeared on UFC
 * Fight Night: Bisping vs Le — fighting Brendan O'Reilly, not Wang Sai. Both
 * seasons were linked to the wrong card and both looked plausible.
 *
 * So the bar is now the EXACT FINAL MATCHUP: the season's two finalists,
 * facing each other, with a result. A champion on a card proves the champion
 * was on a card. Nothing else. Where a season's finalists are not known, the
 * link stays empty rather than being approximated, and finals contested on
 * separate cards are supported — each final carries its own event and date.
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
  /* Finals come from the season's own record: a list of {weight_class, a, b}.
   * Without them there is nothing to verify against, and the honest result is
   * an empty link rather than a guess. */
  const finals = season.expected_finals ?? [];
  if (!finals.length) {
    return { verified: [], unresolved: true, reason: "no finalist pairing recorded for this season; cannot verify a final" };
  }

  const verified = [];
  const missing = [];

  for (const f of finals) {
    const pair = [f.a, f.b];
    const inList = pair.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
    const rows = await rest(`ufc_fighters?select=id,name&name=in.(${encodeURIComponent(inList)})`);
    if (rows.length < 2) {
      missing.push({ ...f, why: `only ${rows.length} of the two finalists has a fighter row` });
      continue;
    }
    const [x, y] = rows;
    /* The bout must be these two AGAINST EACH OTHER. Either corner order. */
    const bouts = await rest(
      `ufc_bouts?select=id,weight_class,ufc_events!inner(name,event_date),ufc_bout_results(method_raw,round,winner_id)` +
        `&or=(and(fighter_a_id.eq.${x.id},fighter_b_id.eq.${y.id}),and(fighter_a_id.eq.${y.id},fighter_b_id.eq.${x.id}))`,
    );
    const hit = bouts.find((b) => {
      const d = b.ufc_events?.event_date;
      if (!d) return false;
      /* Dated where the season says, when the season says it. */
      return f.date ? d === f.date : d.startsWith(String(season.year)) || d.startsWith(String(season.year + 1));
    });
    if (!hit) {
      missing.push({ ...f, why: "the finalist-versus-finalist bout is not in ufc_bouts" });
      continue;
    }
    verified.push({
      weight_class: f.weight_class,
      a: f.a,
      b: f.b,
      event: hit.ufc_events.name,
      date: hit.ufc_events.event_date,
      method: hit.ufc_bout_results?.[0]?.method_raw ?? null,
      round: hit.ufc_bout_results?.[0]?.round ?? null,
    });
  }

  return { verified, missing, unresolved: verified.length === 0, reason: verified.length ? null : "no final matchup could be verified" };
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

    if (out.verified?.length) {
      state.resolved[s.slug] = { finals: out.verified, at: new Date().toISOString() };
      for (const v of out.verified) {
        log(`  ${s.slug.padEnd(16)} FINAL  ${v.a} vs ${v.b} — ${v.event} (${v.date})${v.method ? ` · ${v.method}` : ""}`);
      }
      /* Finals on separate cards are normal, not an error. */
      const cards = [...new Set(out.verified.map((v) => `${v.event}|${v.date}`))];
      if (cards.length > 1) log(`  ${" ".repeat(16)}       finals span ${cards.length} cards, recorded separately`);
      if (WRITE) {
        s.final_bouts = out.verified.map((v) => ({ ...v, verified_against: "ufc_bouts + ufc_bout_results — exact finalist-versus-finalist matchup" }));
        /* The headline finale is the card carrying the first verified final;
         * every final keeps its own event and date regardless. */
        s.finale_event = out.verified[0].event;
        s.finale_date = out.verified[0].date;
        s.finale_link_basis = "Verified by the exact final matchup in our own records.";
        delete s.unresolved_finale;
        applied += 1;
      }
    } else {
      log(`  ${s.slug.padEnd(16)} none   ${out.reason}`);
      for (const m of out.missing ?? []) log(`      unverified: ${m.a} vs ${m.b} (${m.weight_class}) — ${m.why}`);
      if (WRITE) {
        /* An unverified link is left EMPTY. A wrong card is worse than none. */
        s.finale_event = null;
        s.finale_date = null;
        delete s.finale_link_basis;
        delete s.final_bouts;
      }
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
