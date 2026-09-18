/* Availability-episode grouping. Run: npm run test:status
 *
 * The board shows one card per real-world availability episode and keeps every
 * source receipt beneath it. These tests pin the two ways that can go wrong:
 * merging things that are not the same episode, and saying more about a
 * fighter's body than any single source said.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { StatusEvent } from "./status-display.ts";
import {
  groupStatusEvents, filterEpisodes, sortEpisodes, summarizeEpisodes,
  parseTypeFilter, episodeStateLabel,
} from "./status-groups.ts";

let seq = 0;
const evt = (over: Partial<StatusEvent> = {}): StatusEvent => {
  seq += 1;
  return {
    id: `s${seq}`, fighter_id: "f-ortega", fighter_name: "Brian Ortega",
    fighter_espn_athlete_id: null, fighter_ufcstats_id: null,
    record_w: 16, record_l: 4, record_d: 0,
    status_type: "injury", status_detail: null, state: "active",
    event_id: null, event_name: null, event_date: null, bout_id: null,
    replacement_fighter_id: null, replacement_fighter_name: null,
    replaced_fighter_id: null, replaced_fighter_name: null,
    injury_type: null, body_part: null, injury_side: null, clinical_quote: null,
    expected_return_at: null, expected_return_note: null,
    source_url: `https://example.invalid/story-${seq}`, source_name: `Outlet ${seq}`, source_kind: "news",
    source_published_at: null, detected_at: "2026-09-15T12:00:00Z", effective_at: null,
    confidence: 0.85, occurred_at: "2026-09-15T12:00:00Z",
    ...over,
  };
};

const UFC331 = { event_id: "ev-331", event_name: "UFC 331: Van vs. Pantoja 2", event_date: "2026-09-19" };

/* The production shape on 2026-09-18: four withdrawals carrying the bout, one
 * carrying only the event, and two "injured" reports carrying only the event. */
const ortegaSix = () => [
  evt({ ...UFC331, status_type: "withdrawal", source_name: "MMA Fighting", confidence: 0.9, occurred_at: "2026-09-17T15:00:00Z" }),
  evt({ ...UFC331, status_type: "injury", source_name: "The Mac Life", occurred_at: "2026-09-15T08:34:00Z" }),
  evt({ ...UFC331, bout_id: "b-1", status_type: "withdrawal", source_name: "Sherdog", confidence: 0.84, occurred_at: "2026-09-15T04:20:00Z" }),
  evt({ ...UFC331, bout_id: "b-1", status_type: "withdrawal", source_name: "MMA Weekly", confidence: 0.9, occurred_at: "2026-09-15T01:32:00Z" }),
  evt({ ...UFC331, status_type: "injury", source_name: "MMA Mania", occurred_at: "2026-09-15T00:32:00Z" }),
  evt({ event_id: null, event_name: null, event_date: null, bout_id: "b-1", status_type: "withdrawal", source_name: "BJPenn.com", confidence: 0.84, occurred_at: "2026-09-14T23:49:00Z" }),
];

test("1. six reports of one UFC 331 withdrawal are ONE card with all six receipts", () => {
  const rows = ortegaSix();
  const eps = groupStatusEvents(rows);
  assert.equal(eps.length, 1);
  const ep = eps[0];
  assert.equal(ep.receipts.length, 6);
  assert.deepEqual(new Set(ep.receipts.map((r) => r.source_url)), new Set(rows.map((r) => r.source_url)), "no source URL is lost");
  assert.equal(ep.primaryType, "withdrawal", "being off the card is the consequence; the injury is context");
  assert.deepEqual([...ep.types].sort(), ["injury", "withdrawal"]);
  assert.equal(ep.unavailable, true);
  assert.equal(ep.event_id, "ev-331", "a bout-only receipt resolves to its event through a sibling receipt");
  assert.equal(episodeStateLabel(ep), "Unavailable");
  /* Raw rows are not touched. */
  assert.equal(rows[1].status_type, "injury");
});

test("2. repeated cleared reports are one resolution episode", () => {
  const eps = groupStatusEvents([
    evt({ fighter_id: "f-topuria", fighter_name: "Ilia Topuria", status_type: "cleared", occurred_at: "2026-09-17T20:40:00Z" }),
    evt({ fighter_id: "f-topuria", fighter_name: "Ilia Topuria", status_type: "cleared", occurred_at: "2026-09-16T20:30:00Z" }),
    evt({ fighter_id: "f-topuria", fighter_name: "Ilia Topuria", status_type: "return", occurred_at: "2026-09-16T10:00:00Z" }),
  ]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].kind, "resolution");
  assert.equal(eps[0].receipts.length, 3);
  assert.equal(eps[0].unavailable, false);
  assert.equal(eps[0].clinical.status, "none");
});

