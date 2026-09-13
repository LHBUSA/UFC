import { test } from "node:test";
import assert from "node:assert/strict";
import { contractFilterAvailable, groupByFighter, resolvePublicOutcomes, resolvedContractCount, type OutcomeClaimRow, type OutcomeResolutionRow } from "./outcomeResolution.ts";
import { filterAlumni } from "./dwcsAlumni.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const claim = (id: string, over: Partial<OutcomeClaimRow> = {}): OutcomeClaimRow => ({
  id, fighter_id: "f1", event_id: "e1", bout_id: "b1", claim_type: "contract_awarded", claim_status: "eligible",
  source_url: `https://www.ufc.com/news/${id}`, source_title: "Week 1 results", source_date: "2026-08-11",
  source_family: "ufc.com", source_excerpt_short: "X earned a UFC contract", ...over,
});
const resolution = (id: string, claimId: string, over: Partial<OutcomeResolutionRow> = {}): OutcomeResolutionRow => ({
  id, fighter_id: "f1", event_id: "e1", claim_type: "contract_awarded", selected_claim_id: claimId,
  resolution_status: "approved", resolution_rule: "operator_decision", resolved_by: "operator", reviewed_at: "2026-09-13T02:00:00Z", ...over,
});

test("a raw UFC.com claim without a resolution is NOT public", () => {
  assert.deepEqual(resolvePublicOutcomes([claim("c1")], []), []);
});

test("an ESPN-only claim is NOT public, even if a resolution points at it", () => {
  const espn = claim("c2", { source_family: "espn.com", claim_status: "secondary_only" });
  assert.deepEqual(resolvePublicOutcomes([espn], []), []);
  assert.deepEqual(resolvePublicOutcomes([espn], [resolution("r2", "c2")]), []);
});

test("a conflicted or in-review claim is NOT public, even if a resolution points at it", () => {
  for (const status of ["conflicted", "review", "published"]) {
    assert.deepEqual(resolvePublicOutcomes([claim("c3", { claim_status: status })], [resolution("r3", "c3")]), [], status);
  }
});

test("an explicit approved operator resolution IS public", () => {
  const out = resolvePublicOutcomes([claim("c4")], [resolution("r4", "c4")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source_url, "https://www.ufc.com/news/c4");
  assert.equal(out[0].resolved_by, "operator");
});

test("a withdrawn, automatic or mismatched resolution is NOT public", () => {
  const c = claim("c5");
  assert.deepEqual(resolvePublicOutcomes([c], [resolution("r5", "c5", { resolution_status: "withdrawn" })]), []);
  assert.deepEqual(resolvePublicOutcomes([c], [resolution("r5", "c5", { resolution_rule: "sole_claim" })]), []);
  assert.deepEqual(resolvePublicOutcomes([c], [resolution("r5", "c5", { fighter_id: "someone-else" })]), []);
  assert.deepEqual(resolvePublicOutcomes([c], [resolution("r5", "c5", { claim_type: "tuf_invite" })]), []);
});

test("removing or changing a resolution does not touch the evidence", () => {
  const claims = [claim("c6")];
  const frozen = JSON.stringify(claims);
  resolvePublicOutcomes(claims, [resolution("r6", "c6")]);
  resolvePublicOutcomes(claims, [resolution("r6", "c6", { resolution_status: "withdrawn" })]);
  resolvePublicOutcomes(claims, []);
  assert.equal(JSON.stringify(claims), frozen, "the claim rows were mutated");
  assert.equal(claims.length, 1, "evidence disappeared with its resolution");
});

test("a DWCS win alone can never create an outcome", () => {
  /* A winner with no claims and no resolutions: nothing public, and the
     alumni contract filter cannot select them. */
  assert.deepEqual(resolvePublicOutcomes([], []), []);
  const winner: Any = { fighter: { id: "w1", name: "Winner" }, appearances: [{ outcome: "W", identity: { series: "dwcs", season: 5 } }], reachedUfc: true };
  const byFighter = groupByFighter(resolvePublicOutcomes([], []));
  const hasContract = (id: string) => (byFighter.get(id) || []).some((c) => c.claim_type === "contract_awarded");
  assert.deepEqual(filterAlumni([winner], { filter: "contract", series: null, rank: () => null, hasContractClaim: hasContract }), []);
});

test("the contract filter exists only when a resolved public contract exists", () => {
  assert.equal(contractFilterAvailable(new Map()), false);
  assert.equal(contractFilterAvailable(groupByFighter(resolvePublicOutcomes([claim("c7")], []))), false, "unresolved evidence must not enable it");
  const dev = claim("c8", { claim_type: "developmental_deal" });
  assert.equal(contractFilterAvailable(groupByFighter(resolvePublicOutcomes([dev], [resolution("r8", "c8", { claim_type: "developmental_deal" })]))), false, "a developmental deal is not a contract");
  const resolved = groupByFighter(resolvePublicOutcomes([claim("c9")], [resolution("r9", "c9")]));
  assert.equal(contractFilterAvailable(resolved), true);
  assert.equal(resolvedContractCount(resolved), 1);
});

test("two approved resolutions for one outcome display once", () => {
  const out = resolvePublicOutcomes([claim("c10"), claim("c11")], [resolution("r10", "c10"), resolution("r11", "c11")]);
  assert.equal(out.length, 1);
});
