/* Which stored ufc_images row is a fighter's portrait — pure, no imports.
 *
 * ONE rule for every PropBetEdge surface. lib/db.ts (the website) and
 * workers/ufc-api (the display_image contract other properties read) both
 * import this module, so the same fighter can never be shown with one photo
 * on ufc.propbetedge.ai and a different one on propbetedge.ai. The ESPN
 * display preference and identity gate live beside it, in
 * lib/displayPortraitPolicy.ts and lib/espnPortraitGate.ts.
 */

export const IMAGE_KIND_PRIORITY: Readonly<Record<string, number>> = {
  licensed_editorial: 500,
  official_press: 450,
  public_domain: 400,
  wikimedia: 350,
  statcard: 100,
};

/* Catalog images that stay in ufc_images but are never picked as a fighter's
 * primary portrait. Listed by image id, one reason each; the fighter falls
 * through to the next rule (another stored image, else the display fallback). */
export const NOT_PRIMARY_PORTRAIT: ReadonlySet<string> = new Set<string>([
  "73077eea-6c1e-4f3b-88e4-c23a412c11d8", // Petr Yan: Kremlin award ceremony handshake, not a portrait
]);

export type SelectableImage = {
  id: string;
  kind: string;
  fighter_id?: string | null;
  stored_first_party?: boolean | null;
  rights_expires_at?: string | null;
};

export function imagePriority(img: SelectableImage, now = Date.now()): number {
  let p = IMAGE_KIND_PRIORITY[img.kind] || 0;
  if (img.stored_first_party === false) p -= 25;
  if (img.rights_expires_at && Date.parse(img.rights_expires_at) <= now) p -= 10000;
  return p;
}

/**
 * The chosen stored portrait per fighter. `rows` must be newest first
 * (created_at desc): on equal priority the first row seen wins.
 */
export function pickStoredPortraits<T extends SelectableImage>(rows: Iterable<T>, now = Date.now()): Map<string, T> {
  const chosen = new Map<string, T>();
  for (const r of rows) {
    if (!r.fighter_id || NOT_PRIMARY_PORTRAIT.has(r.id)) continue;
    if (r.rights_expires_at && Date.parse(r.rights_expires_at) <= now) continue;
    const prev = chosen.get(r.fighter_id);
    if (!prev || imagePriority(r, now) > imagePriority(prev, now)) chosen.set(r.fighter_id, r);
  }
  return chosen;
}
