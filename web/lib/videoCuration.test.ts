/* Fight Week video language + curation. Run: npm run test:story-media
 *
 * 2026-09-18, UFC 331 week: /fight-week rendered a wall of Korean-titled main
 * channel uploads, each badged ENGLISH, under a ten-card "OFFICIAL VIDEO" group.
 * Three causes, each pinned here: the channel decided the language, localized
 * titles fell through to `other`, and the timeline rendered the inventory. */
import test from "node:test";
import assert from "node:assert/strict";
import { videoLanguage, scriptLanguage, filterByLanguage, defaultLanguage, parseLang, videoPlayability, LANG_LABEL, type VideoLang } from "./videoPolicy.ts";
import { curateFightWeekVideos, foldVariants, variantKey, episodeNumber, CURATION_DEFAULTS, type CurationVideo } from "./videoCuration.ts";
// @ts-expect-error -- plain .mjs shared with the ingest Worker
import { detectLanguage, scriptLanguage as ingestScriptLanguage, classifyVideo } from "../../scripts/videos/lib.mjs";

const row = (channel_name: string, title: string, language?: string) => ({ channel_name, title, description: null, source_metadata: language ? { language } : null });

/* Titles taken from the production rows attached to UFC 331 on 2026-09-18. */
const KO = ["최두호 vs 티아고 타바레스 | 풀 파이트 | Crypto.com UFC 331", "9개월 만의 대면에 설레는 반과 판토자 #UFC331", "최두호가 핏불을 고른 이유🔥 #UFC331", "최두호의 모든 파이트"];
const EN = ["Crypto.com UFC 331: Pre-Fight Press Conference", "Van is ready for the rematch 🙌 #ufc331", "Crypto.com UFC 331 Embedded: Vlog Series - Episode 4", "Arman Tsarukyan vs Dan Hooker | FULL FIGHT | Crypto.com UFC 331"];

test("a Hangul title on the main UFC channel is Korean, never English — even when the row was stored as en", () => {
  for (const t of KO) {
    assert.equal(videoLanguage(row("UFC", t)), "ko", t);
    assert.equal(videoLanguage(row("UFC", t, "en")), "ko", "a stale stored language:en must not survive a Hangul title");
    assert.notEqual(LANG_LABEL[videoLanguage(row("UFC", t, "en"))], "English");
  }
  assert.equal(filterByLanguage(KO.map((t) => row("UFC", t, "en")), "en").length, 0, "no Korean clip in the English view");
});

test("a Japanese title is Japanese; Han without kana is unlisted, not English and not guessed", () => {
  assert.equal(videoLanguage(row("UFC", "平良達郎 vs ジョシュア・ヴァン | フルファイト")), "ja");
  assert.equal(videoLanguage(row("UFC Japan", "朝倉海のUFCデビュー戦を振り返る", "en")), "ja");
  assert.equal(videoLanguage(row("UFC", "張偉麗 對 閆曉楠 完整比賽")), "unknown", "Chinese or Japanese: not decidable from Han alone");
  assert.equal(videoLanguage(row("UFC", "Ислам Махачев: путь чемпиона")), "other");
  assert.equal(videoLanguage(row("ESPN MMA", "مقابلة مع بطل UFC")), "other");
  for (const t of ["平良達郎 vs ジョシュア・ヴァン", "張偉麗 對 閆曉楠", "Ислам Махачев: путь"]) assert.notEqual(videoLanguage(row("UFC", t)), "en", t);
});

