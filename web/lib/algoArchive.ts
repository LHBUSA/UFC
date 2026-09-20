/* PBE Picks archive: the full-history index behind the Track Record & Past
 * Picks page and the live tracker.
 *
 * Pure: no fetch, no env, no "@/..." import, so `node --test` runs it as is.
 * lib/algo.ts supplies the reader; tests supply an in-memory one that behaves
 * like PostgREST, including its row cap.
 *
 * THE POPULATION. Official picks are rows of ufc_model_predictions with a
 * database-stamped locked_at. Drafts are the same table with locked_at NULL and
 * are never selected. Shadow/challenger calls and backtests live in their own
 * tables (ufc_model_shadow_*, ufc_model_backtest_*), which nothing here reads.
 * No model_version filter is applied, so a retired official version keeps its
 * picks in the archive after a promotion.
 *
 * NO ROW CAP. Both scans walk the whole table by primary key and stop on an
 * EMPTY page, never on a short one: a server whose max-rows is lower than the
 * requested limit returns short pages long before the end, and "short page =
 * done" would truncate history silently. Aggregates are computed from this
 * index, never from the ten events a page happens to show.
 *
 * NOTHING IS DROPPED OR MERGED QUIETLY. A pick with no resolvable event is
 * grouped under UNRESOLVED_EVENT and still counted; a grade with no locked
 * prediction, or a primary key seen twice in one scan, is reported in
 * `integrity` instead of being discarded.
 *
 * FROZEN INPUTS. Units use the best price stored in the prediction's lock-time
 * market snapshot and nothing else. A decided pick without one stays in W-L and
 * hit rate and is left out of the ROI denominator; draws, no contests and voids
 * are neither wins nor losses. This is the methodology the tracker has always
 * used (it moved here from lib/algo.ts unchanged). */

export type GradeResult = "WIN" | "LOSS" | "DRAW" | "NC" | "VOID";

/** Lean row: aggregate inputs only. No fighter, no pick side. */
export type IndexPred = {
  id: string;
  event_id: string | null;
  bout_id: string;
  locked_at: string;
  model_version: string;
  pick_probability: number | string;
  model_edge_pts: number | string | null;
  confidence: string | null;
  best_odds: number | string | null;
};
export type IndexGradeRow = { id: string; prediction_id: string; revision: number; result: GradeResult; graded_at: string };
export type IndexEvent = { id: string; name: string; event_date: string };

export type Reader = <T>(path: string) => Promise<T[]>;

export class ArchiveReadError extends Error {
  constructor(message: string) { super(message); this.name = "ArchiveReadError"; }
}

export const SCAN_LIMIT = 1000;
export const ARCHIVE_PAGE_SIZE = 10;
export const UNRESOLVED_EVENT = "unresolved";
/** A card whose picks are still ungraded this many days after its date is overdue. */
export const GRADING_OVERDUE_DAYS = 2;
const MAX_SCAN_PAGES = 500;

export const PRED_INDEX_SELECT = "id,event_id,bout_id,locked_at,model_version,pick_probability,model_edge_pts,confidence:sample_context->>confidence,best_odds:sample_context->market->>pick_best_odds";
export const GRADE_INDEX_SELECT = "id,prediction_id,revision,result,graded_at";

/** Walk a table by primary key until a page comes back empty. */
export async function scanAll<T extends { id: string }>(read: Reader, table: string, select: string, filter = "", limit = SCAN_LIMIT): Promise<{ rows: T[]; duplicates: string[] }> {
  const rows: T[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const batch: T[] = await read<T>(`${table}?select=${select}${filter ? `&${filter}` : ""}${after ? `&id=gt.${after}` : ""}&order=id.asc&limit=${limit}`);
    if (!batch.length) return { rows, duplicates };
    for (const r of batch) {
      if (seen.has(r.id)) duplicates.push(r.id); else seen.add(r.id);
      rows.push(r);
    }
    const last = batch[batch.length - 1].id;
    if (after != null && last <= after) throw new ArchiveReadError(`${table}: scan cursor did not advance past ${after}`);
    after = last;
  }
  throw new ArchiveReadError(`${table}: scan exceeded ${MAX_SCAN_PAGES} pages`);
}

