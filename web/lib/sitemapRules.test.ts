/* Sitemap eligibility. Run: npm run test:sitemap
 *
 * Pins the claims a crawler would be misled by: a URL the route cannot resolve
 * is never emitted, a slug that resolves to a different canonical is never
 * emitted, every skipped row is counted under a reason, and no file exceeds
 * the protocol limit. */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SITEMAP_CHUNK, chunkCount, chunkOf, eligibleEvents, eligibleFighters, eligibleFights, isCleanPath,
  lastmodOf, sitemapIndexXml, urlsetXml, type PopBout, type PopEvent, type PopFighter,
} from "./sitemapRules.ts";

const fighter = (id: string, name: string, espn: string | null, ufcstats: string | null = null): PopFighter => ({ id, name, espn_athlete_id: espn, ufcstats_id: ufcstats });
const event = (id: string, name: string, date: string | null): PopEvent => ({ id, name, event_date: date });
const bout = (id: string, eventId: string, a: string, b: string, order = 1, status = "complete"): PopBout => ({ id, event_id: eventId, status, bout_order: order, fighter_a_id: a, fighter_b_id: b });

test("isCleanPath rejects queries, nulls, empty segments and trailing slashes", () => {
  assert.ok(isCleanPath("/fighters/ian-mccall-701e057d63c124d9"));
  assert.ok(isCleanPath("/events/ufc-163-aldo-vs-jung-2013-08-03"));
  for (const bad of ["/referees/null", "/fighters/x-undefined", "/news/a?utm_source=x", "/events/", "/a//b", "/Fighters/x", "/a-", "/news/a#b"]) {
    assert.equal(isCleanPath(bad), false, bad);
  }
});

test("fighters: every row is emitted or counted under a reason", () => {
  const rows = [
    fighter("1", "Ian McCall", null, "701e057d63c124d9"),
    fighter("2", "Jean Silva", "4879123"),
    fighter("3", "Short Id", "12345"),
    fighter("4", "No Id", null, null),
    fighter("5", "Shared A", "5000001"),
    fighter("6", "Shared B", null, "5000001"),
    fighter("7", "Merged Away", null, "1eff7bc0f815b270"),
    fighter("8", "!!!", "4000001"),
  ];
  const r = eligibleFighters(rows, ["1eff7bc0f815b270"]);
  assert.deepEqual(r.paths, ["/fighters/ian-mccall-701e057d63c124d9", "/fighters/jean-silva-4879123"]);
  assert.deepEqual(r.excluded, { unresolvable_source_id: 1, no_source_id: 1, source_id_shared_by_rows: 2, retired_slug_redirects: 1, empty_name_slug: 1 });
  const total = r.paths.length + Object.values(r.excluded).reduce((a, b) => a + b, 0);
  assert.equal(total, rows.length);
});

test("events: a dated event is emitted once; an undated one is excluded", () => {
  const r = eligibleEvents([event("e1", "UFC 163: Aldo vs Jung", "2013-08-03"), event("e2", "UFC TBA", null), event("e3", "UFC 163: Aldo vs Jung", "2013-08-03")]);
  assert.deepEqual(r.paths, ["/events/ufc-163-aldo-vs-jung-2013-08-03"]);
  assert.deepEqual(r.excluded, { no_event_date: 1, duplicate_slug: 1 });
});

test("fights: emitted only when the route resolves the slug to that same canonical", () => {
  const F = [fighter("a", "Ian McCall", "1000001"), fighter("b", "Iliarde Santos", "1000002"), fighter("c", "Neil Magny", "1000003"), fighter("d", "Rani Yahya", "1000004")];
  const E = [event("e1", "UFC 163: Aldo vs Jung", "2013-08-03")];
  const r = eligibleFights(E, [bout("1", "e1", "a", "b", 2), bout("2", "e1", "c", "a", 1), bout("3", "e1", "a", "b", 0), bout("4", "e1", "a", "zz"), bout("5", "e1", "d", "b", 3, "cancelled")], F);
  assert.deepEqual(r.paths, [
    "/fights/ian-mccall-vs-iliarde-santos-ufc-163-aldo-vs-jung-2013-08-03",
    "/fights/neil-magny-vs-ian-mccall-ufc-163-aldo-vs-jung-2013-08-03",
  ]);
  assert.deepEqual(r.excluded, { duplicate_slug: 1, missing_fighter_row: 1, cancelled_bout: 1 });
});

test("fights: a reversed-corner twin earlier in bout order steals the slug, so it is not emitted", () => {
  const F = [fighter("a", "Ian McCall", "1000001"), fighter("b", "Iliarde Santos", "1000002")];
  const E = [event("e1", "UFC 163: Aldo vs Jung", "2013-08-03")];
  /* Bout 2 (b vs a) sorts first; requesting a-vs-b answers with bout 2, whose canonical is b-vs-a. */
  const r = eligibleFights(E, [bout("1", "e1", "a", "b", 1), bout("2", "e1", "b", "a", 5)], F);
  assert.deepEqual(r.paths, ["/fights/iliarde-santos-vs-ian-mccall-ufc-163-aldo-vs-jung-2013-08-03"]);
  assert.deepEqual(r.excluded, { resolves_to_other_canonical: 1 });
});

test("fights: two same-day events that both answer a slug are ambiguous", () => {
  const F = [fighter("a", "Ian McCall", "1000001"), fighter("b", "Iliarde Santos", "1000002")];
  const E = [event("e1", "UFC Night", "2013-08-03"), event("e2", "UFC Night Two", "2013-08-03")];
  const r = eligibleFights(E, [bout("1", "e1", "a", "b"), bout("2", "e2", "a", "b")], F);
  assert.deepEqual(r.paths, []);
  assert.deepEqual(r.excluded, { ambiguous_across_same_day_events: 2 });
});

test("chunks cover the list exactly and never exceed the protocol limit", () => {
  const list = Array.from({ length: SITEMAP_CHUNK * 2 + 7 }, (_, i) => i);
  assert.equal(chunkCount(list.length), 3);
  assert.equal(chunkCount(0), 1);
  const joined = [1, 2, 3].flatMap((n) => chunkOf(list, n));
  assert.deepEqual(joined, list);
  assert.throws(() => urlsetXml(Array.from({ length: 50001 }, () => ({ loc: "https://x/y" }))));
});

test("xml escapes locations and omits unknown lastmod", () => {
  const xml = urlsetXml([{ loc: "https://ufc.propbetedge.ai/a&b" }, { loc: "https://ufc.propbetedge.ai/c", lastmod: "2026-09-14T00:00:00.000Z" }]);
  assert.match(xml, /<loc>https:\/\/ufc\.propbetedge\.ai\/a&amp;b<\/loc><\/url>/);
  assert.match(xml, /<lastmod>2026-09-14T00:00:00\.000Z<\/lastmod>/);
  assert.match(sitemapIndexXml(["https://ufc.propbetedge.ai/sitemaps/pages.xml"]), /<sitemapindex[^>]*>\n<sitemap><loc>https:\/\/ufc\.propbetedge\.ai\/sitemaps\/pages\.xml<\/loc><\/sitemap>/);
  assert.equal(lastmodOf("2026-09-14"), "2026-09-14T00:00:00.000Z");
  assert.equal(lastmodOf("not a date"), null);
  assert.equal(lastmodOf(null), null);
});