test("3. repeated injury reports from different publishers are one episode, many receipts", () => {
  const a = { fighter_id: "f-aspinall", fighter_name: "Tom Aspinall" };
  const eps = groupStatusEvents([
    evt({ ...a, source_name: "BJPenn.com", occurred_at: "2026-09-14T12:56:00Z" }),
    evt({ ...a, source_name: "MMA Mania", body_part: "eye", clinical_quote: "reveals devastating new eye injury", occurred_at: "2026-09-14T08:52:00Z" }),
    evt({ ...a, source_name: "MMA News", body_part: "eye", clinical_quote: "after devastating eye injury setback", occurred_at: "2026-09-14T07:03:00Z" }),
  ]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].receipts.length, 3);
  assert.equal(eps[0].clinical.status, "stated");
  assert.match(eps[0].clinical.line, /^Eye — the source does not say what the injury is$/, "a body part is where, not what");
  assert.equal(summarizeEpisodes(eps).verifiedDiagnoses, 0, "a body part is not a verified diagnosis");
});

test("3b. unlinked reports far apart in time are different injuries", () => {
  const eps = groupStatusEvents([
    evt({ occurred_at: "2026-09-14T00:00:00Z" }),
    evt({ occurred_at: "2026-03-01T00:00:00Z" }),
  ]);
  assert.equal(eps.length, 2);
});

test("4. an injury and an unrelated suspension stay two episodes", () => {
  const eps = groupStatusEvents([
    evt({ status_type: "injury" }),
    evt({ status_type: "suspension", source_kind: "commission" }),
    evt({ ...UFC331, status_type: "visa_travel" }),
    evt({ ...UFC331, status_type: "weight_miss" }),
    evt({ ...UFC331, status_type: "withdrawal" }),
  ]);
  assert.deepEqual(eps.map((e) => e.primaryType).sort(), ["injury", "suspension", "visa_travel", "weight_miss", "withdrawal"],
    "same fighter, even same card: unlike conditions never merge");
});

test("4b. an unlinked injury is not folded into a card-linked withdrawal, nor an unlinked illness into an injury", () => {
  const eps = groupStatusEvents([
    evt({ ...UFC331, status_type: "withdrawal" }),
    evt({ status_type: "injury" }),
    evt({ status_type: "illness" }),
  ]);
  assert.equal(eps.length, 3);
});

test("4c. fighter_id is identity: a shared name never merges two ids, active never merges with resolved", () => {
  assert.equal(groupStatusEvents([
    evt({ fighter_id: "f-1", fighter_name: "Bruno Silva" }),
    evt({ fighter_id: "f-2", fighter_name: "Bruno Silva" }),
  ]).length, 2);
  assert.equal(groupStatusEvents([evt({ state: "active" }), evt({ state: "resolved" })]).length, 2);
});

test("5. exact duplicate source_url rows are one receipt in presentation", () => {
  const url = "https://example.invalid/ortega-out";
  const eps = groupStatusEvents([
    evt({ ...UFC331, status_type: "withdrawal", source_url: url, confidence: 0.8 }),
    evt({ ...UFC331, status_type: "withdrawal", source_url: `${url}?utm_source=rss`, confidence: 0.9 }),
    evt({ ...UFC331, status_type: "withdrawal", source_url: "https://example.invalid/other" }),
  ]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].receipts.length, 2);
  assert.equal(eps[0].suppressedDuplicates, 1);
  assert.equal(eps[0].receipts.find((r) => r.source_url.startsWith(url))!.confidence, 0.9, "the better-scored copy is the one kept");
  /* Same URL, different claim: both stay. */
  const two = groupStatusEvents([
    evt({ ...UFC331, status_type: "withdrawal", source_url: url }),
    evt({ ...UFC331, status_type: "injury", source_url: url }),
  ]);
  assert.equal(two[0].receipts.length, 2);
});

test("6. no source named a diagnosis: the episode says exactly that", () => {
  const ep = groupStatusEvents(ortegaSix())[0];
  assert.equal(ep.clinical.status, "none");
  assert.equal(ep.clinical.line, "No diagnosis stated by the source");
  assert.equal(ep.clinical.receipt, null);
  assert.equal(summarizeEpisodes([ep]).verifiedDiagnoses, 0);
});