test("English, Spanish and Portuguese behaviour is unchanged", () => {
  for (const t of EN) assert.equal(videoLanguage(row("UFC", t)), "en", t);
  assert.equal(videoLanguage(row("UFC", "Tsarukyan 🆚 Ruffy — who you got? 🔥")), "en", "emoji and symbols are not a script");
  assert.equal(videoLanguage(row("UFC", "Zhang Weili 张 vs Yan")), "en", "one stray character never relabels a title");
  assert.equal(videoLanguage(row("UFC Espanol", "#CryptoCom #UFC331 Embedded Español: Episodio 4")), "es");
  assert.equal(videoLanguage(row("UFC Brasil", "Crypto.com UFC 331: Embedded | Episódio 4")), "pt");
  assert.equal(videoLanguage(row("UFC", "A história da luta: não é você, campeão da noite")), "pt");
  assert.equal(videoLanguage(row("Some Channel", "Fight night recap")), "unknown");
  /* An explicit stored language on a Latin-script title is still the contract. */
  assert.equal(videoLanguage(row("UFC", "Embedded Episode 4", "pt")), "pt");
  assert.equal(videoLanguage(row("UFC", "Embedded Episode 4", "ko")), "ko");
});

test("the toolbar stays four filters; ko/ja are labels, reachable under All", () => {
  assert.deepEqual(["all", "en", "es", "pt"].map(parseLang), ["all", "en", "es", "pt"]);
  assert.equal(parseLang("ko"), null);
  assert.equal(LANG_LABEL.ko, "Korean");
  assert.equal(LANG_LABEL.ja, "Japanese");
  const mixed = [...EN.map((t) => row("UFC", t)), ...KO.map((t) => row("UFC", t))];
  assert.equal(defaultLanguage(mixed), "en");
  assert.equal(filterByLanguage(mixed, "all").length, 8);
  assert.equal(defaultLanguage(KO.map((t) => row("UFC", t, "en"))), "all", "no real English clips: fall back to All, labelled truthfully");
});

test("ingest and web agree on every title (parity)", () => {
  const cases: Array<[string, string]> = [
    ...KO.map((t): [string, string] => ["UFC", t]), ...EN.map((t): [string, string] => ["UFC", t]),
    ["UFC", "平良達郎 vs ジョシュア・ヴァン | フルファイト"], ["UFC", "張偉麗 對 閆曉楠 完整比賽"], ["UFC", "Ислам Махачев: путь чемпиона"],
    ["UFC Brasil", "Coletiva de Imprensa | Crypto.com UFC 331: Van x Pantoja 2"], ["UFC Brasil", "최두호 vs 핏불"], ["UFC Espanol", "#CryptoCom #UFC331: Careos Conferencia de Prensa"],
    ["ESPN MMA", "This corner for #UFC331 will be wild 😭"], ["UFC Fight Pass", "Invicta FC 60 Weigh-In"], ["Unknown Channel", "whatever"],
  ];
  for (const [ch, t] of cases) {
    assert.equal(scriptLanguage(t), ingestScriptLanguage(t), `script: ${t}`);
    assert.equal(detectLanguage(ch, t, null).language, videoLanguage(row(ch, t)), `${ch} | ${t}`);
  }
  assert.equal(detectLanguage("UFC", KO[0], null).method, "script");
});

test("localized programme-format names classify; commentary does not", () => {
  assert.equal(classifyVideo("최두호 vs 다니엘 산토스 | 풀 파이트 | Crypto.com UFC 331", "").video_type, "full_fight");
  assert.equal(classifyVideo("UFC 331 임베디드 4화", "").video_type, "embedded_episode");
  assert.equal(classifyVideo("UFC 331 公式計量", "").video_type, "weigh_in");
  assert.equal(classifyVideo("최두호의 넘버이벤트 첫 기자회견 소감 #ufc331", "").video_type, "other", "a Short talking ABOUT the press conference is not the press conference");
  assert.equal(classifyVideo("Crypto.com UFC 331: Pre-Fight Press Conference", "").video_type, "press_conference");
});

/* ---- curation ---------------------------------------------------------- */

let n = 0;
const vid = (over: Partial<CurationVideo> & { title: string }): CurationVideo => {
  n += 1;
  return { id: `v${String(n).padStart(3, "0")}`, video_type: "other", published_at: "2026-09-17T12:00:00Z", lang: "en", blocked: false, embeddable: true, verified: false, tier: 1, fighter_ids: [], bout_id: null, ...over };
};
const lang = (t: string): VideoLang => videoLanguage(row("UFC", t));

