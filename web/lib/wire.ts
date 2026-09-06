/* Global UFC live wire — API-first reader for the shell rail.
 *
 * Source of truth is `GET /v1/ufc/wire` on ufc-api.propbetedge.ai (attributed
 * ufc_news_items, deduped, newest first, with internal_url mapping). The
 * server render calls it with a 30 s revalidate; the client rail polls the
 * same route directly (public read-only API, CORS *). If the API is
 * unreachable at render time the rail falls back to the server-side news
 * reader so the shell never blanks — it just cannot map internal links. */
import "server-only";
import { getNewsItems } from "@/lib/db";
import { SITE } from "@/lib/site";

export type WireItem = {
  id: string; title: string; published_at: string | null; summary: string | null;
  taxonomy: string | null; source: { name: string | null; url: string | null } | null; source_url: string | null;
  fighter_ids: string[]; event_id: string | null; bout_id: string | null; internal_url: string | null;
};
export type WireMeta = { generated_at: string; newest_published_at: string | null; freshness_minutes: number | null; live: boolean; fight_week: boolean; count: number; origin: "api" | "fallback" };
export type Wire = { items: WireItem[]; meta: WireMeta };

export const WIRE_LIVE_MINUTES = 120;
export const WIRE_BREAKING_MINUTES = 30;
export const WIRE_URGENT = new Set(["card_change", "withdrawal", "replacement", "injury", "weight_miss", "bout_moved", "result", "suspension"]);

export function wireFreshness(items: Array<{ published_at: string | null }>, now = Date.now()) {
  const newest = items.map((i) => i.published_at).filter(Boolean).sort().reverse()[0] || null;
  const minutes = newest ? Math.max(0, Math.round((now - new Date(newest).getTime()) / 60000)) : null;
  return { newest, minutes, live: minutes != null && minutes <= WIRE_LIVE_MINUTES };
}

export async function getWire(limit = 20): Promise<Wire> {
  try {
    const res = await fetch(`${SITE.api}/v1/ufc/wire?limit=${limit}`, { next: { revalidate: 30 }, headers: { accept: "application/json" } });
    if (res.ok) {
      const j = (await res.json()) as { ok: boolean; data?: WireItem[]; meta?: Partial<WireMeta> };
      if (j?.ok && Array.isArray(j.data)) {
        const f = wireFreshness(j.data);
        return {
          items: j.data,
          meta: {
            generated_at: j.meta?.generated_at || new Date().toISOString(), newest_published_at: j.meta?.newest_published_at ?? f.newest,
            freshness_minutes: j.meta?.freshness_minutes ?? f.minutes, live: j.meta?.live ?? f.live, fight_week: Boolean(j.meta?.fight_week), count: j.data.length, origin: "api",
          },
        };
      }
    } else {
      console.error(`[wire] api -> HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[wire] api failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
  }
  /* Server-side fallback: same shape, no internal mapping. */
  const rows = await getNewsItems(limit);
  const items: WireItem[] = rows.map((n) => ({
    id: n.id, title: n.title, published_at: n.published_at, summary: n.summary, taxonomy: n.taxonomy?.labels?.[0] || null,
    source: { name: n.source?.name || null, url: null }, source_url: n.url, fighter_ids: n.fighter_ids || [], event_id: n.event_id, bout_id: n.bout_id, internal_url: null,
  }));
  const f = wireFreshness(items);
  return { items, meta: { generated_at: new Date().toISOString(), newest_published_at: f.newest, freshness_minutes: f.minutes, live: f.live, fight_week: false, count: items.length, origin: "fallback" } };
}
