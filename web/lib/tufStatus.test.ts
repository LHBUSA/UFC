/**
 *   node --experimental-strip-types --test lib/tufStatus.test.ts
 *
 * The hub states two derived facts per season and keeps them apart: whether
 * the competition the season actually ran is represented (structure), and
 * whether the season clears the evidence bar. These tests hold the known
 * seasons to that, prove evidence gaps never lower structure, prove a missing
 * competition bout still does, and keep bracket language off the hub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { evidenceOf, fingerprint, hubStatus, structureOf, type StatusArtifact, type StatusSeasonDetail, type StatusSeasonRow } from "./tufStatus.ts";

const url = (p: string) => new URL(p, import.meta.url);
const json = <T,>(p: string): T => JSON.parse(readFileSync(url(p), "utf8")) as T;
type Row = StatusSeasonRow & Record<string, unknown>;
const inventory = json<{ editions: Array<{ key: string; blurb: string }>; seasons: Row[] }>("../data/tuf/seasons.json");
const artifact = json<StatusArtifact>("../data/tuf/status.generated.json");
const detailOf = (slug: string) => (existsSync(url(`../data/tuf/seasons/${slug}.json`)) ? json<StatusSeasonDetail & Record<string, unknown>>(`../data/tuf/seasons/${slug}.json`) : null);
const episodesOf = (slug: string) => (existsSync(url(`../data/tuf/episodes/${slug}.json`)) ? json<unknown>(`../data/tuf/episodes/${slug}.json`) : null);
const row = (slug: string) => inventory.seasons.find((s) => s.slug === slug)!;
/* Exactly what lib/tuf.ts computes at render time. */
const statusOf = (slug: string, detail = detailOf(slug)) => {
  const r = row(slug);
  return hubStatus(r, detail, evidenceOf(r, artifact.seasons[slug], fingerprint(r, detailOf(slug), episodesOf(slug))));
};
const labels = (slug: string) => {
  const st = statusOf(slug);
  return [st.primary.label, st.secondary?.label].filter(Boolean).join(" + ").toUpperCase();
};
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/* ---- known seasons -------------------------------------------------------- */

test("TUF 1: Complete on the card, while the strict evidence verdict still counts its open conflict", () => {
  const st = statusOf("tuf-1");
  assert.equal(st.structure.structure, "complete");
  assert.equal(st.structure.basis, "declared_format", "measured against its elimination format, not a bracket");
  assert.equal(st.state, "complete");
  assert.equal(labels("tuf-1"), "COMPLETE");
  assert.equal(st.verified, false);
  /* Presentation changed; the verdict did not. The Rafferty episode-placement
   * conflict is still the one thing the matrix bar counts against the season. */
  assert.equal(st.evidence?.evidence, "gaps");
  assert.deepEqual(st.evidence!.reasons, ["OPEN_SOURCE_CONFLICT"]);
});

test("TUF 2: Complete + Verified", () => {
  const st = statusOf("tuf-2");
  assert.equal(st.state, "complete");
  assert.equal(st.verified, true);
  assert.equal(labels("tuf-2"), "COMPLETE + VERIFIED");
  assert.equal(st.evidence?.evidence, "verified");
});

test("TUF 3, 4, 5 and 25–33: Complete, whatever research remains behind them", () => {
  for (const slug of ["tuf-3", "tuf-4", "tuf-5", ...Array.from({ length: 9 }, (_, i) => `tuf-${25 + i}`)]) {
    const st = statusOf(slug);
    assert.equal(st.structure.structure, "complete", `${slug}: ${st.structure.missing.join("; ")}`);
    assert.equal(labels(slug), "COMPLETE", slug);
    assert.equal(st.evidence?.evidence, "gaps", `${slug}: the strict verdict is unchanged`);
  }
});

test("TUF 21 is measured against its points format and never described as a bracket", () => {
  const st = statusOf("tuf-21");
  assert.equal(st.structure.basis, "team_points_format");
  assert.equal(st.structure.structure, "complete");
  assert.equal(labels("tuf-21"), "COMPLETE");
});

