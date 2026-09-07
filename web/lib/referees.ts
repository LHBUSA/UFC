import "server-only";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function headers() {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

async function read<T>(path: string, fallback: T, revalidate = 900): Promise<T> {
  if (!URL_ || !KEY) return fallback;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: headers(), next: { revalidate } });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export type RefereeProfile = {
  name: string;
  display_name: string;
  slug: string;
  bouts: number;
  stoppages: number;
  ko_tko: number;
  submissions: number;
  decisions: number;
  split_decisions: number;
  nc_draws: number;
  title_bouts: number;
  five_round_bouts: number;
  avg_fight_seconds: number | null;
  avg_stoppage_seconds: number | null;
  first_event_date: string | null;
  last_event_date: string | null;
  stoppage_rate: number | null;
  decision_rate: number | null;
  split_decision_share: number | null;
  archive_stoppage_rate: number | null;
  archive_decision_rate: number | null;
  bio: string | null;
  bio_source_url: string | null;
  bio_source_name: string | null;
  bio_verified_at: string | null;
  country: string | null;
  image_url: string | null;
  image_source_url: string | null;
  image_credit: string | null;
  image_license: string | null;
};

export type RefereeBout = {
  referee_name: string;
  referee_slug: string | null;
  bout_id: string;
  method: string;
  method_raw: string;
  round: number | null;
  time_sec: number | null;
  finish_detail: string | null;
  result_source: string;
  has_stats: boolean;
  weight_class: string | null;
  is_womens: boolean;
  is_title: boolean;
  scheduled_rounds: number | null;
  card_position: string | null;
  event_id: string;
  event_name: string;
  event_date: string | null;
  venue: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  fighter_a_id: string;
  fighter_a_name: string;
  fighter_b_id: string;
  fighter_b_name: string;
  winner_id: string | null;
  winner_name: string | null;
  source_url: string;
};

const SELECT = "name,display_name,slug,bouts,stoppages,ko_tko,submissions,decisions,split_decisions,nc_draws,title_bouts,five_round_bouts,avg_fight_seconds,avg_stoppage_seconds,first_event_date,last_event_date,stoppage_rate,decision_rate,split_decision_share,archive_stoppage_rate,archive_decision_rate,bio,bio_source_url,bio_source_name,bio_verified_at,country,image_url,image_source_url,image_credit,image_license";

export async function getReferees(limit = 200): Promise<RefereeProfile[]> {
  return read<RefereeProfile[]>(`ufc_referee_directory?select=${SELECT}&order=bouts.desc,display_name.asc&limit=${limit}`, []);
}

export async function getRefereeBySlug(slug: string): Promise<RefereeProfile | null> {
  const rows = await read<RefereeProfile[]>(`ufc_referee_directory?select=${SELECT}&slug=eq.${encodeURIComponent(slug)}&limit=1`, []);
  return rows[0] || null;
}

export async function getRefereeByName(name: string): Promise<RefereeProfile | null> {
  const direct = await read<RefereeProfile[]>(`ufc_referee_directory?select=${SELECT}&name=eq.${encodeURIComponent(name)}&limit=1`, []);
  if (direct[0]) return direct[0];
  const alias = await read<Array<{ canonical_name: string }>>(`ufc_referee_aliases?select=canonical_name&raw_name=eq.${encodeURIComponent(name)}&limit=1`, []);
  if (!alias[0]) return null;
  const rows = await read<RefereeProfile[]>(`ufc_referee_directory?select=${SELECT}&name=eq.${encodeURIComponent(alias[0].canonical_name)}&limit=1`, []);
  return rows[0] || null;
}

export async function getRefereeBouts(slug: string, limit = 60): Promise<RefereeBout[]> {
  return read<RefereeBout[]>(`ufc_referee_bouts?select=*&referee_slug=eq.${encodeURIComponent(slug)}&order=event_date.desc.nullslast&limit=${limit}`, []);
}

export function refereeArchiveBio(r: RefereeProfile): string {
  const since = r.first_event_date ? new Date(`${r.first_event_date}T00:00:00Z`).getUTCFullYear() : null;
  const through = r.last_event_date ? new Date(`${r.last_event_date}T00:00:00Z`).getUTCFullYear() : null;
  const span = since && through ? (since === through ? `${since}` : `${since}–${through}`) : "the loaded archive";
  return `${r.display_name} appears as the assigned referee in ${r.bouts.toLocaleString()} archived UFC bouts currently loaded by PropBetEdge (historical coverage is still being backfilled, so this is not a career total) across ${span}. This profile treats officiating as context, not destiny: the rates below describe what happened in that historical sample and do not prove that the referee caused a finish, decision, pace change or judging outcome.`;
}

export function refereeImpactRead(r: RefereeProfile): { headline: string; body: string; tone: "finish" | "decision" | "neutral" } {
  if (r.bouts < 20 || r.stoppage_rate == null || r.archive_stoppage_rate == null) {
    return { headline: "Sample still developing", body: `The archive currently contains ${r.bouts} bouts for ${r.display_name}. That is enough to show assignments and outcomes, but not enough to turn a small difference in finish rate into a serious fight-week signal.`, tone: "neutral" };
  }
  const diff = Number(r.stoppage_rate) - Number(r.archive_stoppage_rate);
  if (diff >= 7) return { headline: "Higher-stoppage historical sample", body: `${r.stoppage_rate}% of the loaded bouts officiated by ${r.display_name} ended by stoppage, versus ${r.archive_stoppage_rate}% across the referee archive. Treat the ${diff.toFixed(1)}-point gap as descriptive context only; matchup quality and fighter style are major confounders.`, tone: "finish" };
  if (diff <= -7) return { headline: "More decisions in the loaded sample", body: `${r.decision_rate}% of the loaded bouts officiated by ${r.display_name} reached a decision, versus ${r.archive_decision_rate}% across the referee archive. The gap is context, not a causal betting signal.`, tone: "decision" };
  return { headline: "Near the archive baseline", body: `${r.display_name}'s ${r.stoppage_rate}% stoppage rate sits close to the ${r.archive_stoppage_rate}% archive baseline. The referee sample does not create a strong finish-versus-decision signal on its own.`, tone: "neutral" };
}
