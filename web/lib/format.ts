import type { Bout, Event, Fighter, Result, RoundStat } from "@/lib/db";

export const WEIGHT_LABEL: Record<string, string> = {
  STRAWWEIGHT: "Strawweight",
  FLYWEIGHT: "Flyweight",
  BANTAMWEIGHT: "Bantamweight",
  FEATHERWEIGHT: "Featherweight",
  LIGHTWEIGHT: "Lightweight",
  WELTERWEIGHT: "Welterweight",
  MIDDLEWEIGHT: "Middleweight",
  LIGHT_HEAVYWEIGHT: "Light Heavyweight",
  HEAVYWEIGHT: "Heavyweight",
  SUPER_HEAVYWEIGHT: "Super Heavyweight",
  CATCHWEIGHT: "Catchweight",
  OPEN: "Openweight",
};

export const WEIGHT_LIMIT: Record<string, number> = {
  STRAWWEIGHT: 115, FLYWEIGHT: 125, BANTAMWEIGHT: 135, FEATHERWEIGHT: 145, LIGHTWEIGHT: 155, WELTERWEIGHT: 170,
  MIDDLEWEIGHT: 185, LIGHT_HEAVYWEIGHT: 205, HEAVYWEIGHT: 265,
};

export const METHOD_LABEL: Record<string, string> = {
  KO_TKO: "KO/TKO",
  SUB: "Submission",
  DEC_U: "Unanimous Decision",
  DEC_S: "Split Decision",
  DEC_M: "Majority Decision",
  DQ: "Disqualification",
  NC: "No Contest",
  DRAW: "Draw",
  OTHER: "Result",
};
export const METHOD_SHORT: Record<string, string> = {
  KO_TKO: "KO/TKO", SUB: "SUB", DEC_U: "U-DEC", DEC_S: "S-DEC", DEC_M: "M-DEC", DQ: "DQ", NC: "NC", DRAW: "DRAW", OTHER: "—",
};

export function weightClassLabel(wc: string | null, womens: boolean): string {
  if (!wc) return "Weight TBA";
  return `${womens ? "Women's " : ""}${WEIGHT_LABEL[wc] || wc}`;
}

export function cardPositionLabel(p: string | null): string {
  return p === "main" ? "Main Card" : p === "prelim" ? "Prelims" : p === "early" ? "Early Prelims" : "Card";
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" }): string {
  if (!iso) return "Date TBA";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
}
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return fmtDate(iso.slice(0, 10), { month: "short", day: "numeric" });
}