test("TUF 34: season ongoing, and nothing else on the card", () => {
  const st = statusOf("tuf-34");
  assert.equal(st.state, "ongoing");
  assert.equal(labels("tuf-34"), "SEASON ONGOING");
});

/* ---- what cards may say --------------------------------------------------- */

test("cards say only Complete, Complete + Verified, Partial or Season ongoing — never research backlog or bracket terms", () => {
  const seen = new Set<string>();
  for (const s of inventory.seasons) {
    const l = labels(s.slug);
    seen.add(l);
    assert.ok(/^(COMPLETE|COMPLETE \+ VERIFIED|PARTIAL|SEASON ONGOING)$/.test(l), `${s.slug}: unexpected card label ${l}`);
    assert.doesNotMatch(l, /RESEARCH GAPS|FORMAT COMPLETE|STRUCTURE PARTIAL|BRACKET/, s.slug);
  }
  assert.deepEqual([...seen].sort(), ["COMPLETE", "COMPLETE + VERIFIED", "SEASON ONGOING"]);
  const page = readFileSync(url("../app/tuf/page.tsx"), "utf8");
  assert.doesNotMatch(page, /research gaps|format complete|structure partial|bracket partial|bracket complete|coverage/i, "the hub page carries none of the retired card strings");
  for (const e of inventory.editions) assert.doesNotMatch(e.blurb, /through a bracket/i, `${e.key}: seasons used different formats`);
});

test("the summary counts are consumer-friendly and add up", () => {
  const all = inventory.seasons.map((s) => statusOf(s.slug));
  const complete = all.filter((x) => x.state === "complete").length;
  const ongoing = all.filter((x) => x.state === "ongoing").length;
  const partial = all.filter((x) => x.state === "partial").length;
  const verified = all.filter((x) => x.state === "complete" && x.verified).length;
  assert.deepEqual([complete, ongoing, partial, verified, all.length], [43, 1, 0, 1, 44]);
  assert.ok(all.every((x) => !x.verified || x.state === "complete"), "Verified only ever sits on a complete season");
  const page = readFileSync(url("../app/tuf/page.tsx"), "utf8");
  assert.match(page, /complete seasons/);
  assert.match(page, /verified by primary records/);
});

test("non-bracket seasons are never measured as brackets", () => {
  for (const s of inventory.seasons) {
    const d = detailOf(s.slug);
    const st = structureOf(s, d);
    if (d?.competition_format?.phases?.length) assert.equal(st.basis, "declared_format", s.slug);
    if (d?.team_competition) assert.equal(st.basis, "team_points_format", s.slug);
  }
});

/* ---- structure versus evidence ------------------------------------------- */

test("evidence gaps never downgrade structure", () => {
  for (const slug of ["tuf-3", "tuf-1"]) {
    const d = clone(detailOf(slug)!) as StatusSeasonDetail & { _conflicts?: unknown[]; bracket: Array<{ weight_class: string; stages: Array<{ stage: string; status?: string; bouts: Array<Record<string, unknown>> }> }> };
    d._conflicts = [...(d._conflicts ?? []), { field: "final", detail: "two sources disagree" }];
    for (const wc of d.bracket) for (const st of wc.stages) {
      st.status = "unverified";
      for (const b of st.bouts) {
        b.classification = "unverified"; b.classification_source = null;   // unresolved classification
        delete b.a_fighter_id; delete b.b_fighter_id;                        // unresolved identity
        b.sources = [{ family: "wikipedia", fields: ["winner"] }];           // secondary-only result
        b.method = null; b.time = null;
      }
    }
    assert.equal(structureOf(row(slug), d).structure, "complete", slug);
  }
});

