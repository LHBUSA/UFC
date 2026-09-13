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
import completenessJson from "../data/tuf/record_completeness.json" with { type: "json" };
import inventoryJson from "../data/tuf/seasons.json" with { type: "json" };
import tuf22Json from "../data/tuf/seasons/tuf-22.json" with { type: "json" };
import tuf1Json from "../data/tuf/seasons/tuf-1.json" with { type: "json" };
import tuf20Json from "../data/tuf/seasons/tuf-20.json" with { type: "json" };
import tuf5Json from "../data/tuf/seasons/tuf-5.json" with { type: "json" };
import { advancementProblems, expectedBouts } from "./tufFormat.ts";
import { buildEpisodeViews, rosterMarks, timelineCounts } from "./tufTimeline.ts";
import { classState, resultState } from "./tufBoutState.ts";
import { structureOf } from "./tufStatus.ts";

type Bout = {
  a: string; b: string; winner: string | null; method: string | null;
  round: number | null; time: string | null; episode: number | null;
  classification: string; classification_source?: string | null;
  on_finale_card?: boolean; tournament_deciding?: boolean; dispute?: string;
};
type Stage = { stage: string; label: string; status?: string; note?: string; bouts: Bout[]; disputed?: Bout[] };
type Season = Record<string, unknown> & {
  slug: string; season_state: "completed" | "ongoing"; detail?: string; year: number; weight_classes: string[];
  winners: Array<{ weight_class: string; fighter: string }>;
  finalists?: Array<{ weight_class: string; fighters: string[] }>;
  finale_event: string | null; finale_date: string | null; edition: string;
};

const inventory = inventoryJson as unknown as {
  editions: Array<{ key: string }>;
  seasons: Season[];
  _conflicts: Array<{ scope: string; field: string }>;
  _status_model: Record<string, string>;
};
const tuf22 = tuf22Json as unknown as {
  bracket: Array<{ weight_class: string; stages: Stage[] }>;
  _conflicts: Array<{ field: string }>;
  champions: Array<{ fighter: string; verified_against?: string; won_tournament: boolean; received_contract: boolean }>;
};

const completeness = completenessJson as unknown as { years: Record<string, { complete: boolean }> };
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

/* ---- status model -------------------------------------------------------- */

test("no stored coverage label remains: status is derived, not maintained", () => {
  for (const x of seasons) assert.ok(!("coverage" in x), `${x.slug}: the legacy coverage label must be gone`);
  assert.ok(!("_coverage_model" in inventory), "the legacy bucket model must be gone");
  assert.ok(inventory._status_model?.rule, "the derived status model is documented instead");
});

test("season state is a separate axis from structure", () => {
  for (const x of seasons) {
    assert.ok(["completed", "ongoing"].includes(x.season_state), `${x.slug}: bad season_state`);
    assert.ok(!("status" in x), `${x.slug}: the old conflated 'status' field must be gone`);
  }
});

test("a finale we hold is not structure: structure needs competition bouts", () => {
  const withFinale = seasons.filter((x) => x.finale_event);
  assert.ok(withFinale.length > 1, "several seasons name a finale");
  for (const x of seasons) {
    const d = DETAIL_BY_SLUG[x.slug];
    const hasBouts = (d?.bracket ?? []).some((wc) => wc.stages.some((st) => st.bouts.length));
    if (structureOf(x, d).structure === "complete") assert.ok(hasBouts || (d as { team_competition?: unknown })?.team_competition, `${x.slug}: complete structure without competition bouts`);
  }
  const named = withFinale[0];
  assert.equal(structureOf(named, null).structure, "partial", "a named finale with no season data is not structure");
});

