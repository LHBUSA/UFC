/* High-level PropBetEdge newsroom features, derived ONLY from already-published
 * first-party preview/result fact blocks.
 *
 * This is intentionally a second editorial layer, not a second source of
 * truth. write_articles.mjs builds the verified bout/event packets and the
 * deep core stories. This module reads those published packets and turns them
 * into card-level bettor guides and post-event betting resets. It never reads
 * RSS items, never promotes a third-party report into a publication, and never
 * invents a price, pick, probability or model output.
 *
 * Stable rule:
 *   Live Wire / outside reporting = source material.
 *   Core articles                = verified PropBetEdge bout/event coverage.
 *   Features                     = PropBetEdge's bettor-first synthesis.
 */
import { Supabase, loadEnv, slugify, factHash, wordCount } from './lib.mjs';

const VERSION = 'feature-template-v1';
const HASH_SALT = 'bettor-features-v1';
const GUIDE_CLASS = 'event_bettor_guide';
const RESET_CLASS = 'event_bettor_reset';
const CORE_PREVIEW_CLASSES = new Set(['main_event_preview', 'main_card_preview', 'prelim_preview']);
const RESULT_FEATURE_CLASSES = new Set(['results_analysis', 'prospect_results_analysis', RESET_CLASS]);
const MARKET_ORDER = ['moneyline', 'fight_goes_distance', 'total_rounds', 'method_of_victory', 'round_betting', 'significant_strikes', 'takedowns', 'control_time', 'knockdowns', 'inside_distance'];
const MARKET_LABEL = {
  moneyline: 'moneyline',
  fight_goes_distance: 'fight-goes-distance',
  total_rounds: 'total-rounds',
  method_of_victory: 'method-of-victory',
  round_betting: 'round',
  significant_strikes: 'significant-strike',
  takedowns: 'takedown',
  control_time: 'control-time',
  knockdowns: 'knockdown',
  inside_distance: 'inside-the-distance',
};

const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const sentence = (s) => {
  const x = String(s || '').trim();
  if (!x) return '';
  return /[.!?]$/.test(x) ? x : `${x}.`;
};
const cleanHeadline = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const marketLabel = (m) => MARKET_LABEL[m] || String(m || '').replace(/_/g, '-');
const shortName = (event) => event?.short_name || String(event?.name || 'UFC').split(':')[0];
const articleClass = (a) => a?.fact_block?.story_class || '';
const sourceHash = (a) => (Array.isArray(a?.sources) ? a.sources.find((s) => s?.kind === 'fact_block')?.hash : null) || null;

function stableHash(fb) {
  const stable = { ...fb };
  delete stable.generated_at;
  return factHash(stable, { salt: HASH_SALT });
}

function primaryPair(preview) {
  const m = preview?.fact_block?.matchup;
  return m?.a?.name && m?.b?.name ? `${m.a.name} vs. ${m.b.name}` : preview?.headline || 'the matchup';
}

function positionRank(a) {
  const b = a?.fact_block?.bout || {};
  if (b.is_main || b.position_label === 'main event') return 0;
  if (b.card_position === 'main') return 1;
  return 2;
}

function signalFromPreview(a) {
  const fb = a.fact_block || {};
  const angle = fb.bettor_angle || {};
  const matchup = fb.matchup || {};
  return {
    slug: a.slug,
    headline: a.headline,
    pair: primaryPair(a),
    impact_score: Number(angle.impact_score) || 1,
    markets: Array.isArray(angle.markets) ? angle.markets : [],
    summary: angle.summary || '',
    supporting_facts: Array.isArray(angle.supporting_facts) ? angle.supporting_facts : [],
    risks: Array.isArray(angle.risks) ? angle.risks : [],
    watch_items: Array.isArray(angle.watch_items) ? angle.watch_items : [],
    position_label: fb.bout?.position_label || fb.bout?.card_position || null,
    scheduled_rounds: fb.bout?.scheduled_rounds ?? null,
    fighter_ids: [matchup.a?.fighter_id, matchup.b?.fighter_id].filter(Boolean),
  };
}