test("7. a quote-backed diagnosis stays attached to the receipt that made it", () => {
  const u = { fighter_id: "f-ulberg", fighter_name: "Carlos Ulberg" };
  const espn = evt({ ...u, source_name: "ESPN", confidence: 0.75, injury_type: "acl tear", clinical_quote: "recovering from an ACL tear", occurred_at: "2026-08-27T18:30:00Z" });
  const blog = evt({ ...u, source_name: "Blog", confidence: 0.9, occurred_at: "2026-08-28T18:30:00Z" });
  const ep = groupStatusEvents([blog, espn])[0];
  assert.equal(ep.receipts.length, 2);
  assert.equal(ep.clinical.status, "stated");
  assert.equal(ep.clinical.line, "ACL tear");
  assert.equal(ep.clinical.receipt, espn, "the diagnosis is credited to ESPN, not to the higher-confidence primary");
  assert.equal(ep.primary, blog);
  assert.equal(ep.primary.injury_type, null, "the primary receipt does not inherit a diagnosis it never made");
  assert.equal(ep.primary.clinical_quote, null);
  assert.equal(summarizeEpisodes([ep]).verifiedDiagnoses, 1);
});

test("8. conflicting or partial clinical claims are never combined into a stronger one", () => {
  const conflict = groupStatusEvents([
    evt({ injury_type: "torn acl", clinical_quote: "a torn ACL" }),
    evt({ injury_type: "broken hand", clinical_quote: "a broken hand" }),
  ])[0];
  assert.equal(conflict.clinical.status, "conflict");
  assert.equal(conflict.clinical.receipt, null);
  assert.doesNotMatch(conflict.clinical.line, /acl|hand/i, "neither diagnosis is chosen");
  assert.equal(summarizeEpisodes([conflict]).verifiedDiagnoses, 0);

  const parts = groupStatusEvents([
    evt({ body_part: "knee", clinical_quote: "his knee" }),
    evt({ body_part: "ankle", clinical_quote: "his ankle" }),
  ])[0];
  assert.equal(parts.clinical.status, "conflict");

  /* Side from one report + diagnosis from another would be a claim nobody made. */
  const stitched = groupStatusEvents([
    evt({ injury_type: "torn acl", clinical_quote: "a torn ACL", confidence: 0.9 }),
    evt({ body_part: "knee", injury_side: "left", clinical_quote: "his left knee", confidence: 0.8 }),
  ])[0];
  assert.equal(stitched.clinical.status, "stated");
  assert.equal(stitched.clinical.line, "Torn ACL", "not 'Left torn ACL': the side came from a different source");

  /* A return date is a claim too. */
  const dates = groupStatusEvents([evt({ expected_return_note: "early next year" }), evt({ expected_return_note: "this summer" })])[0];
  assert.equal(dates.expected_return_note, null);
  assert.equal(groupStatusEvents([evt({ expected_return_note: "early next year" }), evt()])[0].expected_return_note, "early next year");
});

test("9. official outranks commission outranks desk outranks news; then confidence; then recency", () => {
  const mk = (over: Partial<StatusEvent>) => evt({ ...UFC331, status_type: "withdrawal", ...over });
  const news = mk({ source_kind: "news", confidence: 0.99, occurred_at: "2026-09-17T00:00:00Z" });
  const manual = mk({ source_kind: "manual", confidence: 0.9 });
  const commission = mk({ source_kind: "commission", confidence: 0.9 });
  const official = mk({ source_kind: "official", confidence: 0.7, occurred_at: "2026-09-14T00:00:00Z" });
  for (const order of [[news, manual, commission, official], [official, commission, manual, news], [manual, official, news, commission]]) {
    const ep = groupStatusEvents(order)[0];
    assert.deepEqual(ep.receipts.map((r) => r.source_kind), ["official", "commission", "manual", "news"], "input order never matters");
    assert.equal(ep.primary, official);
    assert.equal(ep.hasOfficial, true);
  }
  const hi = mk({ confidence: 0.9, occurred_at: "2026-09-14T00:00:00Z" });
  const lo = mk({ confidence: 0.84, occurred_at: "2026-09-17T00:00:00Z" });
  assert.equal(groupStatusEvents([lo, hi])[0].primary, hi, "same class: confidence before recency");
  const older = mk({ confidence: 0.9, occurred_at: "2026-09-13T00:00:00Z" });
  assert.equal(groupStatusEvents([older, hi])[0].primary, hi, "same class and confidence: newer wins");
});

