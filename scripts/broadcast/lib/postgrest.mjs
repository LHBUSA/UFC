/* PostgREST client for the broadcast pass.
 *
 * Extends the weigh-in desk's client rather than copying it — same Range
 * paging, same "never call global fetch with a foreign `this`" rule, same
 * no-node: constraint so the module loads unchanged inside the Worker.
 *
 * It adds exactly one thing: a real UPSERT.
 *
 * The base client can POST, and it can POST with `resolution=ignore-duplicates`
 * for insert-if-absent. This pass needs neither: a verification that finds a
 * moved main card must OVERWRITE the stored row. That is
 * `Prefer: resolution=merge-duplicates`, and it is useless without an explicit
 * `?on_conflict=` — PostgREST otherwise resolves the conflict target to the
 * PRIMARY KEY, which here is the surrogate `id`, so the second run would die
 * on the ufc_slug unique index instead of merging. That exact trap has already
 * cost this codebase one incident; the conflict target is spelled out at every
 * call site.
 */
import { PostgrestClient } from '../../weighins/lib/postgrest.mjs';

export class BroadcastPostgrest extends PostgrestClient {
  /**
   * Insert-or-update on an explicit conflict target.
   * @param {string} table
   * @param {object[]} rows
   * @param {{onConflict: string, returning?: boolean}} opts
   */
  async upsert(table, rows, { onConflict, returning = false } = {}) {
    if (!onConflict) throw new Error('upsert requires an explicit onConflict target');
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const prefer = [returning ? 'return=representation' : 'return=minimal', 'resolution=merge-duplicates'];
    return this.request('POST', `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      body: rows,
      prefer: prefer.join(','),
    });
  }
}

export { PostgrestClient };
