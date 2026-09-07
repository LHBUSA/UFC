#!/usr/bin/env node
// Referee bio + fact enrichment.
//
//   ufc_referee_directory -> Wikipedia summary (must read as a combat-sports
//   official, so a namesake can never attach) -> Wikidata identity facts ->
//   PropBetEdge archive metrics (assignments, title fights, main events,
//   finish/round distribution, durations) -> data/referees/<slug>.json
//
// Every claim carries value, source, method and verified_at. Nothing is
// fabricated: an uncertain tenure is published as "documented UFC assignments
// since YYYY", never as an invented debut date. Derived metrics are labelled
// pbe_derived with their sample size and are stated as historical fact only —
// no "early stoppage referee" style characterisation.
//
// Usage: node scripts/referees/enrich.mjs [--dry-run] [--limit N] [--slug s]
//                                          [--resume] [--report] [--force]
import { claim, cli, identityFacts, nowIso, readPacket, resolveWiki, rest, writeCombined, writePacket } from '../media/lib/subjects.mjs';

/* A referee article must actually describe officiating. "mixed martial arts"
 * alone is not enough — that matches every fighter who shares the name. */
const REF_CONTEXT = /referee|officiat|athletic commission/i;
const args = cli();

const SELECT = 'name,display_name,slug,bouts,stoppages,ko_tko,submissions,decisions,split_decisions,nc_draws,title_bouts,five_round_bouts,avg_fight_seconds,avg_stoppage_seconds,first_event_date,last_event_date,stoppage_rate,decision_rate,split_decision_share,archive_stoppage_rate,archive_decision_rate,bio,bio_source_url,bio_source_name,bio_verified_at,country,image_url,image_source_url,image_credit,image_license';

const yearOf = (d) => (d ? new Date(`${d}T00:00:00Z`).getUTCFullYear() : null);

/* Archive metrics: factual distributions from our own bout rows, with the
 * sample size attached. No characterisation of officiating style. */
async function archiveMetrics(slug) {
  const bouts = await rest(`ufc_referee_bouts?select=method,round,time_sec,is_title,card_position,scheduled_rounds,event_date,event_name,fighter_a_name,fighter_b_name,winner_name,weight_class,is_womens&referee_slug=eq.${encodeURIComponent(slug)}&order=event_date.desc.nullslast&limit=500`).catch(() => []);
  if (!bouts.length) return null;
  const rounds = {};
  let mainEvents = 0, timed = 0, totalTime = 0;
  const byMethod = {};
  for (const b of bouts) {
    const m = String(b.method || 'UNKNOWN');
    byMethod[m] = (byMethod[m] || 0) + 1;
    if (b.round) rounds[b.round] = (rounds[b.round] || 0) + 1;
    if (b.card_position === 'main') mainEvents += 1;
    if (b.round && b.time_sec != null) { timed += 1; totalTime += (b.round - 1) * 300 + b.time_sec; }
  }
  const stoppageTimes = bouts.filter((b) => /KO_TKO|SUB/.test(b.method || '') && b.round && b.time_sec != null).map((b) => (b.round - 1) * 300 + b.time_sec).sort((a, b) => a - b);
  const pctile = (p) => (stoppageTimes.length ? stoppageTimes[Math.min(stoppageTimes.length - 1, Math.floor(stoppageTimes.length * p))] : null);
  return {
    sample_bouts: bouts.length,
    main_event_assignments: mainEvents,
    method_distribution: byMethod,
    round_distribution: rounds,
    avg_fight_seconds: timed ? Math.round(totalTime / timed) : null,
    timed_sample: timed,
    stoppage_time_seconds: stoppageTimes.length ? { p25: pctile(0.25), median: pctile(0.5), p75: pctile(0.75), sample: stoppageTimes.length } : null,
    notable: bouts.filter((b) => b.is_title).slice(0, 8).map((b) => ({ fight: `${b.fighter_a_name} vs ${b.fighter_b_name}`, event: b.event_name, date: b.event_date, method: b.method, round: b.round })),
  };
}

