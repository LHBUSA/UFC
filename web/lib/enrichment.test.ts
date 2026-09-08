/**
 * Guards the packet-versus-live-record agreement.
 *
 *   node --test web/lib/enrichment.test.ts
 *
 * Referee packets are checked into the repository; bout counts come from the
 * live database. Merging two referee identities makes those disagree by
 * construction — "Eric McMahon" went from 26 bouts to 29 when he absorbed a
 * duplicate spelling, and the committed packet went on saying 26. The page
 * then showed a 29-assignment headline above a distribution over 26, which is
 * not really a stale number: it is two different referees on one page.
 *
 * Regenerating the packet fixed that instance. These tests are about the
 * class, so the next merge cannot reintroduce it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { packetMetricsAreCurrent } from "./packet-freshness.ts";
import enrichment from "./generated/enrichment.json" with { type: "json" };

const DB = enrichment as unknown as {
  referees: Record<string, { name?: string; metrics?: { sample_bouts?: number; method_distribution?: Record<string, number>; round_distribution?: Record<string, number> } }>;
};

test("metrics are current only when the sample IS the live record", () => {
  assert.equal(packetMetricsAreCurrent({ metrics: { sample_bouts: 29 } } as never, 29), true);
  assert.equal(packetMetricsAreCurrent({ metrics: { sample_bouts: 26 } } as never, 29), false, "the exact case that shipped");
  assert.equal(packetMetricsAreCurrent({ metrics: { sample_bouts: 29 } } as never, 26), false, "wrong in either direction");
});

test("a missing packet, sample or live count is never treated as current", () => {
  /* Withholding is the safe default: showing nothing is a gap, showing a
   * distribution over an unknown sample is a claim. */
  assert.equal(packetMetricsAreCurrent(null, 29), false);
  assert.equal(packetMetricsAreCurrent(undefined, 29), false);
  assert.equal(packetMetricsAreCurrent({ metrics: {} } as never, 29), false);
  assert.equal(packetMetricsAreCurrent({ metrics: { sample_bouts: 29 } } as never, null), false);
  assert.equal(packetMetricsAreCurrent({ metrics: { sample_bouts: 29 } } as never, undefined), false);
});

test("every packet's distributions add up to its own stated sample", () => {
  /* Internal consistency, checkable without the database. A packet whose
   * method distribution sums to something other than its sample is describing
   * a set of bouts it has not got. */
  const offenders: string[] = [];
  for (const [slug, p] of Object.entries(DB.referees)) {
    const sample = p.metrics?.sample_bouts;
    if (typeof sample !== "number") continue;
    for (const key of ["method_distribution", "round_distribution"] as const) {
      const dist = p.metrics?.[key];
      if (!dist) continue;
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      if (total !== sample) offenders.push(`${slug}.${key} sums to ${total}, sample is ${sample}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("no packet carries a referee identity that was merged away", () => {
  /* The three retired spellings must not reappear in a checked-in artifact,
   * where they would outlive the database change that removed them. */
  const retired = ["eric-mcmahon-2", "vjacheslav-kiselev", "kiselev-viacheslav"];
  for (const slug of retired) {
    assert.equal(DB.referees[slug], undefined, `${slug} was merged away and must not have a packet`);
  }

  const raw = readFileSync(new URL("./generated/enrichment.json", import.meta.url), "utf8");
  assert.ok(
    !/"Eric Mcmahon"/.test(raw),
    'the pre-merge spelling "Eric Mcmahon" must not survive in the combined artifact',
  );
});

test("Eric McMahon's packet reflects the merged identity", () => {
  /* The specific repair, pinned. 26 here again means a packet was regenerated
   * from a database that had been rolled back, or not regenerated at all. */
  const p = DB.referees["eric-mcmahon"];
  assert.ok(p, "eric-mcmahon should have a packet");
  assert.equal(p.name, "Eric McMahon");
  assert.equal(p.metrics?.sample_bouts, 29);
});
