/**
 * Quality gates. Every one of these rejects a specific way an article can be
 * wrong, and each exists because that failure is either already in production
 * or one careless change away.
 *
 * A gate returns a list of violations. An empty list is the only pass. Nothing
 * here warns: a warning is a violation somebody will ship.
 */

import { CLASS_BUDGET, INDEXED_FLOOR_WORDS, isIndexable } from './classes.mjs';
import { checkSlop, checkKeywordStuffing, checkDuplicateParagraphs, checkOpening } from './slop.mjs';
import { allowedNumbers } from './packet.mjs';
import { HEADLINE_MAX } from './compose.mjs';

/**
 * Numbers in the body must exist in the packet.
 *
 * This is the gate that makes "no unsupported numbers" real. Years, round
 * numbers and ordinals under 6 are exempt because they are prose furniture
 * ("round 3", "the last five"), and every one of those is itself derived from a
 * fact the composer already holds.
 */
export function gateNumbers(body, packet) {
  const allowed = allowedNumbers(packet);
  const violations = [];
  /* Drop link targets, then drop the FIRST cell of every table row: that cell
     is a row label ("Takedowns / 15 min"), and the 15 in it is a unit, not a
     claim about this fight. The value cells are still checked. */
  const stripped = String(body)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('|') ? line.replace(/^\s*\|[^|]*\|/, '| ') : line))
    .join('\n');
  for (const m of stripped.matchAll(/(?<![\w/#.])(\d+(?:\.\d+)?)(?![\w/])/g)) {
    const raw = m[1];
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n >= 1900 && n <= 2100) continue;      // years
    if (Number.isInteger(n) && n <= 5) continue; // rounds, "last five", list counts
    if (allowed.has(String(n))) continue;
    violations.push({ gate: 'unsupported_number', value: raw, context: stripped.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, ' ') });
  }
  return violations;
}

/** Prose may only assert what a fact says. Checked by fact coverage. */
export function gateFactCoverage(composed, packet, { minCoverage = 0.55 } = {}) {
  if (!packet.fact_count) return [{ gate: 'empty_packet', detail: 'no facts' }];
  const used = new Set(composed.used_fact_ids ?? []);
  const coverage = used.size / packet.fact_count;
  /* Low coverage means the body outran its evidence: the composer produced more
     prose than the facts it consumed can account for. */
  return coverage >= minCoverage ? [] : [{ gate: 'fact_coverage', detail: `body cites ${used.size} of ${packet.fact_count} facts (${(coverage * 100).toFixed(0)}%), below ${(minCoverage * 100).toFixed(0)}%` }];
}

export function gateDepth({ wordCount, publicationClass, storyDepth, editorialException = null }) {
  const v = [];
  const budget = CLASS_BUDGET[publicationClass];
  if (!budget) return [{ gate: 'unknown_class', detail: publicationClass }];
  if (wordCount < budget.min && !(publicationClass === 'wire')) {
    v.push({ gate: 'below_class_floor', detail: `${wordCount} words, ${publicationClass} floor is ${budget.min}` });
  }
  if (wordCount > budget.max) v.push({ gate: 'above_class_ceiling', detail: `${wordCount} words, ${publicationClass} ceiling is ${budget.max}` });
  if (budget.indexable) {
    const idx = isIndexable(publicationClass, wordCount, { editorialException });
    if (!idx.indexable) v.push({ gate: 'indexed_below_floor', detail: idx.reason });
  }
  if (storyDepth && wordCount < storyDepth.min && publicationClass !== 'wire') {
    v.push({ gate: 'below_story_target', detail: `${wordCount} words, this story type targets ${storyDepth.min}-${storyDepth.max}` });
  }
  return v;
}

