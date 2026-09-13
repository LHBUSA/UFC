#!/usr/bin/env node
/**
 * TUF 33 — exact finale linkage AUDIT. READ-ONLY.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env node scripts/tuf/audit_tuf33_finals_linkage.mjs
 *
 * For every TUF 33 tournament final: what the exact verifier on main
 * (scripts/tuf/lib/boutVerification.mjs, PR #42) says today, every canonical
 * ufc_bouts row between the two finalist ids, and the seven linkage checks the
 * reviewer set. Nothing is applied. Writes:
 *   scripts/tuf/evidence/tuf33_finals_linkage_audit_2026-09-13.json
 *   scripts/tuf/evidence/tuf33_finale_link_proposal_2026-09-13.json   (proposed, NOT applied)
 *   scripts/tuf/lib/fixtures/tuf33_finalist_bouts_2026-09-13.json      (read-only DB snapshot for tests)
 *   docs/tuf/tuf33_finals_linkage_audit_2026-09-13.md
 *
 * Database: read-only selects on ufc_bouts / ufc_events / ufc_bout_results / ufc_fighters.
 * External first-party pages were read once by hand on 2026-09-13; the facts they
 * state are recorded below as captured facts (no re-fetch, nothing redistributed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBout, explicitFinaleBoutIds } from './lib/boutVerification.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const AS_OF = '2026-09-13';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
const env = { ...process.env };
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const q = async (p) => { const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`${p.split('?')[0]} ${r.status}`); return r.json(); };
const one = (v) => (Array.isArray(v) ? v[0] : v);

/* First-party and broadcaster facts read on 2026-09-13 (captured, not re-fetched). */
const CAPTURED = {
  official_recap_finalists: {
    family: 'ufc_com_recap', evidence_level: 'official', url: 'https://www.ufc.com/news/ultimate-fighter-season-33-episode-12-recap', retrieved: '2026-09-12',
    quote: 'Joseph Morales and Alibi Idiris go face-to-face ahead of their bout in the flyweight finale, while Team Cormier fighters Rodrigo Sezinando and Daniil Donchenko step into the cage and square off',
    states: 'the two finale pairings (flyweight Morales vs Idiris, welterweight Sezinando vs Donchenko); names no event and no date',
    via: 'scripts/tuf/evidence/recaps/tuf-33.json (episode 12)',
  },
  official_recap_live_finale: {
    family: 'ufc_com_recap', evidence_level: 'official', url: 'https://www.ufc.com/news/ultimate-fighter-season-33-episode-12-recap', retrieved: '2026-09-12',
    quote: 'to see who will face Alibi Idiris in the live finale', states: 'the flyweight final is fought in "the live finale"; names no event', via: 'scripts/tuf/evidence/recaps/tuf-33.json',
  },
  broadcaster_finale_listing: {
    family: 'paramount_plus_episode_metadata', evidence_level: 'network_listing', url: 'https://www.paramountplus.com/shows/the-ultimate-fighter/', retrieved: '2026-09-12',
    title: 'TUF 33 Finale: Lopes vs. Silva', listing_date: '2026-05-25',
    states: 'the season listing names its finale broadcast "TUF 33 Finale: Lopes vs. Silva"; the listing_date is documented as wrong for recent seasons and is never a date',
    via: 'scripts/tuf/evidence/paramount_plus.json; web/data/tuf/episodes/tuf-33.json finale_broadcast',
  },
  ufc_com_event_pages: [
    { url: 'https://www.ufc.com/event/ufc-319', retrieved: AS_OF, title: 'UFC 319: Du Plessis vs Chimaev', bout_label: 'Flyweight Bout', bout: 'Alibi Idiris vs Joseph Morales', states: 'Early Prelims, Sat Aug 16; round 2, 3:04, Submission. No TUF / tournament / final label; the card\'s only title bout is the middleweight main event' },
    { url: 'https://www.ufc.com/event/ufc-fight-night-september-13-2025', retrieved: AS_OF, title: 'Noche UFC: Lopes vs Silva', bout_label: 'Welterweight Bout', bout: 'Rodrigo Sezinando vs Daniil Donchenko', states: 'Sat Sep 13; round 1, 4:27, KO/TKO. No TUF / tournament / final label' },
  ],
  espn_competitions: [
    { url: 'http://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/600054045/competitions/401808379?lang=en&region=us', retrieved: AS_OF, bout: 'Alibi Idiris vs Joseph Morales', types: ['Flyweight', 'Flyweight Title'], card_segment: 'Early Prelims', states: 'the source of ufc_bouts.is_title=true; "Flyweight Title" is not a TUF label and UFC 319 held no flyweight championship' },
    { url: 'http://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/600053664/competitions/401820047?lang=en&region=us', retrieved: AS_OF, bout: 'Rodrigo Sezinando vs Daniil Donchenko', types: ['Welterweight'], card_segment: 'Prelims', states: 'no title or tournament type' },
  ],
  ufcstats: { url: 'http://ufcstats.com/fight-details/<id>', retrieved: AS_OF, states: 'served a browser challenge to a plain request; not bypassed, no label read' },
};

