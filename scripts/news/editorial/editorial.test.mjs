/**
 * Editorial V4 gates. Run: node --test scripts/news/editorial/editorial.test.mjs
 *
 * Every test here is a defect that was actually produced by the system during
 * development, or one the audit found in production. None of them is
 * hypothetical, which is why they are worth keeping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClass, isIndexable, CLASS_BUDGET, INDEXED_FLOOR_WORDS, STORY_DEPTH } from './classes.mjs';
import { checkSlop, checkKeywordStuffing, checkDuplicateParagraphs, checkOpening, BANNED_PHRASES } from './slop.mjs';
import { fact, buildPacket, allowedNumbers, resetFactIds, taleFacts, recentFormFacts, fightDnaFacts, roundStatFacts } from './packet.mjs';
import { gateNumbers, gateHeadline, gateLinks, gateAsOf, gateModelClaims, gateMarketClaims, gateDates, gateSchema, gateNewsSitemap, gateQuotes } from './gates.mjs';

const src = { table: 't', row_id: 'r' };

/* ---- wire vs article --------------------------------------------------- */

test('a one-family, one-fact packet can never become an article', () => {
  const d = resolveClass('news_brief', { families: ['source_item'], factCount: 1 });
  assert.equal(d.publication_class, 'wire');
  assert.equal(d.downgraded, true);
  assert.match(d.reason, /not enough/);
});

test('wire is never indexable, at any length', () => {
  assert.equal(isIndexable('wire', 240).indexable, false);
  assert.equal(isIndexable('wire', 5000).indexable, false);
});

test('an indexed page below the floor is refused unless an exception is documented', () => {
  assert.equal(isIndexable('brief', INDEXED_FLOOR_WORDS - 1).indexable, false);
  const ex = isIndexable('brief', 300, { editorialException: 'primary-source announcement, value is timeliness' });
  assert.equal(ex.indexable, true);
  assert.match(ex.reason, /documented exception/);
});

test('evidence pulls a story down from its expected class and never up past it', () => {
  const rich = resolveClass('prelim_preview', { families: ['core', 'tale', 'recent_form', 'fight_dna', 'market', 'result'], factCount: 60 });
  assert.equal(rich.publication_class, 'brief', 'a prelim preview stays a prelim preview however rich the packet');
  const thin = resolveClass('main_event_preview', { families: ['core'], factCount: 3 });
  assert.equal(thin.publication_class, 'wire');
});

/* ---- the production defect --------------------------------------------- */

test('the 78-word external template that is live today classifies as wire', () => {
  /* Reproduces the shape of every thin article in production: a source line and
     two record sentences. It must not be entitled to a page. */
  const d = resolveClass('news_brief', { families: ['source_item', 'core'], factCount: 3 });
  assert.equal(d.publication_class, 'wire');
});

/* ---- slop -------------------------------------------------------------- */

test('banned phrases are caught wherever they appear', () => {
  for (const p of ['In the world of MMA, anything can happen', 'Both men will look to impose their game', 'Only time will tell']) {
    assert.equal(checkSlop(p).ok, false, p);
  }
  assert.equal(checkSlop('Silva has four inches of reach on Delgado.').ok, true);
});

test('every banned phrase is one that could be written without knowing the fight', () => {
  for (const p of BANNED_PHRASES) {
    assert.ok(!/\d/.test(p), `"${p}" contains a number and so is not content-free`);
  }
});

test('combat-sports vocabulary is not keyword stuffing', () => {
  /* This fired on a real results draft: "fight" x13 and "strikes" x10 in a
     656-word article about a fight. Penalising it pushes prose toward
     euphemism. */
  const body = [
    'The fight turned in round two.', 'Significant strikes decided the round.',
    'He landed strikes at range and took the round.', 'The bout swung on a takedown.',
    'Control time carried the round on two cards.', 'The fight went the distance.',
    'Strikes to the body opened the round.', 'A late takedown closed the bout.',
  ].join(' ');
  assert.equal(checkKeywordStuffing(body).ok, true, JSON.stringify(checkKeywordStuffing(body).offenders));
  const stuffed = 'betting picks parlay betting picks parlay betting picks parlay '.repeat(4);
  assert.equal(checkKeywordStuffing(stuffed).ok, false);
});

test('a repeated paragraph is caught', () => {
  const p = 'Across eight books the median de-vigged price makes Silva a favourite at seventy-eight percent of the market.';
  assert.equal(checkDuplicateParagraphs(`${p}\n\n${p}`).ok, false);
  assert.equal(checkDuplicateParagraphs(`${p}\n\nSomething else entirely happened afterwards in the second round.`).ok, true);
});

test('an opening that names nobody is a weak opening', () => {
  assert.equal(checkOpening('The anticipation is building ahead of a big night.', { entities: ['Jean Silva'] }).ok, false);
  assert.equal(checkOpening('Jean Silva meets Jose Miguel Delgado at featherweight.', { entities: ['Jean Silva'] }).ok, true);
});

/* ---- facts and numbers -------------------------------------------------- */

