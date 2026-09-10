/* Internal review queue + coverage for fighter portraits (/admin/media).
 *
 * Server-only. Reads are uncached: a reviewer must see the decision they just
 * made, and "does this fighter have an approved portrait yet" is exactly the
 * kind of existence question a data cache gets wrong at the moment it flips.
 * Writes go through the ufc_media_review_candidate / ufc_media_quarantine_asset
 * functions so promotion and the one-primary rule are atomic in Postgres. */
import "server-only";
import { getCurrentAccount } from "@/lib/auth";
import { getEventBouts, getMainEvents, getRankings, getRecentEvents, getUpcomingEvents, isContenderSeries, type RankingsSnapshot } from "@/lib/db";
import {
  buildScope, portraitDecision, NEXT_CARD_REASONS, RANKED_REASONS, UPCOMING_CARD_REASONS,
  type EligiblePortraitRow, type QueueReason, type ScopeEntry,
} from "@/lib/fighterMediaPolicy";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json", ...extra };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

export class MediaAdminError extends Error {}

async function sb<T>(path: string, init: RequestInit = {}): Promise<{ data: T; count: number | null }> {
  if (!URL_ || !KEY) throw new MediaAdminError("Supabase is not configured on this deployment.");
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: headers(init.headers as Record<string, string>), cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.message || msg; } catch { /* raw text */ }
    if (res.status === 404 && /ufc_fighter_media|ufc_media_|portrait_eligible/.test(msg)) {
      throw new MediaAdminError("The fighter media tables do not exist yet. Apply supabase/migrations/20260910210000_ufc_fighter_media_pipeline.sql.");
    }
    throw new MediaAdminError(`${path.split("?")[0]} -> HTTP ${res.status}: ${msg}`);
  }
  const range = res.headers.get("content-range");
  const count = range && range.includes("/") ? Number(range.split("/")[1]) : null;
  return { data: (text ? JSON.parse(text) : null) as T, count: Number.isFinite(count as number) ? count : null };
}

