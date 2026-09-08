/* Status extraction. Run: node --test scripts/status/lib/extract.test.mjs
 *
 * The first block is the one that matters. Everything else is coverage; that
 * block is the product's promise not to invent a medical claim about a named
 * person, and it is written to fail loudly the first time someone decides an
 * unspecified injury would look better as 'unspecified'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  extractStatus, extractClinical, classifyStatus, negatorFor,
  fingerprintOf, STATUS_TYPES, INJURY_TERMS, CANDIDATE_LABELS,
} from './extract.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const NOW = Date.parse('2026-09-08T12:00:00Z');

/** A ufc_news_items row with its fighters already linked. */
const item = (over = {}) => ({
  id: 'news-1',
  url: 'https://example.invalid/a',
  title: '',
  summary: '',
  published_at: '2026-09-07T10:00:00Z',
  taxonomy: { labels: ['withdrawal'], confidence: 0.9 },
  fighters: [{ id: 'f-1', name: 'Jane Doe' }],
  event_id: null,
  bout_id: null,
  source_name: 'Example Wire',
  source_kind: 'news',
  ...over,
});

const one = (over) => {
  const r = extractStatus(item(over), { now: NOW });
  assert.equal(r.events.length, 1, `expected one event for: ${over.title}`);
  return r.events[0];
};

/* ================= NEVER INFER A DIAGNOSIS ================= */

test('an unspecified injury has injury_type NULL — not "unspecified", not a guess', () => {
  for (const title of [
    'Jane Doe withdraws from UFC 320 due to injury',
    'Jane Doe out of UFC 320 with an injury',
    'Jane Doe pulled out of her fight after suffering an injury in camp',
    'Jane Doe forced out of UFC 320 by an undisclosed injury',
  ]) {
    const e = one({ title });
    assert.equal(e.injury_type, null, `injury_type must be null for: ${title}`);
    assert.equal(e.body_part, null, `body_part must be null for: ${title}`);
    assert.equal(e.injury_side, null);
    assert.equal(e.clinical_quote, null, 'and there must be no quote, because nothing was quoted');
    assert.equal(e.provenance.clinical_source, 'not stated by source');
  }
});

test('a named body part is not a named injury', () => {
  const e = one({ title: 'Jane Doe out of UFC 320 with a knee injury' });
  assert.equal(e.body_part, 'knee', 'the source said where');
  assert.equal(e.injury_type, null, 'the source did not say what, so we do not either');
  assert.match(e.clinical_quote, /knee injury/i, 'and the claim carries the sentence that licensed it');
});

test('a named injury is recorded, with the sentence that licensed it', () => {
  const e = one({ title: 'Jane Doe withdraws from UFC 320 with a torn ACL' });
  assert.equal(e.injury_type, 'torn acl');
  assert.equal(e.body_part, 'knee');
  assert.match(e.clinical_quote, /torn ACL/i);
});

test('every clinical value always arrives with a quote', () => {
  /* The database enforces this too. Asserting it here as well means a change
   * that breaks it fails in the test run, not at 3am against a constraint. */
  const texts = [
    'Jane Doe suffered a torn meniscus', 'Jane Doe has a broken hand',
    'Jane Doe out with a shoulder injury', 'Jane Doe withdraws with a concussion',
    'Jane Doe is out of UFC 320', 'Jane Doe withdraws due to injury',
  ];
  for (const t of texts) {
    const c = extractClinical(t);
    const claims = [c.injury_type, c.body_part, c.injury_side].some((v) => v != null);
    assert.equal(claims && !c.clinical_quote, false, `clinical claim without a quote: ${t}`);
  }
});

test('the clinical vocabulary is closed, and every entry needs its literal words', () => {
  /* An injury term that fires on text not containing its own words is a term
   * that will one day fire on the wrong article. */
  for (const term of INJURY_TERMS) {
    assert.equal(term.re.test('Jane Doe is out of UFC 320 with an injury'), false,
      `${term.injury_type} must not match an unspecified injury`);
    assert.equal(term.re.test('Jane Doe withdraws from the card'), false,
      `${term.injury_type} must not match a bare withdrawal`);
  }
});

test('a diagnosis from elsewhere in the fighter’s history is never carried over', () => {
  /* Two items, one fighter. The second says only "an injury". The extractor is
   * stateless by construction; this asserts the property that makes it so. */
  const first = one({ id: 'n1', title: 'Jane Doe withdraws from UFC 319 with a torn ACL' });
  assert.equal(first.injury_type, 'torn acl');
  const second = one({ id: 'n2', title: 'Jane Doe withdraws from UFC 320 due to injury' });
  assert.equal(second.injury_type, null, 'the earlier diagnosis must not leak into a later item');
  assert.equal(second.body_part, null);
});

/* ================= status typing ================= */

