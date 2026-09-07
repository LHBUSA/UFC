/**
 * TUF archive validation.
 *
 *   node --test web/lib/tuf.test.ts
 *
 * Two properties carry the weight here.
 *
 * First: an unsanctioned bout must never reach a professional record, and "we
 * do not know" must behave like "does not count" rather than like "counts".
 *
 * Second, and newer: classification is per bout and must be SOURCED. There is
 * no blanket rule that a house bout is an exhibition — that happens to be true
 * of the season loaded so far, and the tests below prove it is being decided
 * bout by bout rather than assumed, including for the exceptions where a
 * tournament bout was contested on a sanctioned card.
 */
import test from "node:test";
import assert from "node:assert/strict";
import inventoryJson from "../data/tuf/seasons.json" with { type: "json" };
import tuf22Json from "../data/tuf/seasons/tuf-22.json" with { type: "json" };

type Bout = {
  a: string; b: string; winner: string | null; method: string | null;
  round: number | null; time: string | null; episode: number | null;
  classification: string; classification_source?: string | null;
  on_finale_card?: boolean; tournament_deciding?: boolean; dispute?: string;
};
type Stage = { stage: string; label: string; status?: string; note?: string; bouts: Bout[]; disputed?: Bout[] };
type Season = Record<string, unknown> & {
  slug: string; coverage: string; season_state: string; detail?: string;
  winners: Array<{ weight_class: string; fighter: string }>;
  finalists?: Array<{ weight_class: string; fighters: string[] }>;
  finale_event: string | null; finale_date: string | null; edition: string;
};

const inventory = inventoryJson as unknown as {
  editions: Array<{ key: string }>;
  seasons: Season[];
  _conflicts: Array<{ scope: string; field: string }>;
  _coverage_model: { buckets: Record<string, string> };
};
const tuf22 = tuf22Json as unknown as {
  bracket: Array<{ weight_class: string; stages: Stage[] }>;
  _conflicts: Array<{ field: string }>;
  champions: Array<{ fighter: string; verified_against?: string; won_tournament: boolean; received_contract: boolean }>;
};

const seasons = inventory.seasons;
const stages = tuf22.bracket.flatMap((wc) => wc.stages);
const bouts = stages.flatMap((st) => st.bouts);

/** Mirrors lib/tuf.ts. Professional AND sourced. */
const counts = (b: Bout) => b.classification === "professional" && Boolean(b.classification_source);

/* ---- coverage model ------------------------------------------------------ */

test("coverage buckets are mutually exclusive and sum to the season count", () => {
  const buckets = Object.keys(inventory._coverage_model.buckets);
  const tally = new Map(buckets.map((b) => [b, 0]));
  for (const s of seasons) {
    assert.ok(tally.has(s.coverage), `${s.slug}: coverage "${s.coverage}" is not a declared bucket`);
    tally.set(s.coverage, tally.get(s.coverage)! + 1);
  }
  const sum = [...tally.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, seasons.length, "every season must be in exactly one bucket");
});

test("season state is a separate axis from coverage", () => {
  for (const s of seasons) {
    assert.ok(["completed", "ongoing"].includes(s.season_state), `${s.slug}: bad season_state`);
    /* An ongoing season can still have a loaded bracket, and a finished one
     * can be entirely unloaded — the two axes must not be entangled. */
    assert.ok(!("status" in s), `${s.slug}: the old conflated 'status' field must be gone`);
  }
});

test("a finale we hold is not counted as tournament coverage", () => {
  const withFinale = seasons.filter((s) => s.finale_event);
  assert.ok(withFinale.length > 1, "several seasons name a finale");
  const loaded = withFinale.filter((s) => s.coverage !== "metadata_only");
  assert.ok(
    loaded.length < withFinale.length,
    "naming a finale must not by itself lift a season out of metadata_only",
  );
});

test("only a season with a bracket claims bracket coverage", () => {
  for (const s of seasons) {
    if (s.coverage === "metadata_only") continue;
    assert.ok(s.detail, `${s.slug} claims bracket coverage but has no detail file`);
  }
});

test("TUF 22 is partial while its opening round is disputed", () => {
  const t22 = seasons.find((s) => s.slug === "tuf-22")!;
  assert.equal(t22.coverage, "bracket_partial");
  assert.ok(tuf22._conflicts.some((c) => c.field === "round_of_16"), "and the reason is recorded");
});

/* ---- classification ------------------------------------------------------ */

test("every bout is classified individually, with a source behind the claim", () => {
  const allowed = new Set(["professional", "exhibition", "unverified"]);
  for (const b of bouts) {
    assert.ok(allowed.has(b.classification), `${b.a} vs ${b.b}: bad classification`);
    if (b.classification !== "unverified") {
      assert.ok(b.classification_source, `${b.a} vs ${b.b}: a classification other than unverified must cite what established it`);
    }
  }
});

test("there is no blanket rule: classification varies within the same season", () => {
  /* If every bout in a season carried the same classification, that would be
   * indistinguishable from applying a rule to the TUF label. It does not. */
  const kinds = new Set(bouts.map((b) => b.classification));
  assert.ok(kinds.size > 1, "a season's bouts must not all share one classification by default");
  assert.ok(kinds.has("professional") && kinds.has("exhibition"));
});