/** `id=in.(...)` reads in URL-safe chunks. */
export async function readByIds<T>(read: Reader, table: string, select: string, column: string, ids: string[], extra = "", size = 100): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += size) {
    const list = unique.slice(i, i + size).map((x) => `"${x}"`).join(",");
    out.push(...await read<T>(`${table}?select=${select}&${column}=in.(${list})${extra ? `&${extra}` : ""}`));
  }
  return out;
}

/* ---- units and slices (unchanged methodology) --------------------------- */

export function oneUnitReturn(result: GradeResult, odds: number | null): number | null {
  if (result !== "WIN" && result !== "LOSS") return null;
  if (odds == null || !Number.isFinite(odds) || odds === 0) return null;
  if (result === "LOSS") return -1;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}
export function lockPrice(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

export type PerformanceSlice = {
  locked: number; decided: number; wins: number; losses: number; no_decision: number; pending: number;
  hit_rate: number | null; priced_decided: number; net_units: number | null; roi: number | null;
  streak: { result: "WIN" | "LOSS"; count: number } | null;
};

export type CurrentGrade = { result: GradeResult; revision: number; graded_at: string; first_graded_at: string; revisions: number };

/** The grade in force is the highest revision, exactly as ufc_model_prediction_current_grade defines it. */
export function currentGrades(rows: IndexGradeRow[]): Map<string, CurrentGrade> {
  const by = new Map<string, CurrentGrade>();
  for (const g of rows) {
    const cur = by.get(g.prediction_id);
    if (!cur) { by.set(g.prediction_id, { result: g.result, revision: g.revision, graded_at: g.graded_at, first_graded_at: g.graded_at, revisions: 1 }); continue; }
    cur.revisions += 1;
    if (g.graded_at < cur.first_graded_at) cur.first_graded_at = g.graded_at;
    if (g.revision > cur.revision) { cur.result = g.result; cur.revision = g.revision; cur.graded_at = g.graded_at; }
  }
  return by;
}

export function summarizePerformance(preds: Array<Pick<IndexPred, "id" | "best_odds">>, gradeBy: Map<string, Pick<CurrentGrade, "result" | "graded_at">>): PerformanceSlice {
  const graded = preds.flatMap((p) => { const g = gradeBy.get(p.id); return g ? [{ p, g }] : []; });
  const decided = graded.filter((x) => x.g.result === "WIN" || x.g.result === "LOSS");
  const wins = decided.filter((x) => x.g.result === "WIN").length;
  const priced = decided.flatMap(({ p, g }) => { const u = oneUnitReturn(g.result, lockPrice(p.best_odds)); return u == null ? [] : [u]; });
  const net = priced.length ? priced.reduce((s, v) => s + v, 0) : null;
  const ordered = decided.slice().sort((a, b) => b.g.graded_at.localeCompare(a.g.graded_at) || b.p.id.localeCompare(a.p.id));
  let streak: PerformanceSlice["streak"] = null;
  if (ordered.length) {
    const result = ordered[0].g.result as "WIN" | "LOSS";
    let count = 0;
    for (const row of ordered) { if (row.g.result !== result) break; count += 1; }
    streak = { result, count };
  }
  return {
    locked: preds.length, decided: decided.length, wins, losses: decided.length - wins, no_decision: graded.length - decided.length,
    pending: preds.length - graded.length, hit_rate: decided.length ? wins / decided.length : null,
    priced_decided: priced.length, net_units: net, roi: net == null || !priced.length ? null : net / priced.length, streak,
  };
}

export type CalibrationSummary = { n: number; wins: number; losses: number; brier: number | null; logLoss: number | null; hit: number | null };
export function calibrationSummary(preds: IndexPred[], gradeBy: Map<string, Pick<CurrentGrade, "result">>): CalibrationSummary {
  let n = 0, wins = 0, b = 0, l = 0;
  for (const p of preds) {
    const r = gradeBy.get(p.id)?.result;
    if (r !== "WIN" && r !== "LOSS") continue;
    const prob = Number(p.pick_probability);
    const y = r === "WIN" ? 1 : 0;
    n += 1; wins += y;
    b += (prob - y) ** 2;
    l += -(y * Math.log(prob) + (1 - y) * Math.log(1 - prob));
  }
  return n ? { n, wins, losses: n - wins, brier: b / n, logLoss: l / n, hit: wins / n } : { n: 0, wins: 0, losses: 0, brier: null, logLoss: null, hit: null };
}

/* ---- the index ----------------------------------------------------------- */

export type EventStatus = "AWAITING_RESULTS" | "GRADING" | "GRADING_OVERDUE" | "GRADED";
export type EventSummary = PerformanceSlice & {
  event_id: string;            // UNRESOLVED_EVENT when the pick names no event we can read
  event_name: string;
  event_date: string | null;
  status: EventStatus;
  corrected: number;           // picks whose grade has been revised
  model_versions: string[];
  /** Picks with a current grade, the only ones whose identity may be read. */
  graded_prediction_ids: string[];
};

export type ArchiveIntegrity = {
  locked: number; graded: number; pending: number;
  unresolved_event_picks: number;
  orphan_grade_predictions: number;
  duplicate_prediction_ids: string[];
  duplicate_grade_ids: string[];
};

export type ArchiveIndex = {
  generated_at: string;
  preds: IndexPred[];
  gradeBy: Map<string, CurrentGrade>;
  lifetime: PerformanceSlice;
  events: EventSummary[];
  model_versions: string[];
  integrity: ArchiveIntegrity;
  overdue: Array<{ event_id: string; event_name: string; event_date: string; pending: number; days_overdue: number }>;
};

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3);