function guideBody(event, signals, angle) {
  const ev = shortName(event);
  const marketText = angle.markets.length ? angle.markets.map(marketLabel).join(', ') : 'the markets that eventually attach to these matchups';
  const blocks = [];

  blocks.push(
    `PropBetEdge already has a verified bout-level preview for each matchup selected below. This card guide does a different job: it pulls the strongest bettor-facing variables into one map so the card can be read as a market, not as a stack of unrelated fights.`,
    `The discipline is the same across every section. A reach edge, takedown rate, finishing pattern or pace gap is **not value by itself**. It tells us what the eventual price has to account for. Until a verified market is stored, the useful question is where the evidence is strongest, where it is fragile, and which assumption a bettor should test first.`,
    `Across ${ev}, the current fact packets connect most often to ${marketText}. That is a watch list, not a recommendation. The point is to know which numbers matter before the market gives those numbers a price.`
  );

  blocks.push('## The card-level betting map');
  blocks.push(`These are the highest-impact matchup reads in the current PropBetEdge fact blocks. They are ordered by bettor impact first and card position second, so a prelim with a clearer measurable mismatch can outrank a bigger-name fight with less separation in the data.`);

  for (const s of signals) {
    blocks.push(`## ${s.pair}`);
    blocks.push(sentence(s.summary));
    if (s.supporting_facts.length) blocks.push(s.supporting_facts.slice(0, 3).map(sentence).join(' '));
    if (s.risks.length) blocks.push(`The counter-case matters here: ${sentence(s.risks[0])}`);
    if (s.watch_items.length) blocks.push(`Before treating the read as actionable, watch this: ${sentence(s.watch_items[0])}`);
    blocks.push(`The full bout preview keeps the complete tape, recent form and matchup context together: [${s.headline}](/news/${s.slug}).`);
  }

  blocks.push('## What not to overprice');
  blocks.push(
    `The easiest mistake on a full card is to turn every measurable difference into the same kind of edge. They are not the same. Length only matters if a fighter can keep the fight at range. Takedown activity only matters if entries turn into useful control or offense. A finishing rate is a history of outcomes, not a promise that the next opponent will cooperate.`,
    `That is why the risk side of the fact block is part of the article rather than a disclaimer after it. A strong bettor read should make the counter-case easier to see, not hide it. When a matchup has thin UFC-level history, the correct response is to demand more from the eventual price, not to fill the missing sample with confidence.`
  );

  blocks.push('## Where price changes the answer');
  blocks.push(
    `Once verified prices arrive, the job changes. A matchup can have a real stylistic or statistical edge and still be a bad bet if the market has charged too much for it. The inverse is also true: a fight that looks close in raw matchup data can become interesting if the market forces one side to carry too much of the uncertainty.`,
    `PropBetEdge therefore keeps the market layer separate from the matchup layer. The current guide says what should move attention. A later market snapshot is what tells us whether that attention has already been priced in.`
  );

  blocks.push('## What to watch before betting');
  if (angle.watch_items.length) blocks.push(angle.watch_items.slice(0, 6).map((x) => `- ${x}`).join('\n'));
  else blocks.push(`- Confirm the scheduled card and round structure remain unchanged.\n- Recheck the matchup after weigh-ins.\n- Compare the first verified market snapshot with the variables above before treating any read as value.`);

  blocks.push('## Bettor’s bottom line');
  blocks.push(
    `The advantage of card-level coverage is not that every fight becomes a pick. It is that the bettor can separate **strong evidence, mixed evidence and missing evidence** before emotion or price movement compresses them into one story.`,
    `${ev} already has deep bout-by-bout coverage underneath this guide. Use this page to decide where to spend attention; use the individual previews to understand the matchup; and wait for verified price before calling any of it value.`
  );

  return blocks.join('\n\n');
}

