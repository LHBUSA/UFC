/* Deterministic public slugs. No slug column exists yet; every slug carries
 * the entity's source id so it is unique and resolvable without a lookup
 * table:  fighter  -> manel-kape-3155416     (espn athlete id, else ufcstats id)
 *         event    -> ufc-fight-night-royval-vs-kape-2025-12-14
 *         article  -> ufc_articles.slug (already unique) */

export function slugify(s: string): string {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function fighterSlug(f: { name: string; espn_athlete_id: string | null; ufcstats_id: string | null }): string {
  const id = f.espn_athlete_id || f.ufcstats_id || "";
  return `${slugify(f.name)}-${id}`;
}

/* The id is the last dash-separated token. */
export function fighterIdFromSlug(slug: string): string | null {
  const m = String(slug || "").match(/-([0-9a-z]{6,20})$/);
  return m ? m[1] : null;
}

export function eventSlug(e: { name: string; event_date: string | null }): string {
  return `${slugify(e.name)}-${e.event_date || "tbd"}`;
}

export function eventDateFromSlug(slug: string): string | null {
  const m = String(slug || "").match(/-(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

export function matchupSlug(a: { name: string }, b: { name: string }, e: { name: string; event_date: string | null }): string {
  return `${slugify(a.name)}-vs-${slugify(b.name)}-${eventSlug(e)}`;
}
