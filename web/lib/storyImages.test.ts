/* Article fighter images. Run: npm run test:story-media
 *
 * Regression for GitHub issue #19: the Silva/Delgado story listed only Jean
 * Silva in fighter_ids, linked the Silva-vs-Delgado bout, and rendered Delgado
 * as initials although getImagesForFighters() resolves his ESPN display
 * fallback. The page drew both bout fighters from a map built from
 * fighter_ids alone. */
import test from "node:test";
import assert from "node:assert/strict";
import { storyImageIds, storyFaces, storySubject, sameFighterName, loadStoryImages } from "./storyImages.ts";

type Img = { id: string; portrait: string };
const A = { id: "eed368a5-484b-412f-9d2c-a4fd6d24d019", name: "Jean Silva" };
const B = { id: "55ef67ad-88fe-4f7a-b4cb-dc9a10c12feb", name: "Jose Miguel Delgado" };
const bout = { fighter_a: A, fighter_b: B };
const catalog = new Map<string, Img>([
  [A.id, { id: "img-silva", portrait: "https://media.example/silva.webp" }],
  /* Delgado has no stored portrait, only the ESPN display fallback. */
  [B.id, { id: "espn:5223435", portrait: "https://a.espncdn.com/i/headshots/mma/players/full/5223435.png" }],
]);

/* Stand-in for getImagesForFighters: answers only for ids it was asked for,
 * exactly like the real one, and records every call. */
function fakeFetcher(source = catalog) {
  const calls: string[][] = [];
  const fetchImages = async (ids: string[]) => {
    calls.push(ids);
    const m = new Map<string, Img>();
    for (const id of ids) { const img = source.get(id); if (img) m.set(id, img); }
    return m;
  };
  return { calls, fetchImages };
}

/* What StoryView does, end to end: ids -> one fetch -> faces -> img per face. */
async function renderFaces(fighterIds: string[], b: typeof bout | null, articleFighters = [A], source = catalog) {
  const f = fakeFetcher(source);
  const imgs = await loadStoryImages(storyImageIds(fighterIds, b), f.fetchImages);
  const faces = storyFaces(b, articleFighters);
  return { calls: f.calls, rendered: faces.map((x) => ({ name: x.name, img: imgs.get(x.id) ?? null })) };
}

test("fighter_ids=[A] + linked A-vs-B bout: B renders with B's own image", async () => {
  const { calls, rendered } = await renderFaces([A.id], bout);
  assert.equal(calls.length, 1, "images are fetched once for the whole story");
  assert.deepEqual(new Set(calls[0]), new Set([A.id, B.id]));
  assert.equal(rendered[0].name, "Jean Silva");
  assert.equal(rendered[0].img?.id, "img-silva");
  assert.equal(rendered[1].name, "Jose Miguel Delgado");
  assert.equal(rendered[1].img?.id, "espn:5223435");
});

test("the old request set (fighter_ids only) is what dropped B", async () => {
  const f = fakeFetcher();
  const imgs = await f.fetchImages([A.id]);
  assert.equal(imgs.get(B.id), undefined, "documents the #19 defect this module replaces");
});

test("B without any image falls to initials, never to A's photo", async () => {
  const noB = new Map([[A.id, catalog.get(A.id)!]]);
  const { rendered } = await renderFaces([A.id], bout, [A], noB);
  assert.equal(rendered[1].name, "Jose Miguel Delgado");
  assert.equal(rendered[1].img, null);
  assert.equal(rendered[0].img?.id, "img-silva");
});

test("each face gets its own fighter's image even when bout order differs from fighter_ids order", async () => {
  const { rendered } = await renderFaces([B.id], { fighter_a: B, fighter_b: A } as unknown as typeof bout, [B]);
  assert.deepEqual(rendered.map((r) => [r.name, r.img?.id]), [["Jose Miguel Delgado", "espn:5223435"], ["Jean Silva", "img-silva"]]);
});

test("union is de-duplicated, keeps order and ignores blanks", () => {
  assert.deepEqual(storyImageIds([A.id, B.id, "", null, A.id], bout, ["m1", B.id, undefined]), [A.id, B.id, "m1"]);
});

test("no bout: faces are the first two article fighters and only they are requested", async () => {
  const C = { id: "c", name: "Third" };
  const ids = storyImageIds([A.id, B.id, C.id], null);
  assert.deepEqual(ids, [A.id, B.id, C.id]);
  assert.deepEqual(storyFaces(null, [A, B, C]).map((f) => f.id), [A.id, B.id]);
});

test("subject card uses the PRIMARY fighter's image even when the primary is bout.fighter_b", async () => {
  /* Rahiki vs. McMillen, live 2026-09-11: fighter_ids=[Rahiki], bout lists
   * McMillen first. With the union request McMillen's image is now in the
   * map; drawing the subject card from faces[0] would put McMillen's photo on
   * Rahiki's card. The subject resolves by id instead. */
  const R = { id: "b91270c0", name: "Marwan Rahiki" }, M = { id: "b5bceb9a", name: "Tommy McMillen" };
  const imgs = await loadStoryImages(storyImageIds([R.id], { fighter_a: M, fighter_b: R }), async (ids) => new Map(ids.map((id) => [id, { id: `img-${id}` }])));
  const faces = storyFaces({ fighter_a: M, fighter_b: R }, [R]);
  assert.equal(faces[0].name, "Tommy McMillen", "faces[0] is the opponent here");
  const subject = storySubject(R.id, [R.id], [R, M]);
  assert.equal(subject?.name, "Marwan Rahiki");
  assert.equal(imgs.get(subject!.id)?.id, "img-b91270c0");
  assert.equal(storySubject(null, [R.id], [M, R])?.name, "Marwan Rahiki", "falls back to the first article fighter");
  assert.equal(storySubject("unknown", [R.id], [M, R]), null, "never a guess");
});

test("fighter names compare accent- and case-insensitively", () => {
  assert.equal(sameFighterName("José Miguel Delgado", "jose miguel delgado "), true);
  assert.equal(sameFighterName("Jean Silva", "Jose Miguel Delgado"), false);
  assert.equal(sameFighterName(null, "Jean Silva"), false);
});

test("nothing to request makes no request", async () => {
  const f = fakeFetcher();
  const m = await loadStoryImages(storyImageIds([], null), f.fetchImages);
  assert.equal(m.size, 0);
  assert.equal(f.calls.length, 0);
});