function buildGuide(eventId, previews, existing, now) {
  if (!previews.length) return null;
  const event = previews[0].fact_block?.event;
  if (!event?.event_date) return null;

  /* If an editor has already published a card-level guide, that IS the guide.
   * Automation must refresh its own rows, never compete with a human feature. */
  const existingGuide = existing.find((a) => a.event_id === eventId && articleClass(a) === GUIDE_CLASS);
  if (existingGuide && existingGuide.model_version !== VERSION) return null;

  const signals = previews
    .map(signalFromPreview)
    .filter((s) => s.summary && s.supporting_facts.length)
    .sort((a, b) => b.impact_score - a.impact_score || positionRank(previews.find((p) => p.slug === a.slug)) - positionRank(previews.find((p) => p.slug === b.slug)) || a.pair.localeCompare(b.pair))
    .slice(0, 5);
  if (signals.length < 3) return null;

  const markets = MARKET_ORDER.filter((m) => signals.some((s) => s.markets.includes(m)));
  const supporting = uniq(signals.flatMap((s) => s.supporting_facts)).slice(0, 10);
  const risks = uniq(signals.flatMap((s) => s.risks)).slice(0, 8);
  const watch = uniq(signals.flatMap((s) => s.watch_items)).slice(0, 8);
  const impact = Math.max(...signals.map((s) => s.impact_score));
  const summary = `The strongest bettor-facing variables on ${shortName(event)} are concentrated in ${signals.map((s) => s.pair).join('; ')}. The guide ranks what to investigate first, while keeping price separate from matchup analysis until a verified market exists.`;
  const angle = {
    impact_score: Math.max(1, Math.min(5, impact)),
    markets,
    summary,
    supporting_facts: supporting,
    risks: risks.length ? risks : ['The selected matchup signals come from different sample sizes and should not be treated as equally certain.'],
    watch_items: watch.length ? watch : ['Recheck the card after weigh-ins and compare the first verified market snapshot with the matchup variables in this guide.'],
    odds_status: 'unavailable',
    model_status: 'unavailable',
  };
  const sourceRefs = signals.map((s) => {
    const src = previews.find((p) => p.slug === s.slug);
    return { slug: s.slug, fact_hash: sourceHash(src), updated_at: src?.updated_at || null };
  });
  const fb = {
    version: 2,
    story_class: GUIDE_CLASS,
    generated_at: new Date(now).toISOString(),
    generated_from: ['ufc_articles', 'ufc_events', 'ufc_bouts', 'ufc_bout_results', 'ufc_bout_round_stats', 'ufc_fighters'],
    sources: { families: uniq(previews.flatMap((p) => p.fact_block?.sources?.families || [])), news_item_ids: [] },
    event,
    feature: { kind: 'card_bettor_guide', source_articles: sourceRefs, signals },
    bettor_angle: angle,
    market_watch: { status: 'unavailable', markets: markets.slice(0, 5), note: 'Current verified market prices are not yet stored in PropBetEdge data for this card.' },
    depth: { class: GUIDE_CLASS, target: [700, 1400], short: false, short_reason: null },
  };
  const body = guideBody(event, signals, angle);
  const main = previews.find((p) => p.fact_block?.bout?.is_main || p.fact_block?.bout?.position_label === 'main event') || previews[0];
  const mainPair = primaryPair(main);
  return {
    slug: existingGuide?.slug || `${event.slug || slugify(event.name)}-bettors-guide`,
    headline: `${shortName(event)} bettor’s guide: the market questions that matter before ${mainPair}`,
    dek: `A card-level PropBetEdge read of the strongest verified matchup variables, the markets they touch and the counter-cases bettors should keep in view before price enters the equation.`,
    body_md: body,
    story_type: 'fight_preview',
    fact_block: fb,
    fighter_ids: uniq(signals.flatMap((s) => s.fighter_ids)),
    bout_id: null,
    event_id: eventId,
    hero_image_ref: main.hero_image_ref || null,
    hero_credit: main.hero_credit || null,
  };
}