export function eventStatus(s: Pick<PerformanceSlice, "locked" | "pending">, eventDate: string | null, today: string): EventStatus {
  if (s.pending === 0) return "GRADED";
  if (eventDate && dayDiff(eventDate, today) > GRADING_OVERDUE_DAYS) return "GRADING_OVERDUE";
  return s.pending === s.locked ? "AWAITING_RESULTS" : "GRADING";
}

/** Newest card first; the event id breaks ties, so the order never depends on
 *  a grade timestamp and a correction to an old result moves nothing. */
export function compareEvents(a: Pick<EventSummary, "event_id" | "event_date">, b: Pick<EventSummary, "event_id" | "event_date">): number {
  const au = a.event_id === UNRESOLVED_EVENT || !a.event_date, bu = b.event_id === UNRESOLVED_EVENT || !b.event_date;
  if (au !== bu) return au ? 1 : -1;
  return (b.event_date || "").localeCompare(a.event_date || "") || b.event_id.localeCompare(a.event_id);
}

export function buildIndex(p: { preds: IndexPred[]; grades: IndexGradeRow[]; events: IndexEvent[]; today: string; generated_at: string; duplicates?: { preds: string[]; grades: string[] } }): ArchiveIndex {
  const gradeBy = currentGrades(p.grades);
  const predIds = new Set(p.preds.map((x) => x.id));
  const eventBy = new Map(p.events.map((e) => [e.id, e]));
  const groups = new Map<string, IndexPred[]>();
  let unresolved = 0;
  for (const pred of p.preds) {
    const key = pred.event_id && eventBy.has(pred.event_id) ? pred.event_id : UNRESOLVED_EVENT;
    if (key === UNRESOLVED_EVENT) unresolved += 1;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pred);
  }
  const events: EventSummary[] = [...groups.entries()].map(([key, rows]) => {
    const e = eventBy.get(key) || null;
    const slice = summarizePerformance(rows, gradeBy);
    return {
      ...slice,
      event_id: key,
      event_name: e?.name || "Event not resolved",
      event_date: e?.event_date || null,
      status: eventStatus(slice, e?.event_date || null, p.today),
      corrected: rows.filter((r) => (gradeBy.get(r.id)?.revisions || 0) > 1).length,
      model_versions: [...new Set(rows.map((r) => r.model_version))].sort(),
      graded_prediction_ids: rows.filter((r) => gradeBy.has(r.id)).map((r) => r.id),
    };
  }).sort(compareEvents);

  const lifetime = summarizePerformance(p.preds, gradeBy);
  const orphan = [...gradeBy.keys()].filter((id) => !predIds.has(id)).length;
  return {
    generated_at: p.generated_at,
    preds: p.preds,
    gradeBy,
    lifetime,
    events,
    model_versions: [...new Set(p.preds.map((x) => x.model_version))].sort(),
    integrity: {
      locked: p.preds.length, graded: p.preds.length - lifetime.pending, pending: lifetime.pending,
      unresolved_event_picks: unresolved, orphan_grade_predictions: orphan,
      duplicate_prediction_ids: p.duplicates?.preds || [], duplicate_grade_ids: p.duplicates?.grades || [],
    },
    overdue: events.filter((e) => e.status === "GRADING_OVERDUE" && e.event_date).map((e) => ({ event_id: e.event_id, event_name: e.event_name, event_date: e.event_date!, pending: e.pending, days_overdue: dayDiff(e.event_date!, p.today) - GRADING_OVERDUE_DAYS })),
  };
}

