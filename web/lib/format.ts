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

export function weightClassLabel(wc: string | null, womens: boolean): string {
  if (!wc) return "TBA";
  return `${womens ? "Women's " : ""}${WEIGHT_LABEL[wc] || wc}`;
}

export function cardPositionLabel(p: string | null): string {
  return p === "main" ? "Main Card" : p === "prelim" ? "Prelims" : p === "early" ? "Early Prelims" : "Card";
}

export function fmtDate(iso: string | null, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" }): string {
  if (!iso) return "Date TBA";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
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

export function fmtRecord(f: { record_w: number | null; record_l: number | null; record_d: number | null; record_nc?: number | null }): string {
  if (f.record_w == null) return "—";
  const base = `${f.record_w}-${f.record_l ?? 0}-${f.record_d ?? 0}`;
  return f.record_nc ? `${base} (${f.record_nc} NC)` : base;
}

export function age(dob: string | null): number | null {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  const now = new Date();
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