export function gateProse(body, { entities = [] } = {}) {
  const v = [];
  const slop = checkSlop(body);
  for (const h of slop.hits) v.push({ gate: 'banned_phrase', detail: h.phrase });
  if (!slop.hedges.ok) v.push({ gate: 'hedging', detail: `${slop.hedges.count} hedges, ${slop.hedges.per100} per 100 words (limit ${slop.hedges.limit})` });

  const stuff = checkKeywordStuffing(body, { exempt: entities });
  for (const o of stuff.offenders) v.push({ gate: 'keyword_stuffing', detail: `"${o.word}" x${o.n} (${o.density}%)` });

  const dup = checkDuplicateParagraphs(body);
  for (const d of dup.dupes) v.push({ gate: 'duplicate_paragraph', detail: d.text });

  const open = checkOpening(body, { entities });
  if (!open.ok) v.push({ gate: 'weak_opening', detail: open.reason });

  /* A quotation mark pair around prose the packet does not hold is a fabricated
     quote. Source-item titles are the one legitimate quoted string. */
  return v;
}

export function gateQuotes(body, packet) {
  const allowed = packet.facts.filter((f) => f.family === 'source_item').map((f) => f.statement);
  const v = [];
  /* An inch mark closes a height (5'11") and is not a quotation. Requiring the
     opening mark to be a curly quote, or a straight quote not preceded by a
     digit, keeps the tale of the tape out of this gate. */
  for (const m of String(body).matchAll(/(?:“|(?<!\d)")([^”"]{25,})(?:”|")/g)) {
    const quoted = m[1].trim();
    const supported = allowed.some((s) => s.includes(quoted.slice(0, 30)));
    if (!supported) v.push({ gate: 'unsupported_quote', detail: quoted.slice(0, 70) });
  }
  return v;
}

export function gateHeadline(headline) {
  const v = [];
  const words = String(headline).trim().split(/\s+/).filter(Boolean).length;
  if (!headline) v.push({ gate: 'missing_headline' });
  if (headline.length > HEADLINE_MAX) v.push({ gate: 'headline_too_long', detail: `${headline.length} chars, max ${HEADLINE_MAX}` });
  if (words < 2) v.push({ gate: 'headline_too_short', detail: `${words} words` });
  if (words > 22) v.push({ gate: 'headline_too_many_words', detail: `${words} words, max 22` });
  if (/^\d+\s/.test(headline)) v.push({ gate: 'headline_leading_number' });
  return v;
}

/** Links must resolve to a real route pattern and never be invented. */
export const ROUTE_PATTERNS = [
  /^\/$/, /^\/fighters\/[a-z0-9-]+$/, /^\/events\/[a-z0-9-]+$/, /^\/fights\/[a-z0-9-]+$/,
  /^\/news\/[a-z0-9-]+$/, /^\/judges\/[a-z0-9-]+$/, /^\/referees\/[a-z0-9-]+$/,
  /^\/weigh-ins$/, /^\/injuries$/, /^\/model$/, /^\/rankings$/, /^\/events$/, /^\/fighters$/,
  /^\/learn\/fight-dna$/, /^\/about\/editorial$/, /^\/fight-week$/, /^\/tuf(\/[a-z0-9-]+)?$/,
];

export function gateLinks(body, { known = null, publicationClass = 'feature' } = {}) {
  const v = [];
  const internal = [...String(body).matchAll(/\[[^\]]*\]\((\/[^)]*)\)/g)].map((m) => m[1]);
  for (const href of internal) {
    if (!ROUTE_PATTERNS.some((re) => re.test(href))) v.push({ gate: 'bad_internal_link', detail: href });
    else if (known && !known.has(href)) v.push({ gate: 'unresolvable_internal_link', detail: href });
  }
  if (['feature', 'deep_dive'].includes(publicationClass)) {
    if (internal.length < 3) v.push({ gate: 'too_few_internal_links', detail: `${internal.length}, want 3-8` });
    if (internal.length > 8) v.push({ gate: 'too_many_internal_links', detail: `${internal.length}, want 3-8` });
  }
  return v;
}

/** No future data in a historical story. */
export function gateAsOf(packet) {
  if (!packet.as_of) return [];
  const v = [];
  for (const f of packet.facts) {
    if (f.as_of && String(f.as_of).slice(0, 10) > packet.as_of) {
      v.push({ gate: 'as_of_leak', detail: `${f.family} fact dated ${f.as_of} in a packet as of ${packet.as_of}` });
    }
  }
  return v;
}