/** Both scans plus the events they name. Throws ArchiveReadError on any upstream failure. */
export async function loadIndex(read: Reader, opts: { today: string; now?: string; model?: string | null } = { today: new Date().toISOString().slice(0, 10) }): Promise<ArchiveIndex> {
  const modelFilter = opts.model ? `&model_version=eq.${encodeURIComponent(opts.model)}` : "";
  const [predScan, gradeScan] = await Promise.all([
    scanAll<IndexPred>(read, "ufc_model_predictions", PRED_INDEX_SELECT, `locked_at=not.is.null${modelFilter}`),
    scanAll<IndexGradeRow>(read, "ufc_model_prediction_grades", GRADE_INDEX_SELECT),
  ]);
  const predIds = new Set(predScan.rows.map((x) => x.id));
  /* Under a model filter, grades of other official versions are not orphans. */
  const grades = opts.model ? gradeScan.rows.filter((g) => predIds.has(g.prediction_id)) : gradeScan.rows;
  const events = await readByIds<IndexEvent>(read, "ufc_events", "id,name,event_date", "id", predScan.rows.map((x) => x.event_id || ""));
  return buildIndex({ preds: predScan.rows, grades, events, today: opts.today, generated_at: opts.now || new Date().toISOString(), duplicates: { preds: predScan.duplicates, grades: gradeScan.duplicates } });
}

/* ---- pagination ---------------------------------------------------------- */

export type ArchivePage = { page: number; pages: number; total_events: number; items: EventSummary[] };

export function paginate(events: EventSummary[], page: number, size = ARCHIVE_PAGE_SIZE): ArchivePage {
  const pages = Math.max(1, Math.ceil(events.length / size));
  const n = Number.isFinite(page) ? Math.min(pages, Math.max(1, Math.floor(page))) : 1;
  return { page: n, pages, total_events: events.length, items: events.slice((n - 1) * size, n * size) };
}
export function pageOfEvent(events: EventSummary[], eventId: string, size = ARCHIVE_PAGE_SIZE): number | null {
  const i = events.findIndex((e) => e.event_id === eventId);
  return i < 0 ? null : Math.floor(i / size) + 1;
}
export function eventOfPrediction(index: ArchiveIndex, predictionId: string): string | null {
  const p = index.preds.find((x) => x.id === predictionId);
  if (!p || !index.gradeBy.has(p.id)) return null;          // an ungraded pick has no public address
  return index.events.find((e) => e.graded_prediction_ids.includes(p.id))?.event_id || null;
}

/** The most recent results by when each was FIRST graded (a later correction
 *  does not resurface an old pick), wins and losses alike. */
export function recentGradedIds(index: ArchiveIndex, n = 5): string[] {
  return index.preds
    .filter((p) => index.gradeBy.has(p.id))
    .sort((a, b) => index.gradeBy.get(b.id)!.first_graded_at.localeCompare(index.gradeBy.get(a.id)!.first_graded_at) || b.id.localeCompare(a.id))
    .slice(0, n)
    .map((p) => p.id);
}
