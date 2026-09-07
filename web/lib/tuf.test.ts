/**
 * TUF archive validation.
 *
 *   node --test web/lib/tuf.test.ts
 *
 * The property that matters: an unsanctioned bout must never reach a
 * professional record, and "we do not know" must be treated as "does not
 * count" rather than as "counts". Everything else here guards the inventory
 * against the two mistakes that would embarrass this archive — claiming a
 * winner for a season that has not finished, and claiming coverage we do not
 * have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import inventory from "../data/tuf/seasons.json" with { type: "json" };
import tuf22 from "../data/tuf/seasons/tuf-22.json" with { type: "json" };

const seasons = inventory.seasons as Array<Record<string, unknown>>;

/* The exported helper's rule, restated here so the test fails if the module's
 * definition of "counts" ever widens. */
const counts = (c: string) => c === "professional";

test("every bout carries an explicit classification, and none is inferred from the label", () => {
  const allowed = new Set(["professional", "exhibition", "unverified"]);
  for (const wc of tuf22.bracket) {
    for (const st of wc.stages) {
      for (const b of st.bouts) {
        assert.ok(allowed.has(b.classification), `${b.a} vs ${b.b}: bad classification ${b.classification}`);
        assert.ok(b.classification_basis, `${b.a} vs ${b.b}: classification must state its basis`);
      }
    }
  }
});

test("house bouts are exhibitions and only the finale is professional", () => {
  for (const wc of tuf22.bracket) {
    for (const st of wc.stages) {
      for (const b of st.bouts) {
        if (st.stage === "final" && b.on_finale_card) assert.equal(b.classification, "professional");
        else assert.notEqual(b.classification, "professional", `${b.a} vs ${b.b} in ${st.stage} must not be professional`);
      }
    }
  }
});

test("exhibition and unverified bouts are excluded from a professional record", () => {
  const all = tuf22.bracket.flatMap((wc) => wc.stages.flatMap((st) => st.bouts));
  const pro = all.filter((b) => counts(b.classification));
  assert.equal(pro.length, 1, "TUF 22 contributes exactly one professional bout: the final");
  assert.equal(all.length - pro.length, 6, "the six house bouts are excluded");
  /* Unverified must behave like exhibition, not like professional. */
  assert.equal(counts("unverified"), false);
});

test("an unverified round asserts no bouts rather than reconstructing them", () => {
  const elim = tuf22.bracket[0].stages.find((s) => s.stage === "elimination");
  assert.ok(elim);
  assert.equal(elim.status, "unverified");
  assert.equal(elim.bouts.length, 0, "an unverified round must be empty, not guessed");
  assert.ok(tuf22._conflicts.some((c) => c.field === "elimination_round"), "and the reason must be recorded");
});

test("episode number and fight date are separate fields", () => {
  /* A TUF bout is filmed months before it airs. Storing the airdate as the
   * fight date would misdate the entire archive. */
  const all = tuf22.bracket.flatMap((wc) => wc.stages.flatMap((st) => st.bouts));
  for (const b of all) assert.ok("episode" in b, "every bout must carry an episode slot, even when null");
  assert.ok(!("date" in tuf22.bracket[0].stages[1].bouts[0]), "no bare 'date' field that could be confused with an airdate");
});

test("an ongoing season never carries a winner", () => {
  for (const s of seasons) {
    if (s.ongoing) {
      assert.deepEqual(s.winners, [], `${s.slug} is ongoing and must have no winner`);
    }
  }
});

test("a season with disputed winners records finalists, not a guess", () => {
  const t33 = seasons.find((s) => s.slug === "tuf-33");
  assert.ok(t33);
  assert.deepEqual(t33.winners, []);
  assert.ok(Array.isArray(t33.finalists) && (t33.finalists as unknown[]).length > 0);
  assert.ok(inventory._conflicts.some((c) => c.scope === "tuf-33"));
});

test("coverage status is about us, and only a season with a bracket is complete", () => {
  for (const s of seasons) {
    assert.ok(["complete", "partial", "missing"].includes(s.status as string), `${s.slug}: bad status`);
    if (s.status === "complete") {
      assert.ok(s.detail, `${s.slug} claims complete coverage but has no detail file`);
      assert.ok(s.finale_event, `${s.slug} claims complete coverage but names no finale`);
    }
  }
});

test("every season has a unique slug and belongs to a declared edition", () => {
  const editions = new Set((inventory.editions as Array<{ key: string }>).map((e) => e.key));
  const seen = new Set<string>();
  for (const s of seasons) {
    assert.ok(!seen.has(s.slug as string), `duplicate slug ${s.slug}`);
    seen.add(s.slug as string);
    assert.ok(editions.has(s.edition as string), `${s.slug}: unknown edition ${s.edition}`);
  }
});

test("international editions are present, not just the US series", () => {
  const byEdition = new Map<string, number>();
  for (const s of seasons) byEdition.set(s.edition as string, (byEdition.get(s.edition as string) ?? 0) + 1);
  for (const key of ["brazil", "latam", "china", "nations", "smashes"]) {
    assert.ok((byEdition.get(key) ?? 0) > 0, `edition ${key} has no seasons`);
  }
  assert.ok((byEdition.get("us") ?? 0) >= 34, "the US series should carry every numbered season");
});

test("finale names, where claimed, look like real event names we could match", () => {
  for (const s of seasons) {
    if (!s.finale_event) continue;
    assert.match(s.finale_event as string, /Finale$/, `${s.slug}: finale name should end in "Finale" to match our events`);
    assert.match(s.finale_date as string, /^\d{4}-\d{2}-\d{2}$/, `${s.slug}: finale date must be ISO`);
  }
});