test('each status type is recognised from a realistic headline', () => {
  const cases = {
    withdrawal: 'Jane Doe withdraws from UFC 320 main event',
    replacement: 'Jane Doe steps in for John Roe at UFC 320',
    weight_miss: 'Jane Doe misses weight for UFC 320 co-main',
    suspension: 'Jane Doe suspended after anti-doping violation',
    visa_travel: 'Jane Doe hit with visa issues ahead of UFC 320',
    illness: 'Jane Doe hospitalized ahead of UFC 320',
    injury: 'Jane Doe underwent surgery this week',
    cleared: 'Jane Doe medically cleared to return',
    return: 'Jane Doe makes her return at UFC 320',
  };
  for (const [type, title] of Object.entries(cases)) {
    assert.equal(one({ title }).status_type, type, `"${title}" should be ${type}`);
  }
  for (const t of Object.keys(cases)) assert.ok(STATUS_TYPES.includes(t));
});

test('an injury-caused withdrawal is one withdrawal carrying the injury, not two rows', () => {
  const r = extractStatus(item({ title: 'Jane Doe withdraws from UFC 320 with a torn ACL' }), { now: NOW });
  assert.equal(r.events.length, 1, 'one absence is one row');
  assert.equal(r.events[0].status_type, 'withdrawal', 'availability is the fact');
  assert.equal(r.events[0].injury_type, 'torn acl', 'and the cause travels with it');
  assert.ok(r.events[0].provenance.secondary_rules.includes('injury'));
});

/* ================= false positives ================= */

test('a retrospective return is not an injury', () => {
  /* The costliest false positive: this fighter is available, and filing it as
   * an injury takes a healthy athlete off the card on our own site. */
  const r = extractStatus(item({ title: 'Jane Doe returns from the knee injury that cost her 2025' }), { now: NOW });
  assert.deepEqual(r.events, []);
  assert.equal(r.skipped[0].reason, 'negated');
});

test('speculation, conditionals, denials and previews produce nothing', () => {
  const rejected = [
    'Rumors swirl that Jane Doe could be forced out of UFC 320',
    'Jane Doe denies injury reports ahead of UFC 320',
    'If Jane Doe withdraws, who replaces her at UFC 320?',
    'Jane Doe avoided injury in a scary moment at UFC 319',
    'UFC 320 picks and predictions: Doe vs Roe',
    'Jane Doe has a long injury history',
  ];
  for (const title of rejected) {
    const r = extractStatus(item({ title }), { now: NOW });
    assert.deepEqual(r.events, [], `must not produce an event: ${title}`);
    assert.ok(r.skipped.length && r.skipped[0].reason, `and must say why: ${title}`);
  }
});

test('a status headline with no fighter linked is reported, never attributed', () => {
  const r = extractStatus(item({ title: 'Two fighters withdraw from UFC 320', fighters: [] }), { now: NOW });
  assert.deepEqual(r.events, []);
  assert.equal(r.skipped[0].reason, 'unlinked_no_fighter');
});

test('the subject is the fighter named before the status phrase, in its own clause', () => {
  /* Verbatim from our archive. Silva and Wang are the REPLACEMENTS — the two
   * fighters this story confirms are available — and an earlier version of
   * this extractor filed injury rows for both of them. */
  const r = extractStatus(item({
    title: 'Shevchenko injured; Silva-Wang set for UFC 332',
    fighters: [
      { id: 'f-1', name: 'Natalia Silva' },
      { id: 'f-2', name: 'Wang Cong' },
      { id: 'f-3', name: 'Valentina Shevchenko' },
    ],
  }), { now: NOW });
  assert.equal(r.events.length, 1, 'one story, one injured fighter');
  assert.equal(r.events[0].fighter_name, 'Valentina Shevchenko');
  assert.match(r.events[0].provenance.subject_resolved_by, /before the status phrase/);
});

test('when position cannot answer, nothing is emitted at all', () => {
  /* No row beats a low-confidence row: there is no review queue between this
   * and the injuries page, so "emitted for review" means "published". */
  const r = extractStatus(item({
    title: 'UFC 320 shake-up leaves two bouts in doubt',
    summary: 'Jane Doe withdraws from the card. John Roe is also affected.',
    fighters: [{ id: 'f-1', name: 'Jane Doe' }, { id: 'f-2', name: 'John Roe' }],
  }), { now: NOW });
  assert.deepEqual(r.events, [], 'an unattributable status change is reported, never attributed');
  assert.equal(r.skipped[0].reason, 'ambiguous_subject');
  assert.match(r.skipped[0].detail, /Jane Doe, John Roe/, 'and the report names the candidates so a human can adjudicate');
});

test('a diagnosis is only read from a sentence naming the subject', () => {
  /* Cross-attribution is the quiet version of inventing a diagnosis: the
   * injury is real, the person is wrong. */
  const r = extractStatus(item({
    title: 'Jane Doe withdraws from UFC 320',
    summary: 'Jane Doe is out. Separately, John Roe is recovering from a torn ACL.',
    fighters: [{ id: 'f-1', name: 'Jane Doe' }],
  }), { now: NOW });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].injury_type, null, "another fighter's ACL is not this fighter's diagnosis");
  assert.equal(r.events[0].clinical_quote, null);
});