async function enrichOne(r) {
  const existing = readPacket('referees', r.slug);
  if (args.resume && existing?.identity?.checked_at && !args.force) return { slug: r.slug, status: 'skipped' };

  const wiki = await resolveWiki(r.display_name, REF_CONTEXT).catch(() => null);
  const qid = wiki?.wikibase_item || null;
  const facts = qid ? await identityFacts(qid).catch(() => null) : null;
  const wikiUrl = wiki?.content_urls?.desktop?.page || (wiki?.title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.title.replace(/ /g, '_'))}` : null);
  const metrics = await archiveMetrics(r.slug).catch(() => null);

  const firstYear = yearOf(r.first_event_date), lastYear = yearOf(r.last_event_date);
  const archiveSrc = 'PropBetEdge UFC archive (ufc_referee_directory)';
  const packet = {
    subject_type: 'referee', slug: r.slug, name: r.display_name,
    identity: {
      checked_at: nowIso(),
      wikipedia: wikiUrl, wikidata: qid,
      resolved: Boolean(wiki),
      note: wiki ? null : 'No English Wikipedia article passed the combat-sports context check.',
    },
    facts: {
      full_name: claim(wiki?.title && wiki.title.length > r.display_name.length ? wiki.title.replace(/ \(.*\)$/, '') : r.display_name, wikiUrl || archiveSrc, wiki ? 'wikipedia_title' : 'archive'),
      role: claim(facts?.description || (wiki ? null : 'Mixed martial arts referee'), wikiUrl || archiveSrc, facts ? 'wikidata_description' : 'archive'),
      nationality: claim(facts?.nationality || r.country, facts?.nationality ? `https://www.wikidata.org/wiki/${qid}` : archiveSrc, facts?.nationality ? 'wikidata_P27' : 'archive'),
      date_of_birth: claim(facts?.date_of_birth, qid ? `https://www.wikidata.org/wiki/${qid}` : null, 'wikidata_P569'),
      occupations: claim(facts?.occupations, qid ? `https://www.wikidata.org/wiki/${qid}` : null, 'wikidata_P106'),
      /* Tenure is stated as documented archive coverage, never an invented debut. */
      documented_since: claim(firstYear, archiveSrc, 'archive_first_assignment'),
      documented_through: claim(lastYear, archiveSrc, 'archive_last_assignment'),
      tenure_label: claim(firstYear && lastYear ? (firstYear === lastYear ? `Documented UFC assignments in ${firstYear}` : `Documented UFC assignments ${firstYear}–${lastYear}`) : null, archiveSrc, 'archive_derived'),
      status: claim(lastYear && lastYear >= new Date().getUTCFullYear() - 1 ? 'Active in the loaded archive' : lastYear ? `No loaded assignment since ${lastYear}` : null, archiveSrc, 'archive_derived'),
      ufc_bout_count: claim(r.bouts, archiveSrc, 'archive_count'),
      title_fight_count: claim(r.title_bouts, archiveSrc, 'archive_count'),
      five_round_count: claim(r.five_round_bouts, archiveSrc, 'archive_count'),
      main_event_count: claim(metrics?.main_event_assignments, archiveSrc, 'archive_count'),
    },
    bio: {
      /* Sourced prose only: the Wikipedia extract when the article passed the
       * context check, otherwise nothing (the UI falls back to the archive
       * biography it generates from our own numbers). */
      text: wiki?.extract || null,
      source_url: wikiUrl,
      source_name: wiki ? 'English Wikipedia' : null,
      license: wiki ? 'CC BY-SA 4.0' : null,
      verified_at: wiki ? nowIso() : null,
    },
    metrics: metrics ? { ...metrics, origin: 'pbe_derived', computed_at: nowIso(), note: 'Historical distribution across loaded assignments. Descriptive only; a referee does not choose the matchup, styles or scheduled length.' } : null,
    media: existing?.media || null,
    media_search: existing?.media_search || null,
    sources: [wikiUrl, qid ? `https://www.wikidata.org/wiki/${qid}` : null, r.bio_source_url].filter(Boolean),
  };
  if (!args.dry) writePacket('referees', r.slug, packet);
  return { slug: r.slug, status: wiki ? 'enriched' : 'archive_only', qid, bio: Boolean(wiki?.extract), metrics: Boolean(metrics) };
}

const main = async () => {
  let refs = await rest(`ufc_referee_directory?select=${SELECT}&order=bouts.desc&limit=300`);
  if (args.slug) refs = refs.filter((r) => r.slug === args.slug);
  refs = refs.slice(0, args.limit === Infinity ? refs.length : args.limit);
  console.log(`referee enrichment: ${refs.length} subjects${args.dry ? ' (dry run)' : ''}`);
  const counts = { enriched: 0, archive_only: 0, skipped: 0, error: 0 };
  const rows = [];
  for (const r of refs) {
    try {
      const out = await enrichOne(r);
      counts[out.status] = (counts[out.status] || 0) + 1;
      rows.push(out);
      console.log(`  ${out.status.padEnd(13)} ${r.display_name}${out.qid ? ` (${out.qid})` : ''}${out.bio ? ' +bio' : ''}${out.metrics ? ' +metrics' : ''}`);
    } catch (e) {
      counts.error += 1;
      console.log(`  error         ${r.display_name}: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (!args.dry) { const c = writeCombined(); console.log(`combined -> ${c.dest} (referees ${c.referees}, hof ${c.hof})`); }
  console.log(`\nenriched=${counts.enriched} archive_only=${counts.archive_only} skipped=${counts.skipped} error=${counts.error}`);
  if (args.report) console.log(JSON.stringify(rows, null, 2));
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
