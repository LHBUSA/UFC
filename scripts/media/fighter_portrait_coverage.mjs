#!/usr/bin/env node
// Fighter portrait coverage report, read-only.
//
//   node scripts/media/fighter_portrait_coverage.mjs [--queue dryrun.json] [--no-probe] [--json out.json]
//
// Three columns per scope group (ranked, next card, next 3 cards, homepage
// featured, active roster, whole site):
//
//   legacy     what main showed before this pipeline: a stored ufc_images row
//              (newest wins), else a hotlinked ESPN headshot for any fighter
//              with an espn_athlete_id whose CDN URL did not 404. Split into
//              stored vs ESPN. --no-probe skips the ESPN HEAD requests and
//              counts every ESPN id (an upper bound).
//   pipeline   what the resolver serves now: ufc_fighter_portrait_eligible
//              under the high-visibility and standard policies. 0 when the
//              migration is not applied (the resolver fails closed).
//   ceiling    the most review could reach with the candidates on file (the
//              candidates table, or a generator dry run via --queue): fighters
//              with a pending commercial candidate (high-visibility ceiling),
//              and with any pending candidate (standard ceiling). Also the
//              strong-evidence subset (identity >= 0.9 and commercial).
import fs from 'node:fs';
import { portraitDecision, RANKED_REASONS, NEXT_CARD_REASONS, UPCOMING_CARD_REASONS } from '../../web/lib/fighterMediaPolicy.ts';
import { client, gatherScope, loadEnv, pool } from './lib/portraitData.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const PROBE = !argv.includes('--no-probe');
const QUEUE = opt('--queue');
const JSON_OUT = opt('--json');

const db = client(loadEnv());

