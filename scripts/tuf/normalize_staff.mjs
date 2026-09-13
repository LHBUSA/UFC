#!/usr/bin/env node
/**
 * Give every TUF coaching-staff entry a role that means something.
 *
 *   node scripts/tuf/normalize_staff.mjs [--check]
 *
 * The drafter wrote 401 staff entries and marked 360 of them role "head":
 * boxing coaches, nutritionists, a sign-language interpreter, and eleven team
 * header lines ("; Team Rampage") that are not people at all. A fighter
 * profile then read "coached on TUF 17" for Frank Mir, who was Jon Jones's
 * jiu-jitsu coach. The information to do better was already in each entry's
 * note; nothing here is looked up.
 *
 * Roles, decided in this order, each with the rule that fired recorded as
 * role_basis:
 *
 *   head       the season inventory names this person as a coach, or the
 *              source note says "head coach" (Rich Franklin replacing Tito
 *              Ortiz on TUF 11; Hailin Ao's first four episodes on TUF China)
 *   guest      the note says guest
 *   other      staff who were not coaching: nutritionist, interpreter,
 *              sports advisor, sports-performance staff, and a bare "coach"
 *              on a season whose inventory says it had no fixed coaches
 *   assistant  everyone else on a team's staff
 *
 * Header lines are dropped and used for what they were: every entry below
 * "; Team Liddell" belongs to Team Liddell until the next header. A
 * discipline written into the name ("Kamaru Usman (wrestling)") moves to
 * `discipline`; a nickname in quotes moves to `nickname`. The printed string
 * is kept as printed_as whenever the name changes, and the source's note is
 * never rewritten.
 *
 * Idempotent: an entry that already carries role_basis is re-derived from its
 * printed form, so running it twice changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from './lib/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');

const OTHER = /nutritionist|interpreter|sports advisor|sports performance/i;
const HEADER = /^[;\s]*(team\b|fighters eliminated)/i;

/* "Quinton "Rampage" Jackson", "Darrill “Titties” Schoonover". */
const NICK = /\s*["“”]([^"“”]+)["“”]\s*/;
/* "Kamaru Usman (wrestling)", "Matt Hughes (guest coach)". */
const PAREN = /\s*\(([^)]+)\)\s*$/;

export function splitName(printed) {
  let name = String(printed).trim();
  let nickname = null;
  let paren = null;
  const p = PAREN.exec(name);
  if (p) { paren = p[1].trim(); name = name.slice(0, p.index).trim(); }
  const n = NICK.exec(name);
  if (n) { nickname = n[1].trim(); name = `${name.slice(0, n.index)} ${name.slice(n.index + n[0].length)}`.replace(/\s+/g, ' ').trim(); }
  return { name, nickname, paren };
}

function discipline(text) {
  const t = String(text || '').replace(/\b(head|assistant|guest)\b/gi, '').replace(/\b(coach|instructor)\b/gi, '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  return t && !/^jr\.?,?$/i.test(t) ? t.replace(/^jr\.?,\s*/i, '') : null;
}

export function normalizeStaff(season, inventoryRow) {
  const heads = new Set((inventoryRow?.coaches || []).map(fold));
  const noFixedCoaches = !(inventoryRow?.coaches || []).length && /no fixed|rotating/i.test(inventoryRow?.coaches_note || '');
  const out = [];
  let dropped = 0;
  let team = null;
  for (const raw of season.coaches || []) {
    if (typeof raw !== 'object' || !raw) continue;
    const printed = raw.printed_as || raw.name;
    if (HEADER.test(printed) && !raw.note) {
      team = String(printed).replace(/^[;\s]+/, '').trim();
      dropped += 1;
      continue;
    }
    const { name: base, nickname, paren } = splitName(printed);
    /* "Howard Davis" with note "Jr., boxing coach": the drafter split a
     * suffix off the name at the comma. Put it back. */
    let name = base;
    let note = raw.note || '';
    if (/^jr\.?,/i.test(note)) { name = `${name} Jr.`; }
    const source = `${note} ${paren || ''}`.trim();

    let role;
    let basis;
    if (heads.has(fold(name))) { role = 'head'; basis = 'named as a coach of the season in the inventory'; }
    else if (/\bhead coach\b/i.test(source)) { role = 'head'; basis = `source note: "${source}"`; }
    else if (/\bguest\b/i.test(source)) { role = 'guest'; basis = `source note: "${source}"`; }
    else if (OTHER.test(source)) { role = 'other'; basis = `source note: "${source}" (staff, not a coach)`; }
    else if (/^coach$/i.test(source.trim()) && noFixedCoaches) { role = 'other'; basis = 'source says "coach" on a season with no fixed coaches; not asserted as head or assistant'; }
    else { role = 'assistant'; basis = source ? `source note: "${source}"` : 'listed on a team staff with no head-coach designation'; }

    const entry = {
      team: raw.team || team || null,
      name,
      ...(raw.fighter_id ? { fighter_id: raw.fighter_id } : {}),
      role,
      ...(nickname ? { nickname } : {}),
      ...(role === 'assistant' || role === 'guest' ? (discipline(source) ? { discipline: discipline(source) } : {}) : {}),
      ...(raw.region ? { region: raw.region } : {}),
      ...(note ? { note } : {}),
      ...(printed !== name ? { printed_as: printed } : {}),
      role_basis: basis,
      ...(raw.team_basis ? { team_basis: raw.team_basis } : raw.team ? {} : team ? { team_basis: 'section order in the season source' } : {}),
    };
    out.push(entry);
  }
  season.coaches = out;
  return { dropped, counts: out.reduce((m, c) => ({ ...m, [c.role]: (m[c.role] || 0) + 1 }), {}) };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const check = process.argv.includes('--check');
  const inventory = JSON.parse(fs.readFileSync(path.join(DATA, 'seasons.json'), 'utf8'));
  const total = { dropped: 0 };
  let changed = 0;
  for (const row of inventory.seasons) {
    const file = path.join(DATA, 'seasons', `${row.slug}.json`);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const season = JSON.parse(before);
    if (!season.coaches?.length) continue;
    const { dropped, counts } = normalizeStaff(season, row);
    total.dropped += dropped;
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] || 0) + v;
    const after = JSON.stringify(season, null, 2) + '\n';
    if (after !== before) { changed += 1; if (!check) fs.writeFileSync(file, after); }
  }
  console.log(JSON.stringify(total), `${changed} file(s) ${check ? 'would change' : 'written'}`);
  if (check && changed) process.exitCode = 1;
}
