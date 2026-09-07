import "server-only";
import { getEventBouts, getImagesForFighters, getImageFraming, getVideosForEvent, getRankings, getNextEvent, sortVideosTimeline, type Bout, type Event, type FramingRow, type OfficialVideoRow, type PortraitSet, type RankingsSnapshot } from "@/lib/db";
import { buildDeskBriefs, type DeskBrief, type DeskSide } from "@/lib/pregame";
import { getIngestFreshness, type IngestFreshness } from "@/lib/archive";
import { eventSlug } from "@/lib/slug";
import { daysUntil, fmtReach } from "@/lib/format";

/* Fight Week — the Pregame Desk as a product surface.
 *
 * `/fight-week` auto-resolves the current or next canonical UFC card from the
 * schedule (getNextEvent already excludes Contender Series / Road to UFC
 * cards) and `/pregame/[slug]` keeps a permanent per-event copy. Nothing here
 * hard-codes an event, fighter, id or date; every read is derived from the
 * stored packet built by lib/pregame.ts (records, UFC Stats averages,
 * archived results, the dated rankings snapshot and Fight DNA for the main
 * event). */

export type FightWeekPacket = {
  event: Event;
  slug: string;
  bouts: Bout[];
  live: Bout[];
  briefs: DeskBrief[];
  briefById: Map<string, DeskBrief>;
  imgs: Map<string, PortraitSet>;
  framing: Map<string, FramingRow>;
  videos: OfficialVideoRow[];
  done: boolean;
  days: number | null;
  updated: string | null;
  rankingsDate: string | null;
  sources: string[];
};

export type Factor = { key: "pace" | "distance" | "grappling" | "danger" | "durability" | "experience"; label: string; line: string; lean: "a" | "b" | null; weight: number };

const n1 = (v: number | null | undefined) => (v == null ? null : Number(v).toFixed(1).replace(/\.0$/, ""));
const pctOf = (v: number | null | undefined) => (v == null ? null : `${Math.round(Number(v) * (Number(v) <= 1 ? 100 : 1))}%`);
const num = (v: number | null | undefined) => (v == null ? null : Number(v));
const last = (s: DeskSide) => s.fighter.name.split(" ").slice(-1)[0] || s.fighter.name;

/* The canonical card for the hub. */
export async function resolveFightWeekEvent(): Promise<Event | null> {
  return getNextEvent();
}

/* Latest timestamp across the intelligence inputs, used for the quiet
 * "INTELLIGENCE UPDATED" stamp. Falls back to render time because the briefs
 * themselves are rebuilt on every revalidation. */
export function intelligenceUpdated(ingest: IngestFreshness, rankings: RankingsSnapshot | null, videos: OfficialVideoRow[] = []): string {
  const candidates = [ingest?.finished_at, ingest?.started_at, rankings?.captured_at, ...videos.map((v) => v.published_at)].filter(Boolean) as string[];
  const times = candidates.map((s) => Date.parse(s)).filter((t) => Number.isFinite(t) && t <= Date.now());
  return new Date(times.length ? Math.max(...times) : Date.now()).toISOString();
}

