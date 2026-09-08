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
import { readdirSync, readFileSync } from "node:fs";
import inventoryJson from "../data/tuf/seasons.json" with { type: "json" };
import tuf22Json from "../data/tuf/seasons/tuf-22.json" with { type: "json" };
import tuf1Json from "../data/tuf/seasons/tuf-1.json" with { type: "json" };
import tuf20Json from "../data/tuf/seasons/tuf-20.json" with { type: "json" };
import tuf5Json from "../data/tuf/seasons/tuf-5.json" with { type: "json" };

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

/* Read off disk rather than listed by hand. A list is a thing you forget to
 * add to, and a season missing from it would skip every rule below while
 * looking fully checked — the failure mode that matters least when there are
 * four seasons and most when there are forty. Tests do not need bundling, so
 * there is no reason for them to carry the bundler's constraint. */
const DETAIL_DIR = new URL("../data/tuf/seasons/", import.meta.url);
const DETAIL_BY_SLUG: Record<string, { bracket?: Array<{ weight_class: string; stages: Stage[] }> }> =
  Object.fromEntries(
    readdirSync(DETAIL_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [
        f.replace(/\.json$/, ""),
        JSON.parse(readFileSync(new URL(f, DETAIL_DIR), "utf8")) as { bracket?: Array<{ weight_class: string; stages: Stage[] }> },
      ]),
  );
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
  /* Originally this checked that some season naming a finale was still
   * metadata_only — a proxy for "coverage is not just mirroring finale_event",
   * and one that only worked while most of the archive was unloaded. Now that
   * every season carries a bracket the proxy is vacuous, so the property it
   * stood for is asserted directly, in both directions: coverage is a claim
   * about the bracket and about nothing else. */
  const withFinale = seasons.filter((s) => s.finale_event);
  assert.ok(withFinale.length > 1, "several seasons name a finale");

  for (const s of seasons) {
    const bracket = DETAIL_BY_SLUG[s.slug]?.bracket ?? [];
    const hasBouts = bracket.some((d) => d.stages.some((st) => st.bouts.length));
    if (s.coverage === "metadata_only") {
      assert.ok(
        !hasBouts,
        `${s.slug}: has a bracket with bouts but is filed as metadata_only`,
      );
    } else {
      assert.ok(
        hasBouts,
        `${s.slug}: claims ${s.coverage} without a bracket holding any bout — a named finale is not tournament coverage`,
      );
    }
  }
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