test('an ordinary result recap is not a status event', () => {
  const r = extractStatus(item({
    title: 'Jane Doe def. John Roe by unanimous decision at UFC 319',
    taxonomy: { labels: ['result'], confidence: 0.9 },
  }), { now: NOW });
  assert.deepEqual(r.events, []);
  assert.equal(r.skipped[0].reason, 'no_status_rule_matched');
});

/* ================= provenance and idempotency ================= */

test('every event carries what decided it', () => {
  const e = one({ title: 'Jane Doe withdraws from UFC 320 with a torn ACL' });
  assert.equal(e.provenance.extractor, 'status-rules-v1');
  assert.equal(e.provenance.rule, 'withdrawal');
  assert.equal(e.provenance.matched_in, 'title');
  assert.ok(e.provenance.matched.length, 'the matched spans travel with the row');
  assert.equal(e.news_item_id, 'news-1');
  assert.equal(e.source_url, 'https://example.invalid/a');
  assert.equal(e.detected_at, '2026-09-08T12:00:00.000Z');
  assert.equal(e.source_published_at, '2026-09-07T10:00:00Z');
});

test('the fingerprint is stable across re-reads and distinct across claims', () => {
  /* The collector re-reads an overlapping window every few minutes; the same
   * story must hash the same however many times it arrives. */
  const a = one({ title: 'Jane Doe withdraws from UFC 320' });
  const b = extractStatus(item({ title: 'Jane Doe withdraws from UFC 320' }), { now: NOW + 9 * 60000 }).events[0];
  assert.equal(fingerprintOf(a, sha256), fingerprintOf(b, sha256), 'a later pass over the same item is the same claim');

  /* Query strings and fragments are tracking noise, not identity. */
  const tracked = { ...a, source_url: 'https://example.invalid/a?utm_source=x#top' };
  assert.equal(fingerprintOf(tracked, sha256), fingerprintOf(a, sha256));

  const other = { ...a, fighter_id: 'f-2' };
  assert.notEqual(fingerprintOf(other, sha256), fingerprintOf(a, sha256));
  const otherType = { ...a, status_type: 'injury' };
  assert.notEqual(fingerprintOf(otherType, sha256), fingerprintOf(a, sha256));
});

test('the taxonomy prefilter admits exactly the labels worth reading', () => {
  for (const l of ['withdrawal', 'replacement', 'injury', 'suspension', 'weight_miss', 'bout_moved']) {
    assert.ok(CANDIDATE_LABELS.has(l), `${l} must be read`);
  }
  for (const l of ['result', 'rankings', 'contract', 'other']) {
    assert.ok(!CANDIDATE_LABELS.has(l), `${l} is not an availability signal`);
  }
});

test('classification prefers the title, and says where it matched', () => {
  const fromTitle = classifyStatus('Jane Doe withdraws from UFC 320', '');
  const fromSummary = classifyStatus('UFC 320 update', 'Jane Doe withdraws from UFC 320.');
  assert.equal(fromTitle[0].where, 'title');
  assert.equal(fromSummary[0].where, 'summary');
  assert.ok(fromTitle[0].confidence > fromSummary[0].confidence,
    'a title is the claim the publisher stands behind; a summary is context');
});

test('negators are reported with a reason a human can act on', () => {
  const n = negatorFor('Jane Doe returns from the knee injury that cost her 2025');
  assert.ok(n && n.why, 'a rejection without a reason cannot be tuned');
});

test('the subject can be someone the linker never resolved, and then we say nothing', () => {
  /* Verbatim from our archive, including the linkage. The injured fighter —
   * Shevchenko — was never linked to this item; only the two replacements
   * were. An earlier rule fell back to "the only linked fighter named in the
   * title" and filed Natalia Silva, whom the headline names as the fighter
   * taking the vacated title shot, as injured.
   *
   * "Wang" is not Wang Cong's surname either, which is why only one candidate
   * appeared to be named at all — a second reason position, not headcount,
   * has to decide this. */
  const r = extractStatus(item({
    title: 'Shevchenko injured; Silva-Wang set for UFC 332',
    fighters: [{ id: 'f-1', name: 'Natalia Silva' }, { id: 'f-2', name: 'Wang Cong' }],
  }), { now: NOW });
  assert.deepEqual(r.events, [], 'no linked fighter precedes the status phrase, so there is no subject');
  assert.equal(r.skipped[0].reason, 'ambiguous_subject');
});

test('a summary-only match may use the single fighter named in the title', () => {
  /* The one place headcount is still allowed: position in the title cannot
   * speak to a phrase that is not in the title. */
  const e = one({
    title: 'UFC 320 card update',
    summary: 'Jane Doe has withdrawn from her bout with a knee injury.',
    fighters: [{ id: 'f-1', name: 'Jane Doe' }],
  });
  assert.equal(e.fighter_name, 'Jane Doe');
  assert.equal(e.status_type, 'withdrawal');
});
