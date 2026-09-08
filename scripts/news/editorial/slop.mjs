/**
 * The banned-phrase test.
 *
 * Every phrase below shares one property: it can be written without knowing
 * anything about the fight. That is the definition being enforced. "Both men
 * will look to impose their game" fits any two fighters who have ever been
 * booked, which is exactly why it reads as filler and exactly why a model
 * reaches for it when the packet is thin.
 *
 * So this is not a style preference. It is a thin-packet detector that happens
 * to be implemented as a word list: prose that leans on these is prose that ran
 * out of facts, and the correct response is to drop a class, not to rephrase.
 */

/** Phrases that are banned outright. Matched case-insensitively, whole-phrase. */
export const BANNED_PHRASES = [
  'in the world of mma',
  'in the world of mixed martial arts',
  'as fight fans eagerly await',
  'fight fans eagerly await',
  'this highly anticipated matchup',
  'highly anticipated clash',
  'only time will tell',
  'will look to impose their game',
  'will look to impose his game',
  'will look to impose her game',
  'impose his will',
  'when the octagon door closes',
  'when the cage door closes',
  'leave it all in the octagon',
  'all eyes will be on',
  'needs no introduction',
  'it goes without saying',
  'one thing is certain',
  'the stakes could not be higher',
  'the stakes have never been higher',
  'a true test of',
  'looking to bounce back',
  'looking to get back in the win column',
  'a lot on the line',
  'fireworks are expected',
  'expect fireworks',
  'buckle up',
  'make no mistake',
  'at the end of the day',
  'in conclusion',
  'this article will explore',
  'let us dive in',
  'let’s dive in',
  'lets dive in',
  'in today’s fast-paced world',
  'is a testament to',
  'stands as a testament',
  'rich tapestry',
  'delve into',
  'it is important to note that',
  'it should be noted that',
  'without a doubt',
  'time will tell',
  'the sky is the limit',
  'on paper',
  'styles make fights',
];

/**
 * Hedges that are fine once and corrosive in bulk. A sentence may be uncertain;
 * an article that is uncertain in every sentence has not said anything.
 */
export const HEDGE_WORDS = ['arguably', 'perhaps', 'possibly', 'seemingly', 'reportedly', 'apparently', 'likely', 'presumably'];
export const HEDGE_LIMIT_PER_100_WORDS = 1.2;

const normalise = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

/**
 * @returns {{ok: boolean, hits: {phrase: string, index: number}[], hedges: {count: number, per100: number, limit: number, ok: boolean}}}
 */
export function checkSlop(text) {
  const body = normalise(text);
  const hits = [];
  for (const phrase of BANNED_PHRASES) {
    let from = 0;
    for (;;) {
      const i = body.indexOf(phrase, from);
      if (i < 0) break;
      hits.push({ phrase, index: i });
      from = i + phrase.length;
    }
  }

  const words = body.split(/\s+/).filter(Boolean);
  let hedgeCount = 0;
  for (const w of words) if (HEDGE_WORDS.includes(w.replace(/[^a-z']/g, ''))) hedgeCount += 1;
  const per100 = words.length ? (hedgeCount * 100) / words.length : 0;
  const hedges = { count: hedgeCount, per100: Number(per100.toFixed(2)), limit: HEDGE_LIMIT_PER_100_WORDS, ok: per100 <= HEDGE_LIMIT_PER_100_WORDS };

  return { ok: hits.length === 0 && hedges.ok, hits, hedges };
}

/**
 * Keyword stuffing: the same content term repeated far past what prose needs.
 * Names are excluded because an article about two fighters says their names a
 * lot and should.
 */
/**
 * The nouns of the sport. Repeating these is what writing about fighting looks
 * like; penalising them would push the prose toward thesaurus-driven
 * euphemism, which reads worse than the repetition it avoids.
 */
export const DOMAIN_TERMS = new Set([
  'fight', 'fights', 'fighter', 'fighters', 'round', 'rounds', 'strike', 'strikes',
  'striking', 'minute', 'minutes', 'bout', 'bouts', 'card', 'takedown', 'takedowns',
  'control', 'weight', 'title', 'win', 'wins', 'loss', 'losses', 'record', 'records',
  'significant', 'distance', 'archive', 'sample', 'coverage', 'profile', 'profiles',
  'market', 'books', 'price', 'event', 'division', 'octagon', 'decision', 'finish',
]);

export function checkKeywordStuffing(text, { exempt = [] } = {}) {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'was', 'are', 'were', 'has', 'have', 'had', 'that', 'this', 'it', 'its', 'his', 'her', 'he', 'she', 'they', 'their', 'not', 'no', 'by', 'from', 'as', 'be', 'been', 'than', 'then', 'over', 'under', 'into', 'out', 'up', 'down', 'one', 'two', 'three', 'first', 'second', 'third', 'more', 'most', 'both', 'each', 'who', 'which', 'what', 'when', 'where', 'how', 'if', 'so', 'all', 'any', 'per', 'about', 'after', 'before', 'between']);
  const exemptSet = new Set(exempt.flatMap((n) => String(n).toLowerCase().split(/\s+/)));
  const words = normalise(text).replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
  const counts = new Map();
  for (const w of words) {
    if (w.length < 4 || stop.has(w) || exemptSet.has(w) || DOMAIN_TERMS.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const total = words.length || 1;
  const offenders = [...counts.entries()]
    .map(([word, n]) => ({ word, n, density: Number(((n * 100) / total).toFixed(2)) }))
    .filter((x) => x.n >= 6 && x.density >= 1.6)
    .sort((a, b) => b.density - a.density);
  return { ok: offenders.length === 0, offenders };
}

/** Two paragraphs that say the same thing is padding wearing a paragraph break. */
export function checkDuplicateParagraphs(markdown) {
  const paras = String(markdown || '').split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('>'));
  const seen = new Map();
  const dupes = [];
  for (const p of paras) {
    const key = normalise(p).replace(/[^a-z0-9 ]/g, '').split(' ').filter((w) => w.length > 3).slice(0, 24).join(' ');
    if (!key) continue;
    if (seen.has(key)) dupes.push({ text: p.slice(0, 90) });
    else seen.set(key, true);
  }
  return { ok: dupes.length === 0, dupes };
}

/**
 * Openers that establish nothing. Checked against the first sentence only,
 * because that is where throat-clearing lives.
 */
export function checkOpening(text, { entities = [] } = {}) {
  const first120 = String(text || '').replace(/^#.*$/gm, '').trim().split(/\s+/).slice(0, 120).join(' ');
  const lower = normalise(first120);
  const named = entities.filter((e) => e && lower.includes(String(e).toLowerCase().split(/\s+/)[0]));
  return {
    ok: named.length > 0,
    entities_named: named,
    first_120_words: first120,
    reason: named.length ? null : 'no primary entity appears in the first 120 words',
  };
}