/* "SEP 7 · 06:00 UTC" */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase();
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${day} · ${hm} UTC`;
}

export function packetSources(briefs: DeskBrief[], rankings: RankingsSnapshot | null, ingest: IngestFreshness): string[] {
  const archived = briefs.reduce((n, b) => n + b.a.archive.fights + b.b.archive.fights, 0);
  const dna = briefs.some((b) => b.evidence.some((e) => /Fight DNA matchup comparison loaded/.test(e)));
  return [
    `UFC Stats career averages${ingest?.finished_at ? ` (ingest ${fmtStamp(ingest.finished_at)})` : ""}`,
    rankings ? `Official rankings snapshot ${rankings.snapshot_date}` : "Rankings snapshot unavailable",
    dna ? "Fight DNA matchup comparison (main event)" : "Fight DNA not available for the main event pairing",
    `${archived} archived results with method and round`,
    "Event card as published",
  ];
}

export async function loadFightWeek(event: Event, opts: { archive?: boolean } = {}): Promise<FightWeekPacket> {
  const bouts = await getEventBouts(event.id);
  const live = bouts.filter((b) => b.status !== "cancelled");
  const done = event.card_status === "complete" || (live.length > 0 && live.every((b) => b.result));
  const [briefs, imgs, videosRaw, rankings, ingest] = await Promise.all([
    live.length ? buildDeskBriefs(event, live, live.length, { includeCompleted: done || Boolean(opts.archive), asOf: done ? event.event_date : null }).catch(() => [] as DeskBrief[]) : Promise.resolve([] as DeskBrief[]),
    getImagesForFighters(live.flatMap((b) => [b.fighter_a.id, b.fighter_b.id])),
    getVideosForEvent(event.id, 24).catch(() => [] as OfficialVideoRow[]),
    getRankings().catch(() => null),
    getIngestFreshness().catch(() => null),
  ]);
  const framing = await getImageFraming(live.slice(0, 1).flatMap((b) => [imgs.get(b.fighter_a.id)?.id, imgs.get(b.fighter_b.id)?.id]).filter(Boolean) as string[]).catch(() => new Map<string, FramingRow>());
  const videos = sortVideosTimeline(videosRaw);
  return assemblePacket({ event, bouts, live, briefs, imgs, framing, videos, done, updated: intelligenceUpdated(ingest, rankings, videos), rankingsDate: rankings?.snapshot_date || null, sources: packetSources(briefs, rankings, ingest) });
}

/* Pure assembler, shared with the /qa/preview fixtures. */
export function assemblePacket(p: Omit<FightWeekPacket, "slug" | "briefById" | "days">): FightWeekPacket {
  return { ...p, slug: eventSlug(p.event), briefById: new Map(p.briefs.map((b) => [b.bout.id, b])), days: daysUntil(p.event.event_date) };
}

/* Card structure from the stored card positions. Bouts without a position
 * are listed as announced rather than guessed into a segment. */
export function cardSections(live: Bout[]): { main: Bout | null; mainCard: Bout[]; prelims: Bout[]; unpositioned: Bout[] } {
  const main = live[0] || null;
  const rest = live.slice(1);
  return {
    main,
    mainCard: rest.filter((b) => b.card_position === "main"),
    prelims: rest.filter((b) => b.card_position === "prelim" || b.card_position === "early"),
    unpositioned: rest.filter((b) => !b.card_position || !["main", "prelim", "early"].includes(b.card_position)),
  };
}

/* FIGHT READ — one or two sentences, evidence-led, never a pick. For a thin
 * packet the caller shows WHAT TO WATCH instead. */
export function fightRead(b: DeskBrief): string[] {
  if (b.tier === "watch") return [];
  const out: string[] = [];
  if (b.mainTake[1]) out.push(b.mainTake[1]);
  const clash = b.styleClash.find((s) => !/Fight DNA/.test(s)) || b.styleClash[0];
  if (clash) out.push(clash);
  return out.slice(0, 2);
}
export function whatToWatch(b: DeskBrief): string[] {
  return [b.mainTake[0], b.earlyRead[0]].filter(Boolean).slice(0, 2);
}

/* 3 THINGS THAT MATTER — PACE · DISTANCE · GRAPPLING · DANGER ZONE ·
 * DURABILITY · EXPERIENCE, each only when the packet holds evidence for it,
 * ranked by the size of the contrast. */
export function thingsThatMatter(b: DeskBrief, max = 3): Factor[] {
  const A = b.a, B = b.b, a = A.fighter, f = B.fighter;
  const out: Factor[] = [];
  const side = (s: DeskSide): "a" | "b" => (s === A ? "a" : "b");
  const poss = (s: DeskSide) => `${last(s)}${/s$/i.test(last(s)) ? "’" : "’s"}`;

  const sa = num(a.career_slpm), sb = num(f.career_slpm);
  if (sa != null && sb != null) {
    const diff = Math.abs(sa - sb);
    const hi = sa >= sb ? A : B, lo = sa >= sb ? B : A;
    out.push({
      key: "pace", label: "Pace", weight: 0.6 + diff, lean: diff >= 1.2 ? side(hi) : null,
      line: diff >= 1.2
        ? `${last(hi)} lands ${n1(hi.fighter.career_slpm)} significant strikes per minute to ${poss(lo)} ${n1(lo.fighter.career_slpm)}: a real volume gap.`
        : `${n1(sa)} and ${n1(sb)} significant strikes per minute: similar output, so accuracy${a.career_str_acc != null && f.career_str_acc != null ? ` (${pctOf(a.career_str_acc)} vs ${pctOf(f.career_str_acc)})` : ""} decides the exchanges.`,
    });
  }

  const ra = num(a.reach_in), rb = num(f.reach_in);
  if (ra != null && rb != null && Math.abs(ra - rb) >= 2) {
    const diff = Math.round(Math.abs(ra - rb));
    const longer = ra > rb ? A : B, shorter = ra > rb ? B : A;
    const stances = Boolean(a.stance && f.stance && a.stance !== f.stance);
    out.push({
      key: "distance", label: "Distance", weight: 0.5 + diff / 2 + (stances ? 0.3 : 0), lean: side(longer),
      line: `${last(longer)} holds a ${diff}-inch reach edge (${fmtReach(longer.fighter.reach_in)} to ${fmtReach(shorter.fighter.reach_in)}); ${last(shorter)} has to cross distance to land${stances ? ", and opposite stances open the lead-side lane" : ""}.`,
    });
  }

  const ta = num(a.career_td_avg), tb = num(f.career_td_avg);
  const wrestler = ta != null && tb != null ? (ta >= tb ? A : B) : ta != null ? A : tb != null ? B : null;
  if (wrestler) {
    const w = num(wrestler.fighter.career_td_avg) as number, other = wrestler === A ? B : A, def = num(other.fighter.career_td_def);
    const subs = num(a.career_sub_avg), subb = num(f.career_sub_avg);
    if (w >= 1.5) {
      out.push({
        key: "grappling", label: "Grappling", weight: 0.4 + w / 1.5 + (def != null && def <= 0.6 ? 0.6 : 0), lean: def != null && def >= 0.75 ? side(other) : side(wrestler),
        line: `${last(wrestler)} averages ${n1(w)} takedowns per 15 minutes${def != null ? `; ${last(other)} has stopped ${pctOf(def)} of attempts on record` : ""}.`,
      });
    } else if ((subs != null && subs >= 1) || (subb != null && subb >= 1)) {
      const s = subs != null && subs >= (subb || 0) ? A : B;
      out.push({ key: "grappling", label: "Grappling", weight: 0.9, lean: side(s), line: `Neither fighter shoots often, but ${last(s)} attempts ${n1(s.fighter.career_sub_avg)} submissions per 15 minutes once a scramble starts.` });
    }
  }

  const fin = (s: DeskSide) => (s.archive.w >= 3 ? (s.archive.ko + s.archive.sub) / s.archive.w : null);
  const fa = fin(A), fb = fin(B);
  const r1 = (s: DeskSide) => s.lastResults.filter((r) => r.won && r.method && /R1/.test(r.method)).length;
  if (fa != null || fb != null) {
    const s = (fa ?? -1) >= (fb ?? -1) ? A : B, rate = (s === A ? fa : fb) as number, early = r1(s);
    if (rate >= 0.5) {
      out.push({
        key: "danger", label: "Danger zone", weight: 0.3 + rate * 1.5 + (early >= 2 ? 0.5 : 0), lean: side(s),
        line: `${last(s)} has finished ${Math.round(rate * 100)}% of archived wins (${s.archive.ko} KO/TKO, ${s.archive.sub} submission)${early >= 2 ? `, ${early} of them inside round one in the last ${s.lastResults.length}` : ""}.`,
      });
    }
  }

  const dur = [A, B].filter((s) => s.archive.fights >= 3);
  if (dur.length) {
    const hit = dur.filter((s) => s.archive.finishedBy > 0).sort((x, y) => y.archive.finishedBy - x.archive.finishedBy)[0];
    const clean = [A, B].find((s) => s !== hit && s.archive.fights >= 3 && s.archive.finishedBy === 0);
    if (hit) {
      const sd = num(hit.fighter.career_str_def);
      out.push({
        key: "durability", label: "Durability", weight: 0.4 + hit.archive.finishedBy * 0.7 + (sd != null && sd <= 0.5 ? 0.4 : 0), lean: hit === A ? "b" : "a",
        line: `${last(hit)} has been finished ${hit.archive.finishedBy} time${hit.archive.finishedBy === 1 ? "" : "s"} in the archive${num(hit.fighter.career_sapm) != null ? ` and absorbs ${n1(hit.fighter.career_sapm)} strikes per minute` : ""}${clean ? `; ${last(clean)} has never been stopped in the stored record` : ""}.`,
      });
    } else if (dur.length === 2) {
      out.push({ key: "durability", label: "Durability", weight: 0.5, lean: null, line: `Neither fighter has been finished in the stored record (${A.archive.fights} and ${B.archive.fights} archived bouts), so a stoppage would be a first.` });
    }
  }

  const five = b.bout.is_title || b.bout.scheduled_rounds === 5;
  const fd = Math.abs(A.fiveRoundBouts - B.fiveRoundBouts), ad = Math.abs(A.archive.fights - B.archive.fights);
  if ((five && fd >= 1) || ad >= 5) {
    const more = five && fd >= 1 ? (A.fiveRoundBouts >= B.fiveRoundBouts ? A : B) : A.archive.fights >= B.archive.fights ? A : B;
    const lessS = more === A ? B : A;
    out.push({
      key: "experience", label: "Experience", weight: 0.3 + (five ? fd * 0.7 : 0) + ad / 8, lean: side(more),
      line: five && fd >= 1
        ? `${last(more)} has ${more.fiveRoundBouts} archived five-round fight${more.fiveRoundBouts === 1 ? "" : "s"} to ${poss(lessS)} ${lessS.fiveRoundBouts}; championship rounds are familiar territory for one side.`
        : `${last(more)} has ${more.archive.fights} archived bouts to ${poss(lessS)} ${lessS.archive.fights}: the deeper book of tape belongs to ${last(more)}.`,
    });
  }

  return out.sort((x, y) => y.weight - x.weight).slice(0, max);
}

/* FIGHT PHASE — EARLY → MIDDLE → LATE, each line anchored to the packet. */
export function fightPhases(b: DeskBrief): { early: string; middle: string; late: string } | null {
  if (b.tier === "watch") return null;
  const A = b.a, B = b.b, a = A.fighter, f = B.fighter;
  const early = b.earlyRead[0];
  const late = b.ifItGoesLong[0] || b.resultChanges[0];
  if (!early || !late) return null;
  let middle: string;
  const ta = num(a.career_td_avg), tb = num(f.career_td_avg);
  const w = ta != null && ta >= 2 ? A : tb != null && tb >= 2 ? B : null;
  const sa = num(a.career_slpm), sb = num(f.career_slpm);
  if (w) {
    const o = w === A ? B : A;
    middle = `Rounds two and three turn on whether ${last(w)} keeps landing takedowns at ${n1(w.fighter.career_td_avg)} per 15 minutes; if ${last(o)} stays upright${sa != null && sb != null ? `, the striking rates (${n1(sa)} vs ${n1(sb)} landed per minute) take over` : ", the fight becomes a striking contest"}.`;
  } else if (sa != null && sb != null && Math.abs(sa - sb) >= 1.2) {
    const hi = sa >= sb ? A : B, lo = hi === A ? B : A;
    middle = `The middle rounds belong to whoever sets the pace: ${last(hi)} averages ${n1(hi.fighter.career_slpm)} landed per minute to ${last(lo)} at ${n1(lo.fighter.career_slpm)}, so ${last(lo)} needs the counters to land clean${num(lo.fighter.career_str_acc) != null ? ` (${pctOf(lo.fighter.career_str_acc)} accuracy on record)` : ""}.`;
  } else {
    middle = `With the stored numbers close, the middle rounds come down to adjustments: who solves the opening read first${num(a.career_str_def) != null && num(f.career_str_def) != null ? `, with strike defense at ${pctOf(a.career_str_def)} and ${pctOf(f.career_str_def)}` : ""}.`;
  }
  return { early, middle, late };
}

export type { DeskBrief };
