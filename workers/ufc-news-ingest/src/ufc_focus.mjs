/* Is this item about the UFC, and is it news at all?
 *
 * Cheap, deterministic filters that run before anything expensive. They exist
 * because the wire is already contaminated: sitting in ufc_news_items right now
 * are "Title Fight Preview | Ryan Garcia vs Conor Benn" (boxing), a RIZIN/PFL
 * co-promotion story and a Bobby Green human-interest piece. A relevance model
 * would catch those too and would charge us for the privilege on every one.
 *
 * THE ASYMMETRY THAT SHAPES THIS FILE
 *
 * Two mistakes are available and they are not equally bad.
 *
 *   Wrongly rejecting a real UFC story costs us that story. It never publishes
 *   and nobody finds out, which is the failure this project exists to fix.
 *
 *   Wrongly accepting a boxing story costs one relevance call downstream, and
 *   it is then rejected by a stage that reads the article body.
 *
 * So rejection must be POSITIVELY EVIDENCED, never inferred from the absence of
 * the word "UFC". Most real UFC headlines never say it: "Makhachev defends in
 * December", "Pereira out of the main event".
 *
 * WHY A KEYWORD LIST IS NOT ENOUGH, AND WHAT REPLACES IT
 *
 * The first version of this file rejected on promotion keywords alone, and it
 * let "Title Fight Preview | Ryan Garcia vs Conor Benn" straight through -
 * because that headline contains no boxing word at all. Two boxers, a generic
 * noun phrase, nothing to match. Catching it with a list of boxer names would
 * mean maintaining a roster of every athlete in every sport we are not, and
 * being wrong the week a new one gets famous.
 *
 * We already own the correct signal: 3,184 rows of ufc_fighters and an alias
 * resolver that reads them. "Does this headline name anyone who has ever fought
 * in the UFC?" is answerable from our own data, costs one in-memory lookup, and
 * improves by itself every time the fighter table grows.
 *
 * WHY THAT RULE IS NARROWED TO MATCHUP HEADLINES
 *
 * The obvious form - "names no UFC fighter, so reject" - is wrong, and the
 * reason is a detail of findFighterMentions: it only matches MULTI-TOKEN names,
 * because single-token nicknames tag far too loosely. So "Pereira out of the
 * main event" resolves ZERO fighters despite being a perfectly ordinary UFC
 * headline, and surname-only headlines are extremely common. Rejecting on a
 * zero count would have quietly binned a large share of real news.
 *
 * Rescuing those with a surname list does not work either, and the same example
 * shows why: the UFC roster contains a Garcia (Rafa Garcia), so "Ryan Garcia"
 * would be rescued by exactly the mechanism meant to catch it.
 *
 * What actually separates the two cases is that the boxing headline is a
 * MATCHUP - "A vs B" - naming two full names, neither of which is ours. A
 * matchup headline is the one shape where a zero count is informative, because
 * "X vs Y" always carries both fighters' names in full. So the entity rule
 * fires only there. It is narrow on purpose: it covers the contamination we
 * have actually observed and declines to guess anywhere else.
 */

/* Rival promotions and other combat sports. Naming one is evidence, not proof:
 * "Makhachev reacts to Ryan Garcia" is a UFC story about a boxer. */
const FOREIGN_PROMOTION = [
  ['boxing', /\b(boxing|boxer|wba|wbc|wbo|ibf|ring magazine|queensberry|matchroom|top rank|golden boy)\b/i],
  ['pfl', /\b(pfl|professional fighters league|smart cage)\b/i],
  ['rizin', /\b(rizin|deep jewels)\b/i],
  ['one', /\b(one championship|one fc|one friday fights)\b/i],
  ['bellator', /\b(bellator)\b/i],
  ['regional', /\b(ksw|oktagon|cage warriors|\blfa\b|legacy fighting alliance|brave cf|ares fc)\b/i],
  ['bkfc', /\b(bkfc|bare ?knuckle|power slap|slap fighting)\b/i],
  ['grappling', /\b(adcc|ibjjf|polaris|submission underground|\bsug\b)\b/i],
  ['wrestling', /\b(wwe|aew|pro wrestling|ncaa wrestling)\b/i],
  ['kickboxing', /\b(glory kickboxing|\bk-?1\b|lumpinee|rajadamnern)\b/i],
];

/* Anchors that keep an item ours even when a rival promotion is named, and
 * that rescue a story about someone our tables have never heard of. */
const UFC_ANCHOR = /\b(ufc\s?\d{2,4}|ufc fight night|noche ufc|the ultimate fighter|dana white|dwcs|contender series|ufc apex|octagon|ufc rankings|ufc champion|ufc title|ufc debut|ufc contract|signs with the ufc|ufc\.com|\bufc\b)/i;

