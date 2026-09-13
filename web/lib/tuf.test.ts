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

type Bout = {
  a: string; b: string; winner: string | null; method: string | null;
  round: number | null; time: string | null; episode: number | null;
  classification: string; classification_source?: string | null;
  on_finale_card?: boolean; tournament_deciding?: boolean; dispute?: string;
};
type Stage = { stage: string; label: string; status?: string; note?: string; bouts: Bout[]; disputed?: Bout[] };
type Season = Record<string, unknown> & {
  slug: string; coverage: string; season_state: string; detail?: string; year: number;
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
    episode_number: number; title: string | null; air_date: null; listing_date: string | null; recap_url: string | null;
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
      assert.equal(e.air_date, null, `${slug} ep${e.episode_number}: no source states an air date`);
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
  const fc = seasons.filter((s) => s.coverage === "format_complete");
  assert.equal(fc.length, 1, "season 21 is the only season with no tournament bracket");
  for (const s of fc) {
    const d = DETAIL_BY_SLUG[s.slug] as {
      team_competition?: { standings?: unknown[]; concluding_bout?: { winner?: string | null } };
    };
    assert.ok(d?.team_competition, `${s.slug}: format_complete requires the format to be recorded`);
    assert.ok(d.team_competition!.standings?.length, `${s.slug}: a scored season needs its standings`);
    assert.ok(
      d.team_competition!.concluding_bout?.winner,
      `${s.slug}: the bout that concluded it must be visible, outside the bracket it never had`,
    );
  }
});