function resetBody(fb) {
  const event = fb.event || {};
  const R = fb.results || {};
  const totals = R.totals || {};
  const main = R.main || {};
  const angle = fb.bettor_angle || {};
  const ev = shortName(event);
  const blocks = [];

  blocks.push(
    `${ev} is over. For bettors, the useful work starts after the result: separate what the card actually added to the database from the narratives that a dramatic finish, a close decision or a dominant sequence can create.`,
    `This reset is built from the stored PropBetEdge result packet and round-stat layer. It is not a grade on a closing market because no verified pre-fight price is attached here. The goal is forward-looking: identify which fighter profiles changed, which assumptions survived, and what the next line will need to account for.`
  );

  blocks.push('## What the card actually produced');
  if (totals.bouts != null) {
    blocks.push(`The stored card has ${totals.bouts} bouts with results. ${totals.finishes ?? 0} ended inside the distance, including ${totals.ko_tko ?? 0} by KO/TKO and ${totals.subs ?? 0} by submission; ${totals.decisions ?? 0} went to the judges${totals.split_decisions ? `, with ${totals.split_decisions} split decision${totals.split_decisions === 1 ? '' : 's'}` : ''}. ${totals.r1_finishes ? `${totals.r1_finishes} fights ended in the opening round.` : ''}`);
  }
  blocks.push(`Those totals describe the card. They do **not** mean the next card, division or individual fighter should inherit the same finish expectation. Card-level results are useful for identifying what changed; matchup-level history still decides whether a pattern belongs to a fighter or was specific to one night.`);

  blocks.push('## Main-event betting reset');
  if (angle.summary) blocks.push(sentence(angle.summary));
  if (Array.isArray(angle.supporting_facts) && angle.supporting_facts.length) blocks.push(angle.supporting_facts.slice(0, 5).map(sentence).join(' '));
  if (main.winner?.name && main.loser?.name) {
    blocks.push(`The result belongs in both fighters’ next matchup packet, but it should not be carried forward as a one-line rule. ${main.winner.name} now has new evidence on the winning path; ${main.loser.name} has new evidence on the losing path. The next opponent decides which part of that evidence matters.`);
  }

  blocks.push('## Where bettors can overreact');
  const risks = Array.isArray(angle.risks) ? angle.risks : [];
  if (risks.length) blocks.push(risks.slice(0, 6).map((x) => `- ${x}`).join('\n'));
  blocks.push(
    `A result is strongest when it answers a question that existed before the fight. It is weaker when it creates an entirely new conclusion from one sequence. Fast finishes can make a fighter look more repeatable than the sample supports; long control stretches can make a scorecard look more certain than the damage supports; a close decision can make a competitive fight look like a binary referendum on either fighter.`,
    `PropBetEdge treats those as different evidence classes. The bettor advantage is not being less impressed by a result. It is being more precise about what the result proved.`
  );

  blocks.push('## Markets to reassess next time');
  const markets = Array.isArray(angle.markets) ? angle.markets : [];
  if (markets.length) blocks.push(`The current result packet points future attention toward ${markets.map(marketLabel).join(', ')} markets. That does not mean the same side of those markets will be attractive. It means the new result changed the inputs those prices will have to absorb.`);
  else blocks.push(`The result packet does not single out a specific future market. In that case, the correct reset is modest: update the fighter archive and wait for the next matchup before forcing a betting thesis.`);

  blocks.push('## What to carry into the next booking');
  const watch = Array.isArray(angle.watch_items) ? angle.watch_items : [];
  if (watch.length) blocks.push(watch.slice(0, 6).map((x) => `- ${x}`).join('\n'));
  else blocks.push(`- Opponent style and whether it attacks the same weakness or strength this result exposed.\n- The first verified market snapshot on each fighter’s next bout.\n- Whether the next price appears to charge for the highlight more aggressively than the underlying sample supports.`);

  blocks.push('## Bettor’s bottom line');
  blocks.push(
    `The best post-fight coverage should make the next bet easier to evaluate, not simply retell the last fight. The card result is now part of the PropBetEdge archive, and the archive will travel into the next matchup automatically.`,
    `Until that matchup and its verified price exist, the right output is a **profile reset, not a retroactive pick**. Keep what the data proved, keep the counter-case beside it, and make the next market earn whatever conclusion it wants bettors to buy.`
  );

  return blocks.join('\n\n');
}