const inventory = readJson(path.join(DATA, 'seasons.json'));
const row = inventory.seasons.find((s) => s.slug === 'tuf-33');
const season = readJson(path.join(DATA, 'seasons', 'tuf-33.json'));
const episodes = readJson(path.join(DATA, 'episodes', 'tuf-33.json'));
const conflicts = (inventory._conflicts || []).filter((c) => c.scope === 'tuf-33');
const finals = season.bracket.flatMap((wc) => wc.stages.filter((s) => s.stage === 'final').flatMap((s) => s.bouts.map((b) => ({ ...b, weight_class: wc.weight_class, stage: 'final' }))));

const snapshot = { _about: `Read-only snapshot (${AS_OF}) of every ufc_bouts row involving a TUF 33 finalist, with event and result. Fixture for scripts/tuf/lib/tuf33FinaleLinks.test.mjs.`, bouts: {} };
const fighterRows = await q(`ufc_fighters?select=id,name,ufcstats_id,espn_athlete_id&id=in.(${[...new Set(finals.flatMap((f) => [f.a_fighter_id, f.b_fighter_id]).filter(Boolean))].join(',')})`);
const results = [];
for (const f of finals) {
  const ids = [f.a_fighter_id, f.b_fighter_id];
  const byFighter = {};
  for (const id of ids.filter(Boolean)) {
    byFighter[id] = await q(`ufc_bouts?select=id,status,fighter_a_id,fighter_b_id,is_title,card_position,bout_order,weight_class,event:ufc_events(id,name,event_date,card_status),result:ufc_bout_results(winner_id,method,round,time_sec)&or=(fighter_a_id.eq.${id},fighter_b_id.eq.${id})&order=id.asc`);
    for (const b of byFighter[id]) snapshot.bouts[b.id] = b;
  }
  const pairRows = ids.every(Boolean) ? byFighter[ids[0]].filter((b) => [b.fighter_a_id, b.fighter_b_id].sort().join('|') === [...ids].sort().join('|')) : [];
  const current = verifyBout({ bout: f, seasonRow: row, episodes, pairRows, today: AS_OF });
  const cand = pairRows.length === 1 ? pairRows[0] : null;
  const ev = cand ? one(cand.event) : null;
  const res = cand ? one(cand.result) : null;
  const winnerId = f.winner === f.a ? f.a_fighter_id : f.winner === f.b ? f.b_fighter_id : null;
  const listingHeadline = CAPTURED.broadcaster_finale_listing.title.replace(/^TUF 33 Finale:\s*/, '');
  const eventHeadline = ev ? ev.name.replace(/^[^:]*:\s*/, '') : null;
  const identities = ids.map((id, i) => ({ fighter: i ? f.b : f.a, fighter_id: id, canonical: fighterRows.find((x) => x.id === id) ?? null }));
  const checks = {
    '1_finalist_ids_map_to_bout': { pass: Boolean(cand) && [cand.fighter_a_id, cand.fighter_b_id].sort().join('|') === [...ids].sort().join('|'), detail: cand ? `ufc_bouts ${cand.id} is between ${ids.join(' and ')}` : 'no single candidate' },
    '2_on_the_actual_tuf33_finale_event': (() => {
      if (!ev) return { pass: false, detail: 'no candidate' };
      const exactRecorded = row.finale_event && row.finale_event === ev.name;
      const listingNames = listingHeadline === eventHeadline;
      return {
        pass: Boolean(exactRecorded),
        detail: exactRecorded ? 'recorded finale_event equals the canonical event name'
          : listingNames
            ? `NOT PROVEN EXACTLY. No finale event is recorded for TUF 33 and no first-party page labels this bout a TUF 33 final. Corroboration only: the broadcaster's season listing names "${CAPTURED.broadcaster_finale_listing.title}", whose headline equals the headline of the canonical event "${ev.name}" (the only "Lopes vs. Silva" event in ufc_events) — a headline correspondence, not an exact event-name match.`
            : `CONTRADICTED. The candidate is on "${ev.name}" (${ev.event_date}). The official recap puts this final in "the live finale", and the only finale the broadcaster names is "${CAPTURED.broadcaster_finale_listing.title}" — a different card. No first-party page labels this bout a TUF 33 final (UFC.com: "Flyweight Bout"); ESPN types it "Flyweight Title", which is not a TUF label.`,
        corroboration: listingNames ? 'broadcaster_listing_headline' : null,
      };
    })(),
    '3_canonical_date_matches_recorded_date': { pass: Boolean(ev && row.finale_date && row.finale_date === ev.event_date), detail: ev ? `no finale date is recorded for TUF 33 (the broadcaster listing date ${CAPTURED.broadcaster_finale_listing.listing_date} is documented as wrong); the canonical date ${ev.event_date} has nothing exact to match` : 'no candidate' },
    '4_recorded_winner_matches_result': { pass: Boolean(res && winnerId && res.winner_id === winnerId), detail: res ? `archive winner ${f.winner} (${winnerId}); canonical winner_id ${res.winner_id}. The archive winner itself is draft-sourced: the inventory records winners [] and an open "winners" conflict` : 'no result' },
    '5_no_other_bout_between_the_pair': { pass: pairRows.length === 1, detail: `${pairRows.length} ufc_bouts row(s) between the two ids, ever` },
    '6_professional_card_bout_not_house': { pass: Boolean(ev && cand.status === 'complete' && !/contender series|ultimate fighter.*episode/i.test(ev.name)), detail: ev ? `${ev.name}, ${cand.card_position ?? '—'} bout ${cand.bout_order ?? '—'}, status ${cand.status}; a UFC card, not a TUF house bout` : 'no candidate' },
    '7_not_a_later_rematch': { pass: pairRows.length === 1, detail: pairRows.length === 1 ? 'the only meeting of the two finalists in the canonical database, so no earlier or later bout between them exists to confuse it with' : 'more than one meeting' },
  };
  const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([k]) => k);
  const verdict = !failed.length ? 'CLEAN_EXACT_LINK' : failed.includes('2_on_the_actual_tuf33_finale_event') && /CONTRADICTED/.test(checks['2_on_the_actual_tuf33_finale_event'].detail) ? 'HOLD_AMBIGUOUS_EVENT' : 'HOLD_EVENT_NOT_PROVEN_EXACTLY';
  results.push({
    division: f.weight_class, tournament: 'The Ultimate Fighter 33: Team Cormier vs. Team Sonnen', fighter_a: f.a, fighter_b: f.b, recorded_winner: f.winner,
    current_verified_against: f.verified_against ?? null, current_ufc_bout_id: f.ufc_bout_id ?? null, explicit_links: explicitFinaleBoutIds(f),
    current_finale_event_field: row.finale_event ?? null, current_finale_date_field: row.finale_date ?? null, inventory_final_bouts: row.final_bouts ?? null,
    inventory_finalists: (row.finalists || []).find((x) => x.weight_class === f.weight_class) ?? null,
    identities, identities_resolved: identities.every((x) => x.fighter_id && x.canonical),
    verifier_now: { result: current.result, evidence: current.evidence, finale_link: current.actualFinaleDbBout, refusal: current.finaleLinkReason, classification: f.classification },
    candidates: pairRows.map((b) => ({ ufc_bout_id: b.id, event: one(b.event)?.name, event_date: one(b.event)?.event_date, status: b.status, is_title: b.is_title, card_position: b.card_position, bout_order: b.bout_order, result: one(b.result) })),
    all_bouts_of_each_finalist: Object.fromEntries(Object.entries(byFighter).map(([id, list]) => [id, list.map((b) => `${one(b.event)?.event_date} ${one(b.event)?.name} (${b.id})`).sort()])),
    checks, failed_checks: failed, verdict,
    confidence: verdict === 'CLEAN_EXACT_LINK' ? 'high' : verdict === 'HOLD_EVENT_NOT_PROVEN_EXACTLY' ? 'high on bout identity; event not proven exactly' : 'bout identity unique; finale event contradicted',
    danger_flags: [
      ...(f.classification === 'unverified' ? ['final classification is "unverified"; a link would make it CLASSIFICATION_REPAIRABLE, not repaired'] : []),
      ...(row.winners?.length ? [] : ['inventory winners [] with an open "winners" conflict; the archive winner is draft-sourced']),
      ...((row.finalists || []).some((x) => x.weight_class === f.weight_class && !x.fighters.includes(f.b) && !x.fighters.includes(f.a)) ? ['inventory finalists disagree with the bracket final'] : []),
      ...((row.finalists || []).filter((x) => x.weight_class === f.weight_class && [f.a, f.b].some((n) => !x.fighters.includes(n))).map((x) => `inventory finalists list ${x.fighters.join(' vs ')}; the bracket final and the official episode 12 recap say ${f.a} vs ${f.b}`)),
      ...(checks['2_on_the_actual_tuf33_finale_event'].corroboration ? ['event evidence is a broadcaster listing headline, not an exact event record'] : []),
      ...(/CONTRADICTED/.test(checks['2_on_the_actual_tuf33_finale_event'].detail) ? ['the candidate card differs from the only finale card any source names'] : []),
    ],
  });
}

