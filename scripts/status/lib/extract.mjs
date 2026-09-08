/* Deterministic extraction of fighter status events from news text.
 *
 * Rules, not scores; a closed vocabulary, not a model. Every field this
 * produces can be traced to a matched span, and the spans travel with the row
 * in `provenance` so a false positive can be argued about six months later
 * without re-fetching a page that may have changed.
 *
 * THE ONE RULE THAT OUTRANKS COVERAGE
 *
 *   "Out with an injury" yields status_type='injury' and injury_type NULL.
 *
 * Not 'unspecified'. Not inherited from this fighter's last injury. Not
 * inferred from "limped away" or "grabbed his knee". The clinical fields are
 * filled ONLY by INJURY_TERMS matching literal words in the text, and every
 * one of them carries `clinical_quote` — the sentence that licensed it. The
 * migration enforces the same rule as a CHECK constraint, so the unsourced
 * version cannot be stored even if something here goes wrong. A wrong body
 * part attached to a named athlete is a fabricated medical claim about a real
 * person; an empty column is a gap. Those are not the same size of mistake.
 *
 * WHY IT IS SEPARATE FROM THE TAXONOMY. ufc_news_items.taxonomy answers "is
 * this article about an injury?" — a good question for ranking a wire feed and
 * the wrong one for a status row. Its `injury` rule matches "illness",
 * "medical" and "staph" in one bucket; it fires on a retrospective ("returned
 * from the injury that cost him 2024"); and it has no notion of who is out or
 * of what. Taxonomy is used here as a CHEAP PREFILTER — it decides which items
 * are worth reading — and then these rules decide what, if anything, is true.
 */

/* ------------------------------------------------------------------ types */

/** Status types, mirroring the CHECK constraint in the migration. */
export const STATUS_TYPES = [
  'injury', 'illness', 'withdrawal', 'replacement', 'suspension',
  'visa_travel', 'weight_miss', 'return', 'cleared', 'other',
];

/* Cheap prefilter: which taxonomy labels are worth reading at all. An item
 * with none of these is not opened. */
export const CANDIDATE_LABELS = new Set(['withdrawal', 'replacement', 'injury', 'suspension', 'weight_miss', 'bout_moved']);

/* ------------------------------------------------------------- vocabulary */

/**
 * Status rules. Order matters: the first match in this list wins, and the
 * list is ordered by how specific the claim is, not by how common it is.
 *
 * `requiresSubject` marks rules whose sentence must name a fighter for the
 * event to mean anything: "steps in on short notice" with nobody named is a
 * headline about a card, not a status change for a person.
 */
