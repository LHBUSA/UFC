import { test } from "node:test";
import assert from "node:assert/strict";
import { freshWire, railFollowStories, railIntelLinks, RAIL_WIRE_MAX_AGE_DAYS, type RailStory } from "./storyRail.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const s = (id: string, o: Partial<RailStory> = {}): RailStory => ({ id, slug: id, headline: id, story_type: "external", bout_id: null, event_id: null, fighter_ids: [], published_at: ago(1), ...o });

test("live wire drops items older than the window and undated items", () => {
  const items = [{ id: "a", published_at: ago(1) }, { id: "b", published_at: ago(RAIL_WIRE_MAX_AGE_DAYS + 1) }, { id: "c", published_at: null }];
  assert.deepEqual(freshWire(items, NOW).map((x) => x.id), ["a"]);
});

test("same-story coverage ranks bout, then shared fighter, then event, newest first", () => {
  const cur = s("cur", { bout_id: "B", event_id: "E", fighter_ids: ["f1", "f2"] });
  const related = [
    s("event-only", { event_id: "E", published_at: ago(0) }),
    s("fighter-old", { fighter_ids: ["f2"], published_at: ago(5) }),
    s("bout", { bout_id: "B", published_at: ago(9) }),
    s("fighter-new", { fighter_ids: ["f1"], published_at: ago(2) }),
    s("unrelated", { fighter_ids: ["zz"] }),
  ];
  const r = railFollowStories(cur, related, [], []);
  assert.deepEqual(r.related.map((x) => x.id), ["bout", "fighter-new", "fighter-old", "event-only"]);
  assert.deepEqual(r.latest, []);
});

test("never repeats the current story or anything already on the page", () => {
  const cur = s("cur", { fighter_ids: ["f1"] });
  const related = [s("cur", { fighter_ids: ["f1"] }), s("more1", { fighter_ids: ["f1"] }), s("r1", { fighter_ids: ["f1"] })];
  const latest = [s("more1"), s("l1", { fighter_ids: ["x"] }), s("r1", { fighter_ids: ["f1"] })];
  const r = railFollowStories(cur, related, latest, ["more1"]);
  const ids = [...r.related, ...r.latest].map((x) => x.id);
  assert.deepEqual(ids, ["r1", "l1"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("thin same-story coverage is filled with distinct developments, never the story's own", () => {
  const cur = s("cur", { bout_id: "B", fighter_ids: ["f1"] });
  const latest = [
    s("own", { bout_id: "B" }),
    s("x1", { bout_id: "X" }), s("x2", { bout_id: "X" }),
    s("y1", { bout_id: "Y" }), s("z1", { bout_id: "Z" }), s("w1", { bout_id: "W" }),
  ];
  const r = railFollowStories(cur, [], latest, []);
  assert.deepEqual(r.latest.map((x) => x.id), ["x1", "y1", "z1", "w1"]);
});

test("enough same-story coverage stands alone", () => {
  const cur = s("cur", { fighter_ids: ["f1"] });
  const related = [1, 2, 3].map((i) => s(`r${i}`, { fighter_ids: ["f1"], published_at: ago(i) }));
  const r = railFollowStories(cur, related, [s("l1", { bout_id: "L" })], []);
  assert.equal(r.related.length, 3);
  assert.equal(r.latest.length, 0);
});

test("intel links follow the story's timing and never exceed four", () => {
  const up = railIntelLinks({ storyType: "fight_preview", eventDate: ago(-1), hasBout: true, now: NOW }).map((l) => l.href);
  assert.deepEqual(up, ["/fight-week", "/simulator", "/rankings", "/learn/fight-dna"]);
  const res = railIntelLinks({ storyType: "results", eventDate: ago(6), hasBout: true, now: NOW }).map((l) => l.href);
  assert.deepEqual(res, ["/round-by-round", "/judges", "/rankings", "/learn/fight-dna"]);
  const none = railIntelLinks({ storyType: "external", eventDate: null, hasBout: false, now: NOW }).map((l) => l.href);
  assert.deepEqual(none, ["/round-by-round", "/rankings", "/learn/fight-dna"]);
});