const summary = {
  total_finals: results.length,
  verified_now: results.filter((r) => r.verifier_now.result === 'verified').length,
  unverified_now: results.filter((r) => r.verifier_now.result !== 'verified').length,
  with_exact_candidate_bout: results.filter((r) => r.candidates.length === 1).length,
  blocked_by_identity: results.filter((r) => !r.identities_resolved).length,
  blocked_by_missing_event_or_date: results.filter((r) => /no recorded finale date or event|no recorded finale/.test(String(r.verifier_now.refusal))).length,
  genuinely_ambiguous: results.filter((r) => r.verdict === 'HOLD_AMBIGUOUS_EVENT').length,
  event_not_proven_exactly: results.filter((r) => r.verdict === 'HOLD_EVENT_NOT_PROVEN_EXACTLY').length,
  clean_exact_links: results.filter((r) => r.verdict === 'CLEAN_EXACT_LINK').length,
  final_not_verified_removable_now: results.every((r) => r.verdict === 'CLEAN_EXACT_LINK'),
};

const proposal = {
  _about: 'PROPOSED repair records for TUF 33 finale linkage. NOT APPLIED. Each record is held unless its verdict is CLEAN_EXACT_LINK; a reviewer decision is needed to apply any held record.',
  batch: 'tuf33-finals-exact-linkage', format: 'verified_against = "ufc_bouts:<uuid>" (verifier-supported explicit link; seen on TUF 8, 14, 18 finals). Historical provenance is not overwritten: the record adds a finale_link provenance object beside it.',
  records: results.map((r) => {
    const c = r.candidates[0];
    const slugWc = r.division.toLowerCase();
    return {
      repair_key: `tuf33-finals-exact-linkage/${slugWc}-final/${r.fighter_a.split(' ').at(-1).toLowerCase()}-${r.fighter_b.split(' ').at(-1).toLowerCase()}`,
      status: r.verdict === 'CLEAN_EXACT_LINK' ? 'proposed_clean' : 'held',
      hold_reason: r.verdict === 'CLEAN_EXACT_LINK' ? null : r.checks['2_on_the_actual_tuf33_finale_event'].detail,
      final: { season: 'tuf-33', weight_class: r.division, stage: 'final', a: r.fighter_a, b: r.fighter_b },
      field: 'verified_against', old: r.current_verified_against, new: c ? `ufc_bouts:${c.ufc_bout_id}` : null,
      canonical_bout: c ? { ufc_bout_id: c.ufc_bout_id, event: c.event, event_date: c.event_date, fighter_ids: r.identities.map((x) => x.fighter_id), winner_id: c.result?.winner_id ?? null, winner: r.recorded_winner, method: c.result?.method ?? null, round: c.result?.round ?? null, time_sec: c.result?.time_sec ?? null } : null,
      finale_link_provenance: c ? {
        relationship_source: 'ufc_bouts row between the exact finalist ids (read-only select) + official UFC.com episode 12 recap naming the finale pairing',
        finalist_pair_source: CAPTURED.official_recap_finalists,
        event_evidence: r.checks['2_on_the_actual_tuf33_finale_event'].detail,
        checks: Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v.pass])),
      } : null,
    };
  }),
};