export const STATUS_RULES = [
  /* Withdrawal is first because a withdrawal caused by an injury is, for
   * availability purposes, a withdrawal. The injury rule below still runs and
   * contributes the clinical detail; see extractStatus. */
  {
    type: 'withdrawal',
    base: 0.72,
    requiresSubject: true,
    patterns: [
      /\b(?:has\s+)?(?:withdrawn|withdraws|withdraw|withdrew)\s+from\b/i,
      /\b(?:pulls?|pulled|pulling)\s+out\s+of\b/i,
      /\bout\s+of\s+(?:ufc\b|the\s+(?:card|fight|bout|event)|his\s+(?:fight|bout)|her\s+(?:fight|bout)|their\s+(?:fight|bout))/i,
      /\b(?:is\s+)?off\s+the\s+card\b/i,
      /\bremoved\s+from\s+(?:the\s+)?(?:card|bout|fight)\b/i,
      /\bforced\s+out\s+of\b/i,
      /\bno\s+longer\s+(?:fighting|facing|competing|on)\b/i,
    ],
  },
  {
    type: 'replacement',
    base: 0.72,
    requiresSubject: true,
    patterns: [
      /\b(?:steps?|stepped|stepping)\s+in\s+(?:for|against|on)\b/i,
      /\b(?:replaces?|replaced|replacing)\b/i,
      /\bfills?\s+in\s+for\b/i,
      /\bnew\s+opponent\b/i,
      /\b(?:now|will)\s+fac(?:es?|ing)\b/i,
      /\bon\s+(?:short|late)\s+notice\b/i,
      /\bshort[-\s]notice\s+(?:replacement|opponent|bout)\b/i,
    ],
  },
  {
    type: 'weight_miss',
    base: 0.8,
    requiresSubject: true,
    patterns: [
      /\bmiss(?:es|ed)\s+weight\b/i,
      /\bweight\s+miss\b/i,
      /\bfail(?:s|ed)\s+to\s+make\s+weight\b/i,
      /\bcame\s+in\s+(?:\d+(?:\.\d+)?\s+)?(?:pounds?|lbs?)\s+over\b/i,
      /\b(?:\d+(?:\.\d+)?)\s+(?:pounds?|lbs?)\s+over\s+the\s+(?:limit|championship\s+limit)\b/i,
      /\bwill\s+be\s+a\s+catchweight\b/i,
    ],
  },
  {
    type: 'suspension',
    base: 0.75,
    requiresSubject: true,
    patterns: [
      /\b(?:is\s+)?suspended\b/i,
      /\bsuspension\b/i,
      /\b(?:has\s+been\s+)?flagged\s+(?:by|for)\b/i,
      /\banti-?doping\s+(?:violation|policy\s+violation)\b/i,
      /\b(?:usada|cscs|nsac|vada)\b.{0,40}\b(?:violation|flag|test|sanction)\b/i,
      /\b(?:provisionally\s+suspended|serving\s+a\s+ban)\b/i,
      /\bmedical\s+suspension\b/i,
    ],
  },
  {
    type: 'visa_travel',
    base: 0.8,
    requiresSubject: true,
    patterns: [
      /\bvisa\s+(?:issues?|problems?|denial|denied|refused|rejection|troubles?|delay)\b/i,
      /\b(?:denied|refused)\s+a\s+visa\b/i,
      /\bunable\s+to\s+(?:travel|enter)\b/i,
      /\btravel\s+(?:ban|restrictions?|issues?)\b/i,
      /\b(?:passport|immigration)\s+(?:issues?|problems?|delay)\b/i,
    ],
  },
  {
    type: 'illness',
    base: 0.7,
    requiresSubject: true,
    patterns: [
      /\b(?:is\s+)?ill\b/i,
      /\billness\b/i,
      /\bfell\s+ill\b/i,
      /\b(?:has|had|with)\s+(?:the\s+)?(?:flu|covid(?:-19)?|pneumonia|staph\s+infection|infection)\b/i,
      /\bhospitali[sz]ed\b/i,
    ],
  },
  {
    type: 'injury',
    base: 0.7,
    requiresSubject: true,
    patterns: [
      /\binjur(?:y|ed|ies)\b/i,
      /\bunderwent\s+surgery\b/i,
      /\b(?:has|had)\s+surgery\b/i,
      /\btor(?:e|n)\s+(?:his|her|their|an?\s+)?\w+/i,
      /\bbroke(?:n)?\s+(?:his|her|their|an?\s+)?\w+/i,
      /\bfractured?\b/i,
      /\bconcussion\b/i,
    ],
  },
  {
    type: 'cleared',
    base: 0.75,
    requiresSubject: true,
    patterns: [
      /\b(?:medically\s+)?cleared\s+(?:to\s+(?:fight|compete|return)|by)\b/i,
      /\bcleared\s+of\b/i,
      /\bsuspension\s+(?:lifted|overturned|reduced\s+to\s+time\s+served)\b/i,
      /\bexonerated\b/i,
    ],
  },
  {
    type: 'return',
    base: 0.65,
    requiresSubject: true,
    patterns: [
      /\b(?:returns?|returning)\s+(?:to\s+(?:action|competition|the\s+octagon)|at\s+ufc\b|from\s+(?:injury|a\s+\w+\s+injury|surgery|suspension))/i,
      /\bmakes?\s+(?:his|her|their)\s+return\b/i,
      /\bback\s+in\s+action\s+(?:at|against)\b/i,
      /\bcomeback\s+(?:fight|bout)\b/i,
    ],
  },
];