function buildReset(core, existing, now) {
  const fb0 = core.fact_block || {};
  const event = fb0.event;
  const R = fb0.results;
  if (!event?.event_date || !R?.main || !R?.totals) return null;

  /* An editor-written result feature already gives this event its second-day
   * analysis. Do not manufacture a competing automated version beside it. */
  const existingFeature = existing.find((a) => a.event_id === core.event_id && RESULT_FEATURE_CLASSES.has(articleClass(a)));
  if (existingFeature && existingFeature.model_version !== VERSION) return null;

  const fb = {
    version: 2,
    story_class: RESET_CLASS,
    generated_at: new Date(now).toISOString(),
    generated_from: uniq([...(fb0.generated_from || []), 'ufc_articles']),
    sources: { families: uniq(fb0.sources?.families || []), news_item_ids: [] },
    event,
    results: R,
    bettor_angle: fb0.bettor_angle,
    market_watch: fb0.market_watch,
    feature: { kind: 'post_event_bettor_reset', source_article: { slug: core.slug, fact_hash: sourceHash(core), updated_at: core.updated_at || null } },
    depth: { class: RESET_CLASS, target: [650, 1200], short: false, short_reason: null },
  };
  const body = resetBody(fb);
  const m = R.main;
  const pair = m.a?.name && m.b?.name ? `${m.a.name} vs. ${m.b.name}` : event.name;
  return {
    slug: existingFeature?.slug || `${event.slug || slugify(event.name)}-bettor-reset`,
    headline: `${shortName(event)} betting reset: what ${pair} changed for the next market`,
    dek: `A PropBetEdge post-fight reset built from the verified result packet: what changed, what can be overreacted to and which markets deserve a fresh look the next time these fighters are priced.`,
    body_md: body,
    story_type: 'results',
    fact_block: fb,
    fighter_ids: Array.isArray(core.fighter_ids) ? core.fighter_ids : [],
    bout_id: core.bout_id || null,
    event_id: core.event_id,
    hero_image_ref: core.hero_image_ref || null,
    hero_credit: core.hero_credit || null,
  };
}