export function fmtTime(sec: number | null): string {
  if (sec == null) return "";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function fmtHeight(inches: number | null): string {
  if (inches == null) return "—";
  const n = Math.round(Number(inches));
  return `${Math.floor(n / 12)}'${n % 12}"`;
}
export function fmtReach(inches: number | null): string {
  return inches == null ? "—" : `${Number(inches)}"`;
}

export function fmtRecord(f: { record_w: number | null; record_l: number | null; record_d: number | null; record_nc?: number | null }): string {
  if (f.record_w == null) return "—";
  const base = `${f.record_w}-${f.record_l ?? 0}-${f.record_d ?? 0}`;
  return f.record_nc ? `${base} (${f.record_nc} NC)` : base;
}

export function age(dob: string | null, at?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  const now = at ? new Date(`${at}T00:00:00Z`) : new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a -= 1;
  return a;
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`).getTime();
  const today = new Date();
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((d - t) / 86400e3);
}

export function stanceLabel(s: string | null): string {
  return s ? s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ") : "—";
}

export function eventStatusLabel(e: Event): string {
  const d = daysUntil(e.event_date);
  if (e.card_status === "complete") return "Final";
  if (d == null) return "Date TBA";
  if (d === 0) return "Fight night";
  if (d < 0) return "Awaiting results";
  if (d === 1) return "Tomorrow";
  if (d <= 6) return "Fight week";
  return `In ${d} days`;
}

export function eventShortName(name: string): string {
  return name.replace(/^UFC Fight Night:\s*/i, "Fight Night: ").replace(/^Dana White's Contender Series/i, "DWCS");
}

/* "UFC 331" or "Fight Night" or "Noche UFC" — the brand line for posters. */
export function eventBrand(name: string): string {
  const m = name.match(/^(UFC \d+|UFC Fight Night|Noche UFC|UFC on [A-Z]+\s?\d*|Dana White's Contender Series|The Ultimate Fighter[^:]*|UFC[^:]*)/i);
  return (m ? m[1] : name.split(":")[0]).trim();
}
export function eventHeadline(name: string): string {
  const i = name.indexOf(":");
  return i > 0 ? name.slice(i + 1).trim() : "";
}

export function locationLine(e: Event): string {
  return [e.venue, e.city, e.region || e.country].filter(Boolean).join(" · ");
}
export function cityLine(e: Event): string {
  return [e.city, e.region || e.country].filter(Boolean).join(", ");
}

export function resultLine(r: Result | null): string {
  if (!r) return "";
  const m = METHOD_LABEL[r.method] || r.method;
  return `${m}${r.round ? ` · R${r.round}` : ""}${r.time_sec != null ? ` ${fmtTime(r.time_sec)}` : ""}`;
}

export function winnerOf(b: Bout): Fighter | null {
  const r = b.result;
  if (!r?.winner_id) return null;
  return r.winner_id === b.fighter_a.id ? b.fighter_a : r.winner_id === b.fighter_b.id ? b.fighter_b : null;
}
export function loserOf(b: Bout): Fighter | null {
  const w = winnerOf(b);
  if (!w) return null;
  return w.id === b.fighter_a.id ? b.fighter_b : b.fighter_a;
}
export function methodVerb(method: string): string {
  return method === "KO_TKO" ? "stops" : method === "SUB" ? "submits" : method.startsWith("DEC") ? "outpoints" : method === "DQ" ? "wins by DQ over" : "vs";
}

/* Per-fighter totals across the rounds of one bout. */
export type StatTotals = {
  rounds: number; kd: number; sig_l: number; sig_a: number; tot_l: number; tot_a: number; td_l: number; td_a: number; sub: number; rev: number; ctrl: number;
  head: number; body: number; leg: number; dist: number; clinch: number; ground: number;
};
export function totals(rows: RoundStat[]): StatTotals {
  const t: StatTotals = { rounds: 0, kd: 0, sig_l: 0, sig_a: 0, tot_l: 0, tot_a: 0, td_l: 0, td_a: 0, sub: 0, rev: 0, ctrl: 0, head: 0, body: 0, leg: 0, dist: 0, clinch: 0, ground: 0 };
  for (const r of rows) {
    t.rounds += 1; t.kd += r.kd || 0; t.sig_l += r.sig_str_landed || 0; t.sig_a += r.sig_str_att || 0; t.tot_l += r.total_str_landed || 0; t.tot_a += r.total_str_att || 0;
    t.td_l += r.td_landed || 0; t.td_a += r.td_att || 0; t.sub += r.sub_att || 0; t.rev += r.rev || 0; t.ctrl += r.ctrl_sec || 0;
    t.head += r.head_landed || 0; t.body += r.body_landed || 0; t.leg += r.leg_landed || 0; t.dist += r.distance_landed || 0; t.clinch += r.clinch_landed || 0; t.ground += r.ground_landed || 0;
  }
  return t;
}
export function pct(l: number, a: number): string {
  return a ? `${Math.round((l / a) * 100)}%` : "—";
}

/* Archive-derived record summary for a fighter from our bout rows. */
export function archiveSummary(fighterId: string, bouts: Bout[]) {
  let w = 0, l = 0, d = 0, nc = 0, ko = 0, sub = 0, dec = 0, finishedBy = 0;
  for (const b of bouts) {
    const r = b.result; if (!r) continue;
    if (r.method === "NC") { nc += 1; continue; }
    if (r.method === "DRAW" || !r.winner_id) { d += 1; continue; }
    if (r.winner_id === fighterId) { w += 1; if (r.method === "KO_TKO") ko += 1; else if (r.method === "SUB") sub += 1; else dec += 1; }
    else { l += 1; if (r.method === "KO_TKO" || r.method === "SUB") finishedBy += 1; }
  }
  return { w, l, d, nc, ko, sub, dec, finishedBy, fights: w + l + d + nc, finishRate: w ? Math.round(((ko + sub) / w) * 100) : null };
}

export function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || "") + (p[p.length - 1]?.[0] || "")).toUpperCase();
}

export function plural(n: number, s: string, p = `${s}s`): string {
  return `${n} ${n === 1 ? s : p}`;
}
