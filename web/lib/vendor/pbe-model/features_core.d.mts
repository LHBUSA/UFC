export const SNAPSHOT_SELECT: string;
export function assembleBoutRow(bout: Record<string, unknown>, event: { name?: string | null; event_date: string }, fighters: Map<string, Record<string, unknown>>, snapsOf: Map<string, Array<Record<string, unknown>>>, rowsOf: Map<string, Array<Record<string, unknown>>>): {
  fighter_1_id: string; fighter_2_id: string; x: number[]; available: number[]; available_count: number; min_prior_bouts: number; min_stat_bouts: number;
  snapshot_integrity: Array<{ fighter_id: string; snapshot: string | null; target_in_snapshot?: boolean; snapshot_after_event?: boolean }>;
};