test("TUF 22's disputed opening round is a research gap, not missing structure", () => {
  const t22 = seasons.find((x) => x.slug === "tuf-22")!;
  assert.ok(tuf22._conflicts.some((c) => c.field === "round_of_16"), "the dispute is still recorded");
  assert.equal(structureOf(t22, DETAIL_BY_SLUG["tuf-22"]).structure, "complete");
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
  /* Two seasons were once linked by matching a champion to any card he
   * appeared on. Chad Laprise fought Yosdenis Cedeno that night, not his
   * tournament final; Zhang Lipeng fought Brendan O'Reilly, not Wang Sai.
   *
   * Both seasons are now resolved, so this can no longer assert that they stay
   * empty — that was a statement about how much data we had, not about what
   * counts as evidence. What it asserts instead is the rule itself, which
   * outlives the gap: the two wrong PAIRINGS may never appear as a verified
   * final, and a season with no verified final keeps an empty link.
   *
   * TUF China makes the distinction concrete. Its featherweight final really
   * was on UFC Fight Night: Bisping vs Le — the same card the bad match once
   * picked — but between Guangyou Ning and Jianping Yang, who are not Zhang
   * Lipeng. Banning the card would now reject a correct finding; banning the
   * pairing rejects only the error. */
  const forbidden: Array<[string, string, string]> = [
    ["tuf-nations-1", "Chad Laprise", "Yosdenis Cedeno"],
    ["tuf-china-1", "Zhang Lipeng", "Brendan O'Reilly"],
  ];
  const fold = (n: string) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  for (const [slug, a, b] of forbidden) {
    const s = seasons.find((x) => x.slug === slug)!;
    const finals = ((s as Record<string, unknown>).final_bouts ?? []) as Array<{ a: string; b: string }>;
    for (const f of finals) {
      const pair = [fold(f.a), fold(f.b)].sort().join("|");
      assert.notEqual(
        pair,
        [fold(a), fold(b)].sort().join("|"),
        `${slug}: ${a} versus ${b} was never a tournament final and must not be recorded as one`,
      );
    }
  }

  /* And the general form: no verified final, no link. */
  for (const s of seasons) {
    const finals = ((s as Record<string, unknown>).final_bouts ?? []) as unknown[];
    if (finals.length) continue;
    if ((s as Record<string, unknown>).champion_verification_blocked) continue;
    assert.equal(s.finale_event, null, `${s.slug}: an unverified finale link stays empty`);
    assert.equal(s.finale_date, null, `${s.slug}: an unverified finale date stays empty`);
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

test("a season the matrix verifies has no unverified round and no dispute", () => {
  const status = JSON.parse(readFileSync(new URL("../data/tuf/status.generated.json", import.meta.url), "utf8")) as { seasons: Record<string, { matrix_status: string }> };
  const full = seasons.filter((s) => status.seasons[s.slug]?.matrix_status === "COMPLETE");
  assert.ok(full.length > 0, "at least one season should be verified by now");
  for (const s of full) {
    const detail = DETAIL_BY_SLUG[s.slug];
    assert.ok(detail, `${s.slug}: verified but has no detail file`);
    assert.ok(detail.bracket?.length, `${s.slug}: verified but its detail file has no competition bouts`);
    for (const wc of detail.bracket!) {
      for (const st of wc.stages) {
        assert.notEqual(st.status, "unverified", `${s.slug}/${st.stage}: a verified season cannot contain an unverified round`);
        assert.ok(!st.disputed?.length, `${s.slug}/${st.stage}: a verified season cannot contain a disputed bout`);
        assert.ok(st.bouts.length > 0, `${s.slug}/${st.stage}: a stage in a verified season must have bouts`);
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

/* ---- classification evidence ---------------------------------------------- */

test("an exhibition cites both legs of its argument, not just the episode", () => {
  /* Airing in an episode says WHERE the bout sat in the show. On its own it is
   * not a claim about sanctioning — a bout can air in an episode and still have
   * been contested on a card. The second leg is that no professional bout of
   * that description exists, which only carries weight for a year our own
   * records actually cover. Both facts have to appear in the source text. */
  for (const [slug, detail] of Object.entries(DETAIL_BY_SLUG)) {
    for (const div of detail.bracket ?? []) {
      for (const st of div.stages) {
        for (const b of st.bouts) {
          if (b.classification !== "exhibition") continue;
          const src = b.classification_source ?? "";
          assert.ok(src, `${slug}: an exhibition must carry its evidence`);
          const onFinaleCard = (b as { on_finale_card?: boolean }).on_finale_card === true;
          if (onFinaleCard) continue;   // the hand-built seasons word these differently
          /* Leg one: something that PLACES the bout inside the competition.
           * An episode number does that; so does the season source stating it
           * outright for a bout it does not date by episode. The test is for
           * the leg, not for a particular wording. */
          assert.match(
            src,
            /episode|contested inside the competition/i,
            `${slug}: "${b.a} vs ${b.b}" should say what places it inside the season`,
          );
          assert.match(
            src,
            /absent from our fight records|not contested on a sanctioned card|sanctioned/i,
            `${slug}: "${b.a} vs ${b.b}" should say why it was not a professional bout, not only that it aired`,
          );
        }
      }
    }
  }
});

test("a season from a year our records do not cover claims no exhibitions", () => {
  /* 2024 has bouts without results and 2026 has events without bouts, so an
   * absence there is a gap in our loading rather than a fact about a fight.
   * Those seasons must not borrow the argument. */
  const incomplete = new Set<number>(
    Object.entries(completeness.years)
      .filter(([, v]) => !(v as { complete: boolean }).complete)
      .map(([y]) => Number(y)),
  );
  assert.ok(incomplete.size > 0, "some year should be incomplete, or this test proves nothing");

  for (const s of seasons) {
    if (!incomplete.has(s.year)) continue;
    const detail = DETAIL_BY_SLUG[s.slug];
    for (const div of detail?.bracket ?? []) {
      for (const st of div.stages) {
        for (const b of st.bouts) {
          if ((b as { on_finale_card?: boolean }).on_finale_card) continue;
          assert.notEqual(
            b.classification,
            "exhibition",
            `${s.slug} (${s.year}): our records for that year are incomplete, so "${b.a} vs ${b.b}" cannot be argued into an exhibition`,
          );
        }
      }
    }
  }
});

/* ---- formats that are not gaps -------------------------------------------- */

test("a documented wildcard or replacement is recorded with the sentence that documents it", () => {
  let seen = 0;
  for (const [slug, detail] of Object.entries(DETAIL_BY_SLUG)) {
    const fx = (detail as { format_exceptions?: Array<{ kinds: string[]; fighters: string[]; detail: string }> }).format_exceptions ?? [];
    for (const x of fx) {
      seen += 1;
      assert.ok(x.kinds.length, `${slug}: an exception must say what kind it is`);
      assert.ok(x.fighters.length, `${slug}: an exception must name someone the season knows`);
      assert.ok(x.detail && x.detail.length > 20, `${slug}: an exception must keep the sentence it came from`);
    }
  }
  assert.ok(seen > 20, `these seasons are full of wildcards and replacements; only ${seen} were captured`);
});

/* ---- official repairs ------------------------------------------------------ */

type Repair = {
  id: string; season: string; op: string; kind: string;
  bout?: { weight_class: string; stage: string; a: string; b: string };
  set?: Record<string, unknown>; value?: Record<string, unknown>;
  source: { url: string; family: string; quote: string };
  add_conflict?: { kind: string };
};
const ledger = JSON.parse(readFileSync(new URL("../data/tuf/official_repairs.json", import.meta.url), "utf8")) as { repairs: Repair[] };

function ledgerBout(r: Repair) {
  const detail = DETAIL_BY_SLUG[r.season];
  const st = detail?.bracket?.find((d) => d.weight_class === r.bout!.weight_class)?.stages.find((s) => s.stage === r.bout!.stage);
  return st?.bouts.filter((b) => (b.a === r.bout!.a && b.b === r.bout!.b) || (b.a === r.bout!.b && b.b === r.bout!.a)) ?? [];
}

test("every official repair is present in the season files, with its source on the bout", () => {
  assert.ok(ledger.repairs.length >= 10);
  for (const r of ledger.repairs) {
    /* The one exception is stripping wiki markup from a name, which asserts
     * nothing the draft did not already say. */
    if (r.kind !== "markup_debris") {
      assert.match(r.source.url, /^https:\/\/www\.ufc\.com\//, `${r.id}: an official repair cites an official page`);
      assert.ok(r.source.quote.length > 20, `${r.id}: the sentence carrying the fact is kept`);
    }
    if (r.op !== "patch_bout" && r.op !== "add_bout") continue;
    const hits = ledgerBout(r);
    assert.equal(hits.length, 1, `${r.id}: exactly one bout carries the repair`);
    const bout = hits[0] as Bout & { sources?: Array<{ repair: string }> };
    for (const [k, v] of Object.entries(r.set ?? r.value ?? {})) {
      assert.deepEqual((bout as Record<string, unknown>)[k], v, `${r.id}: ${k} is not in the state the ledger records`);
    }
    assert.ok(bout.sources?.some((s) => s.repair === r.id), `${r.id}: the bout must say which source changed it`);
  }
});

test("the six source conflicts resolve to the official account", () => {
  const find = (slug: string, a: string, b: string, stage: string) =>
    (DETAIL_BY_SLUG[slug].bracket ?? []).flatMap((d) => d.stages.filter((s) => s.stage === stage).flatMap((s) => s.bouts))
      .filter((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  for (const [a, b] of [["James McSweeney", "Roy Nelson"], ["Brendan Schaub", "Marcus Jones"]]) {
    assert.equal(find("tuf-10", a, b, "semi_final")[0].episode, 12, `TUF 10 ${a} vs ${b} aired in episode 12`);
  }
  /* Two different fights between the same men, and they must stay two. */
  const r16 = find("tuf-11", "Josh Bryant", "Kris McCray", "round_of_16");
  const sf = find("tuf-11", "Josh Bryant", "Kris McCray", "semi_final");
  assert.equal(r16.length, 1);
  assert.equal(sf.length, 1);
  assert.deepEqual([r16[0].winner, r16[0].episode, r16[0].round], ["Josh Bryant", 5, 3]);
  assert.deepEqual([sf[0].winner, sf[0].episode], ["Kris McCray", 11]);
  assert.equal(find("tuf-30", "Jordan Heiderman", "Chandler Cole", "quarter_final")[0].time, "1:14");
  assert.equal(find("tuf-33", "Alibi Idiris", "Roybert Echeverria", "semi_final")[0].method, "KO (flying knee)");
  const t32 = DETAIL_BY_SLUG["tuf-32"] as { _conflicts?: Array<{ kind?: string }> };
  assert.equal(find("tuf-32", "Guillermo Torres", "Roedie Roets", "quarter_final")[0].winner, "Roedie Roets");
  assert.ok(
    t32._conflicts?.some((c) => c.kind === "official_source_contradicts_itself"),
    "an official page that contradicts itself is recorded as a conflict, not resolved away",
  );
});

test("a repaired bout keeps its classification and the evidence behind it", () => {
  for (const r of ledger.repairs.filter((x) => x.op === "patch_bout" || x.op === "add_bout")) {
    const b = ledgerBout(r)[0];
    if (b.classification === "exhibition") {
      assert.ok(b.classification_source, `${r.id}: still sourced`);
      if (b.episode != null) {
        assert.match(b.classification_source!, new RegExp(`episode ${b.episode}\\b`), `${r.id}: the evidence names the corrected episode`);
      }
    }
    assert.ok(!countsTowardsRecordShape(b), `${r.id}: an in-house bout never becomes record-eligible through a repair`);
  }
});

/* ---- identity -------------------------------------------------------------- */

type IdentityEntry = {
  roles: string[]; status: string; tier?: string; rule?: string; fighter_id?: string;
  evidence?: unknown; candidates?: Array<{ id: string; name: string; rule?: string; evidence?: unknown }>;
};
const identity = JSON.parse(readFileSync(new URL("../data/tuf/identity.json", import.meta.url), "utf8")) as {
  entries: Record<string, IdentityEntry>;
  proven_duplicates: Record<string, { canonical_for_archive: string; proof: string }>;
};
const identityIndex = JSON.parse(readFileSync(new URL("../data/tuf/identity.index.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;

test("a house fighter never borrows a namesake's career", () => {
  const e = identity.entries["tuf-28|Anderson da Silva"];
  assert.ok(e, "TUF 28's Anderson da Silva is in the registry");
  assert.notEqual(e.status, "linked", "Anderson da Silva must not resolve to Anderson Silva");
  assert.equal(identityIndex["tuf-28"]?.["Anderson da Silva"], undefined);
});

test("an accent does not decide whether a coach or champion links", () => {
  const pena18 = identity.entries["tuf-18|Julianna Peña"];
  const pena30 = identity.entries["tuf-30|Julianna Peña"];
  assert.equal(pena18.status, "linked");
  assert.equal(pena30.status, "linked");
  assert.equal(pena18.fighter_id, pena30.fighter_id, "one person across both seasons");
  for (const s of seasons) {
    for (const w of s.winners) {
      assert.ok((w as { fighter_id?: string }).fighter_id, `${s.slug}: winner ${w.fighter} resolves to a canonical fighter`);
    }
  }
});

test("a spelling convention is never accepted without a bout behind it", () => {
  for (const [key, e] of Object.entries(identity.entries)) {
    if (e.status !== "linked") continue;
    if (e.tier === "convention" || e.tier === "exact_with_evidence") {
      assert.ok(e.evidence, `${key}: linked by ${e.rule} with no evidence`);
    }
    assert.match(String(e.fighter_id), /^[0-9a-f-]{36}$/, `${key}: a link is a canonical id`);
  }
});

test("every id on a season page is the id the registry decided", () => {
  for (const [slug, detail] of Object.entries(DETAIL_BY_SLUG)) {
    const d = detail as {
      bracket?: Array<{ stages: Array<{ bouts: Array<Bout & { a_fighter_id?: string; b_fighter_id?: string }> }> }>;
      teams?: Array<{ roster: Array<{ name: string; fighter_id?: string }> }>;
      coaches?: Array<{ name: string; fighter_id?: string }>;
    };
    const want = (name: string) => identityIndex[slug]?.[name];
    for (const div of d.bracket ?? []) for (const st of div.stages) for (const b of st.bouts) {
      assert.equal(b.a_fighter_id, want(b.a), `${slug}: ${b.a}`);
      assert.equal(b.b_fighter_id, want(b.b), `${slug}: ${b.b}`);
    }
    for (const t of d.teams ?? []) for (const p of t.roster) assert.equal(p.fighter_id, want(p.name), `${slug}: roster ${p.name}`);
    for (const p of (d as { pre_draft_cast?: Array<{ name: string; fighter_id?: string }> }).pre_draft_cast ?? []) assert.equal(p.fighter_id, want(p.name), `${slug}: pre-draft ${p.name}`);
    for (const c of d.coaches ?? []) assert.equal(c.fighter_id, want(c.name), `${slug}: staff ${c.name}`);
  }
});

test("a proven duplicate row is recorded with its proof, and both spellings reach one fighter", () => {
  const dup = identity.proven_duplicates["f5785bba-c6f8-45de-8682-d044d586c8ac"];
  assert.ok(dup?.proof.includes("2504639"), "the proof names the shared opponent");
  const a = identityIndex["tuf-brazil-3"]?.["Márcio Alexandre Jr."];
  const b = identityIndex["tuf-brazil-3"]?.["Márcio Alexandre Júnior"];
  assert.ok(a && a === b && a === dup.canonical_for_archive);
});

/* ---- episodes and weigh-ins --------------------------------------------------- */

type EpisodeFile = {
  slug: string;
  episodes: Array<{
    episode_number: number; title: string | null; air_date: string | null; listing_date: string | null; recap_url: string | null;
    bouts?: Array<{
      a: string; b: string; a_fighter_id?: string; b_fighter_id?: string;
      bracket: { weight_class: string; stage: string; a: string; b: string } | null;
      result: { winner: string | null } | null;
      weigh_ins: Array<{ fighter: string; fighter_id?: string; weight_lbs: number | null; weight_text?: string; missed_weight: boolean; episode_number: number; source_url: string }>;
    }>;
  }>;
};
const EPISODE_DIR = new URL("../data/tuf/episodes/", import.meta.url);
const EPISODES: Record<string, EpisodeFile> = Object.fromEntries(
  readdirSync(EPISODE_DIR).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, EPISODE_DIR), "utf8"))]),
);

test("an episode never carries an air date or a fight date it was not given", () => {
  let n = 0;
  for (const [slug, file] of Object.entries(EPISODES)) {
    const numbers = file.episodes.map((e) => e.episode_number);
    assert.deepEqual(numbers, [...new Set(numbers)].sort((a, b) => a - b), `${slug}: episode numbers are unique and ordered`);
    for (const e of file.episodes) {
      n += 1;
      /* An air date exists only where the network listing date and an
       * independent source give the same day, and both are recorded. */
      const res = (e as { air_date_resolution?: { basis: string | null; network_listing_date: string | null; independent_date: string | null } }).air_date_resolution;
      if (e.air_date !== null) {
        assert.equal(res?.basis, "network_listing + independent_source", `${slug} ep${e.episode_number}: an air date needs two agreeing sources`);
        assert.equal(res?.network_listing_date, e.air_date);
        assert.equal(res?.independent_date, e.air_date);
      }
      assert.ok(!("fight_date" in e), `${slug} ep${e.episode_number}: an episode is not a fight date`);
    }
  }
  assert.ok(n > 400, `episodes loaded: ${n}`);
});

test("every in-house weigh-in names its fighter, its weight or the words used, and its source", () => {
  let rows = 0;
  let misses = 0;
  for (const [slug, file] of Object.entries(EPISODES)) {
    for (const e of file.episodes) for (const b of e.bouts ?? []) for (const w of b.weigh_ins) {
      rows += 1;
      if (w.missed_weight) misses += 1;
      assert.ok(w.fighter, `${slug} ep${e.episode_number}: weigh-in without a fighter`);
      /* A miss can be the whole fact: "It's less than a pound" gives no number. */
      assert.ok(w.weight_lbs != null || w.weight_text || w.missed_weight, `${slug} ep${e.episode_number}: ${w.fighter} has neither a weight, the recap's words, nor a recorded miss`);
      assert.equal(w.episode_number, e.episode_number);
      assert.match(w.source_url, /^https:\/\/www\.ufc\.com\//, `${slug}: a weigh-in cites the official recap`);
      assert.ok(w.fighter === b.a || w.fighter === b.b || w.fighter_id === b.a_fighter_id || w.fighter_id === b.b_fighter_id || /\s/.test(w.fighter), `${slug} ep${e.episode_number}: ${w.fighter} is not in ${b.a} vs ${b.b}`);
    }
  }
  assert.ok(rows > 100, `weigh-in rows: ${rows}`);
  assert.ok(misses > 0, "misses are captured, not smoothed over");
});

test("a recap bout points at a real bracket bout, and the bracket carries the episode it reports", () => {
  for (const [slug, file] of Object.entries(EPISODES)) {
    for (const e of file.episodes) for (const b of e.bouts ?? []) {
      if (!b.bracket) continue;
      const detail = DETAIL_BY_SLUG[slug];
      const st = detail.bracket?.find((d) => d.weight_class === b.bracket!.weight_class)?.stages.find((s) => s.stage === b.bracket!.stage);
      const bout = st?.bouts.find((x) => x.a === b.bracket!.a && x.b === b.bracket!.b);
      assert.ok(bout, `${slug} ep${e.episode_number}: ${b.bracket.a} vs ${b.bracket.b} is not in the bracket`);
      assert.equal(bout!.episode, e.episode_number, `${slug}: ${bout!.a} vs ${bout!.b} aired in episode ${e.episode_number}`);
    }
  }
});

test("the current season lists its episodes without inventing results", () => {
  const t34 = EPISODES["tuf-34"];
  assert.ok(t34, "TUF 34 has an episode file");
  assert.equal(t34.episodes.length, 12);
  assert.ok(t34.episodes.every((e) => e.title && !e.bouts), "titles from the listing, no recap facts");
});

/* ---- scheduled finals and name corrections (TUF 34, repair batch 1) ---------- */

type AnyBout = Bout & {
  a_fighter_id?: string; b_fighter_id?: string; result_state?: string;
  scheduled?: { event: string; date: string; ufc_bout_id: string; verified_against: string };
  sources?: Array<{ family: string; fields: string[]; states_winner?: boolean }>;
};
const boutsOf = (slug: string) =>
  ((DETAIL_BY_SLUG[slug] as { bracket?: Array<{ weight_class: string; stages: Array<{ stage: string; bouts: AnyBout[] }> }> }).bracket ?? [])
    .flatMap((br) => br.stages.flatMap((st) => st.bouts.map((b) => ({ ...b, stage: st.stage, weight_class: br.weight_class }))));

test("a scheduled bout carries no result, anywhere in the archive", () => {
  for (const slug of Object.keys(DETAIL_BY_SLUG)) {
    for (const b of boutsOf(slug)) {
      if (b.result_state !== "scheduled") continue;
      assert.equal(b.winner, null, `${slug}: ${b.a} vs ${b.b} is scheduled and has a winner`);
      assert.equal(b.method, null);
      assert.equal(b.round, null);
      assert.match(String(b.scheduled?.ufc_bout_id), /^[0-9a-f-]{36}$/, `${slug}: a scheduled bout names the announced bout it is`);
      assert.match(String(b.scheduled?.verified_against), /ufc_bouts/);
      assert.ok(b.a_fighter_id && b.b_fighter_id, `${slug}: a scheduled bout is matched by both finalists' ids`);
    }
  }
});

test("TUF 34's finals are scheduled professional bouts, and the season stays ongoing with no winner", () => {
  const row = seasons.find((s) => s.slug === "tuf-34")!;
  assert.equal(row.season_state, "ongoing");
  assert.deepEqual(row.winners, []);
  assert.equal(row.finale_event, "UFC Fight Night: Rosas Jr. vs. Barcelos");
  assert.equal(row.finale_date, "2026-09-26");
  const finalBouts = (row as Record<string, unknown>).final_bouts as Array<{ status?: string; winner?: string; ufc_bout_id?: string }>;
  assert.equal(finalBouts.length, 2);
  for (const f of finalBouts) {
    assert.equal(f.status, "scheduled");
    assert.equal(f.winner, undefined, "no winner before the bout");
  }
  const finals = boutsOf("tuf-34").filter((b) => b.stage === "final");
  const want: Record<string, [string, string]> = {
    Bantamweight: ["13dd06fe-1f79-401b-9a8a-23c61a907745", "70116fec-53b8-4a05-8684-4415498f4889"],
    "Women's Strawweight": ["f0f35412-3bc3-4fbd-a5ef-c5a3e4b0c27d", "aef54e82-da80-4fa1-b917-11b94eca49e8"],
  };
  assert.equal(finals.length, 2);
  for (const f of finals) {
    assert.equal(f.result_state, "scheduled");
    assert.equal(f.classification, "professional");
    assert.match(String(f.classification_source), /sanctioned/i);
    assert.deepEqual([f.a_fighter_id, f.b_fighter_id].sort(), [...want[f.weight_class]].sort(), `${f.weight_class}: exact finalist ids`);
    assert.equal(f.scheduled?.date, "2026-09-26");
    assert.ok(finalBouts.some((x) => x.ufc_bout_id === f.scheduled?.ufc_bout_id), "inventory and bracket name the same announced bout");
  }
  assert.deepEqual((DETAIL_BY_SLUG["tuf-34"] as { _conflicts?: unknown[] })._conflicts, [], "an unfought final is not a source conflict");
});

test("TUF 34's house bouts keep an unresolved classification: absence from our records is not proof", () => {
  const house = boutsOf("tuf-34").filter((b) => b.stage !== "final");
  assert.equal(house.length, 12);
  for (const b of house) {
    assert.equal(b.classification, "unverified", `${b.a} vs ${b.b}`);
    assert.equal(b.classification_source, null);
    assert.ok(b.winner, "the draft's reported winner is kept");
    assert.ok(!(b.sources ?? []).some((s) => s.fields.includes("winner")), "nothing attached states the result");
  }
});

test("Gigi Canuto is a source correction, and Giovanna is kept as draft provenance only, never as an alias", () => {
  const d = DETAIL_BY_SLUG["tuf-34"] as {
    teams: Array<{ roster: Array<{ name: string; printed_as?: string }> }>;
    name_corrections: Array<{ draft_name: string; name: string; fighter_id: string; kind: string; official_alias?: boolean }>;
  };
  assert.equal(identityIndex["tuf-34"]["Gigi Canuto"], "b4028b75-c0ad-4087-b91f-4ed24306eeb6");
  assert.equal(identityIndex["tuf-34"]["Giovanna Canuto"], undefined);
  assert.equal(identity.entries["tuf-34|Giovanna Canuto"], undefined, "the draft spelling is not a registry name");
  const printed = [...boutsOf("tuf-34").flatMap((b) => [b.a, b.b, b.winner]), ...d.teams.flatMap((t) => t.roster.flatMap((p) => [p.name, p.printed_as]))];
  assert.ok(!printed.includes("Giovanna Canuto"), "no page name or printed_as carries Giovanna");
  const c = d.name_corrections.find((x) => x.draft_name === "Giovanna Canuto")!;
  assert.equal(c.name, "Gigi Canuto");
  assert.equal(c.kind, "source_correction");
  assert.equal(c.official_alias, false);
  const aliases = readFileSync(new URL("../data/tuf/name_aliases.json", import.meta.url), "utf8");
  assert.ok(!aliases.includes("Giovanna"), "not asserted in the alias file either");
});

test("TUF 34's misspelled finalists resolve to one fighter each, with no split left behind", () => {
  assert.equal(identityIndex["tuf-34"]["Mehemmedeli Osmanli"], "13dd06fe-1f79-401b-9a8a-23c61a907745");
  assert.equal(identityIndex["tuf-34"]["Ilimbek Akylbek Uulu"], "70116fec-53b8-4a05-8684-4415498f4889");
  for (const old of ["Mehemedeli Osmanli", "Illimbek Akylbek Uulu"]) {
    assert.equal(identity.entries[`tuf-34|${old}`], undefined, `${old} is no longer a separate, unlinked person`);
  }
  const kinds = (DETAIL_BY_SLUG["tuf-34"] as { name_corrections: Array<{ draft_name: string; kind: string }> }).name_corrections;
  assert.deepEqual(kinds.filter((k) => k.kind === "spelling_variant").map((k) => k.draft_name).sort(), ["Illimbek Akylbek Uulu", "Mehemedeli Osmanli"]);
});

/* ---- TUF 1 gold standard ---------------------------------------------------- */

type T1Bout = AnyBout & { episode: number | null; ufc_bout_id?: string; result_sources?: Array<{ family: string; evidence_level: string }>;
  classification_basis?: { affirmative: Array<{ family: string; evidence_level: string; quote?: string }>; corroborating: Array<{ kind?: string; evidence_level: string }>; authority?: string } };
const t1 = DETAIL_BY_SLUG["tuf-1"] as unknown as {
  competition_format: { kind: string; phases: Array<{ stage: string; expected_bouts: number | null }> };
  bracket: Array<{ weight_class: string; stages: Array<{ stage: string; label: string; bouts: T1Bout[] }> }>;
  timeline_events: Array<{ id: string; episode: number | null; episode_candidates?: number[]; type: string; fighters: string[]; sources: Array<{ family: string }> }>;
  teams: Array<{ name: string; roster: Array<{ name: string; pick?: number; note?: string }> }>;
  coaches: Array<{ name: string; team: string | null; role: string; discipline?: string; from_episode?: number }>;
  _conflicts: Array<{ field: string }>; _resolved_conflicts: Array<{ field: string; resolution: string }>;
};
const t1Bouts = t1.bracket.flatMap((br) => br.stages.flatMap((st) => st.bouts.map((b) => ({ ...b, stage: st.stage, weight_class: br.weight_class }))));
const t1House = t1Bouts.filter((b) => b.stage !== "final");

test("TUF 1 declares its real format: elimination phase, semi-finals, finals — no quarter-final expectation", () => {
  assert.equal(t1.competition_format.kind, "elimination_then_semifinals");
  assert.deepEqual(t1.competition_format.phases.map((p) => p.stage), ["elimination", "semi_final", "final"]);
  assert.ok(!t1Bouts.some((b) => b.stage === "quarter_final"), "no quarter-final stage");
  assert.equal(expectedBouts(t1.competition_format as never, "quarter_final", 0).undeclared, true);
  const el = expectedBouts(t1.competition_format as never, "elimination", 3);
  assert.deepEqual([el.expected, el.basis], [3, "declared_open"], "an elimination phase has no fixed count, so it is never short");
  assert.equal(expectedBouts(null, "quarter_final", 3).expected, 4, "a season with no declared format keeps the modern shape");
});

test("TUF 1 advancement is valid in its own format, with no bout invented", () => {
  assert.deepEqual(advancementProblems(t1 as never), []);
  const inElim = (name: string) => t1Bouts.filter((b) => b.stage === "elimination" && (b.a === name || b.b === name)).length;
  assert.equal(inElim("Bobby Southworth"), 2, "Southworth fought twice: won, then lost");
  assert.equal(inElim("Diego Sanchez"), 2, "Sanchez fought twice");
  for (const name of ["Sam Hoger", "Kenny Florian", "Mike Swick"]) {
    assert.equal(inElim(name), 0, `${name} reached the last four without a house fight`);
    assert.ok(t1Bouts.some((b) => b.stage === "semi_final" && (b.a === name || b.b === name)), `${name} fought a semi-final`);
  }
  assert.equal(t1Bouts.length, 12, "twelve bouts, none added");
  assert.deepEqual(t1.bracket.map((br) => br.stages.map((st) => [st.stage, st.bouts.length])), [
    [["elimination", 3], ["semi_final", 2], ["final", 1]],
    [["elimination", 3], ["semi_final", 2], ["final", 1]],
  ]);
  assert.ok(!t1._conflicts.some((c) => /quarter_finals/.test(c.field)), "the bracket-model conflicts are no longer open");
  assert.equal(t1._resolved_conflicts.filter((c) => /quarter_finals/.test(c.field) && /elimination phase/.test(c.resolution)).length, 2);
});

test("an elimination-format season with a loser reappearing and no sourced return is flagged", () => {
  const broken = JSON.parse(JSON.stringify(t1)) as typeof t1;
  broken.timeline_events = broken.timeline_events.filter((e) => e.type !== "replacement_return");
  const problems = advancementProblems(broken as never);
  assert.deepEqual(problems.map((p) => p.fighter), ["Chris Leben"], "Leben lost in episode 6; only his sourced return makes his semi-final valid");
});

/* ---- TUF 1: Nevada State Athletic Commission reconciliation ---------------- */

type T1Source = { family: string; evidence_level: string; source_type?: string; document_id?: string; record_id?: string; winner?: string; former_authority?: boolean; superseded_by?: string; quote?: string };
type T1Nsac = T1Bout & {
  fight_date?: string; fight_date_source?: { document_id: string; record_id: string }; commission_record_id?: string;
  superseded_result_sources?: T1Source[]; method_detail?: { value: string; relation: string; source: T1Source };
  corrections?: Array<{ field: string; kind?: string; old: unknown; new: unknown; detail?: string; batch?: string }>;
  a_fighter_id?: string; b_fighter_id?: string;
};
const T1_DOC = "nsac-2004-tuf-season-1";
const t1Audit = JSON.parse(readFileSync(new URL("../../scripts/tuf/evidence/tuf1_nsac_audit_2026-09-13.json", import.meta.url), "utf8")) as {
  document: { sha256: string }; summary: { matched: number; unmatched: number; ambiguous: number };
  bouts: Array<{ bout: string; match: string; record_id: string; ids: [string, string]; canonical: { method: string; time: string | null } }>;
};
const t1Ledger = () => JSON.parse(readFileSync(new URL("../data/tuf/commission_records.json", import.meta.url), "utf8")) as {
  documents: Array<{ id: string; sha256: string; classification_language: { quote: string }; identity_disagreements?: Array<{ fighter: string; field: string; printed: string; canonical: string; action: string }> }>;
  records: Array<{ id: string; document_id: string; date: string; winner: string; method: string; round: number; time: string | null; referee?: string; scorecards: unknown; corners: Array<{ weight_lbs?: number }>; remarks: unknown[] }>;
};
const t1N = t1House as unknown as T1Nsac[];

test("TUF 1: 10/10 house bouts match exactly one commission record, deterministically", () => {
  assert.deepEqual([t1Audit.summary.matched, t1Audit.summary.unmatched, t1Audit.summary.ambiguous], [10, 0, 0]);
  const ledger = t1Ledger();
  const doc = ledger.documents.find((d) => d.id === T1_DOC)!;
  assert.equal(doc.sha256, t1Audit.document.sha256);
  const recs = ledger.records.filter((r) => r.document_id === T1_DOC);
  assert.equal(recs.length, 10);
  assert.equal(new Set(t1N.map((b) => b.commission_record_id)).size, 10, "every record used once");
  for (const b of t1N) {
    const rec = recs.find((r) => r.id === b.commission_record_id)!;
    assert.ok(rec, `${b.a} vs ${b.b}: no record`);
    assert.equal(rec.winner, b.winner);
    assert.equal(t1Audit.bouts.find((x) => x.bout === `${b.a} vs ${b.b}`)?.record_id, rec.id, "the audited match");
  }
});

test("TUF 1: 10/10 house results verified from the commission; Wikipedia is history, not authority", () => {
  assert.equal(t1N.length, 10);
  for (const b of t1N) {
    assert.equal(resultState(b as never), "verified", `${b.a} vs ${b.b}`);
    assert.ok(b.result_sources?.length === 1 && b.result_sources[0].family === "athletic_commission" && b.result_sources[0].evidence_level === "commission_record");
    assert.ok(!(b.result_sources as T1Source[]).some((x) => x.family === "wikipedia"), "Wikipedia no longer states the canonical result");
    assert.ok(b.superseded_result_sources?.length && b.superseded_result_sources.every((x) => x.family === "wikipedia" && x.superseded_by === b.commission_record_id), "the draft source is preserved as history");
    const rec = t1Ledger().records.find((r) => r.id === b.commission_record_id)!;
    assert.deepEqual([b.round, b.time], [rec.round, rec.time], "round and time are the commission's");
  }
});

test("TUF 1: 10/10 exhibitions backed by the commission; ESPN and record absence are corroboration only", () => {
  const quote = t1Ledger().documents.find((d) => d.id === T1_DOC)!.classification_language.quote;
  assert.match(quote, /EXHIBITION/);
  for (const b of t1N) {
    assert.equal(classState(b as never), "exhibition", `${b.a} vs ${b.b}`);
    const basis = b.classification_basis as unknown as { affirmative: T1Source[]; corroborating: Array<T1Source & { kind?: string }>; authority: string };
    assert.equal(basis.authority, "affirmative");
    assert.equal(basis.affirmative.length, 1);
    assert.deepEqual([basis.affirmative[0].family, basis.affirmative[0].evidence_level, basis.affirmative[0].record_id], ["athletic_commission", "commission_record", b.commission_record_id]);
    const espn = basis.corroborating.filter((x) => x.family === "espn_retrospective");
    assert.equal(espn.length, 1, "the ESPN retrospective is kept");
    assert.equal(espn[0].former_authority, true, "and marked as the former authority");
    assert.ok(!basis.affirmative.some((x) => x.family === "espn_retrospective" || x.family === "our_records"));
    assert.equal(basis.corroborating.filter((x) => x.kind === "record_absence").length, 1, "the 2004 absence is kept as corroboration");
    assert.match(String(b.classification_source), /Nevada State Athletic Commission/);
  }
});

test("TUF 1: six commission time corrections and one real method contradiction, old values kept", () => {
  const byKind = (kind: string, field: string) => t1N.flatMap((b) => (b.corrections ?? []).filter((c) => c.kind === kind && c.field === field).map((c) => ({ bout: `${b.a} vs ${b.b}`, ...c })));
  const times = byKind("commission_correction", "time");
  assert.equal(times.length, 6);
  for (const c of times) assert.equal(c.old, t1Audit.bouts.find((x) => x.bout === c.bout)!.canonical.time, `${c.bout}: the draft time is kept`);
  const methods = byKind("commission_correction", "method");
  assert.deepEqual(methods.map((c) => [c.bout, c.old, c.new]), [["Bobby Southworth vs Lodune Sincaid", "KO (strikes)", "TKO"]]);
  const southworth = t1N.find((b) => b.b === "Lodune Sincaid")!;
  assert.deepEqual([southworth.method, southworth.round, southworth.time], ["TKO", 2, "0:14"]);
  assert.equal(southworth.method_detail, undefined, "the contradicted KO label is not carried forward as detail");
  assert.ok(t1N.every((b) => (b.corrections ?? []).every((c) => c.field !== "round")), "no round changed");
});

test("TUF 1: three compatible method details are kept apart from the official commission method", () => {
  const expected: Array<[string, string, string, string]> = [
    ["Forrest Griffin vs Sam Hoger", "TKO", "strikes", "TKO (strikes)"],
    ["Stephan Bonnar vs Mike Swick", "Submission (armbar)", "triangle armbar", "Submission (triangle armbar)"],
    ["Kenny Florian vs Chris Leben", "TKO", "doctor stoppage", "TKO (doctor stoppage)"],
  ];
  const withDetail = t1N.filter((b) => b.method_detail).map((b) => `${b.a} vs ${b.b}`).sort();
  assert.deepEqual(withDetail, expected.map((e) => e[0]).sort());
  for (const [bout, official, detail, draft] of expected) {
    const b = t1N.find((x) => `${x.a} vs ${x.b}` === bout)!;
    assert.equal(b.method, official, `${bout}: the official method is the commission's wording`);
    assert.ok(!String(b.method).includes(detail), "the secondary detail is not merged into the canonical method");
    assert.equal(b.method_detail!.value, detail);
    assert.equal(b.method_detail!.relation, "compatible_detail");
    assert.deepEqual([b.method_detail!.source.family, b.method_detail!.source.evidence_level], ["wikipedia", "secondary_draft"], "the detail carries its own secondary source");
    const norm = (b.corrections ?? []).filter((c) => c.kind === "method_normalization");
    assert.deepEqual(norm.map((c) => [c.old, c.new, c.detail]), [[draft, official, detail]], "recorded as a normalization, not as a draft shown wrong");
    assert.equal(resultState(b as never), "verified", "the verified state belongs to the commission result");
  }
});

test("TUF 1: fight dates are the commission's show dates and stay apart from episode air dates", () => {
  const ep = EPISODES["tuf-1"] as unknown as { episodes: Array<{ episode_number: number; air_date: string | null }> };
  for (const b of t1N) {
    const rec = t1Ledger().records.find((r) => r.id === b.commission_record_id)!;
    assert.equal(b.fight_date, rec.date);
    assert.deepEqual(b.fight_date_source, { document_id: T1_DOC, record_id: rec.id });
    assert.match(String(b.fight_date), /^2004-(10|11)-/, "fought in late 2004");
    const aired = ep.episodes.find((e) => e.episode_number === b.episode)!.air_date;
    assert.ok(aired && aired.startsWith("2005-") && aired !== b.fight_date, `${b.a} vs ${b.b}: episode ${b.episode} aired ${aired}, a separate fact`);
  }
  const ledger = t1Ledger();
  const recs = ledger.records.filter((r) => r.document_id === T1_DOC);
  assert.equal(recs.filter((r) => r.referee).length, 10, "a referee for every bout");
  assert.equal(recs.filter((r) => r.scorecards).length, 3, "cards for the three decisions");
  assert.equal(recs.reduce((n, r) => n + r.corners.filter((c) => typeof c.weight_lbs === "number").length, 0), 20, "20/20 weights");
  assert.equal(recs.reduce((n, r) => n + r.remarks.length, 0), 0, "no remarks invented");
});

test("TUF 1: the Rafferty placement conflict stays open, and identities, DOBs and finals are untouched", () => {
  assert.ok(t1._conflicts.some((c) => c.field === "timeline:josh_rafferty_trade_episode"), "the commission does not settle the trade episode");
  assert.equal(t1.timeline_events.find((e) => e.id === "tuf1-rafferty-trade")!.episode, null);
  for (const b of t1N) {
    const audited = t1Audit.bouts.find((x) => x.bout === `${b.a} vs ${b.b}`)!;
    assert.deepEqual([b.a_fighter_id, b.b_fighter_id], audited.ids, `${b.a} vs ${b.b}: identities unchanged`);
  }
  const finals = t1Bouts.filter((b) => b.stage === "final").map((f) => [f.winner, f.method, f.round, f.time, f.ufc_bout_id, f.classification]);
  assert.deepEqual(finals, [
    ["Forrest Griffin", "Decision (unanimous)", 3, "5:00", "65856c98-1421-4859-8e62-4eb651fdc221", "professional"],
    ["Diego Sanchez", "TKO (punches)", 1, "2:49", "45c3c849-90b4-47ec-a891-76e7a1effa5f", "professional"],
  ], "finale professional results unchanged");
  assert.ok(t1Bouts.filter((b) => b.stage === "final").every((f) => !(f as T1Nsac).commission_record_id), "no commission evidence on the finals");
  const disagreements = t1Ledger().documents.find((d) => d.id === T1_DOC)!.identity_disagreements!;
  assert.deepEqual(disagreements.map((d) => [d.fighter, d.field, d.printed, d.canonical, d.action]), [
    ["Forrest Griffin", "dob", "1977-11-26", "1979-03-16", "recorded_only"],
    ["Alex Schoenauer", "dob", "1976-05-12", "1976-05-05", "recorded_only"],
  ]);
  assert.ok(!JSON.stringify(DETAIL_BY_SLUG["tuf-1"]).includes("\"dob\""), "no DOB written into the season");
});

test("TUF 1 finals remain verified professional bouts, linked by exact bout id", () => {
  const finals = t1Bouts.filter((b) => b.stage === "final");
  assert.equal(finals.length, 2);
  for (const f of finals) {
    assert.equal(resultState(f as never), "verified");
    assert.equal(classState(f as never), "professional");
    assert.match(String(f.ufc_bout_id), /^[0-9a-f-]{36}$/);
  }
});

test("scorecards are read from the database, never copied into a season file", () => {
  for (const [slug, detail] of Object.entries(DETAIL_BY_SLUG)) {
    assert.ok(!JSON.stringify(detail).includes("\"scorecards\""), `${slug} carries a copied scorecards field`);
  }
});

test("Nathan Quarry resolves to the canonical Nate Quarry through the governed alias", () => {
  assert.equal(identityIndex["tuf-1"]["Nathan Quarry"], "e8999544-0e72-4010-9d05-d4325b552f45");
  const e = identity.entries["tuf-1|Nathan Quarry"];
  assert.equal(e.status, "linked");
  assert.equal(e.tier, "alias");
  assert.match(String(e.evidence), /Lodune Sincaid/);
});

test("the 16 TUF 1 ESPN athlete ids map one to one, each through its finale bout", () => {
  const plan = JSON.parse(readFileSync(new URL("../../scripts/reconcile/evidence/tuf1_espn_athlete_ids.2026-09-13.json", import.meta.url), "utf8")) as {
    expected: number; mapped: number; ambiguous: number; conflicts: number; duplicate_ids: number;
    mappings: Array<{ fighter_id: string; espn_athlete_id: string; bout_id: string; espn_competition_id: string; role: string }>;
  };
  assert.deepEqual([plan.expected, plan.mapped, plan.ambiguous, plan.conflicts, plan.duplicate_ids], [16, 16, 0, 0, 0]);
  assert.equal(new Set(plan.mappings.map((m) => m.espn_athlete_id)).size, 16);
  assert.equal(new Set(plan.mappings.map((m) => m.fighter_id)).size, 16);
  const roster = new Set(t1.teams.flatMap((t) => t.roster.map((r) => identityIndex["tuf-1"][r.name])));
  assert.ok(plan.mappings.every((m) => roster.has(m.fighter_id)), "only TUF 1 contestants");
  const byBout = new Map<string, string[]>();
  for (const m of plan.mappings) byBout.set(m.bout_id, [...(byBout.get(m.bout_id) ?? []), m.role]);
  assert.equal(byBout.size, 8, "eight finale bouts, one winner and one loser each");
  for (const roles of byBout.values()) assert.deepEqual(roles.sort(), ["loser", "winner"]);
});

test("TUF 1 air dates resolve only where the network listing and an independent source agree, keeping the +1 display offset", () => {
  const f = EPISODES["tuf-1"] as unknown as { episodes: Array<{ episode_number: number; air_date: string | null; listing_date: string | null; air_date_resolution?: { network_display_date: string | null; date_conflict_note?: string } }>; source_defects?: Array<{ episodes: number[] | string; defect: string }>; finale_broadcast?: { air_date?: string | null } };
  assert.equal(f.episodes.length, 12);
  for (const e of f.episodes) {
    assert.equal(e.air_date, e.listing_date);
    assert.ok(e.air_date_resolution?.network_display_date && e.air_date_resolution.network_display_date > e.air_date!, "the network display date is preserved, one day later");
    assert.match(String(e.air_date_resolution?.date_conflict_note), /\+1 day/);
  }
  assert.equal(f.finale_broadcast?.air_date, "2005-04-09");
  assert.ok(f.source_defects?.some((d) => d.defect === "descriptions_swapped" && JSON.stringify(d.episodes) === "[11,12]"), "the episode 11/12 description swap is kept as a source defect");
  const withIndependent = new Set(Object.keys((JSON.parse(readFileSync(new URL("../../scripts/tuf/evidence/air_dates.json", import.meta.url), "utf8")) as { seasons: Record<string, unknown> }).seasons));
  for (const [slug, file] of Object.entries(EPISODES)) if (!withIndependent.has(slug)) assert.ok(file.episodes.every((e) => e.air_date === null), `${slug}: no captured independent source, no air date`);
});

test("every TUF 1 episode has sourced facts, and the Rafferty trade stays unresolved", () => {
  const views = buildEpisodeViews(t1 as never, EPISODES["tuf-1"] as never);
  assert.equal(views.episodes.length, 12);
  assert.deepEqual(views.episodes.filter((v) => !v.hasFacts).map((v) => v.episode.episode_number), [], "no title-only shells");
  const rafferty = t1.timeline_events.find((e) => e.id === "tuf1-rafferty-trade")!;
  assert.equal(rafferty.episode, null);
  assert.deepEqual(rafferty.episode_candidates, [7, 8]);
  assert.ok(t1._conflicts.some((c) => c.field === "timeline:josh_rafferty_trade_episode"), "an open conflict, not a silent choice");
  assert.deepEqual(views.unplacedEvents.map((e) => e.id), ["tuf1-rafferty-trade"]);
  const counts = timelineCounts(t1 as never);
  assert.deepEqual([counts.trades, counts.withdrawals, counts.replacements, counts.injuries, counts.eliminations, counts.weight_events, counts.staff_changes], [3, 1, 1, 3, 12, 1, 1]);
  const people = new Set([...t1.teams.flatMap((t) => t.roster.map((r) => r.name)), ...t1.coaches.map((c) => c.name)]);
  for (const e of t1.timeline_events) {
    assert.ok(e.sources.length, `${e.id}: a timeline event carries its sources`);
    for (const who of e.fighters) assert.ok(people.has(who), `${e.id}: ${who} is not in the season's cast or staff`);
  }
  assert.ok(t1.teams.every((t) => t.roster.every((r) => r.pick && !r.note)), "roster cards are clean: picks, no loose notes");
  const marks = rosterMarks(t1 as never);
  assert.deepEqual(marks.get("Chris Leben")?.map((m) => [m.label, m.episode]), [["Lost elimination fight", 6], ["Returned", 8], ["Lost semi-final", 10]]);
});

test("TUF 1 staff are discipline coaches with no invented team", () => {
  for (const [name, discipline] of [["Marc Laimon", "Grappling"], ["Ganyao Fairtex", "Muay Thai"], ["Peter Welch", "Boxing"]]) {
    const c = t1.coaches.find((x) => x.name === name)!;
    assert.equal(c.discipline, discipline);
    assert.equal(c.team, null);
  }
  const quarry = t1.coaches.find((x) => x.name === "Nathan Quarry")!;
  assert.deepEqual([quarry.role, quarry.team, quarry.from_episode], ["assistant", null, 8]);
});

/* ---- TUF 2 gold standard: the commission record ------------------------------ */

type T2Bout = Omit<T1Bout, "result_sources"> & { fight_date?: string; commission_record_id?: string; corrections?: Array<{ field: string; old: unknown; new: unknown; source: { document_id?: string; record_id?: string }; reason: string }>;
  result_sources?: Array<{ family: string; evidence_level: string; source_type?: string; document_id?: string; record_id?: string; winner?: string }> };
const t2 = DETAIL_BY_SLUG["tuf-2"] as unknown as {
  competition_format: { kind: string; steps: Array<{ key: string }>; phases: Array<{ stage: string }> };
  bracket: Array<{ weight_class: string; stages: Array<{ stage: string; label: string; bouts: T2Bout[] }> }>;
  teams: Array<{ name: string; roster: Array<{ name: string; status?: string; replacement_for?: string }> }>;
  pre_draft_cast: Array<{ name: string; exit: string; episode: number; timeline_event: string }>;
  timeline_events: Array<{ id: string; episode: number | null; type: string; fighters: string[]; sources: Array<{ family: string }> }>;
  overview: { fight_window: { start: string; end: string }; premiere: { date: string } };
};
const t2Bouts = t2.bracket.flatMap((br) => br.stages.flatMap((st) => st.bouts.map((b) => ({ ...b, stage: st.stage, weight_class: br.weight_class }))));
const t2House = t2Bouts.filter((b) => b.stage !== "final");
const commissionLedger = JSON.parse(readFileSync(new URL("../data/tuf/commission_records.json", import.meta.url), "utf8")) as {
  documents: Array<{ id: string; source_family: string; source_type: string; jurisdiction: string; sha256: string; url: string; classification_language: { quote: string } }>;
  records: Array<{ id: string; document_id: string; date: string; winner: string; method: string; round: number; time: string | null; bout: { weight_class: string; stage: string; a: string; b: string } }>;
};

test("all 12 TUF 2 house results are verified by the commission record, and each citation resolves", () => {
  assert.equal(t2House.length, 12);
  for (const b of t2House) {
    assert.equal(resultState(b as never), "verified", `${b.a} vs ${b.b}`);
    const src = b.result_sources!.find((s) => s.family === "athletic_commission")!;
    assert.equal(src.source_type, "commission_result_record");
    assert.equal(src.evidence_level, "commission_record");
    const rec = commissionLedger.records.find((r) => r.id === src.record_id);
    const doc = commissionLedger.documents.find((d) => d.id === src.document_id);
    assert.ok(rec && doc, `${b.a} vs ${b.b}: the cited commission record exists`);
    assert.equal(rec!.document_id, doc!.id);
    assert.equal(doc!.source_type, "commission_result_record");
    assert.match(doc!.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([rec!.bout.weight_class, rec!.bout.stage, rec!.bout.a, rec!.bout.b], [b.weight_class, b.stage, b.a, b.b], "the record is tied to this bout");
    assert.equal(rec!.winner, b.winner);
    assert.deepEqual([b.method, b.round, b.time], [rec!.method, rec!.round, rec!.time], "the bracket carries the commission's values");
  }
});

test("a government document is not authoritative without an explicit record tied to the bout", () => {
  const base = { a: "A One", b: "B Two", winner: "A One", classification: "exhibition" as const, classification_source: "x" };
  assert.equal(resultState({ ...base, result_sources: [{ family: "athletic_commission", source_type: "commission_result_record", evidence_level: "commission_record", document_id: "d", winner: "A One" }] } as never), "reported", "no record id");
  assert.equal(resultState({ ...base, result_sources: [{ family: "athletic_commission", source_type: "commission_result_record", evidence_level: "commission_record", document_id: "d", record_id: "r", winner: "B Two" }] } as never), "reported", "a different winner");
  assert.equal(resultState({ ...base, result_sources: [{ family: "athletic_commission", evidence_level: "secondary", document_id: "d", record_id: "r", winner: "A One" }] } as never), "reported", "not typed as a commission result record");
  assert.equal(resultState({ ...base, result_sources: [{ family: "athletic_commission", source_type: "commission_result_record", evidence_level: "commission_record", document_id: "d", record_id: "r", winner: "A One" }] } as never), "verified");
});

test("TUF 2 house classifications are exhibitions from the commission record, not from database absence", () => {
  for (const b of t2House) {
    assert.equal(classState(b as never), "exhibition");
    const basis = b.classification_basis!;
    assert.equal(basis.authority, "affirmative");
    assert.equal(basis.affirmative.length, 1);
    assert.equal(basis.affirmative[0].family, "athletic_commission");
    assert.equal(basis.affirmative[0].evidence_level, "commission_record");
    assert.equal(basis.affirmative[0].quote, "Exhibition Results");
    assert.ok(basis.corroborating.every((c) => c.evidence_level === "corroboration_only"));
    assert.ok(!basis.affirmative.some((a) => a.family === "our_records" || a.family === "espn_retrospective"), "neither absence nor the TUF 1 retrospective is the authority");
  }
});

test("commission corrections beat the draft and keep old value, new value, source and reason", () => {
  const corrected = t2House.filter((b) => b.corrections?.length);
  assert.deepEqual(corrected.map((b) => `${b.a}|${b.b}`).sort(), ["Brad Imes|Rob MacDonald", "Joe Stevenson|Jason Von Flue", "Joe Stevenson|Marcus Davis", "Luke Cummo|Sammy Morgan"]);
  const get = (a: string, b: string) => t2House.find((x) => x.a === a && x.b === b)!;
  assert.deepEqual(get("Brad Imes", "Rob MacDonald").corrections!.map((c) => [c.field, c.old, c.new]), [["time", "4:07", "4:10"]]);
  assert.deepEqual(get("Joe Stevenson", "Marcus Davis").corrections!.map((c) => [c.field, c.old, c.new]), [["method", "Submission (elbows)", "Submission (elbow strikes)"], ["time", "4:10", "4:12"]]);
  assert.deepEqual(get("Luke Cummo", "Sammy Morgan").corrections!.map((c) => [c.field, c.old, c.new]), [["method", "KO (knee)", "TKO"], ["time", "2:05", "2:08"]]);
  assert.deepEqual(get("Joe Stevenson", "Jason Von Flue").corrections!.map((c) => [c.field, c.old, c.new]), [["time", "4:46", "4:49"]]);
  for (const b of corrected) for (const c of b.corrections!) {
    assert.ok(c.source.document_id && c.source.record_id && c.reason.length > 20);
  }
});

test("fight dates come from the commission and are never air dates", () => {
  const eps = EPISODES["tuf-2"] as unknown as { episodes: Array<{ episode_number: number; air_date: string | null; air_date_resolution?: { status: string; network_listing_date: string | null; independent_date: string | null } }>; finale_broadcast: { air_date: string | null } };
  assert.equal(t2House.filter((b) => b.fight_date).length, 12);
  for (const b of t2House) {
    const rec = commissionLedger.records.find((r) => r.id === b.commission_record_id)!;
    assert.equal(b.fight_date, rec.date);
    assert.ok(b.fight_date! >= "2005-06-15" && b.fight_date! <= "2005-07-12");
    const aired = eps.episodes.find((e) => e.episode_number === b.episode)!;
    assert.notEqual(aired.air_date, b.fight_date, `${b.a} vs ${b.b}: fought months before it aired`);
  }
  assert.deepEqual([t2.overview.fight_window.start, t2.overview.fight_window.end], ["2005-06-15", "2005-07-12"]);
  assert.notEqual(t2.overview.premiere.date, t2.overview.fight_window.start, "the broadcast window is not the fight window");
  const resolved = eps.episodes.filter((e) => e.air_date).map((e) => e.episode_number);
  assert.deepEqual(resolved, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const e12 = eps.episodes.find((e) => e.episode_number === 12)!;
  assert.equal(e12.air_date, null);
  assert.deepEqual([e12.air_date_resolution?.status, e12.air_date_resolution?.network_listing_date, e12.air_date_resolution?.independent_date], ["unresolved", "2005-10-31", "2005-11-01"]);
  assert.equal(eps.finale_broadcast.air_date, "2005-11-05");
  const defects = (EPISODES["tuf-2"] as unknown as { source_defects: Array<{ defect: string; episodes: unknown }> }).source_defects;
  assert.ok(defects.some((d) => d.defect === "descriptions_swapped" && JSON.stringify(d.episodes) === "[10,11]"));
});

test("TUF 2 pre-draft exits are timeline events and cast, never bouts", () => {
  assert.deepEqual(t2.pre_draft_cast.map((p) => [p.name, p.exit, p.episode]), [["Kerry Schall", "injury", 1], ["Eli Joslin", "left_show", 1], ["Kenny Stevens", "forfeit", 1]]);
  assert.ok(!t2.teams.some((t) => t.name === "Unassigned"), "no synthetic team");
  const inBouts = new Set(t2Bouts.flatMap((b) => [b.a, b.b]));
  for (const name of ["Kerry Schall", "Eli Joslin", "Kenny Stevens"]) assert.ok(!inBouts.has(name), `${name} has no house bout`);
  const forfeit = t2.timeline_events.find((e) => e.type === "forfeit")!;
  assert.deepEqual(forfeit.fighters, ["Kenny Stevens", "Sammy Morgan"]);
  assert.equal(t2Bouts.filter((b) => [b.a, b.b].includes("Sammy Morgan") && b.stage === "elimination").length, 0, "the forfeit is not recorded as a bout");
  for (const p of t2.pre_draft_cast) assert.ok(t2.timeline_events.some((e) => e.id === p.timeline_event), `${p.name}: exit event exists`);
  assert.deepEqual(t2.competition_format.steps.map((s) => s.key), ["pre_draft", "draft"]);
  assert.deepEqual(t2.competition_format.phases.map((p) => p.stage), ["elimination", "semi_final", "final"]);
});

test("TUF 2 advancement is valid in its own format", () => {
  assert.deepEqual(advancementProblems(t2 as never), []);
  const elim = (name: string) => t2Bouts.filter((b) => b.stage === "elimination" && (b.a === name || b.b === name)).length;
  assert.equal(elim("Rashad Evans"), 2, "Evans fought twice");
  assert.equal(elim("Sammy Morgan"), 0, "Morgan reached the semi-finals through a forfeit");
  assert.equal(elim("Keith Jardine"), 0, "Jardine reached the semi-finals without a house fight");
  assert.equal(t2.teams.flatMap((t) => t.roster).find((r) => r.name === "Jason Von Flue")?.replacement_for, "Josh Burkman");
  assert.equal(t2.teams.flatMap((t) => t.roster).find((r) => r.name === "Josh Burkman")?.status, "withdrawn");
  const views = buildEpisodeViews(t2 as never, EPISODES["tuf-2"] as never);
  assert.deepEqual(views.episodes.filter((v) => !v.hasFacts).map((v) => v.episode.episode_number), [], "12 of 12 episodes carry facts");
  for (const e of t2.timeline_events) assert.ok(e.sources.length, `${e.id}: sourced`);
});

test("TUF 2 finals remain verified professional bouts, linked by exact bout id", () => {
  const finals = t2Bouts.filter((b) => b.stage === "final");
  assert.equal(finals.length, 2);
  for (const f of finals) {
    assert.equal(resultState(f as never), "verified");
    assert.equal(classState(f as never), "professional");
    assert.match(String(f.ufc_bout_id), /^[0-9a-f-]{36}$/);
  }
});

test("Josh Burkman resolves to the canonical Joshua Burkman through one governed alias, not a naming rule", () => {
  assert.equal(identityIndex["tuf-2"]["Josh Burkman"], "1f85c086-ece4-46fd-9cb0-cd991a3caaee");
  const e = identity.entries["tuf-2|Josh Burkman"];
  assert.equal(e.tier, "alias");
  const aliases = JSON.parse(readFileSync(new URL("../data/tuf/name_aliases.json", import.meta.url), "utf8")) as { aliases: Array<{ source_name: string; seasons: string[] }> };
  assert.deepEqual(aliases.aliases.filter((a) => /Josh/.test(a.source_name)).map((a) => [a.source_name, a.seasons]), [["Josh Burkman", ["tuf-2"]]], "scoped to one person in one season");
  for (const other of ["Josh Koscheck", "Josh Rafferty"]) assert.equal(identity.entries[`tuf-1|${other}`]?.tier, "exact", `${other} is untouched`);
  assert.equal(identityIndex["tuf-2"]["Eli Joslin"], undefined, "Eli Joslin is not Jeff Joslin");
  assert.equal(identityIndex["tuf-2"]["Kenny Stevens"], undefined);
});

test("the 10 TUF 2 ESPN athlete ids map one to one through the finale, with the Imes DOB conflict kept", () => {
  const plan = JSON.parse(readFileSync(new URL("../../scripts/reconcile/evidence/tuf2_espn_athlete_ids.2026-09-13.json", import.meta.url), "utf8")) as {
    expected: number; mapped: number; ambiguous: number; conflicts: number; duplicate_ids: number;
    mappings: Array<{ name: string; fighter_id: string; espn_athlete_id: string; bout_id: string; role: string; canonical_dob: string; espn_dob: string; commission_dob: string | null }>;
  };
  assert.deepEqual([plan.expected, plan.mapped, plan.ambiguous, plan.conflicts, plan.duplicate_ids], [10, 10, 0, 0, 0]);
  assert.equal(new Set(plan.mappings.map((m) => m.espn_athlete_id)).size, 10);
  const roster = new Set([...t2.teams.flatMap((t) => t.roster.map((r) => identityIndex["tuf-2"][r.name])), ...t2.pre_draft_cast.map((p) => identityIndex["tuf-2"][p.name])]);
  assert.ok(plan.mappings.every((m) => roster.has(m.fighter_id)), "only TUF 2 contestants");
  const imes = plan.mappings.find((m) => m.name === "Brad Imes")!;
  assert.deepEqual([imes.canonical_dob, imes.espn_dob, imes.commission_dob], ["1977-03-13", "1977-03-16", "1977-03-16"], "two sources agreeing does not overwrite the canonical date");
});

/* ---- rosters and staff ------------------------------------------------------- */

test("no roster, staff or exception entry is parser debris", () => {
  const debris = /\[\[|\]\]|\|TUF|\bwas replaced\b|\bunable to make weight\b|^\s*;/;
  for (const [slug, detail] of Object.entries(DETAIL_BY_SLUG)) {
    const d = detail as {
      teams?: Array<{ roster: Array<{ name: string }> }>;
      coaches?: Array<{ name: string }>;
      format_exceptions?: Array<{ fighters: string[] }>;
    };
    for (const t of d.teams ?? []) for (const p of t.roster) assert.doesNotMatch(p.name, debris, `${slug}: roster "${p.name}"`);
    for (const c of d.coaches ?? []) assert.doesNotMatch(c.name, debris, `${slug}: staff "${c.name}"`);
    for (const x of d.format_exceptions ?? []) for (const n of x.fighters) assert.doesNotMatch(n, debris, `${slug}: exception "${n}"`);
  }
  const t25 = DETAIL_BY_SLUG["tuf-25"] as { teams: Array<{ name: string; roster: Array<{ name: string; pick?: number }> }> };
  assert.deepEqual(
    t25.teams.find((t) => t.name === "Team Dillashaw")!.roster.map((p) => p.name),
    ["James Krause", "Jesse Taylor", "Ramsey Nijem", "Dhiego Lima", "Joe Stevenson", "Tom Gallicchio", "Gilbert Smith"],
    "TUF 25 rosters are the official selection order",
  );
});

test("staff roles are head, assistant, guest or other, and only the season's coaches are head", () => {
  const ROLES = new Set(["head", "assistant", "guest", "other"]);
  let heads = 0;
  let assistants = 0;
  for (const s of seasons) {
    const d = DETAIL_BY_SLUG[s.slug] as { coaches?: Array<{ name: string; role: string; role_basis?: string; note?: string }> };
    for (const c of d?.coaches ?? []) {
      assert.ok(ROLES.has(c.role), `${s.slug}: ${c.name} has role "${c.role}"`);
      assert.ok(c.role_basis, `${s.slug}: ${c.name} must say why it has its role`);
      if (c.role === "head") {
        heads += 1;
        const named = (s as unknown as { coaches: string[] }).coaches.some((n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "") === c.name.normalize("NFD").replace(/[̀-ͯ]/g, ""));
        assert.ok(named || /head coach/i.test(c.note ?? ""), `${s.slug}: ${c.name} is head without being a named or noted head coach`);
      }
      if (c.role === "assistant") assistants += 1;
    }
  }
  assert.ok(heads < 100, `head coaches are two a season, not ${heads}`);
  assert.ok(assistants > heads, "assistants outnumber head coaches");
});

function countsTowardsRecordShape(b: Bout) {
  return b.classification === "professional" && Boolean(b.classification_source) && !(b as { on_finale_card?: boolean }).on_finale_card;
}

test("a season with no bracket to load is not filed as missing data", () => {
  const fc = seasons.filter((s) => structureOf(s, DETAIL_BY_SLUG[s.slug]).basis === "team_points_format");
  assert.equal(fc.length, 1, "season 21 is the only season with no tournament bracket");
  for (const s of fc) {
    assert.equal(structureOf(s, DETAIL_BY_SLUG[s.slug]).structure, "complete", `${s.slug}: complete in its own format`);
    const d = DETAIL_BY_SLUG[s.slug] as {
      team_competition?: { standings?: unknown[]; concluding_bout?: { winner?: string | null } };
    };
    assert.ok(d?.team_competition, `${s.slug}: a points season requires the format to be recorded`);
    assert.ok(d.team_competition!.standings?.length, `${s.slug}: a scored season needs its standings`);
    assert.ok(
      d.team_competition!.concluding_bout?.winner,
      `${s.slug}: the bout that concluded it must be visible, outside the bracket it never had`,
    );
  }
});
