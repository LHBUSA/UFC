#!/usr/bin/env node
// Read-only audit of the remaining UFC-native gaps before broad MMA expansion.
// Structural existence and depth/auxiliary layers are reported separately.
//
//   node scripts/combat/remaining_ufc_audit.mjs --json logs/ufc-gap-audit.json
import { all, arg, pct, writeJson } from './common.mjs';

async function optional(resource) {
  try { return await all(resource); }
  catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

const uniq = (rows, key) => new Set((rows || []).map((r) => r?.[key]).filter(Boolean)).size;

const main = async () => {
  const [fighters, events, bouts, results, rounds, scorecards, weighins, statuses, rankDates, images, videos, market, finish, position, scoreGaps] = await Promise.all([
    all('ufc_fighters?select=id,name,ufcstats_id,espn_athlete_id,is_active'),
    all('ufc_events?select=id,event_date,card_status,ufcstats_id,espn_event_id'),
    all('ufc_bouts?select=id,event_id,status,ufcstats_id,espn_competition_id,fighter_a_id,fighter_b_id'),
    all('ufc_bout_results?select=bout_id,winner_id,method,referee,judge_1,judge_2,judge_3,has_stats'),
    all('ufc_bout_round_stats?select=bout_id,fighter_id,round'),
    optional('ufc_bout_scorecards?select=bout_id'),
    optional('ufc_weigh_in_results?select=id,event_id,bout_id,fighter_id,result,official_weight_lbs,source_kind'),
    optional('ufc_fighter_status_events?select=id,fighter_id,event_id,bout_id,status_type,state'),
    optional('ufc_rankings?select=snapshot_date&order=snapshot_date.desc&limit=1'),
    optional('ufc_images?select=id,fighter_id'),
    optional('ufc_videos?select=id,event_id'),
    optional('ufc_market_observations?select=id,bout_id'),
    optional('ufc_bout_finish_enrichment?select=bout_id'),
    optional('ufc_bout_position_stats?select=bout_id'),
    optional('ufc_scorecard_gaps?select=bout_id'),
  ]);

  const resultByBout = new Map(results.map((r) => [r.bout_id, r]));
  const roundBoutIds = new Set(rounds.map((r) => r.bout_id));
  const scorecardBoutIds = new Set((scorecards || []).map((r) => r.bout_id));
  const completedBouts = bouts.filter((b) => b.status === 'complete' || resultByBout.has(b.id));
  const decisionBouts = completedBouts.filter((b) => ['DEC_U','DEC_S','DEC_M','DRAW'].includes(resultByBout.get(b.id)?.method));
  const completeWithResult = completedBouts.filter((b) => resultByBout.has(b.id));
  const completeWithRounds = completedBouts.filter((b) => roundBoutIds.has(b.id));
  const completeWithReferee = completedBouts.filter((b) => Boolean(resultByBout.get(b.id)?.referee));
  const decisionsWithJudges = decisionBouts.filter((b) => {
    const r = resultByBout.get(b.id);
    return Boolean(r?.judge_1 || r?.judge_2 || r?.judge_3);
  });
  const decisionsWithScorecards = decisionBouts.filter((b) => scorecardBoutIds.has(b.id));

  const latestRankDate = rankDates?.[0]?.snapshot_date || null;
  const latestRankings = latestRankDate
    ? await all(`ufc_rankings?select=fighter_id,division,is_womens,is_p4p,rank,name_raw&snapshot_date=eq.${latestRankDate}`)
    : [];

  const completedEvents = events.filter((e) => e.card_status === 'complete');
  const eventBouts = new Map();
  for (const b of bouts) eventBouts.set(b.event_id, (eventBouts.get(b.event_id) || 0) + 1);
  const completeEventsWithBouts = completedEvents.filter((e) => (eventBouts.get(e.id) || 0) > 0);

  const report = {
    generated_at: new Date().toISOString(),
    identity: {
      fighters: fighters.length,
      active: fighters.filter((f) => f.is_active === true).length,
      with_ufcstats_id: fighters.filter((f) => f.ufcstats_id).length,
      with_espn_id: fighters.filter((f) => f.espn_athlete_id).length,
      with_both_primary_ids: fighters.filter((f) => f.ufcstats_id && f.espn_athlete_id).length,
    },
    structural: {
      completed_events: completedEvents.length,
      completed_events_with_bouts: completeEventsWithBouts.length,
      completed_bouts: completedBouts.length,
      completed_bouts_with_results: completeWithResult.length,
    },
    depth: {
      completed_bouts_with_round_stats: completeWithRounds.length,
      round_rows: rounds.length,
      completed_bouts_with_referee: completeWithReferee.length,
      decision_bouts: decisionBouts.length,
      decisions_with_judge_names: decisionsWithJudges.length,
      decisions_with_scorecards: decisionsWithScorecards.length,
      scorecard_rows: scorecards?.length ?? null,
      scorecard_gap_rows: scoreGaps?.length ?? null,
      finish_enrichment_rows: finish?.length ?? null,
      finish_enriched_bouts: finish == null ? null : uniq(finish, 'bout_id'),
      position_stat_rows: position?.length ?? null,
      position_stat_bouts: position == null ? null : uniq(position, 'bout_id'),
    },
    weigh_ins: weighins == null ? { table_available: false } : {
      table_available: true,
      rows: weighins.length,
      fighters: uniq(weighins, 'fighter_id'),
      bouts: uniq(weighins, 'bout_id'),
      events: uniq(weighins, 'event_id'),
      made: weighins.filter((w) => w.result === 'made').length,
      missed: weighins.filter((w) => w.result === 'missed').length,
      pending: weighins.filter((w) => w.result === 'pending').length,
      official_source_rows: weighins.filter((w) => w.source_kind === 'official').length,
      commission_source_rows: weighins.filter((w) => w.source_kind === 'commission').length,
    },
    fighter_status: statuses == null ? { table_available: false } : {
      table_available: true,
      rows: statuses.length,
      open: statuses.filter((s) => s.state === 'open').length,
      fighters: uniq(statuses, 'fighter_id'),
    },
    rankings: {
      latest_snapshot: latestRankDate,
      rows: latestRankings.length,
      linked: latestRankings.filter((r) => r.fighter_id).length,
      unresolved: latestRankings.filter((r) => !r.fighter_id).length,
    },
    media: images == null ? { table_available: false } : {
      table_available: true,
      image_rows: images.length,
      fighters_with_images: uniq(images, 'fighter_id'),
    },
    video: videos == null ? { table_available: false } : {
      table_available: true,
      rows: videos.length,
      events: uniq(videos, 'event_id'),
    },
    market: market == null ? { table_available: false } : {
      table_available: true,
      observations: market.length,
      bouts: uniq(market, 'bout_id'),
    },
  };

  console.log('\n=== REMAINING UFC DATA AUDIT ===');
  console.log(`Identity: ${report.identity.with_both_primary_ids}/${report.identity.fighters} fighters have both UFC Stats + ESPN ids (${pct(report.identity.with_both_primary_ids, report.identity.fighters)})`);
  console.log(`Structure: ${report.structural.completed_events_with_bouts}/${report.structural.completed_events} completed events have bouts (${pct(report.structural.completed_events_with_bouts, report.structural.completed_events)})`);
  console.log(`Results: ${report.structural.completed_bouts_with_results}/${report.structural.completed_bouts} completed bouts (${pct(report.structural.completed_bouts_with_results, report.structural.completed_bouts)})`);
  console.log(`Round depth: ${report.depth.completed_bouts_with_round_stats}/${report.structural.completed_bouts} (${pct(report.depth.completed_bouts_with_round_stats, report.structural.completed_bouts)})`);
  console.log(`Referees: ${report.depth.completed_bouts_with_referee}/${report.structural.completed_bouts} (${pct(report.depth.completed_bouts_with_referee, report.structural.completed_bouts)})`);
  console.log(`Decision scorecards: ${report.depth.decisions_with_scorecards}/${report.depth.decision_bouts} (${pct(report.depth.decisions_with_scorecards, report.depth.decision_bouts)})`);
  if (report.weigh_ins.table_available) console.log(`Weigh-ins: ${report.weigh_ins.rows} readings across ${report.weigh_ins.events} events / ${report.weigh_ins.bouts} bouts`);
  if (report.media.table_available) console.log(`Portrait/media rows: ${report.media.fighters_with_images}/${report.identity.fighters} fighters (${pct(report.media.fighters_with_images, report.identity.fighters)})`);
  if (latestRankDate) console.log(`Rankings ${latestRankDate}: ${report.rankings.linked}/${report.rankings.rows} rows linked (${pct(report.rankings.linked, report.rankings.rows)})`);

  const priorities = [
    ['round_stats', report.structural.completed_bouts - report.depth.completed_bouts_with_round_stats],
    ['decision_scorecards', report.depth.decision_bouts - report.depth.decisions_with_scorecards],
    ['referees', report.structural.completed_bouts - report.depth.completed_bouts_with_referee],
    ['results', report.structural.completed_bouts - report.structural.completed_bouts_with_results],
    ['event_structure', report.structural.completed_events - report.structural.completed_events_with_bouts],
    ['ranking_identity', report.rankings.unresolved],
  ].sort((a, b) => b[1] - a[1]);
  report.priority_gaps = priorities.map(([lane, missing]) => ({ lane, missing }));
  console.log('\nLargest countable native UFC gaps:');
  for (const p of report.priority_gaps) console.log(`  ${String(p.missing).padStart(6)}  ${p.lane}`);
  console.log(`  ${report.depth.finish_enrichment_rows ?? 'n/a'}  finish-enrichment rows currently present`);
  console.log(`  ${report.depth.position_stat_rows ?? 'n/a'}  position-stat rows currently present`);

  writeJson(arg('--json'), report);
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