const out = { _about: 'READ-ONLY audit (scripts/tuf/audit_tuf33_finals_linkage.mjs). Nothing applied.', as_of: AS_OF, main: '9415fea057fddd17c899027a70ffa34aa59e7c40', verifier: 'scripts/tuf/lib/boutVerification.mjs (PR #42)', summary, captured_evidence: CAPTURED, inventory_row: { finale_event: row.finale_event, finale_date: row.finale_date, final_bouts: row.final_bouts ?? null, finalists: row.finalists, winners: row.winners, winner_note: row.winner_note, completion_unverified: row.completion_unverified }, open_conflicts: conflicts, finals: results,
  separate_recommendations: [
    'DATA (not identity): seasons.json tuf-33 finalists list the welterweight pair as Daniil Donchenko vs Matt Dixon (Wikipedia). Donchenko beat Dixon in the semi-final (episode 12 recap); the official recap names the finale pairing Sezinando vs Donchenko, which is the bracket final. Correct the inventory finalists in their own reviewed batch before or with any finale linkage.',
    'EVIDENCE: neither final can be linked exactly without a first-party record of where each TUF 33 final was fought (a UFC.com results article or event page that labels the bout as the TUF 33 final, or an athletic commission result). The broadcaster listing names only one finale card ("Lopes vs. Silva"); the flyweight candidate is on UFC 319 a month earlier.',
    'WINNERS: TUF 33 winners stay unresolved (open inventory "winners" conflict) independently of linkage; WINNER_UNRESOLVED does not clear by linking a bout.',
    'DISPLAY (observation, not changed): web/lib/tufGraph.ts marks a TUF 33 final by title flag + year when no finale date is on file; it uses the inventory finalists, so it can mark the flyweight bout but not the welterweight one.',
  ],
  identity_review: 'No identity blocker: all four bracket finalists resolve to canonical fighters with ufcstats and ESPN ids. No identity change is proposed.',
};
fs.writeFileSync(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf33_finals_linkage_audit_2026-09-13.json'), JSON.stringify(out, null, 1) + '\n');
fs.writeFileSync(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf33_finale_link_proposal_2026-09-13.json'), JSON.stringify(proposal, null, 1) + '\n');
fs.mkdirSync(path.join(ROOT, 'scripts', 'tuf', 'lib', 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'scripts', 'tuf', 'lib', 'fixtures', 'tuf33_finalist_bouts_2026-09-13.json'), JSON.stringify(snapshot, null, 1) + '\n');

const t = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const md = ['# TUF 33 — exact finals linkage audit (2026-09-13)', '', 'Read-only. Nothing applied. Evidence: `scripts/tuf/evidence/tuf33_finals_linkage_audit_2026-09-13.json`; proposal (held): `scripts/tuf/evidence/tuf33_finale_link_proposal_2026-09-13.json`.', '',
  '## Summary', '', '| Measure | Value |', '|---|---|', ...Object.entries(summary).map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${v} |`), ''];
for (const r of results) {
  const c = r.candidates[0];
  md.push(`## ${r.division}: ${r.fighter_a} vs ${r.fighter_b}`, '', '| Field | Value |', '|---|---|',
    `| Recorded winner | ${r.recorded_winner} |`, `| verified_against / ufc_bout_id | ${t(r.current_verified_against)} / ${t(r.current_ufc_bout_id)} |`,
    `| Recorded finale event / date | ${t(r.current_finale_event_field)} / ${t(r.current_finale_date_field)} |`, `| Inventory finalists | ${r.inventory_finalists?.fighters.join(' vs ') ?? '—'} |`,
    `| Fighter ids | ${r.identities.map((x) => `${x.fighter} ${x.fighter_id} (${x.canonical?.name ?? 'no canonical row'})`).join('; ')} |`, `| Identities resolved | ${r.identities_resolved} |`,
    `| Verifier today | ${r.verifier_now.result}; refusal: ${r.verifier_now.refusal} |`,
    `| Candidate bouts | ${r.candidates.map((x) => `\`${x.ufc_bout_id}\` ${x.event} ${x.event_date}, winner ${x.result?.winner_id}, ${x.result?.method} R${x.result?.round} ${x.result?.time_sec}s, is_title ${x.is_title}`).join('; ') || 'none'} |`,
    `| Verdict | **${r.verdict}** (${r.confidence}) |`, '', '| Check | Pass | Detail |', '|---|---|---|', ...Object.entries(r.checks).map(([k, v]) => `| ${k} | ${v.pass ? 'yes' : 'NO'} | ${v.detail} |`), '',
    '**Danger / ambiguity flags**', '', ...r.danger_flags.map((x) => `- ${x}`), '');
  void c;
}
md.push('## Separate recommendations', '', ...out.separate_recommendations.map((x) => `- ${x}`), '', `Identity: ${out.identity_review}`, '');
fs.writeFileSync(path.join(ROOT, 'docs', 'tuf', 'tuf33_finals_linkage_audit_2026-09-13.md'), md.join('\n') + '\n');
console.log(JSON.stringify({ summary, verdicts: results.map((r) => `${r.division}: ${r.verdict} ${r.candidates.map((c) => c.ufc_bout_id)}`) }, null, 1));