test('a number in the body must exist in the packet', () => {
  resetFactIds();
  const packet = buildPacket({ storyType: 'news_brief', parts: [[fact({ family: 'core', statement: 'He landed 42 strikes.', value: 42, source: src })]] });
  assert.equal(gateNumbers('He landed 42 strikes.', packet).length, 0);
  assert.equal(gateNumbers('He landed 91 strikes.', packet).length, 1);
});

test('years and small ordinals are prose furniture, not claims', () => {
  resetFactIds();
  const packet = buildPacket({ storyType: 'news_brief', parts: [[fact({ family: 'core', statement: 'x', source: src })]] });
  assert.equal(gateNumbers('It happened in 2026 in round 3.', packet).length, 0);
});

test('a row label in a module table is not an unsupported number', () => {
  /* "Takedowns / 15 min" is a unit, and the first version of the gate read the
     15 as a claim about the fight. */
  resetFactIds();
  const packet = buildPacket({ storyType: 'results', parts: [[fact({ family: 'core', statement: 'x', source: src })]] });
  const body = '| | A | B |\n|---|---|---|\n| Takedowns / 15 min | 0.00 | 0.00 |';
  assert.equal(gateNumbers(body, packet).length, 0);
});

test('a derived metric is supported when its rule is documented', () => {
  const facts = taleFacts({ fighters: [{ id: '1', name: 'A', career_slpm: 5.0, career_sapm: 4.0 }], eventDate: '2026-01-01' });
  const net = facts.find((f) => /nets/.test(f.statement));
  assert.ok(net, 'net striking should be a fact');
  assert.match(net.source.rule, /career_slpm - career_sapm/);
  assert.equal(net.value, 1);
});

test('career percentage columns are read as whole percentages', () => {
  /* Multiplying by 100 produced "5300% striking defence" in the first preview. */
  const facts = taleFacts({ fighters: [{ id: '1', name: 'A', career_str_def: 53, career_td_def: 78 }], eventDate: '2026-01-01' });
  assert.ok(facts.some((f) => /53% striking defence/.test(f.statement)));
  assert.ok(facts.some((f) => /78% of takedowns/.test(f.statement)));
});

/* ---- as-of safety ------------------------------------------------------- */

test('a fact dated after the packet as-of is refused at build time', () => {
  resetFactIds();
  assert.throws(() => buildPacket({
    storyType: 'results',
    asOf: '2024-01-01',
    parts: [[fact({ family: 'market', statement: 'a price', source: src, as_of: '2026-09-08' })]],
  }), /as-of leak/);
});

test('recent form drops a bout dated on or after the story date', () => {
  /* Filtering it out is the safe direction: a same-day bout on the same card
     must not appear in the run-up to the fight being written about. */
  const out = recentFormFacts({
    fighters: [{ id: '1', name: 'A' }],
    bouts: [{ fighter_id: '1', bout_id: 'b', event_date: '2026-05-01', outcome: 'W', method: 'KO_TKO' }],
    asOf: '2026-05-01',
  });
  assert.equal(out.length, 0);
});

test('fight DNA never selects a snapshot dated after the bout', () => {
  const out = fightDnaFacts({
    fighters: [{ id: '1', name: 'A' }],
    snapshots: [{ fighter_id: '1', as_of_date: '2026-09-08', sample_stat_bouts: 9, coverage_status: 'high', metrics: { sig_landed_per_min: { value: 4 } } }],
    asOf: '2024-01-01',
  });
  assert.equal(out.length, 0, 'a later snapshot must not be used for an older story');
});

test('gateAsOf reports a leak rather than silently passing', () => {
  const packet = { as_of: '2024-01-01', facts: [{ family: 'market', as_of: '2026-01-01', statement: 'x' }] };
  assert.equal(gateAsOf(packet).length, 1);
});

/* ---- unsupported claims ------------------------------------------------- */

test('a model claim without a locked model fact is refused', () => {
  const packet = { facts: [] };
  assert.equal(gateModelClaims('The PBE Model makes him a 61% favourite.', packet).length, 1);
  assert.equal(gateModelClaims('Nothing about a model here.', packet).length, 0);
});

test('an odds claim without a market fact is refused, and stale must be stated', () => {
  assert.equal(gateMarketClaims('He is the favourite with the books.', { facts: [] }).length, 1);
  const stalePacket = { facts: [{ family: 'market', statement: 'That reading is stale.' }] };
  assert.equal(gateMarketClaims('The market likes him.', stalePacket).length, 1, 'body must say stale');
  assert.equal(gateMarketClaims('The market likes him, though the price is stale.', stalePacket).length, 0);
});

test('a quotation the packet does not hold is a fabricated quote', () => {
  const packet = { facts: [{ family: 'source_item', statement: 'MMA Fighting published "Silva out with injury" on Sep 1.' }] };
  assert.equal(gateQuotes('He said "I will finish him inside two rounds, guaranteed."', packet).length, 1);
  assert.equal(gateQuotes('MMA Fighting published "Silva out with injury" on Sep 1.', packet).length, 0);
});

