/* Date-of-birth evidence per source — pure logic.
 *
 * ufc_fighters.dob is ONE value. Where the sources behind a canonical fighter
 * print different dates (combat_fighter_identities keeps one dob per source
 * namespace), that single value must not be shown as if the sources agreed.
 * This decides whether they disagree and how to say it; it never picks a
 * winner and never changes the stored value. */

export type SourceDob = { source: string; dob: string };

const SOURCE_LABEL: Record<string, string> = { espn: "ESPN", ufcstats: "UFC Stats", wikidata: "Wikidata", wikipedia_en: "Wikipedia" };

export type DobDispute = { values: Array<{ dob: string; sources: string[] }> } | null;

export function dobDispute(rows: SourceDob[]): DobDispute {
  const byDob = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r?.dob || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.dob).slice(0, 10))) continue;
    const d = String(r.dob).slice(0, 10);
    byDob.set(d, (byDob.get(d) || new Set()).add(SOURCE_LABEL[r.source] || r.source));
  }
  if (byDob.size < 2) return null;
  return { values: [...byDob.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dob, s]) => ({ dob, sources: [...s].sort() })) };
}

/** Whole-year ages across the disputed dates, youngest first: "37–38". */
export function ageRange(dispute: NonNullable<DobDispute>, at: Date = new Date()): string {
  const ages = dispute.values.map(({ dob }) => {
    const [y, m, d] = dob.split("-").map(Number);
    let a = at.getUTCFullYear() - y;
    if (at.getUTCMonth() + 1 < m || (at.getUTCMonth() + 1 === m && at.getUTCDate() < d)) a -= 1;
    return a;
  });
  const lo = Math.min(...ages), hi = Math.max(...ages);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}