/* UFC 331 in miniature: the press-conference hour, with its Korean and English Shorts. */
function fightWeek(): CurationVideo[] {
  n = 0;
  const burstHour = (i: number) => `2026-09-18T01:${String(10 + i).padStart(2, "0")}:00Z`;
  return [
    ...Array.from({ length: 9 }, (_, i) => vid({ title: `${KO[1]} ${i}`, lang: lang(KO[1]), published_at: burstHour(i) })),
    ...Array.from({ length: 8 }, (_, i) => vid({ title: `Van is ready for the rematch ${i} #ufc331`, published_at: burstHour(i + 20) })),
    vid({ title: KO[0], lang: "ko", video_type: "full_fight", published_at: "2026-09-18T02:00:00Z" }),
    vid({ title: "Crypto.com UFC 331 Embedded: Vlog Series - Episode 4", video_type: "embedded_episode", published_at: "2026-09-17T14:49:00Z" }),
    vid({ title: "Crypto.com UFC 331 Embedded: Vlog Series - Episode 3", video_type: "embedded_episode", published_at: "2026-09-16T14:46:00Z" }),
    vid({ title: "Crypto.com UFC 331 Embedded: Vlog Series - Episode 2", video_type: "embedded_episode", published_at: "2026-09-15T15:10:00Z" }),
    vid({ title: "Crypto.com UFC 331 Countdown - Full Episode", video_type: "countdown", published_at: "2026-09-13T11:45:00Z" }),
    vid({ title: "Crypto.com UFC 331: Pre-Fight Press Conference", video_type: "press_conference", published_at: "2026-09-18T00:48:00Z" }),
    vid({ title: "\"He's The Joker!\" | Crypto.com UFC 331 Media Day", video_type: "media_day", published_at: "2026-09-16T23:22:00Z" }),
    vid({ title: "Crypto.com UFC 331: Ceremonial Weigh-In", video_type: "weigh_in", published_at: "2026-09-14T18:07:00Z" }),
    vid({ title: "what are these faceoffs saying?! #ufc331", video_type: "faceoff", published_at: "2026-09-16T15:41:00Z" }),
    vid({ title: "UFC 331 Betting Preview with Laura Sanko", video_type: "fight_preview", published_at: "2026-09-17T17:30:00Z" }),
    ...Array.from({ length: 4 }, (_, i) => vid({ title: `Interview ${i} #ufc331`, video_type: "interview", published_at: `2026-09-16T1${i}:00:00Z` })),
    vid({ title: "Arman Tsarukyan vs Dan Hooker | FULL FIGHT", video_type: "full_fight", published_at: "2026-09-08T14:00:00Z" }),
    vid({ title: "Blocked Countdown (BR only)", video_type: "countdown", blocked: true, published_at: "2026-09-18T03:00:00Z" }),
    vid({ title: "Embedding disabled weigh-in", video_type: "weigh_in", embeddable: false, published_at: "2026-09-18T03:00:00Z" }),
    vid({ title: "Crypto.com UFC 331: Embedded | Episódio 4", lang: "pt", tier: 3, video_type: "embedded_episode", published_at: "2026-09-17T23:00:00Z" }),
    vid({ title: "#CryptoCom #UFC331 Embedded Español: Episodio 4", lang: "es", tier: 3, video_type: "embedded_episode", published_at: "2026-09-17T21:26:00Z" }),
  ];
}

test("default English Fight Week: curated, no Korean, every real stage present, caps hold", () => {
  const all = fightWeek();
  assert.ok(all.length >= 30);
  const desk = curateFightWeekVideos(all, { lang: "en" });
  assert.equal(desk.lang, "en");
  assert.ok(desk.curated.length <= CURATION_DEFAULTS.max && desk.curated.length >= 8, `${desk.curated.length} cards`);
  assert.ok(desk.curated.every((v) => v.lang === "en"), "no Korean, Spanish or Portuguese clip leaks into the English desk");
  const types = desk.curated.map((v) => v.video_type);
  for (const stage of ["embedded_episode", "countdown", "press_conference", "media_day", "weigh_in", "faceoff", "fight_preview", "interview", "full_fight"]) assert.ok(types.includes(stage), `${stage} is represented`);
  assert.equal(desk.curated[0].title, "Crypto.com UFC 331 Embedded: Vlog Series - Episode 4", "the newest Embedded leads");
  const count = (t: string) => types.filter((x) => x === t).length;
  for (const t of new Set(types)) assert.ok(count(t) <= CURATION_DEFAULTS.perType, `${t} x${count(t)}`);
  assert.ok(count("other") <= CURATION_DEFAULTS.other);
});

