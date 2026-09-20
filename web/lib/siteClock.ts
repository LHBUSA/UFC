/* UFC consumer rollover clock.
 *
 * Fight cards routinely run across UTC midnight. Using raw UTC calendar dates
 * makes the homepage, header, Fight Week, PBE Picks and other "current card"
 * surfaces jump to next week while Saturday's card is still live.
 *
 * Product rule: keep the fight-night date active until 05:00 UTC the next day.
 * This is presentation/current-card selection only. Data ingestion, model
 * timestamps, grading and historical storage stay on real UTC instants.
 */

export const UFC_SITE_ROLLOVER_UTC_HOUR = 5;
export const UFC_SITE_ROLLOVER_MS = UFC_SITE_ROLLOVER_UTC_HOUR * 60 * 60 * 1000;

export function ufcSiteDate(now = Date.now()): string {
  return new Date(now - UFC_SITE_ROLLOVER_MS).toISOString().slice(0, 10);
}

export function ufcDaysUntil(eventDate: string | null | undefined, now = Date.now()): number | null {
  if (!eventDate) return null;
  const eventMs = Date.parse(`${eventDate.slice(0, 10)}T00:00:00Z`);
  const siteMs = Date.parse(`${ufcSiteDate(now)}T00:00:00Z`);
  if (!Number.isFinite(eventMs) || !Number.isFinite(siteMs)) return null;
  return Math.round((eventMs - siteMs) / 86400e3);
}