function validateFeature(article) {
  const problems = [];
  const words = wordCount(String(article.body_md || '').replace(/^#+ .*$/gm, ''));
  if (words < 600) problems.push(`thin feature (${words} words)`);
  if (!article.fact_block?.bettor_angle) problems.push('bettor_angle missing');
  if (article.fact_block?.bettor_angle?.odds_status !== 'unavailable') problems.push('unverified odds state');
  if (article.fact_block?.bettor_angle?.model_status !== 'unavailable') problems.push('unverified model state');
  if (!article.body_md.includes('## Bettor')) problems.push('bettor-first close missing');
  if (/\b(?:lock|guaranteed|sure thing|free money|our pick|will win|should win)\b/i.test(`${article.headline}\n${article.dek}\n${article.body_md}`)) problems.push('pick/certainty language');
  if (/\b(?:DraftKings|FanDuel|BetMGM|Caesars|bet365|Pinnacle)\b/i.test(article.body_md)) problems.push('sportsbook mention');
  return { problems, words };
}

async function persist(sb, article, existingBySlug, now) {
  const { problems, words } = validateFeature(article);
  if (problems.length) {
    console.warn(`  feature held ${article.slug}: ${problems.join('; ')}`);
    return { held: 1, created: 0, refreshed: 0, unchanged: 0, words };
  }
  const hash = stableHash(article.fact_block);
  const existing = existingBySlug.get(article.slug);
  const oldHash = Array.isArray(existing?.sources) ? existing.sources.find((s) => s?.kind === 'feature_block')?.hash : null;
  if (existing && oldHash === hash) return { held: 0, created: 0, refreshed: 0, unchanged: 1, words };

  const row = {
    slug: article.slug,
    headline: cleanHeadline(article.headline),
    dek: article.dek,
    body_md: article.body_md,
    story_type: article.story_type,
    status: 'published',
    hero_image_ref: article.hero_image_ref,
    hero_credit: article.hero_credit,
    sources: [{ kind: 'feature_block', hash, version: 1 }, { kind: 'tables', names: article.fact_block.generated_from }, { kind: 'first_party_synthesis', source_articles: article.fact_block.feature }],
    fact_block: article.fact_block,
    fighter_ids: article.fighter_ids,
    bout_id: article.bout_id,
    event_id: article.event_id,
    model_version: VERSION,
    needs_human: false,
    updated_at: new Date(now).toISOString(),
  };

  if (existing) {
    await sb.patch('ufc_articles', `id=eq.${existing.id}`, row);
    existingBySlug.set(article.slug, { ...existing, ...row });
    console.log(`  ~ feature ${article.fact_block.story_class.padEnd(20)} ${String(words).padStart(4)}w ${article.slug}`);
    return { held: 0, created: 0, refreshed: 1, unchanged: 0, words };
  }

  row.published_at = new Date(now).toISOString();
  const inserted = await sb.insert('ufc_articles', [row], { onConflict: 'slug', ignoreDuplicates: true });
  if (inserted?.[0]) existingBySlug.set(article.slug, inserted[0]);
  console.log(`  + feature ${article.fact_block.story_class.padEnd(20)} ${String(words).padStart(4)}w ${article.slug}`);
  return { held: 0, created: inserted?.length ? 1 : 0, refreshed: 0, unchanged: inserted?.length ? 0 : 1, words };
}

/**
 * Run after the core writer. The core writer can create/refresh bout previews
 * and result packets first; this pass then sees the new first-party material in
 * the same invocation and publishes the higher-order newsroom layer from it.
 */
export async function main(injectedEnv, { now = Date.now() } = {}) {
  const env = injectedEnv || loadEnv();
  const sb = new Supabase(env);
  const today = new Date(now).toISOString().slice(0, 10);
  const rows = await sb.select('ufc_articles', 'select=id,slug,headline,story_type,status,sources,fact_block,fighter_ids,bout_id,event_id,hero_image_ref,hero_credit,published_at,updated_at,model_version,needs_human&status=eq.published');
  const existingBySlug = new Map(rows.map((a) => [a.slug, a]));

  const corePreviews = rows.filter((a) => a.story_type === 'fight_preview' && CORE_PREVIEW_CLASSES.has(articleClass(a)) && a.fact_block?.event?.event_date >= today);
  const previewGroups = new Map();
  for (const a of corePreviews) {
    if (!a.event_id) continue;
    if (!previewGroups.has(a.event_id)) previewGroups.set(a.event_id, []);
    previewGroups.get(a.event_id).push(a);
  }
  const upcoming = [...previewGroups.entries()]
    .sort(([, a], [, b]) => String(a[0]?.fact_block?.event?.event_date || '').localeCompare(String(b[0]?.fact_block?.event?.event_date || '')))
    .slice(0, 2);

  const coreResults = rows
    .filter((a) => a.story_type === 'results' && articleClass(a) === 'results' && a.fact_block?.event?.event_date <= today)
    .sort((a, b) => String(b.fact_block?.event?.event_date || '').localeCompare(String(a.fact_block?.event?.event_date || '')))
    .slice(0, 4);

  const candidates = [];
  for (const [eventId, previews] of upcoming) {
    const guide = buildGuide(eventId, previews, rows, now);
    if (guide) candidates.push(guide);
  }
  for (const result of coreResults) {
    const reset = buildReset(result, rows, now);
    if (reset) candidates.push(reset);
  }

  const stats = { created: 0, refreshed: 0, unchanged: 0, held: 0, candidates: candidates.length };
  for (const article of candidates) {
    const r = await persist(sb, article, existingBySlug, now);
    stats.created += r.created;
    stats.refreshed += r.refreshed;
    stats.unchanged += r.unchanged;
    stats.held += r.held;
  }
  console.log(`features: candidates=${stats.candidates} created=${stats.created} refreshed=${stats.refreshed} unchanged=${stats.unchanged} held=${stats.held}`);
  return stats;
}

const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('write_features.mjs');
if (isCli) main(undefined, {}).catch((e) => { console.error(e); process.exit(1); });
