/**
 * Episode air dates: the two-source resolution rule (approved 2026-09-13).
 *
 * A canonical air_date is shown only when the network's listing date exists
 * AND an independent source gives the same calendar date. Either source alone
 * leaves it unresolved; any disagreement leaves it unresolved and says so.
 *
 * The listing date is never promoted by itself: for recent seasons it is plainly
 * not a broadcast date (TUF 33's finale is listed nine months late). And the
 * network's separate display date is kept as evidence even where it differs —
 * Paramount+ renders a 7pm Pacific listing as the next UTC day.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {{ listing_date: string|null, display_date?: string|null, independent?: { date: string|null, family: string, url: string, retrieved: string, cites?: string } | null, network?: { family: string, url: string, retrieved: string } | null }} input
 * @returns {{ air_date: string|null, air_date_resolution: object|null }}
 */
export function resolveAirDate({ listing_date, display_date = null, independent = null, network = null }) {
  const listing = ISO.test(String(listing_date ?? '')) ? listing_date : null;
  const other = independent && ISO.test(String(independent.date ?? '')) ? independent.date : null;
  const display = ISO.test(String(display_date ?? '')) ? display_date : null;
  if (!listing && !other && !display) return { air_date: null, air_date_resolution: null };
  const offsetDays = listing && display ? Math.round((Date.parse(display) - Date.parse(listing)) / 86400e3) : null;
  const evidence = {
    network_listing_date: listing,
    network_display_date: display,
    ...(network ? { network_source: network } : {}),
    independent_date: other,
    ...(independent ? { independent_source: { family: independent.family, url: independent.url, retrieved: independent.retrieved, ...(independent.cites ? { cites: independent.cites } : {}) } } : {}),
    ...(offsetDays ? { date_conflict_note: `network display date is ${offsetDays > 0 ? '+' : ''}${offsetDays} day${Math.abs(offsetDays) === 1 ? '' : 's'} from its listing date` } : {}),
  };
  if (listing && other && listing === other) {
    return { air_date: listing, air_date_resolution: { basis: 'network_listing + independent_source', status: 'resolved', ...evidence } };
  }
  const why = !listing ? 'no network listing date' : !other ? 'no independent source date' : `network listing ${listing} and independent source ${other} disagree`;
  return { air_date: null, air_date_resolution: { basis: null, status: 'unresolved', why, ...evidence } };
}