/**
 * The closed clinical vocabulary. NOTHING outside this list can ever populate
 * injury_type, and every entry requires its own literal words in the text.
 *
 * This is deliberately small and deliberately literal. Enlarging it is safe;
 * making any entry fuzzy is not, because the cost of a wrong entry is a
 * fabricated medical claim about a named person.
 */
export const INJURY_TERMS = [
  { re: /\btorn\s+acl\b|\bacl\s+tear\b/i, injury_type: 'torn acl', body_part: 'knee' },
  { re: /\btorn\s+mcl\b|\bmcl\s+tear\b/i, injury_type: 'torn mcl', body_part: 'knee' },
  { re: /\btorn\s+meniscus\b/i, injury_type: 'torn meniscus', body_part: 'knee' },
  { re: /\btorn\s+(?:bicep|biceps)\b/i, injury_type: 'torn bicep', body_part: 'arm' },
  { re: /\btorn\s+(?:pec|pectoral)\b/i, injury_type: 'torn pectoral', body_part: 'chest' },
  { re: /\btorn\s+(?:rotator\s+cuff)\b/i, injury_type: 'torn rotator cuff', body_part: 'shoulder' },
  { re: /\btorn\s+(?:hamstring)\b/i, injury_type: 'torn hamstring', body_part: 'leg' },
  { re: /\bruptured\s+achilles\b|\bachilles\s+(?:tear|rupture)\b/i, injury_type: 'ruptured achilles', body_part: 'achilles' },
  { re: /\bbroken\s+hand\b|\bhand\s+fracture\b/i, injury_type: 'broken hand', body_part: 'hand' },
  { re: /\bbroken\s+foot\b|\bfoot\s+fracture\b/i, injury_type: 'broken foot', body_part: 'foot' },
  { re: /\bbroken\s+(?:jaw|orbital)\b/i, injury_type: 'facial fracture', body_part: 'face' },
  { re: /\bbroken\s+(?:rib|ribs)\b|\brib\s+fracture\b/i, injury_type: 'broken ribs', body_part: 'ribs' },
  { re: /\bbroken\s+(?:nose)\b/i, injury_type: 'broken nose', body_part: 'nose' },
  { re: /\bbroken\s+(?:leg|tibia|fibula)\b/i, injury_type: 'broken leg', body_part: 'leg' },
  { re: /\bconcussion\b/i, injury_type: 'concussion', body_part: 'head' },
  { re: /\bstaph\s+infection\b/i, injury_type: 'staph infection', body_part: null },
  { re: /\bdetached\s+retina\b/i, injury_type: 'detached retina', body_part: 'eye' },
  { re: /\bherniated\s+disc\b/i, injury_type: 'herniated disc', body_part: 'back' },
];

/** Body parts named without a specific diagnosis: "a knee injury". */
export const BODY_PART_TERMS = [
  { re: /\b(?:knee)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'knee' },
  { re: /\b(?:hand)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'hand' },
  { re: /\b(?:foot)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'foot' },
  { re: /\b(?:back)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'back' },
  { re: /\b(?:shoulder)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'shoulder' },
  { re: /\b(?:elbow)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'elbow' },
  { re: /\b(?:ankle)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'ankle' },
  { re: /\b(?:rib|ribs)\s+(?:injury|issue|problem)\b/i, body_part: 'ribs' },
  { re: /\b(?:eye)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'eye' },
  { re: /\b(?:neck)\s+(?:injury|issue|problem|surgery)\b/i, body_part: 'neck' },
  { re: /\b(?:leg)\s+(?:injury|issue|problem)\b/i, body_part: 'leg' },
  { re: /\b(?:facial|face)\s+(?:injury|laceration|cut)\b/i, body_part: 'face' },
];