/* Not news. Deliberately short: this is the obvious-junk door, and the
 * relevance model is the real editor. Patterns are added only after something
 * has actually appeared in the wire. */
const NOT_NEWS = [
  ['promo', /\b(tickets on sale|merch|merchandise|shop now|sweepstakes|giveaway|betting promo|bonus code|sportsbook promo|odds boost|free bet)\b/i],
  ['podcast', /\b(podcast|full episode|ep\.?\s?\d+|watch the full|live stream replay|press conference replay)\b/i],
  ['listicle', /\b(top \d+ (?:moments|finishes|knockouts|photos|fights)|photo gallery|best of \d{4}|on this day|throwback)\b/i],
  ['lifestyle', /\b(net worth|girlfriend|house tour|car collection|responds to troll|fires back at fan)\b/i],
];

/* Taxonomy labels substantive enough to keep an item alive on their own. A
 * withdrawal or a weight miss is UFC-shaped news even from a feed that also
 * covers other promotions; 'other' and 'result' are not - 'result' matches
 * every boxing recap ever written. */
const SUBSTANTIVE_LABELS = new Set(['withdrawal', 'replacement', 'weight_miss', 'bout_moved', 'injury', 'suspension', 'rankings', 'contract']);

/* "A vs B" / "A vs. B" / "A versus B". The one headline shape that reliably
 * carries both fighters' names in full, and therefore the only shape where
 * "we resolved nobody" means something. */
const MATCHUP = /\bvs\.?\b|\bversus\b/i;

/**
 * @param {string} title
 * @param {string} summary
 * @param {object} evidence
 * @param {number|null} evidence.ufcFighterCount  fighters resolved against ufc_fighters.
 *   null means "not looked up" and disables the entity rule entirely, so a
 *   caller without the index degrades to keyword-only rather than rejecting
 *   everything.
 * @param {string[]} evidence.taxonomyLabels
 */
export function classifyFocus(title, summary = '', { ufcFighterCount = null, taxonomyLabels = [] } = {}) {
  const text = `${title || ''} ${summary || ''}`.trim();
  if (text.length < 12) {
    return { ok: false, verdict: 'not_news', reason: 'text_too_short', foreign: [], anchored: false, ufc_fighters: ufcFighterCount };
  }

  const anchored = UFC_ANCHOR.test(text);
  const foreign = FOREIGN_PROMOTION.filter(([, re]) => re.test(text)).map(([name]) => name);
  const substantive = (taxonomyLabels || []).some((l) => SUBSTANTIVE_LABELS.has(l));
  const base = { foreign, anchored, ufc_fighters: ufcFighterCount };

  /* 1. A rival promotion named with no UFC anchor: not our sport. */
  if (foreign.length && !anchored) {
    return { ok: false, verdict: 'foreign_sport', reason: `names ${foreign.join(', ')} with no UFC anchor`, ...base };
  }

  /* 2. Obvious non-news. */
  for (const [kind, re] of NOT_NEWS) {
    if (re.test(text)) return { ok: false, verdict: 'not_news', reason: `${kind}_pattern`, ...base };
  }

  /* 3. A matchup between two people we have never recorded, with no anchor and
   *    no substantive label. This is the rule that catches two boxers in a
   *    headline containing no boxing word. FOUR clauses, all required: the
   *    matchup shape is what makes a zero fighter count meaningful at all, and
   *    without it this rule would reject every surname-only headline. */
  const isMatchup = MATCHUP.test(String(title || ''));
  if (isMatchup && ufcFighterCount === 0 && !anchored && !substantive) {
    return { ok: false, verdict: 'no_ufc_link', reason: 'matchup headline naming no known UFC fighter, with no UFC anchor and no substantive label', ...base, matchup: true };
  }

  return { ok: true, verdict: 'ufc', reason: null, ...base };
}

/**
 * The state a newly ingested item takes.
 *
 * Everything is stored - the wire shows raw items, and an operator inspecting a
 * bad rejection needs the row to exist. What differs is whether the item can
 * ever become a candidate. 'new' is eligible for scoring; 'skipped' is terminal
 * until a human or a backlog pass moves it, and no model is ever called on it.
 *
 * 'no_ufc_link' in particular is reversible by design: it can be revisited by a
 * relink pass once the fighter table has grown, which is why the reason is
 * recorded in full rather than collapsed to "skipped".
 */
export function initialState(focus) {
  if (focus.ok) return { state: 'new', state_reason: null };
  return { state: 'skipped', state_reason: `${focus.verdict}: ${focus.reason}` };
}