test("the exception is decided by where a bout was contested, not by its stage", () => {
  /* A final is not professional because it is a final. It is professional
   * because it happened on a sanctioned card — and in seasons where the final
   * was fought in the house instead, the same stage is an exhibition. */
  const finals = stages.filter((s) => s.stage === "final").flatMap((s) => s.bouts);
  for (const f of finals) {
    if (f.on_finale_card) {
      assert.equal(f.classification, "professional", `${f.a} vs ${f.b}: on a sanctioned card`);
      assert.match(String(f.classification_source), /sanctioned/i);
    } else {
      assert.notEqual(f.classification, "professional", `${f.a} vs ${f.b}: a final off a sanctioned card is not professional`);
    }
  }
  const houseBouts = stages.filter((s) => s.stage !== "final").flatMap((s) => s.bouts);
  for (const b of houseBouts) {
    assert.notEqual(b.classification, "professional", `${b.a} vs ${b.b}: not contested on a card`);
  }
});

test("exhibition and unverified are excluded from a professional record", () => {
  const pro = bouts.filter(counts);
  assert.equal(pro.length, 1, "TUF 22 contributes exactly one professional bout: the final");
  assert.equal(bouts.length - pro.length, 30, "every other bout is excluded");
  assert.equal(counts({ classification: "unverified" } as Bout), false);
  /* And a professional label with nothing behind it still does not count. */
  assert.equal(counts({ classification: "professional", classification_source: null } as Bout), false);
});

/* ---- completeness and honesty -------------------------------------------- */

test("TUF 22 carries a full opening round, not an empty one", () => {
  const elim = stages.find((s) => s.stage === "elimination")!;
  assert.equal(elim.bouts.length, 16, "sixteen entry bouts decided the sixteen who entered the house");
  const r16 = stages.find((s) => s.stage === "round_of_16")!;
  assert.equal(r16.bouts.length, 8, "eight bouts take sixteen to eight");
});

test("an irreconcilable bout is shown but never counted", () => {
  const r16 = stages.find((s) => s.stage === "round_of_16")!;
  assert.ok(r16.disputed?.length, "the duplicate the source lists is kept visible");
  for (const d of r16.disputed!) {
    assert.ok(d.dispute, "a disputed entry must say why");
    assert.equal(counts(d), false, "and must not count towards anything");
  }
  /* Disputed entries live outside `bouts`, so no aggregate can pick them up. */
  assert.ok(!bouts.some((b) => b === r16.disputed![0]));
});

test("the champion is verified against a real finale result, not a summary", () => {
  const c = tuf22.champions[0];
  assert.equal(c.fighter, "Ryan Hall");
  assert.match(String(c.verified_against), /ufc_bout_results/);
  /* Winning the tournament and getting a contract are separate facts. */
  assert.ok("won_tournament" in c && "received_contract" in c);
});

test("episode number and fight date stay separate fields", () => {
  for (const b of bouts) assert.ok("episode" in b, "every bout carries an episode slot, even when null");
  assert.ok(!bouts.some((b) => "date" in b), "no bare 'date' that could be confused with an airdate");
});

test("an ongoing season never carries a winner", () => {
  for (const s of seasons) {
    if (s.season_state === "ongoing") assert.deepEqual(s.winners, [], `${s.slug} is ongoing`);
  }
});

test("a season with disputed winners records finalists, not a guess", () => {
  const t33 = seasons.find((s) => s.slug === "tuf-33")!;
  assert.deepEqual(t33.winners, []);
  assert.ok((t33.finalists ?? []).length > 0);
  assert.ok(inventory._conflicts.some((c) => c.scope === "tuf-33"));
});

test("every season has a unique slug in a declared edition, and the internationals are present", () => {
  const editions = new Set(inventory.editions.map((e) => e.key));
  const seen = new Set<string>();
  const byEdition = new Map<string, number>();
  for (const s of seasons) {
    assert.ok(!seen.has(s.slug), `duplicate slug ${s.slug}`);
    seen.add(s.slug);
    assert.ok(editions.has(s.edition), `${s.slug}: unknown edition`);
    byEdition.set(s.edition, (byEdition.get(s.edition) ?? 0) + 1);
  }
  for (const key of ["brazil", "latam", "china", "nations", "smashes"]) {
    assert.ok((byEdition.get(key) ?? 0) > 0, `edition ${key} has no seasons`);
  }
  assert.ok((byEdition.get("us") ?? 0) >= 34);
});

test("a finale is matched by participant and date, not by the word Finale", () => {
  /* Modern and international seasons put their tournament finals on ordinary
   * UFC cards. Requiring "Finale" in the name reported seven seasons as
   * missing whose cards we already held, so any season whose finale does not
   * carry the word must say how it was resolved instead. */
  let offName = 0;
  for (const s of seasons) {
    if (!s.finale_event) continue;
    assert.match(String(s.finale_date), /^\d{4}-\d{2}-\d{2}$/, `${s.slug}: finale date must be ISO`);
    if (!/Finale$/.test(s.finale_event)) {
      offName += 1;
      assert.ok(
        (s as Record<string, unknown>).finale_link_basis,
        `${s.slug}: a finale not named "Finale" must record how it was matched`,
      );
    }
  }
  assert.ok(offName > 0, "the archive should contain finales resolved by participant rather than by name");
});
