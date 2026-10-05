/* Fight DNA division context — pure parsing of the private daily document
 * written by the ufc-intelligence Worker (workers/ufc-intelligence/src/divisionContext.js).
 * The document holds ranks and population sizes only, never metric values. */

export type DivisionRank = { metric: string; rank: number; n: number; better: "higher" | "lower" };
export type DnaDivisionContext = {
  as_of: string;
  division: { key: string; label: string; population: number };
  ranks: DivisionRank[];
};

type Doc = {
  as_of?: unknown;
  metrics?: Record<string, { better?: unknown }>;
  divisions?: Record<string, { label?: unknown; population?: unknown }>;
  fighters?: Record<string, { division?: unknown; ranks?: Record<string, unknown> }>;
};

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** The context for one fighter, or null when the document is malformed or the fighter is not ranked. */
export function pickDivisionContext(doc: unknown, fighterId: string): DnaDivisionContext | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Doc;
  if (typeof d.as_of !== "string" || !d.fighters || !d.divisions || !d.metrics) return null;
  const f = d.fighters[fighterId];
  if (!f || typeof f.division !== "string" || !f.ranks) return null;
  const div = d.divisions[f.division];
  if (!div || typeof div.label !== "string" || !posInt(div.population)) return null;
  const ranks: DivisionRank[] = [];
  for (const [metric, meta] of Object.entries(d.metrics)) {
    const r = f.ranks[metric];
    if (!Array.isArray(r) || !posInt(r[0]) || !posInt(r[1]) || r[0] > r[1]) continue;
    ranks.push({ metric, rank: r[0], n: r[1], better: meta?.better === "lower" ? "lower" : "higher" });
  }
  if (!ranks.length) return null;
  return { as_of: d.as_of, division: { key: f.division, label: div.label, population: div.population }, ranks };
}