/* PostgREST caps a response at 1000 rows no matter what limit= says. */
async function sbAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data } = await sb<T[]>(`${path}&limit=1000&offset=${offset}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function count(path: string): Promise<number | null> {
  return (await sb<unknown[]>(`${path}${path.includes("?") ? "&" : "?"}limit=1`, { headers: { Prefer: "count=exact" } })).count;
}

/* ---- access ----------------------------------------------------------- */

/* Owner/admin accounts only. Returns the reviewer label written to the
 * audit columns, or null (the page 404s; actions refuse). */
export async function currentMediaReviewer(): Promise<string | null> {
  const account = await getCurrentAccount();
  if (!account || (account.role !== "owner" && account.role !== "admin")) return null;
  return `account:${account.email}`;
}

/* ---- scope ------------------------------------------------------------ */

type ScopeData = { scope: Map<string, ScopeEntry>; rankings: RankingsSnapshot | null; nextEvents: Array<{ id: string; name: string; event_date: string | null }> };

/* Homepage featured fighters: the same inputs app/page.tsx draws faces for
 * (main events of the upcoming/recent strips incl. Contender Series, champions,
 * top-3 contenders), minus the next card itself, which has its own reason. */
export async function getPortraitScope(): Promise<ScopeData> {
  const [rankings, upcoming, recent, dwcsUpcoming] = await Promise.all([
    getRankings(), getUpcomingEvents(7), getRecentEvents(20), getUpcomingEvents(30, { includeContenderSeries: true }),
  ]);
  const nextEvents = upcoming.slice(0, 3);
  const cards = await Promise.all(nextEvents.map(async (e) => (await getEventBouts(e.id))
    .filter((b) => b.status !== "cancelled")
    .map((b) => ({ fighter_a_id: b.fighter_a.id, fighter_b_id: b.fighter_b.id }))));

  const stripEvents = [
    ...upcoming.slice(1, 7),
    ...recent.filter((e) => !isContenderSeries(e.name)).slice(0, 3),
    ...[dwcsUpcoming.find((e) => isContenderSeries(e.name)), recent.find((e) => isContenderSeries(e.name))].filter(Boolean) as Array<{ id: string }>,
  ];
  const mains = await getMainEvents(stripEvents.map((e) => e.id));
  const divisions = (rankings?.divisions || []).filter((d) => !d.is_p4p);
  const featured = [
    ...[...mains.values()].flatMap((b) => [b.fighter_a.id, b.fighter_b.id]),
    ...divisions.map((d) => d.champion?.fighter_id).filter(Boolean) as string[],
    ...divisions.filter((d) => d.champion).flatMap((d) => d.entries.slice(0, 3).map((e) => e.fighter_id)).filter(Boolean) as string[],
  ];
  const [active, legacy] = await Promise.all([
    sbAll<{ id: string }>("ufc_fighters?select=id&is_active=eq.true&order=id"),
    sbAll<{ fighter_id: string }>("ufc_images?select=fighter_id&fighter_id=not.is.null&order=id"),
  ]);
  return {
    scope: buildScope({ rankings, cards, featuredIds: featured, activeIds: active.map((r) => r.id), legacyIds: legacy.map((r) => r.fighter_id) }),
    rankings,
    nextEvents: nextEvents.map((e) => ({ id: e.id, name: e.name, event_date: e.event_date })),
  };
}

/* ---- portraits on file ------------------------------------------------ */

async function eligibleByFighter(): Promise<Map<string, EligiblePortraitRow>> {
  const rows = await sbAll<EligiblePortraitRow>("ufc_fighter_portrait_eligible?select=*&order=fighter_id");
  return new Map(rows.map((r) => [r.fighter_id, r]));
}

export type PortraitState = "high_visibility" | "standard_only" | "missing";
function stateOf(row: EligiblePortraitRow | undefined): PortraitState {
  if (row && portraitDecision(row, "high_visibility").ok) return "high_visibility";
  if (row && portraitDecision(row, "standard").ok) return "standard_only";
  return "missing";
}

/* ---- queue ------------------------------------------------------------ */

export type CandidateRow = {
  id: string; fighter_id: string; image_url: string; thumbnail_url: string | null; storage_key: string | null;
  legacy_image_id: string | null; source_url: string; source_name: string; source_type: string; license_type: string;
  license_label: string | null; author: string | null; commercial_use_allowed: boolean; derivative_use_allowed: boolean;
  attribution_required: boolean; attribution_text: string | null; identity_evidence: Record<string, unknown>;
  identity_confidence: number; suitability_score: number | null; priority_score: number; queue_reasons: string[];
  width: number | null; height: number | null; proposed_surface_policy: string; flags: string[]; status: string;
  review_reason: string | null; reviewed_by: string | null; reviewed_at: string | null; discovered_by: string; created_at: string;
};
type FighterLite = { id: string; name: string; nickname: string | null; dob: string | null; espn_athlete_id: string | null; ufcstats_id: string | null; record_w: number | null; record_l: number | null; record_d: number | null; is_active: boolean | null };

export type QueueFighter = {
  fighter: FighterLite; reasons: QueueReason[]; priority: number; state: PortraitState;
  current: EligiblePortraitRow | null; candidates: CandidateRow[];
};
export type QueueFilter = "all" | "ranked" | "next_card" | "upcoming" | "featured" | "active" | "legacy";

export async function getReviewQueue(opts: { filter?: QueueFilter; page?: number; perPage?: number; withCandidatesOnly?: boolean } = {}): Promise<{
  fighters: QueueFighter[]; total: number; page: number; pages: number; nextEvents: ScopeData["nextEvents"];
}> {
  const perPage = opts.perPage ?? 20;
  const [{ scope, nextEvents }, eligible, pendingRows] = await Promise.all([
    getPortraitScope(),
    eligibleByFighter(),
    sbAll<{ fighter_id: string }>("ufc_fighter_media_candidates?select=fighter_id&status=eq.pending&order=fighter_id"),
  ]);
  const withPending = new Set(pendingRows.map((r) => r.fighter_id));
  const match = (reasons: QueueReason[]): boolean => {
    switch (opts.filter || "all") {
      case "ranked": return reasons.some((r) => RANKED_REASONS.has(r));
      case "next_card": return reasons.some((r) => NEXT_CARD_REASONS.has(r));
      case "upcoming": return reasons.some((r) => UPCOMING_CARD_REASONS.has(r));
      case "featured": return reasons.includes("featured");
      case "active": return reasons.includes("active_roster");
      case "legacy": return reasons.includes("legacy_portrait");
      default: return true;
    }
  };
  const missing = [...scope.entries()]
    .filter(([id, s]) => stateOf(eligible.get(id)) !== "high_visibility" && match(s.reasons))
    .filter(([id]) => !opts.withCandidatesOnly || withPending.has(id))
    .sort((a, b) => b[1].priority - a[1].priority || Number(withPending.has(b[0])) - Number(withPending.has(a[0])) || a[0].localeCompare(b[0]));
  const pages = Math.max(1, Math.ceil(missing.length / perPage));
  const page = Math.min(Math.max(1, opts.page || 1), pages);
  const slice = missing.slice((page - 1) * perPage, page * perPage);
  const ids = slice.map(([id]) => id);
  if (!ids.length) return { fighters: [], total: missing.length, page, pages, nextEvents };

  const [fighters, candidates] = await Promise.all([
    sb<FighterLite[]>(`ufc_fighters?select=id,name,nickname,dob,espn_athlete_id,ufcstats_id,record_w,record_l,record_d,is_active&id=in.(${ids.join(",")})`).then((r) => r.data),
    sb<CandidateRow[]>(`ufc_fighter_media_candidates?select=*&fighter_id=in.(${ids.join(",")})&order=status.asc,priority_score.desc&limit=1000`).then((r) => r.data),
  ]);
  const fighterById = new Map(fighters.map((f) => [f.id, f]));
  const byFighter = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    if (!byFighter.has(c.fighter_id)) byFighter.set(c.fighter_id, []);
    byFighter.get(c.fighter_id)!.push(c);
  }
  const statusOrder = (s: string) => (s === "pending" ? 0 : s === "approved" ? 1 : 2);
  return {
    fighters: slice.flatMap(([id, s]) => {
      const fighter = fighterById.get(id);
      if (!fighter) return [];
      const cs = (byFighter.get(id) || []).sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || b.priority_score - a.priority_score);
      return [{ fighter, reasons: s.reasons, priority: s.priority, state: stateOf(eligible.get(id)), current: eligible.get(id) || null, candidates: cs }];
    }),
    total: missing.length, page, pages, nextEvents,
  };
}

/* ---- review writes ------------------------------------------------------ */

export type ReviewAction = "approve" | "reject" | "quarantine";

export async function reviewCandidate(input: { candidateId: string; action: ReviewAction; reason: string; reviewer: string; makePrimary: boolean }): Promise<Record<string, unknown>> {
  return (await sb<Record<string, unknown>>("rpc/ufc_media_review_candidate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_candidate_id: input.candidateId, p_action: input.action, p_reason: input.reason, p_reviewer: input.reviewer, p_make_primary: input.makePrimary }),
  })).data;
}

export async function quarantineAsset(input: { assetId: string; reason: string; reviewer: string }): Promise<Record<string, unknown>> {
  return (await sb<Record<string, unknown>>("rpc/ufc_media_quarantine_asset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_asset_id: input.assetId, p_reason: input.reason, p_by: input.reviewer }),
  })).data;
}

/* ---- coverage ---------------------------------------------------------- */

export type CoverageGroup = { key: string; label: string; total: number; highVisibility: number; standardOnly: number };
export type Coverage = {
  generated_at: string;
  total_fighters: number | null;
  approved_portraits: number;           /* fighters with an approved primary on any surface */
  approved_high_visibility: number;     /* of those, cleared for high-visibility surfaces */
  groups: CoverageGroup[];
  candidates: Record<string, number>;
  quarantine_active: number | null;
  assets_quarantined: number | null;
  next_events: ScopeData["nextEvents"];
};

export async function getCoverage(): Promise<Coverage> {
  const [{ scope, nextEvents }, eligible, totalFighters, candStatus, quarantineActive, assetsQuarantined] = await Promise.all([
    getPortraitScope(),
    eligibleByFighter(),
    count("ufc_fighters?select=id"),
    sbAll<{ status: string }>("ufc_fighter_media_candidates?select=status&order=id"),
    count("ufc_media_quarantine?select=id&lifted_at=is.null"),
    count("ufc_fighter_media_assets?select=id&review_status=eq.quarantined"),
  ]);
  const group = (key: string, label: string, pick: (r: QueueReason[]) => boolean): CoverageGroup => {
    const ids = [...scope.entries()].filter(([, s]) => pick(s.reasons)).map(([id]) => id);
    const states = ids.map((id) => stateOf(eligible.get(id)));
    return { key, label, total: ids.length, highVisibility: states.filter((s) => s === "high_visibility").length, standardOnly: states.filter((s) => s === "standard_only").length };
  };
  const candidates: Record<string, number> = {};
  for (const c of candStatus) candidates[c.status] = (candidates[c.status] || 0) + 1;
  const states = [...eligible.values()].map((r) => stateOf(r));
  return {
    generated_at: new Date().toISOString(),
    total_fighters: totalFighters,
    approved_portraits: states.filter((s) => s !== "missing").length,
    approved_high_visibility: states.filter((s) => s === "high_visibility").length,
    groups: [
      group("ranked", "Ranked fighters (champions + ranked)", (r) => r.some((x) => RANKED_REASONS.has(x))),
      group("next_card", `Next card${nextEvents[0] ? ` (${nextEvents[0].name})` : ""}`, (r) => r.some((x) => NEXT_CARD_REASONS.has(x))),
      group("upcoming", "Next 3 cards", (r) => r.some((x) => UPCOMING_CARD_REASONS.has(x))),
      group("featured", "Homepage featured", (r) => r.includes("featured")),
      group("active", "Active roster", (r) => r.includes("active_roster")),
      group("legacy", "Had a stored photo before the pipeline", (r) => r.includes("legacy_portrait")),
      group("scope", "Whole queue scope", () => true),
    ],
    candidates,
    quarantine_active: quarantineActive,
    assets_quarantined: assetsQuarantined,
    next_events: nextEvents,
  };
}
