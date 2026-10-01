import test from "node:test";
import assert from "node:assert/strict";
import { wireDevelopmentKey } from "./wireDedupe.ts";

test("generic event result hub variants share one development key", () => {
  const event_id = "845c3b2c-c201-4873-91eb-f5115d65b549";
  const main = {
    title: "Main Card Results | UFC 332: Silva vs Wang",
    event_id,
    bout_id: null,
    fighter_ids: [],
    topic_signature: null,
    taxonomy: { labels: ["result"], matched: ["result:results"] },
  };
  const prelims = { ...main, title: "Prelims Results | UFC 332: Silva vs Wang" };
  const scorecards = {
    ...main,
    title: "Official Scorecards | UFC 332: Silva vs Wang",
    taxonomy: { labels: ["result"], matched: ["result:scorecards"] },
  };

  assert.equal(wireDevelopmentKey(main), `event-result-hub:${event_id}`);
  assert.equal(wireDevelopmentKey(prelims), wireDevelopmentKey(main));
  assert.equal(wireDevelopmentKey(scorecards), wireDevelopmentKey(main));
});

test("weigh-in results and fighter/bout-specific result stories stay separate", () => {
  const event_id = "845c3b2c-c201-4873-91eb-f5115d65b549";
  assert.equal(wireDevelopmentKey({
    title: "UFC 332 weigh-in results",
    event_id,
    bout_id: null,
    fighter_ids: [],
    taxonomy: { labels: ["result"], matched: ["result:win"] },
  }), null);

  assert.equal(wireDevelopmentKey({
    title: "Silva beats Wang",
    event_id,
    bout_id: "bout-1",
    fighter_ids: ["silva", "wang"],
    taxonomy: { labels: ["result"], matched: ["result:results"] },
  }), null);
});

test("topic signature remains the strongest semantic key", () => {
  assert.equal(wireDevelopmentKey({
    title: "Late replacement changes UFC 332",
    event_id: "event-1",
    fighter_ids: ["fighter-1"],
    topic_signature: "ufc:replacement:fighter-1",
    taxonomy: { labels: ["replacement"], matched: ["replacement:new opponent"] },
  }), "topic:ufc:replacement:fighter-1");
});
