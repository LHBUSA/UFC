/* Run: node --experimental-strip-types --test lib/newsClusters.test.ts */
import test from "node:test";
import assert from "node:assert/strict";
import { clusterNewsPage, developmentKey, PRIMARY_SLOTS } from "./newsClusters.ts";

const art = (id: string, over: Partial<{ bout_id: string | null; event_id: string | null; fighter_ids: string[]; story_type: string }> = {}) =>
  ({ id, bout_id: null, event_id: null, fighter_ids: [], story_type: "external", ...over });

/* Shape of the live inventory on 2026-09-15: three Ortega/Moicano withdrawal stories lead. */
const live = [
  art("ortega1", { bout_id: "b-ortega", event_id: "e331", fighter_ids: ["moicano", "ortega"] }),
  art("ortega2", { bout_id: "b-ortega", event_id: "e331", fighter_ids: ["ortega", "moicano"] }),
  art("ortega3", { bout_id: "b-ortega", event_id: "e331", fighter_ids: ["ortega", "moicano"] }),
  art("delgado", { fighter_ids: ["delgado"] }),
  art("merab", { bout_id: "b-merab", event_id: "e2", fighter_ids: ["merab", "x"] }),
  art("aspinall1", { fighter_ids: ["aspinall"] }),
  art("silva1", { bout_id: "b-silva", event_id: "e3", fighter_ids: ["silva", "delgado"] }),
  art("hokit", { fighter_ids: ["hokit"] }),
  art("aspinall2", { fighter_ids: ["aspinall"] }),
  art("mcgregor", { fighter_ids: ["mcgregor"] }),
  art("silva2", { fighter_ids: ["silva"] }),
];

test("development key prefers bout, then fighter set, then event+type, then the article", () => {
  assert.equal(developmentKey(art("a", { bout_id: "b1", fighter_ids: ["x"] })), "bout:b1");
  assert.equal(developmentKey(art("a", { fighter_ids: ["y", "x", "x"] })), "fighters:x+y");
  assert.equal(developmentKey(art("a", { event_id: "e", story_type: "rankings" })), "event:e:rankings");
  assert.equal(developmentKey(art("a")), "article:a");
});

test("hero stays the newest story; its duplicates move to More on this story; the first slots are distinct", () => {
  const { hero, heroRelated, feed } = clusterNewsPage(live);
  assert.equal(hero?.id, "ortega1");
  assert.deepEqual(heroRelated.map((a) => a.id), ["ortega2", "ortega3"]);
  const firstSix = [hero!, ...feed.slice(0, PRIMARY_SLOTS - 1)];
  assert.equal(new Set(firstSix.map(developmentKey)).size, PRIMARY_SLOTS);
  assert.ok(new Set(firstSix.slice(0, 4).map(developmentKey)).size >= 3, "at least three developments in the first major viewport");
});

test("nothing is lost or duplicated: every article appears exactly once", () => {
  const { hero, heroRelated, feed } = clusterNewsPage(live);
  const ids = [hero!, ...heroRelated, ...feed].map((a) => a.id).sort();
  assert.deepEqual(ids, live.map((a) => a.id).sort());
});

test("displaced articles of other developments stay in the feed, never adjacent to their own development where avoidable", () => {
  const { feed } = clusterNewsPage(live);
  assert.ok(feed.some((a) => a.id === "aspinall2"));
  for (let i = 1; i < feed.length; i++) assert.notEqual(developmentKey(feed[i]), developmentKey(feed[i - 1]), `adjacent ${feed[i - 1].id}/${feed[i].id}`);
});

test("thin inventory fills primary slots rather than leaving holes; single-development pages keep order", () => {
  const one = [art("a1", { bout_id: "b" }), art("a2", { bout_id: "b" }), art("a3", { bout_id: "b" })];
  const r = clusterNewsPage(one);
  assert.equal(r.hero?.id, "a1");
  assert.deepEqual(r.heroRelated.map((a) => a.id), ["a2", "a3"]);
  const mixed = [art("a1", { bout_id: "b" }), art("c1", { bout_id: "c" }), art("c2", { bout_id: "c" }), art("c3", { bout_id: "c" })];
  const m = clusterNewsPage(mixed);
  assert.deepEqual(m.feed.map((a) => a.id), ["c1", "c2", "c3"], "c2/c3 fill primary slots when no other development exists");
});

test("deterministic: identical input, identical output", () => {
  assert.deepEqual(clusterNewsPage(live), clusterNewsPage([...live]));
  assert.deepEqual(clusterNewsPage([]), { hero: null, heroRelated: [], feed: [] });
});