/** A model claim requires a locked, published prediction. */
export function gateModelClaims(body, packet) {
  const hasModel = packet.facts.some((f) => f.family === 'model');
  if (hasModel) return [];
  const v = [];
  if (/\bPBE (Fight )?Model\b|\bmodel (gives|makes|has|rates|puts)\b|\bmodel probability\b/i.test(body)) {
    v.push({ gate: 'unavailable_model_claim', detail: 'body references a model number with no locked model fact in the packet' });
  }
  return v;
}

/** An odds claim requires a market observation, and staleness must be stated. */
export function gateMarketClaims(body, packet) {
  const market = packet.facts.filter((f) => f.family === 'market');
  const v = [];
  if (!market.length && /\b(favourite|favorite|underdog|the books|odds|priced at|implied probability)\b/i.test(body)) {
    v.push({ gate: 'unavailable_odds_claim', detail: 'body references the market with no market fact in the packet' });
  }
  const stale = market.find((f) => /stale/.test(f.statement));
  if (stale && !/stale/i.test(body)) {
    v.push({ gate: 'stale_odds_as_current', detail: 'packet market reading is stale and the body does not say so' });
  }
  return v;
}

/** Dates: published_at is immutable; updated only on a material change. */
export function gateDates({ publishedAt, previousPublishedAt = null, updatedAt = null, materialChange = false }) {
  const v = [];
  if (!publishedAt) v.push({ gate: 'missing_publication_timestamp' });
  if (previousPublishedAt && publishedAt && publishedAt !== previousPublishedAt) {
    v.push({ gate: 'artificial_date_freshening', detail: `published_at moved ${previousPublishedAt} -> ${publishedAt}` });
  }
  if (updatedAt && !materialChange) v.push({ gate: 'fake_update_timestamp', detail: 'dateModified set without a material change' });
  return v;
}

/** NewsArticle JSON-LD completeness. */
export const REQUIRED_SCHEMA_FIELDS = [
  '@id', 'headline', 'description', 'image', 'datePublished', 'dateModified',
  'author', 'publisher', 'mainEntityOfPage', 'articleSection', 'wordCount', 'isAccessibleForFree',
];

export function gateSchema(ld) {
  const v = [];
  if (!ld || ld['@type'] !== 'NewsArticle') return [{ gate: 'schema_not_newsarticle' }];
  for (const f of REQUIRED_SCHEMA_FIELDS) {
    if (ld[f] === undefined || ld[f] === null || ld[f] === '') v.push({ gate: 'missing_schema_field', detail: f });
  }
  if (ld.headline && String(ld.headline).length > HEADLINE_MAX) v.push({ gate: 'schema_headline_too_long', detail: String(ld.headline).length });
  if (ld.author && !ld.author.url) v.push({ gate: 'missing_author_url' });
  if (ld.publisher && !ld.publisher.logo) v.push({ gate: 'missing_publisher_logo' });
  return v;
}

/** A wire item may never enter the Google News sitemap. */
export function gateNewsSitemap(entries) {
  return entries
    .filter((e) => e.publication_class === 'wire' || e.indexable === false)
    .map((e) => ({ gate: 'wire_in_news_sitemap', detail: e.slug }));
}

/** Run everything that applies to a composed article. */
export function runAllGates({ composed, packet, headline, dek, publicationClass, storyDepth, entities, knownRoutes = null, schema = null, dates = null, editorialException = null }) {
  const v = [];
  v.push(...gateDepth({ wordCount: composed.word_count, publicationClass, storyDepth, editorialException }));
  if (publicationClass !== 'wire') {
    v.push(...gateProse(composed.body_md, { entities }));
    v.push(...gateLinks(composed.body_md, { known: knownRoutes, publicationClass }));
    v.push(...gateFactCoverage(composed, packet));
  }
  v.push(...gateNumbers(composed.body_md, packet));
  v.push(...gateQuotes(composed.body_md, packet));
  v.push(...gateHeadline(headline));
  v.push(...gateAsOf(packet));
  v.push(...gateModelClaims(composed.body_md, packet));
  v.push(...gateMarketClaims(composed.body_md, packet));
  if (schema) v.push(...gateSchema(schema));
  if (dates) v.push(...gateDates(dates));
  if (!dek || dek.length < 60) v.push({ gate: 'weak_dek', detail: `${(dek || '').length} chars` });
  return v;
}