test('an inch mark is not an opening quotation', () => {
  const packet = { facts: [] };
  assert.equal(gateQuotes('He stands 5\'11" and carries a 73-inch reach across the division.', packet).length, 0);
});

/* ---- headline, links, dates, schema, sitemap ---------------------------- */

test('headline rules', () => {
  assert.equal(gateHeadline('Silva beats Delgado by unanimous decision').length, 0);
  assert.ok(gateHeadline('x'.repeat(120)).some((v) => v.gate === 'headline_too_long'));
  assert.ok(gateHeadline('Short').some((v) => v.gate === 'headline_too_short'));
  assert.ok(gateHeadline('5 reasons Silva wins this weekend at featherweight').some((v) => v.gate === 'headline_leading_number'));
});

test('internal links must match a real route and features need three to eight', () => {
  const ok = '[a](/fighters/x) [b](/events/y) [c](/model)';
  assert.equal(gateLinks(ok, { publicationClass: 'feature' }).length, 0);
  assert.ok(gateLinks('[a](/made-up-surface)', { publicationClass: 'brief' }).some((v) => v.gate === 'bad_internal_link'));
  assert.ok(gateLinks('[a](/model)', { publicationClass: 'feature' }).some((v) => v.gate === 'too_few_internal_links'));
  assert.ok(gateLinks(ok, { known: new Set(['/model']), publicationClass: 'brief' }).some((v) => v.gate === 'unresolvable_internal_link'));
});

test('published_at is immutable and dateModified needs a material change', () => {
  assert.ok(gateDates({ publishedAt: 'B', previousPublishedAt: 'A' }).some((v) => v.gate === 'artificial_date_freshening'));
  assert.ok(gateDates({ publishedAt: 'A', updatedAt: 'B', materialChange: false }).some((v) => v.gate === 'fake_update_timestamp'));
  assert.equal(gateDates({ publishedAt: 'A', updatedAt: 'B', materialChange: true }).length, 0);
});

test('NewsArticle schema completeness, including author URL', () => {
  const good = {
    '@type': 'NewsArticle', '@id': 'x', headline: 'h', description: 'd', image: ['i'],
    datePublished: 'p', dateModified: 'm', author: { name: 'PropBetEdge Editorial Desk', url: '/about/editorial' },
    publisher: { name: 'PropBetEdge', logo: { url: 'l' } }, mainEntityOfPage: 'u',
    articleSection: 's', wordCount: 900, isAccessibleForFree: true,
  };
  assert.equal(gateSchema(good).length, 0);
  assert.ok(gateSchema({ ...good, author: { name: 'x' } }).some((v) => v.gate === 'missing_author_url'));
  assert.ok(gateSchema({ ...good, wordCount: undefined }).some((v) => v.detail === 'wordCount'));
});

test('a wire item may never enter the Google News sitemap', () => {
  const v = gateNewsSitemap([
    { slug: 'a', publication_class: 'feature', indexable: true },
    { slug: 'b', publication_class: 'wire', indexable: false },
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].detail, 'b');
});

/* ---- round stats -------------------------------------------------------- */

test('round statistics produce per-round facts and a totals comparison', () => {
  resetFactIds();
  const fighters = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }];
  const rows = [
    { bout_id: 'b', fighter_id: '1', round: 1, sig_str_landed: 20, sig_str_att: 40, td_landed: 1, td_att: 2, ctrl_sec: 90, kd: 0, sub_att: 0 },
    { bout_id: 'b', fighter_id: '2', round: 1, sig_str_landed: 10, sig_str_att: 30, td_landed: 0, td_att: 1, ctrl_sec: 0, kd: 0, sub_att: 0 },
  ];
  const out = roundStatFacts({ rows, fighters, bout: { id: 'b' } });
  assert.ok(out.some((f) => /^Round 1:/.test(f.statement)), 'a per-round line');
  assert.ok(out.some((f) => /out-landed/.test(f.statement)), 'a totals comparison');
  assert.ok(out.every((f) => f.family === 'round_stats'));
});

/* ---- the class budgets are internally coherent -------------------------- */

test('every story depth target overlaps its class budget', () => {
  /* Overlap, not containment, and the distinction is real rather than a
     loosened assertion. A class is the publication OBJECT and carries a hard
     floor and ceiling; a story-type target is the editorial AMBITION for that
     kind of piece, and the two are allowed to straddle. A main-event preview
     is briefed at 1200-1800 while deep_dive runs 1400-2200: a 1250-word main
     event is a real main-event preview that landed at the short end, and the
     reconciliation ladder will publish it as the class its length actually
     reached. Requiring containment would mean rewriting the editorial brief to
     suit the class table, which is the wrong way round. */
  for (const [type, d] of Object.entries(STORY_DEPTH)) {
    const b = CLASS_BUDGET[d.class];
    assert.ok(b, `${type} names an unknown class`);
    assert.ok(d.min <= b.max && d.max >= b.min, `${type} target ${d.min}-${d.max} does not overlap ${d.class} budget ${b.min}-${b.max}`);
  }
});