test("a genuinely missing competition bout makes the card Partial", () => {
  type D = StatusSeasonDetail & { bracket: Array<{ weight_class: string; stages: Array<{ stage: string; bouts: unknown[] }> }>; team_competition?: { standings?: unknown[] } };
  const cases: Array<[string, (d: D) => void]> = [
    ["tuf-3", (d) => { d.bracket[0].stages.find((s) => s.stage === "quarter_final")!.bouts.pop(); }],
    ["tuf-3", (d) => { d.bracket[0].stages = d.bracket[0].stages.filter((s) => s.stage !== "final"); }],
    ["tuf-3", (d) => { d.bracket.pop(); }],
    ["tuf-1", (d) => { d.bracket[0].stages.find((s) => s.stage === "semi_final")!.bouts.pop(); }],
    ["tuf-21", (d) => { d.team_competition!.standings = []; }],
  ];
  for (const [slug, mutate] of cases) {
    const d = clone(detailOf(slug)!) as D;
    mutate(d);
    const r = row(slug);
    const st = hubStatus(r, d, { evidence: "verified", reasons: [] });
    assert.equal(st.structure.structure, "partial", `${slug}: ${mutate.toString()}`);
    assert.equal(st.primary.label.toUpperCase(), "PARTIAL");
    assert.equal(st.secondary, null, "no badge beside Partial");
  }
  assert.equal(structureOf(row("tuf-3"), null).structure, "partial", "no season data at all is not structure");
});

/* ---- the evidence artifact ------------------------------------------------- */

test("the evidence artifact covers every season and matches the current season data", () => {
  const slugs = readdirSync(url("../data/tuf/seasons/")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  for (const s of inventory.seasons) {
    const entry = artifact.seasons[s.slug];
    assert.ok(entry, `${s.slug}: not in status.generated.json — re-run scripts/tuf/completeness_matrix.mjs`);
    assert.equal(entry.fingerprint, fingerprint(s, detailOf(s.slug), episodesOf(s.slug)), `${s.slug}: season data changed since the matrix ran — re-run scripts/tuf/completeness_matrix.mjs`);
  }
  assert.equal(Object.keys(artifact.seasons).length, inventory.seasons.length);
  assert.ok(slugs.every((sl) => artifact.seasons[sl]), "every detail file is measured");
});

test("a stale or missing evidence verdict is never shown as verified", () => {
  const r = row("tuf-2");
  const entry = artifact.seasons["tuf-2"];
  assert.equal(evidenceOf(r, { ...entry, fingerprint: "00000000" }, entry.fingerprint).evidence, "gaps");
  assert.equal(evidenceOf(r, undefined, entry.fingerprint).evidence, "gaps");
  assert.equal(evidenceOf({ ...r, completion_unverified: true }, entry, entry.fingerprint).evidence, "gaps");
});

test("the strict evidence layer is untouched: verdicts, fingerprints and structure rules", () => {
  /* Verdicts straight from the matrix export, independent of any card text. */
  assert.equal(artifact.seasons["tuf-2"].matrix_status, "COMPLETE");
  assert.equal(inventory.seasons.filter((s) => artifact.seasons[s.slug]?.matrix_status === "COMPLETE").length, 1);
  const entry = artifact.seasons["tuf-2"];
  assert.equal(evidenceOf(row("tuf-2"), { ...entry, fingerprint: "00000000" }, entry.fingerprint).evidence, "gaps", "a stale verdict is still never verified");
  const t1 = detailOf("tuf-1")!;
  const broken = clone(t1) as StatusSeasonDetail & { bracket: Array<{ stages: Array<{ stage: string; bouts: unknown[] }> }> };
  broken.bracket[0].stages = broken.bracket[0].stages.filter((x) => x.stage !== "final");
  assert.equal(structureOf(row("tuf-1"), broken).structure, "partial", "structure rules unchanged");
  const matrix = readFileSync(url("../../scripts/tuf/completeness_matrix.mjs"), "utf8");
  assert.match(matrix, /HOUSE_RESULTS_SECONDARY_ONLY/);
  assert.match(matrix, /OPEN_SOURCE_CONFLICT/);
});