async function main() {
  const { scope, nextEvents } = await gatherScope(db);
  const fighters = await db.all('ufc_fighters?select=id,espn_athlete_id&order=id');
  const images = await db.all('ufc_images?select=fighter_id,rights_expires_at&fighter_id=not.is.null&order=id');
  const stored = new Set(images.filter((r) => !r.rights_expires_at || Date.parse(r.rights_expires_at) > Date.now()).map((r) => r.fighter_id));
  const espnId = new Map(fighters.filter((f) => /^\d+$/.test(String(f.espn_athlete_id || '').trim())).map((f) => [f.id, String(f.espn_athlete_id).trim()]));

  /* Legacy ESPN fallback applied to every fighter without a stored row. Probe
   * only where it matters for the groups (scope), plus count site-wide ids. */
  const espnOk = new Map();
  const toProbe = [...scope.keys()].filter((id) => !stored.has(id) && espnId.has(id));
  if (PROBE) {
    await pool(toProbe, 8, async (id) => {
      try {
        const res = await fetch(`https://a.espncdn.com/i/headshots/mma/players/full/${espnId.get(id)}.png`, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
        espnOk.set(id, !(res.status === 404 || res.status === 410));
      } catch { espnOk.set(id, true); }  /* main kept the image on network failure */
    });
  }
  const legacyState = (id) => (stored.has(id) ? 'stored' : espnId.has(id) && (!PROBE || espnOk.get(id) !== false) ? 'espn' : 'none');

  const pipelineReady = await db.exists('ufc_fighter_portrait_eligible');
  const eligible = pipelineReady ? await db.all('ufc_fighter_portrait_eligible?select=*&order=fighter_id') : [];
  const eligibleBy = new Map(eligible.map((r) => [r.fighter_id, r]));
  const pipeState = (id) => {
    const r = eligibleBy.get(id);
    if (r && portraitDecision(r, 'high_visibility').ok) return 'high';
    if (r && portraitDecision(r, 'standard').ok) return 'standard';
    return 'none';
  };

  let candidates = [];
  let candidateSource = 'none';
  if (QUEUE) { candidates = JSON.parse(fs.readFileSync(QUEUE, 'utf8')).candidates; candidateSource = `dry run ${QUEUE}`; }
  else if (await db.exists('ufc_fighter_media_candidates')) {
    candidates = await db.all('ufc_fighter_media_candidates?select=fighter_id,status,commercial_use_allowed,identity_confidence,proposed_surface_policy&order=id');
    candidateSource = 'ufc_fighter_media_candidates';
  }
  const pending = candidates.filter((c) => c.status === 'pending');
  const ceilHigh = new Set(pending.filter((c) => c.commercial_use_allowed && c.proposed_surface_policy === 'all_surfaces').map((c) => c.fighter_id));
  const ceilAny = new Set(pending.filter((c) => c.proposed_surface_policy !== 'internal_only').map((c) => c.fighter_id));
  const strong = new Set(pending.filter((c) => c.commercial_use_allowed && Number(c.identity_confidence) >= 0.9).map((c) => c.fighter_id));

  const groups = [
    ['Ranked (champions + ranked)', (r) => r.some((x) => RANKED_REASONS.has(x))],
    [`Next card${nextEvents[0] ? ` — ${nextEvents[0].name}` : ''}`, (r) => r.some((x) => NEXT_CARD_REASONS.has(x))],
    ['Next 3 cards', (r) => r.some((x) => UPCOMING_CARD_REASONS.has(x))],
    ['Homepage featured', (r) => r.includes('featured')],
    ['Active roster', (r) => r.includes('active_roster')],
    ['Had a stored photo before', (r) => r.includes('legacy_portrait')],
    ['Whole queue scope', () => true],
  ].map(([label, pick]) => {
    const ids = [...scope.entries()].filter(([, s]) => pick(s.reasons)).map(([id]) => id);
    const c = (f) => ids.filter(f).length;
    return {
      label, total: ids.length,
      legacy_stored: c((id) => legacyState(id) === 'stored'),
      legacy_espn: c((id) => legacyState(id) === 'espn'),
      pipeline_high: c((id) => pipeState(id) === 'high'),
      pipeline_standard_only: c((id) => pipeState(id) === 'standard'),
      ceiling_high: c((id) => pipeState(id) === 'high' || ceilHigh.has(id)),
      ceiling_standard: c((id) => pipeState(id) !== 'none' || ceilAny.has(id)),
      strong_commercial: c((id) => strong.has(id)),
    };
  });

  const siteEspn = [...espnId.keys()].filter((id) => !stored.has(id)).length;
  const report = {
    generated_at: new Date().toISOString(),
    total_fighters: fighters.length,
    legacy: { stored_fighters: stored.size, espn_fallback_ids_without_stored: siteEspn, espn_probed: PROBE ? toProbe.length : 0, espn_404_in_scope: [...espnOk.values()].filter((v) => !v).length },
    pipeline: {
      migration_applied: pipelineReady,
      approved_portraits: eligible.filter((r) => portraitDecision(r, 'standard').ok).length,
      approved_high_visibility: eligible.filter((r) => portraitDecision(r, 'high_visibility').ok).length,
      pending_candidates: pending.length,
      candidates_by_status: candidates.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {}),
      quarantine_active: pipelineReady ? await db.count('ufc_media_quarantine?select=id&lifted_at=is.null') : null,
      assets_quarantined: pipelineReady ? await db.count('ufc_fighter_media_assets?select=id&review_status=eq.quarantined') : null,
      candidate_source: candidateSource,
    },
    groups,
  };
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n');

  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  const out = [];
  out.push(`Fighter portrait coverage — ${report.generated_at}`);
  out.push(`Total fighters ${report.total_fighters} · legacy stored ${stored.size} · legacy ESPN-fallback ids ${siteEspn} · migration applied: ${pipelineReady ? 'yes' : 'NO (resolver serves no portraits)'}`);
  out.push(`Pipeline: approved ${report.pipeline.approved_portraits} (high-vis ${report.pipeline.approved_high_visibility}) · pending candidates ${pending.length} (${candidateSource}) · quarantine ${report.pipeline.quarantine_active ?? '—'} · assets quarantined ${report.pipeline.assets_quarantined ?? '—'}`);
  out.push('');
  out.push('| Group | Fighters | Legacy photo (stored + ESPN) | Pipeline high-vis | Pipeline standard-only | Ceiling high-vis | Ceiling any surface | Strong-evidence commercial |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const g of groups) {
    const legacy = g.legacy_stored + g.legacy_espn;
    out.push(`| ${g.label} | ${g.total} | ${legacy} (${pct(legacy, g.total)}) = ${g.legacy_stored} + ${g.legacy_espn} | ${g.pipeline_high} | ${g.pipeline_standard_only} | ${g.ceiling_high} (${pct(g.ceiling_high, g.total)}) | ${g.ceiling_standard} (${pct(g.ceiling_standard, g.total)}) | ${g.strong_commercial} |`);
  }
  console.log(out.join('\n'));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
