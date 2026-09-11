/* Which fighters an article draws a face for, and therefore which fighters it
 * must request portraits for.
 *
 * THE BUG THIS EXISTS TO PREVENT (GitHub issue #19)
 *
 * StoryView requested images for `a.fighter_ids` only, then drew the linked
 * bout's fighter_a AND fighter_b from that map. An article whose fighter_ids
 * named only the primary fighter rendered the opponent as initials even when
 * a stored portrait or display fallback existed, because nobody asked for it.
 *
 * The rule: every fighter the page can render is in the request set, and the
 * page makes ONE request for that set. Images are looked up by fighter id and
 * nothing else, so a missing portrait falls through to that fighter's initials,
 * never to another fighter's photo.
 *
 * Pure on purpose: no db, no server-only, so the rule is testable in isolation
 * (storyImages.test.ts). */

type Id = string | null | undefined;
type Side = { id?: Id } | null | undefined;
export type BoutSides = { fighter_a?: Side; fighter_b?: Side } | null | undefined;

/** Union of article fighter ids, the linked bout's two fighters and any extra
 * ids the page renders (the legacy matchup module), de-duplicated, order kept. */
export function storyImageIds(articleFighterIds: readonly Id[] | null | undefined, bout: BoutSides, extra: readonly Id[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: Id) => {
    const s = typeof id === "string" ? id.trim() : "";
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  };
  (articleFighterIds || []).forEach(push);
  push(bout?.fighter_a?.id);
  push(bout?.fighter_b?.id);
  extra.forEach(push);
  return out;
}

/** The fighters the story draws faces for: the bout's two sides when a bout is
 * linked, otherwise the first two article fighters. */
export function storyFaces<F extends { id: string }>(bout: { fighter_a: F; fighter_b: F } | null | undefined, articleFighters: readonly F[]): F[] {
  return bout ? [bout.fighter_a, bout.fighter_b] : articleFighters.slice(0, 2);
}

/** The story's primary subject -- the fighter the subject card and the hero
 * photo are about. That is fact_block.primary.fighter_id, else the first
 * article fighter; it is NOT faces[0], which is bout.fighter_a and is the
 * opponent whenever the subject is listed second on the bout (the Rahiki vs.
 * McMillen story). Returns null rather than a guess. */
export function storySubject<F extends { id: string }>(primaryId: Id, articleFighterIds: readonly Id[] | null | undefined, candidates: readonly (F | null | undefined)[]): F | null {
  const byId = new Map<string, F>();
  for (const c of candidates) if (c && c.id && !byId.has(c.id)) byId.set(c.id, c);
  const want = (typeof primaryId === "string" && primaryId) || (articleFighterIds || []).find((x): x is string => typeof x === "string" && !!x);
  return (want && byId.get(want)) || null;
}

/** Same person, by display name, for data that carries a name but no id. */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase();
export const sameFighterName = (a?: string | null, b?: string | null) => !!a && !!b && fold(a) === fold(b);

/** Fetch portraits once for everything the story can render. */
export async function loadStoryImages<T>(
  ids: readonly string[],
  fetchImages: (ids: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  return ids.length ? fetchImages([...ids]) : new Map<string, T>();
}