test("generic `other` is capped even when it is nearly everything", () => {
  n = 0;
  const flood = Array.from({ length: 15 }, (_, i) => vid({ title: `clip ${i} #ufc331`, published_at: `2026-09-${10 + i}T12:00:00Z` }));
  const desk = curateFightWeekVideos(flood, { lang: "en" });
  assert.equal(desk.curated.length, CURATION_DEFAULTS.other, "15 unclassified uploads render 2 cards, not 15");
  assert.equal(desk.remainder.length, 13, "and the other 13 are one click away, not gone");
});

test("15 uploads inside one hour cannot take the surface", () => {
  n = 0;
  const hour = Array.from({ length: 15 }, (_, i) => vid({ title: `burst ${i}`, video_type: ["interview", "faceoff", "press_conference", "highlights", "other"][i % 5], published_at: `2026-09-18T01:${String(i).padStart(2, "0")}:00Z` }));
  const steady = [vid({ title: "Countdown", video_type: "countdown", published_at: "2026-09-13T11:00:00Z" }), vid({ title: "Embedded Episode 1", video_type: "embedded_episode", published_at: "2026-09-14T16:00:00Z" }), vid({ title: "Weigh-In", video_type: "weigh_in", published_at: "2026-09-14T18:00:00Z" })];
  const desk = curateFightWeekVideos([...hour, ...steady], { lang: "en" });
  const fromBurst = desk.curated.filter((v) => v.title.startsWith("burst")).length;
  assert.equal(fromBurst, CURATION_DEFAULTS.perHour);
  for (const s of steady) assert.ok(desk.curated.includes(s), `${s.title} survives the burst`);
});

test("playability outranks freshness and stage: blocked and unembeddable rows never reach the desk", () => {
  const all = fightWeek();
  for (const l of ["en", "all"] as const) {
    const desk = curateFightWeekVideos(all, { lang: l });
    assert.ok(![...desk.curated, ...desk.remainder].some((v) => v.blocked || v.embeddable === false), l);
    assert.equal(desk.suppressed, 2);
  }
  n = 0;
  const verifiedOld = vid({ title: "Countdown (region verified)", video_type: "countdown", verified: true, published_at: "2026-09-01T00:00:00Z" });
  const freshUnverified = vid({ title: "Countdown (fresh, unverified)", video_type: "countdown", published_at: "2026-09-18T00:00:00Z" });
  assert.equal(curateFightWeekVideos([freshUnverified, verifiedOld], { lang: "en", perType: 1 }).curated[0], verifiedOld);
  /* No regression in the policy the curation sits on. */
  assert.equal(videoPlayability({ embeddable: true, source_metadata: { region_check: { method: "youtube_data_api" }, region_restriction: { blocked: ["US"] } } }), "blocked");
  assert.equal(videoPlayability({ embeddable: false, source_metadata: null }), "unembeddable");
});