test("classification follows evidence, and is never applied by label", () => {
  /* Deliberately NOT a rule that classifications must vary — a season whose
   * every bout was contested the same way legitimately has one value
   * throughout. What must hold is that each bout was decided on its own
   * evidence, which is what the source field records. */
  for (const b of bouts) {
    if (b.classification === "unverified") continue;
    assert.ok(
      b.classification_source && b.classification_source.length > 8,
      `${b.a} vs ${b.b}: classification must cite the evidence behind it, not the TUF label`,
    );
  }
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

/* ---- finale matching: regressions for two real false positives ---------- */

test("a champion merely appearing on a card is not a finale match", () => {
  /* Both of these were linked by an earlier pass that matched on a champion
   * being somewhere on a card. Chad Laprise fought Yosdenis Cedeno that night,
   * not his tournament final; Zhang Lipeng fought Brendan O'Reilly, not Wang
   * Sai. Named explicitly so neither can come back. */
  const rejected: Array<[string, string]> = [
    ["tuf-nations-1", "UFC Fight Night: MacDonald vs Saffiedine"],
    ["tuf-china-1", "UFC Fight Night: Bisping vs Le"],
  ];
  for (const [slug, wrongCard] of rejected) {
    const s = seasons.find((x) => x.slug === slug)!;
    assert.notEqual(s.finale_event, wrongCard, `${slug} must not be linked to ${wrongCard}`);
    assert.equal(s.finale_event, null, `${slug}: an unverified finale link stays empty`);
    assert.equal(s.finale_date, null);
    assert.ok(
      (s as Record<string, unknown>).unresolved_finale,
      `${slug}: a withdrawn match must record what was wrong and what blocks it`,
    );
  }
});

test("every off-name finale link is backed by an exact finalist-versus-finalist bout", () => {
  for (const s of seasons) {
    if (!s.finale_event) continue;
    assert.match(String(s.finale_date), /^\d{4}-\d{2}-\d{2}$/, `${s.slug}: finale date must be ISO`);
    if (/Finale$/.test(s.finale_event)) continue;
    const finals = (s as Record<string, unknown>).final_bouts as
      | Array<{ a: string; b: string; event: string; date: string; verified_against?: string }>
      | undefined;
    assert.ok(finals?.length, `${s.slug}: a card not named "Finale" needs the matchup that proves it`);
    for (const f of finals!) {
      assert.ok(f.a && f.b && f.a !== f.b, `${s.slug}: a final needs two distinct finalists`);
      assert.match(String(f.verified_against), /ufc_bouts/, `${s.slug}: verified against our own records`);
      assert.match(String(f.date), /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test("finals contested on separate cards are supported", () => {
  /* final_bouts is a list and each entry carries its own event and date, so a
   * season whose divisions were decided on different nights is representable
   * rather than forced onto one card. */
  for (const s of seasons) {
    const finals = (s as Record<string, unknown>).final_bouts as Array<{ event: string; date: string }> | undefined;
    if (!finals) continue;
    for (const f of finals) assert.ok(f.event && f.date, `${s.slug}: each final carries its own event and date`);
  }
});

test("a champion who won a title rather than a contract records both facts distinctly", () => {
  /* TUF 20's winner received the inaugural strawweight championship, not a
   * contract. Collapsing the two would misdescribe every season that did it
   * one way or the other. */
  const t20 = tuf20Json as unknown as {
    champions: Array<{ won_tournament: boolean; received_contract: boolean; received_title?: string; verified_against?: string }>;
  };
  const c = t20.champions[0];
  assert.equal(c.won_tournament, true);
  assert.equal(c.received_contract, false, "she did not receive a contract");
  assert.ok(c.received_title, "she received a championship, and it is recorded as such");
  assert.match(String(c.verified_against), /ufc_bout_results/);
});

test("a season claiming full bracket coverage has no unverified round and no dispute", () => {
  const full = seasons.filter((s) => s.coverage === "bracket_full");
  assert.ok(full.length > 0, "at least one season should be fully loaded by now");
  for (const s of full) {
    const detail = DETAIL_BY_SLUG[s.slug];
    assert.ok(detail, `${s.slug}: claims full coverage but has no detail file`);
    assert.ok(detail.bracket?.length, `${s.slug}: claims full coverage but its detail file has no bracket`);
    for (const wc of detail.bracket!) {
      for (const st of wc.stages) {
        assert.notEqual(st.status, "unverified", `${s.slug}/${st.stage}: full coverage cannot contain an unverified round`);
        assert.ok(!st.disputed?.length, `${s.slug}/${st.stage}: full coverage cannot contain a disputed bout`);
        assert.ok(st.bouts.length > 0, `${s.slug}/${st.stage}: a stage in a full bracket must have bouts`);
      }
    }
  }
});

test("a champion who lost the matched bout is never recorded as verified", () => {
  /* TUF 24: the only bout we hold for Tim Elliott on that card is the
   * flyweight title fight he LOST to Demetrious Johnson, not his tournament
   * final. Being on the finale card is not the same as winning the tournament
   * there — the same mistake the Nations and China links made. */
  const t24 = seasons.find((s) => s.slug === "tuf-24")!;
  const blocked = (t24 as Record<string, unknown>).champion_verification_blocked as
    | { actual_winner: string; fighter: string; why: string }
    | undefined;
  assert.ok(blocked, "tuf-24 must record why its champion could not be verified");
  assert.notEqual(blocked!.actual_winner, blocked!.fighter);
  assert.ok(!(t24 as Record<string, unknown>).final_bouts, "and must carry no verified final");
});

test("a differing spelling is recorded, not resolved away", () => {
  /* TUF 26's champion is "Nicco Montaño" in the season record and "Nicco
   * Montano" in ufc_fighters. The verified row carries the database's
   * spelling — it has to, that is what was matched — and keeps the archive's
   * beside it rather than quietly adopting one as the truth. */
  const t26 = seasons.find((s) => s.slug === "tuf-26")!;
  const finals = (t26 as Record<string, unknown>).final_bouts as Array<{ winner?: string; name_in_archive?: string }>;
  assert.ok(finals?.length, "tuf-26 should be verified");
  const f = finals[0];
  assert.ok(f.name_in_archive, "the archive's spelling must be preserved when it differs");
  assert.notEqual(f.name_in_archive, f.winner, "and it must differ, which is the point of the field");
});

test("every verified final records the champion as the winner", () => {
  for (const s of seasons) {
    const finals = (s as Record<string, unknown>).final_bouts as
      | Array<{ a: string; b: string; winner?: string; verified_against?: string }>
      | undefined;
    if (!finals) continue;
    for (const f of finals) {
      if (!f.winner) continue;
      assert.ok(
        f.winner === f.a || f.winner === f.b,
        `${s.slug}: the recorded winner must be one of the two fighters`,
      );
      /* Accent-folded, because the archive spells names as its sources do and
       * ufc_fighters generally does not — "Nicco Montaño" and "Nicco Montano"
       * are one person. A verified row records the database's spelling and
       * keeps the archive's in name_in_archive, so both survive. */
      const fold = (n: string) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      /* Two spellings are allowed to stand for the champion: the winner as our
       * database records it, and the archive's own spelling in name_in_archive.
       * Folding closes an accent gap ("Montaño" / "Montano") but not a naming
       * one — our row for the TUF Brazil 4 lightweight champion carries a third
       * name the archive's does not. That is a declaration, not a fuzzy match:
       * a winner who is not the champion still fails unless the file says
       * outright which champion the spelling belongs to. */
      const spellings = [f.winner!, (f as { name_in_archive?: string }).name_in_archive].filter(Boolean) as string[];
      assert.ok(
        s.winners.some((w) => spellings.some((n) => fold(w.fighter) === fold(n))),
        `${s.slug}: a verified final must be won by a recorded champion, not merely contested by one`,
      );
    }
  }
});

test("an alternate spelling only excuses the champion, never a different fighter", () => {
  /* The rule above accepts name_in_archive as a second spelling of the winner.
   * That must not become a hole a stranger fits through: a bout whose winner is
   * nobody's champion under either spelling still has to fail. */
  const fold = (n: string) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const champions = ["Glaico França"];
  const passes = (winner: string, archive?: string) =>
    [winner, archive].filter(Boolean).some((n) => champions.some((c) => fold(c) === fold(n as string)));

  assert.ok(passes("Glaico Franca Moreira", "Glaico França"), "the declared archive spelling is accepted");
  assert.ok(!passes("Fernando Bruno", undefined), "the losing finalist is not");
  assert.ok(!passes("Fernando Bruno", "Fernando Bruno"), "and declaring his own name does not launder him into the champion");
});
