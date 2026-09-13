/* Contender Series identity from an event name — pure, no I/O, testable.
 *
 * Presentation metadata only. Canonical events and bouts are not rewritten;
 * the series, season, week and episode are read from the name ESPN publishes,
 * which carries them explicitly:
 *
 *   "Dana White's Contender Series: Season 4, Week 6"  -> dwcs  S4  W6
 *   "Dana White's Contender Series: Brazil 2"          -> brazil     episode 2
 *
 * Contender Series Brazil (August 2018) is a separate series. Its episodes are
 * never folded into numbered Season 2 and never given a week number, which is
 * how /contender-series came to show Season 2 as eleven weeks.
 */

export type ContenderSeriesKey = "dwcs" | "brazil";

export type ContenderIdentity = {
  series: ContenderSeriesKey;
  season: number | null;
  week: number | null;
  episode: number | null;
  /** "Season 4 · Week 6" | "Brazil · Episode 2" */
  label: string;
  /** "S4 W6" | "Brazil E2" */
  short: string;
};

export function isDanaWhiteContenderSeries(name: string | null | undefined): boolean {
  return /dana white(?:'s|’s)? contender series|contender series/i.test(String(name || "")) && !/road to ufc/i.test(String(name || ""));
}

export function contenderIdentity(name: string, eventDate?: string | null): ContenderIdentity {
  const n = String(name || "");
  const brazil = /contender series[^a-z]*brazil\b\s*(\d{1,2})?/i.exec(n);
  if (brazil) {
    const episode = brazil[1] ? Number(brazil[1]) : null;
    return {
      series: "brazil", season: null, week: null, episode,
      label: episode ? `Brazil · Episode ${episode}` : "Brazil",
      short: episode ? `Brazil E${episode}` : "Brazil",
    };
  }
  const direct = n.match(/season\s*(\d{1,2})/i);
  const year = eventDate ? Number(String(eventDate).slice(0, 4)) : NaN;
  /* DWCS Season 1 began in 2017 and has run one numbered season per year. The
   * year fallback applies only to the numbered series. */
  const season = direct ? Number(direct[1]) : Number.isFinite(year) && year >= 2017 && year <= 2035 ? year - 2016 : null;
  const weekHit = n.match(/week\s*(\d{1,2})/i);
  const week = weekHit ? Number(weekHit[1]) : null;
  const label = [season ? `Season ${season}` : null, week ? `Week ${week}` : null].filter(Boolean).join(" · ") || "Contender Series";
  const short = [season ? `S${season}` : null, week ? `W${week}` : null].filter(Boolean).join(" ") || "DWCS";
  return { series: "dwcs", season, week, episode: null, label, short };
}