test("9b. a sourced withdrawal is the primary outcome even beside an official injury report", () => {
  const ep = groupStatusEvents([
    evt({ ...UFC331, status_type: "injury", source_kind: "official", confidence: 1, occurred_at: "2026-09-10T00:00:00Z" }),
    evt({ ...UFC331, status_type: "withdrawal", source_kind: "news", confidence: 0.84, occurred_at: "2026-09-15T00:00:00Z" }),
  ])[0];
  assert.equal(ep.primaryType, "withdrawal");
  assert.equal(ep.primary.source_kind, "news");
  assert.equal(ep.hasOfficial, true, "the official receipt is still on the card");
});

test("10. type filters select episodes, not receipt rows", () => {
  const eps = groupStatusEvents([
    ...ortegaSix(),
    evt({ fighter_id: "f-x", fighter_name: "X", status_type: "suspension" }),
    evt({ fighter_id: "f-y", fighter_name: "Y", status_type: "cleared" }),
    evt({ fighter_id: "f-z", fighter_name: "Z", ...UFC331, status_type: "weight_miss" }),
  ]);
  assert.equal(eps.length, 4);
  const w = filterEpisodes(eps, "withdrawals");
  assert.equal(w.length, 1, "four withdrawal receipts, one withdrawal episode");
  assert.equal(w[0].receipts.length, 6, "the filter keeps the whole episode, injury receipts included");
  assert.equal(filterEpisodes(eps, "medical").length, 1, "the same episode is findable by its cause");
  assert.equal(filterEpisodes(eps, "suspensions")[0].fighter_name, "X");
  assert.equal(filterEpisodes(eps, "returns")[0].fighter_name, "Y");
  assert.equal(filterEpisodes(eps, "weight")[0].fighter_name, "Z");
  assert.equal(filterEpisodes(eps, "visa").length, 0);
  assert.equal(filterEpisodes(eps, "all").length, 4);
  assert.equal(parseTypeFilter("withdrawals"), "withdrawals");
  assert.equal(parseTypeFilter("'; drop table"), "all");
  assert.equal(parseTypeFilter(undefined), "all");
});

test("hero metrics count people and episodes, never receipts as fighters", () => {
  const s = summarizeEpisodes(groupStatusEvents([
    ...ortegaSix(),
    evt({ status_type: "suspension" }),                                                   // Ortega again: same person
    evt({ fighter_id: "f-y", fighter_name: "Y", status_type: "cleared" }),
  ]));
  assert.deepEqual(s, { episodes: 3, fighters: 2, unavailableFighters: 1, verifiedDiagnoses: 0, receipts: 8 });
});

test("active sort: nearest upcoming card first, then other unavailable, then changes; source count never ranks", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  const eps = groupStatusEvents([
    evt({ fighter_id: "f-c", fighter_name: "Cleared", status_type: "cleared", occurred_at: "2026-09-18T11:00:00Z" }),
    evt({ fighter_id: "f-n", fighter_name: "NoCard", occurred_at: "2026-09-18T10:00:00Z" }),
    evt({ fighter_id: "f-n", fighter_name: "NoCard", occurred_at: "2026-09-18T09:00:00Z" }),
    evt({ fighter_id: "f-n", fighter_name: "NoCard", occurred_at: "2026-09-18T08:00:00Z" }),
    evt({ fighter_id: "f-far", fighter_name: "Far", status_type: "withdrawal", event_id: "ev-333", event_date: "2026-10-24", occurred_at: "2026-09-18T11:39:00Z" }),
    evt({ fighter_id: "f-near", fighter_name: "Near", ...UFC331, status_type: "withdrawal", occurred_at: "2026-09-14T00:00:00Z" }),
    evt({ fighter_id: "f-past", fighter_name: "Past", status_type: "withdrawal", event_id: "ev-old", event_date: "2026-08-01", occurred_at: "2026-07-30T00:00:00Z" }),
  ]);
  assert.deepEqual(sortEpisodes(eps, "active", now).map((e) => e.fighter_name), ["Near", "Far", "NoCard", "Past", "Cleared"]);
  assert.deepEqual(sortEpisodes(eps, "all", now).map((e) => e.fighter_name), ["Far", "Cleared", "NoCard", "Near", "Past"]);
});