test("All keeps localized clips reachable, labelled truthfully, and folds only true variants", () => {
  const all = fightWeek();
  const desk = curateFightWeekVideos(all, { lang: "all" });
  const everything = [...desk.curated, ...desk.remainder, ...[...desk.variants.values()].flat()];
  assert.equal(everything.length, all.length - desk.suppressed, "nothing eligible is dropped in All");
  assert.equal(everything.filter((v) => v.lang === "ko").length, 10);
  assert.ok(desk.curated.length <= CURATION_DEFAULTS.max);
  /* Embedded Episode 4 exists in en, pt and es: one card, English first, two variants behind it. */
  const ep4 = desk.curated.find((v) => episodeNumber(v.title) === 4)!;
  assert.equal(ep4.lang, "en");
  assert.deepEqual((desk.variants.get(ep4.id) || []).map((v) => v.lang).sort(), ["es", "pt"]);
  /* Each language view still has its own copy. */
  assert.equal(curateFightWeekVideos(all, { lang: "pt" }).curated[0].lang, "pt");
  assert.equal(curateFightWeekVideos(all, { lang: "es" }).curated[0].lang, "es");
});

test("variant folding is conservative: unrelated clips uploaded together are never merged", () => {
  n = 0;
  const a = vid({ title: "Interview with A", video_type: "interview", fighter_ids: ["f1"], lang: "en" });
  const b = vid({ title: "Entrevista com A", video_type: "interview", fighter_ids: ["f1"], lang: "pt" });
  assert.equal(variantKey(a), null, "interviews are never variants of each other");
  assert.equal(foldVariants([a, b], "en").kept.length, 2);
  const p1 = vid({ title: "Press Conference", video_type: "press_conference", lang: "en" });
  const p2 = vid({ title: "Coletiva de Imprensa", video_type: "press_conference", lang: "pt" });
  assert.equal(foldVariants([p1, p2], "en").kept.length, 2, "no linked fighter or bout: not enough evidence to merge");
  const f1 = vid({ title: "A vs B | FULL FIGHT", video_type: "full_fight", fighter_ids: ["f1", "f2"], lang: "en" });
  const f2 = vid({ title: "A x B | LUTA COMPLETA", video_type: "full_fight", fighter_ids: ["f2", "f1"], lang: "pt" });
  const f3 = vid({ title: "A vs C | FULL FIGHT", video_type: "full_fight", fighter_ids: ["f1", "f3"], lang: "pt" });
  const f4 = vid({ title: "A vs B | FULL FIGHT (2019 upload)", video_type: "full_fight", fighter_ids: ["f1", "f2"], lang: "pt", published_at: "2026-08-01T00:00:00Z" });
  const folded = foldVariants([f1, f2, f3, f4], "en");
  assert.deepEqual(folded.kept.map((v) => v.id).sort(), [f1.id, f3.id, f4.id].sort(), "same fighters + same type + 48h folds; a different opponent or a month apart does not");
  const e1 = vid({ title: "Embedded Episode 2", video_type: "embedded_episode", lang: "en" });
  const e2 = vid({ title: "Embedded Episode 3", video_type: "embedded_episode", lang: "pt" });
  assert.equal(foldVariants([e1, e2], "en").kept.length, 2, "different episodes are different items");
  const same = [vid({ title: "Media Day A", video_type: "media_day", fighter_ids: ["f1"] }), vid({ title: "Media Day A again", video_type: "media_day", fighter_ids: ["f1"] })];
  assert.equal(foldVariants(same, "en").kept.length, 2, "two English clips are two clips, never variants");
});

test("deterministic: input order never changes the desk; a missing language falls back to All", () => {
  const a = fightWeek();
  const ids = (list: CurationVideo[]) => curateFightWeekVideos(list, { lang: "en" }).curated.map((v) => v.title);
  assert.deepEqual(ids([...a].reverse()), ids(a));
  assert.deepEqual(ids([...a].sort((x, y) => x.title.localeCompare(y.title))), ids(a));
  n = 0;
  const onlyKo = KO.map((t) => vid({ title: t, lang: "ko" }));
  const desk = curateFightWeekVideos(onlyKo, { lang: "en" });
  assert.deepEqual([desk.lang, desk.fellBack, desk.curated.every((v) => v.lang === "ko")], ["all", true, true]);
  /* After the card: the aftermath leads. */
  const post = curateFightWeekVideos([...a, vid({ title: "Post-Fight Press Conference", video_type: "post_fight" })], { lang: "en", phase: "post" });
  assert.equal(post.curated[0].video_type, "post_fight");
});