/**
 * Phrases that mean this text is NOT a present-tense status change, however
 * many status words it contains.
 *
 * This is where most false positives live. Wire copy is full of injuries that
 * are being remembered, previewed or speculated about — "returns from the knee
 * injury that cost him 2024" is a fighter who is BACK, and filing it as an
 * injury would take an available athlete off the card on our site.
 */
export const NEGATORS = [
  { re: /\breturns?\s+from\s+(?:a\s+|the\s+)?[\w\s]{0,24}\binjury\b/i, why: 'retrospective: returning from a past injury' },
  { re: /\brecovered\s+from\b/i, why: 'retrospective: recovery already happened' },
  { re: /\brecovering\s+from\s+(?:a\s+|the\s+)?[\w\s]{0,24}\b(?:injury|surgery)\b.{0,40}\breturns?\b/i, why: 'retrospective framing around a return' },
  { re: /\bavoided\s+(?:injury|a\s+\w+\s+injury)\b/i, why: 'explicitly did not happen' },
  { re: /\b(?:no|not)\s+(?:injury|injured)\b/i, why: 'explicitly negated' },
  { re: /\bdenies?\s+(?:injury|reports)\b/i, why: 'subject denies the claim' },
  { re: /\brumou?rs?\b|\breportedly\s+could\b|\bmay\s+be\s+forced\b|\bcould\s+be\s+forced\b/i, why: 'speculative' },
  /* "If X withdraws, who replaces her?" — the subject is named, the rules
   * fire, and none of it has happened. Allow a name between "if" and the verb
   * rather than only a pronoun, or the conditional reads as an event. */
  { re: /\bif\s+[\w\s.'’-]{0,40}?\b(?:withdraws?|withdrew|pulls?\s+out|is\s+forced\s+out|misses?\s+weight)\b/i, why: 'conditional' },
  /* A headline that ASKS is not a headline that reports. */
  { re: /^[^.]{0,120}\?\s*$/i, why: 'interrogative headline: a question, not a report' },
  { re: /\blast\s+year['’]?s\b|\bin\s+20[0-2]\d\b.{0,30}\binjury\b/i, why: 'historical reference' },
  { re: /\binjury\s+history\b|\binjury[-\s]prone\b/i, why: 'characterisation, not an event' },
  { re: /\bwould\s+have\s+(?:withdrawn|pulled\s+out)\b/i, why: 'counterfactual' },
  /* "Rakhmonov on fighting Garry injured" — a fight that already happened,
   * described by someone else. Found in our own archive producing injury rows
   * for four fighters, none of whom were unavailable. */
  { re: /\b(?:on\s+)?fighting\s+[\w\s.'’-]{0,30}\binjured\b/i, why: 'retrospective: describes a completed fight' },
  { re: /\bfought\s+(?:through|with)\s+(?:an?\s+)?injur/i, why: 'retrospective: fought through it' },
  { re: /\bfantasy\b|\bpicks?\s+and\s+predictions?\b|\bbetting\s+preview\b/i, why: 'preview/prediction copy' },
];

/* ---------------------------------------------------------------- helpers */

const clamp01 = (n) => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

/** Split into sentences, keeping it dumb and predictable. */
export function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z(“"])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The first sentence containing any of `res`, or null. */
function sentenceWith(text, res) {
  for (const s of sentences(text)) {
    for (const re of res) if (re.test(s)) return s;
  }
  return null;
}

/**
 * Clinical detail, or nulls. This function is the whole diagnosis rule.
 *
 * A specific injury term wins over a bare body part; a bare body part wins
 * over nothing; and nothing is the answer whenever the text only says that an
 * injury exists. `quote` is mandatory alongside any value — it is what the
 * database constraint will demand.
 */
/** The surname a headline is most likely to use. */
export function surnameOf(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Restrict text to the sentences that are ABOUT this fighter.
 *
 * Without this, clinical extraction reads the whole item and attaches whatever
 * injury it finds to whoever the rule picked. In a real item from our own
 * archive — "Shevchenko injured; Silva-Wang set for UFC 332" — the summary
 * names one fighter's condition and three other fighters, and a whole-text
 * read would attribute the injury to the wrong athlete. A diagnosis may only
 * come from a sentence that names the person it is about.
 */
export function sentencesAbout(text, subjectName) {
  const surname = surnameOf(subjectName);
  if (!surname) return [];
  const re = new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return sentences(text).filter((s) => re.test(s));
}

export function extractClinical(text) {
  const t = String(text || '');

  for (const term of INJURY_TERMS) {
    const m = t.match(term.re);
    if (!m) continue;
    const quote = sentenceWith(t, [term.re]) || m[0];
    return {
      injury_type: term.injury_type,
      body_part: term.body_part,
      injury_side: sideNear(t, m.index ?? 0),
      clinical_quote: quote.slice(0, 400),
    };
  }

  for (const term of BODY_PART_TERMS) {
    const m = t.match(term.re);
    if (!m) continue;
    const quote = sentenceWith(t, [term.re]) || m[0];
    return {
      /* A named body part is NOT a named injury. "A knee injury" tells us
       * where, never what, and injury_type stays null. */
      injury_type: null,
      body_part: term.body_part,
      injury_side: sideNear(t, m.index ?? 0),
      clinical_quote: quote.slice(0, 400),
    };
  }

  return { injury_type: null, body_part: null, injury_side: null, clinical_quote: null };
}

/** 'left'/'right' only when the word sits right beside the injury phrase. */
function sideNear(text, index) {
  const window = text.slice(Math.max(0, index - 24), index + 24);
  if (/\bleft\b/i.test(window)) return 'left';
  if (/\bright\b/i.test(window)) return 'right';
  return null;
}

/** Any negator that applies, or null. */
export function negatorFor(text) {
  for (const n of NEGATORS) if (n.re.test(String(text || ''))) return n;
  return null;
}

/**
 * The status type and the spans that decided it.
 *
 * Title matches count for more than summary matches for the same reason the
 * taxonomy does it: a title is the claim the publisher is willing to make.
 */
export function classifyStatus(title, summary) {
  const t = String(title || '');
  const s = String(summary || '');
  const hits = [];

  for (const rule of STATUS_RULES) {
    const inTitle = rule.patterns.filter((re) => re.test(t));
    const inSummary = rule.patterns.filter((re) => re.test(s));
    if (!inTitle.length && !inSummary.length) continue;
    const matched = [...inTitle, ...inSummary].map((re) => (t.match(re) || s.match(re) || [''])[0]).filter(Boolean);
    hits.push({
      type: rule.type,
      where: inTitle.length ? 'title' : 'summary',
      confidence: clamp01(rule.base + (inTitle.length ? 0.12 : -0.15) + 0.03 * Math.min(2, matched.length - 1)),
      matched: [...new Set(matched.map((m) => m.toLowerCase()))],
      requiresSubject: rule.requiresSubject,
    });
  }

  return hits;
}

/**
 * Which linked fighter the status is actually about.
 *
 * Returns `{ id, name, how }` or null. Null means "cannot tell", and the
 * caller emits nothing — never a guess, and never a row for each candidate.
 *
 * The rules, in order:
 *
 *   1. Only one fighter linked        that is the subject.
 *   2. The status phrase is in the    the nearest fighter named BEFORE it, in
 *      title, and one linked fighter  the same clause. English puts the
 *      is named before it             subject in front: "Shevchenko injured",
 *                                     "Doe withdraws from UFC 320". Clauses
 *                                     are split on ; and — because
 *                                     "Shevchenko injured; Silva-Wang set for
 *                                     UFC 332" is two separate claims and only
 *                                     the first is about availability.
 *   3. Exactly one linked fighter is  that is the subject; the others were
 *      named in the title at all      linked from the summary as context.
 *   4. Otherwise                      ambiguous. Emit nothing.
 *
 * Rule 4 matters more than the rest. This ran against our own archive and
 * found "Shevchenko injured; Silva-Wang set for UFC 332" producing injury rows
 * for Natalia Silva and Wang Cong, who are the replacements — the two people
 * whose availability the story confirms. An injuries page asserting that a
 * healthy fighter is hurt is worse than one that is incomplete.
 */
export function resolveSubject(title, summary, fighters, primary) {
  if (!fighters.length) return null;
  if (fighters.length === 1) return { ...fighters[0], how: 'only linked fighter' };

  const t = String(title || '');
  const named = fighters
    .map((f) => ({ f, at: t.search(new RegExp(`\\b${surnameOf(f.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')) }))
    .filter((x) => x.at >= 0);

  if (primary.where === 'title') {
    /* Where does the matched phrase sit, and which clause is that? */
    const hit = primary.matched
      .map((m) => t.toLowerCase().indexOf(m.toLowerCase()))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    if (hit != null) {
      const clauseStart = Math.max(t.lastIndexOf(';', hit), t.lastIndexOf(' — ', hit), t.lastIndexOf(' - ', hit), -1) + 1;
      const before = named.filter((x) => x.at < hit && x.at >= clauseStart).sort((a, b) => b.at - a.at);
      if (before.length) return { ...before[0].f, how: 'named before the status phrase in the same clause' };
    }
    /* The phrase is in the title and no linked fighter precedes it. Stop.
     *
     * Falling through to "the only linked fighter named in the title" is what
     * an earlier version did, and against our own archive it produced this:
     * "Shevchenko injured; Silva-Wang set for UFC 332" was linked to Silva and
     * Wang but NOT to Shevchenko, so the fallback picked Silva — a fighter the
     * headline names as the beneficiary — and filed her as injured. The
     * subject of a status change can be someone the linker never resolved, and
     * the only safe reading of "nobody linked is in front of the phrase" is
     * that we do not know who this is about. */
    return null;
  }

  /* The phrase matched only in the summary, where position in the title says
   * nothing. One linked fighter in the title is then the best available
   * reading of who the story is about. */
  if (named.length === 1) return { ...named[0].f, how: 'the only linked fighter named in the title' };
  return null;
}

/**
 * Turn one news item into zero or more status-event candidates.
 *
 * Returns `{ events, skipped }`. `skipped` carries a reason for every item
 * that produced nothing, because a rules engine you cannot interrogate is one
 * you cannot tune: the backfill report is built entirely out of these.
 *
 * `item` is a ufc_news_items row plus a resolved `fighters` array
 * ([{id, name}]) that the caller linked. Linking is NOT done here — the news
 * pipeline already resolves fighter mentions and doing it twice, differently,
 * is how two answers to one question appear.
 */
export function extractStatus(item, { now = Date.now() } = {}) {
  const title = item.title || '';
  const summary = item.summary || '';
  const text = `${title}. ${summary}`;
  const skipped = [];

  const negator = negatorFor(text);
  if (negator) {
    return { events: [], skipped: [{ id: item.id, title, reason: 'negated', detail: negator.why }] };
  }

  const hits = classifyStatus(title, summary);
  if (!hits.length) {
    return { events: [], skipped: [{ id: item.id, title, reason: 'no_status_rule_matched' }] };
  }

  const fighters = Array.isArray(item.fighters) ? item.fighters : [];
  const primary = hits.sort((a, b) => b.confidence - a.confidence)[0];

  if (primary.requiresSubject && !fighters.length) {
    return {
      events: [],
      skipped: [{ id: item.id, title, reason: 'unlinked_no_fighter', detail: `${primary.type} matched but no fighter resolved` }],
    };
  }

  /* WHO the status is about.
   *
   * The news linker attaches every fighter it can find, which is right for a
   * wire feed and wrong here: "Shevchenko injured; Silva-Wang set for UFC 332"
   * links three fighters, and only one of them is unavailable. Emitting a row
   * per linked fighter — even a low-confidence one — puts two healthy athletes
   * on an injury page, which is a false claim about a named person and exactly
   * what this system must not do.
   *
   * So the subject is resolved by position, and when position cannot answer,
   * NOTHING is emitted. English attributes the status to the name in front of
   * it: "Shevchenko injured", "Doe withdraws from". Take the nearest linked
   * fighter appearing before the matched phrase within the same clause. */
  const subject = resolveSubject(title, summary, fighters, primary);
  if (primary.requiresSubject && !subject) {
    return {
      events: [],
      skipped: [{
        id: item.id, title, reason: 'ambiguous_subject',
        detail: `${primary.type} matched but ${fighters.length} fighters are linked and none is positionally the subject: ${fighters.map((f) => f.name).join(', ')}`,
      }],
    };
  }

  /* A diagnosis may only be read from a sentence that names the subject. */
  const clinicalScope = (() => {
    const about = sentencesAbout(text, subject?.name);
    return about.length ? about.join(' ') : (subject && new RegExp(`\\b${surnameOf(subject.name)}\\b`, 'i').test(title) ? title : '');
  })();
  const clinical = (primary.type === 'injury' || primary.type === 'illness' || primary.type === 'withdrawal')
    ? extractClinical(clinicalScope)
    : { injury_type: null, body_part: null, injury_side: null, clinical_quote: null };

  /* A withdrawal whose text also names an injury keeps status_type
   * 'withdrawal' — availability is the fact — and carries the injury detail
   * alongside. Two rows would double-count one absence. */
  const secondary = hits.filter((h) => h.type !== primary.type).map((h) => h.type);

  const events = (subject ? [subject] : []).map((f) => ({
    fighter_id: f.id,
    fighter_name: f.name,
    status_type: primary.type,
    /* Verbatim from the source, never composed. Null when the title is the
     * only thing we have, because a title is already stored. */
    status_detail: null,
    state: 'active',
    event_id: item.event_id ?? null,
    bout_id: item.bout_id ?? null,
    replacement_fighter_id: null,
    replaced_fighter_id: null,
    ...clinical,
    expected_return_at: null,
    expected_return_note: null,
    source_url: item.url,
    source_name: item.source_name || null,
    source_kind: item.source_kind || 'news',
    news_item_id: item.id,
    source_published_at: item.published_at ?? null,
    detected_at: new Date(now).toISOString(),
    effective_at: null,
    /* Official promotion surfaces are the promotion amending its own card,
     * not a report about it, so they carry more weight than the wire. */
    confidence: clamp01(primary.confidence + (item.source_kind === 'official' ? 0.1 : 0)),
    provenance: {
      extractor: 'status-rules-v1',
      rule: primary.type,
      matched_in: primary.where,
      matched: primary.matched,
      secondary_rules: secondary,
      title,
      subject_resolved_by: subject.how,
      fighter_candidates: fighters.map((x) => x.name),
      taxonomy_labels: item.taxonomy?.labels ?? [],
      clinical_source: clinical.clinical_quote ? 'quoted' : 'not stated by source',
    },
    ambiguous: false,
  }));

  return { events, skipped };
}

/**
 * Stable idempotency key.
 *
 * Deliberately NOT over the whole row. The collector re-reads an overlapping
 * feed window every few minutes and the same story reappears with a new
 * detected_at, sometimes a re-scored confidence, sometimes an edited summary.
 * Hashing those would make every pass look like new news. What identifies the
 * claim is: this fighter, this kind of change, this bout or event, this
 * article, on this day.
 */
export function fingerprintOf(evt, sha256) {
  const day = String(evt.effective_at || evt.source_published_at || evt.detected_at || '').slice(0, 10);
  return sha256([
    evt.fighter_id,
    evt.status_type,
    evt.bout_id || evt.event_id || 'no-card',
    String(evt.source_url || '').replace(/[?#].*$/, ''),
    day,
  ].join('|'));
}
