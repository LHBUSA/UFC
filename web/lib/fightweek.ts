import "server-only";
import { getRoundCoverageFor } from "@/lib/roundIndex";
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
  /* Round coverage per bout, using the shared eligibility rule. Empty until a
   * card has completed bouts with stored observations. */
  roundCoverage: Map<string, { rounds: number; bothCorners: boolean }>;
  rankingsDate: string | null;
  sources: string[];
};

/* `hook` is the evidence in a few words (e.g. "6.1 vs 4.8 landed / min") so a
 * reader finds the fact before the explanation. */
export type Factor = { key: "pace" | "distance" | "grappling" | "danger" | "durability" | "experience"; label: string; hook: string; line: string; lean: "a" | "b" | null; weight: number };

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
  /* Only a completed card can have round observations, so the lookup is
   * skipped entirely for an upcoming one rather than issuing a request that
   * can only come back empty. */
  const roundCoverage = done ? await getRoundCoverageFor(bouts.map((b) => b.id)) : new Map();
  return assemblePacket({ event, bouts, live, briefs, imgs, framing, videos, done, roundCoverage, updated: intelligenceUpdated(ingest, rankings, videos), rankingsDate: rankings?.snapshot_date || null, sources: packetSources(briefs, rankings, ingest) });
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
/* One strong lead statement, an optional supporting sentence only when it adds
 * a second dimension, and the top factor as a short evidence line. */
export function fightReadParts(b: DeskBrief): { lead: string; supporting: string | null; evidence: string | null; watch: boolean } | null {
  const read = fightRead(b);
  const watch = !read.length;
  const lines = watch ? whatToWatch(b) : read;
  if (!lines.length) return null;
  const lead = lines[0];
  const second = lines[1] || null;
  const sameDimension = (x: string, y: string) => [/volume|per minute|strikes/i, /wrestl|takedown|grappl/i, /reach|distance|range/i, /finish|stopped|KO/i].some((re) => re.test(x) && re.test(y));
  const supporting = second && !sameDimension(lead, second) ? second : null;
  const top = thingsThatMatter(b, 1)[0];
  return { lead, supporting, evidence: top ? `${top.label}: ${top.hook}` : null, watch };
}

/* Evidence-led phase headlines derived from the phase text itself. */
export function phaseHeadlines(b: DeskBrief, phases: { early: string; middle: string; late: string }): { early: string; middle: string; late: string } {
  const five = b.bout.is_title || b.bout.scheduled_rounds === 5;
  const early = /first-round finish/i.test(phases.early) ? "Opening danger" : /takedown/i.test(phases.early) ? "The first takedown test" : /reach|range/i.test(phases.early) ? "Range discovery" : /title/i.test(phases.early) ? "Who is willing to lead" : "Who leads, who counters";
  const middle = /takedowns keep landing/i.test(phases.middle) ? "Do the takedowns keep landing?" : /pace/i.test(phases.middle) ? "Pace and distance settle" : "Adjustments decide";
  const late = five ? "Five-round questions" : /Decision share|cards/i.test(phases.late) ? "Round three and the cards" : /title|belt/i.test(phases.late) ? "What the result changes" : "The final round";
  return { early, middle, late };
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
      hook: `${n1(hi.fighter.career_slpm)} vs ${n1(lo.fighter.career_slpm)} landed / min`,
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
      hook: `${diff}-inch reach difference`,
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
        hook: `${n1(w)} takedowns / 15${def != null ? ` vs ${pctOf(def)} defense` : ""}`,
        line: `${last(wrestler)} averages ${n1(w)} takedowns per 15 minutes${def != null ? `; ${last(other)} has stopped ${pctOf(def)} of attempts on record` : ""}.`,
      });
    } else if ((subs != null && subs >= 1) || (subb != null && subb >= 1)) {
      const s = subs != null && subs >= (subb || 0) ? A : B;
      out.push({ key: "grappling", label: "Grappling", weight: 0.9, lean: side(s), hook: `${n1(s.fighter.career_sub_avg)} submission attempts / 15`, line: `Neither fighter shoots often, but ${last(s)} attempts ${n1(s.fighter.career_sub_avg)} submissions per 15 minutes once a scramble starts.` });
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
        hook: early >= 2 ? `${early} recent R1 finishes` : `${Math.round(rate * 100)}% finish rate`,
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
        hook: `${last(hit)} finished ${hit.archive.finishedBy}× on record`,
        line: `${last(hit)} has been finished ${hit.archive.finishedBy} time${hit.archive.finishedBy === 1 ? "" : "s"} in the archive${num(hit.fighter.career_sapm) != null ? ` and absorbs ${n1(hit.fighter.career_sapm)} strikes per minute` : ""}${clean ? `; ${last(clean)} has never been stopped in the stored record` : ""}.`,
      });
    } else if (dur.length === 2) {
      out.push({ key: "durability", label: "Durability", weight: 0.5, lean: null, hook: "Neither has been finished", line: `Neither fighter has been finished in the stored record (${A.archive.fights} and ${B.archive.fights} archived bouts), so a stoppage would be a first.` });
    }
  }

  const five = b.bout.is_title || b.bout.scheduled_rounds === 5;
  const fd = Math.abs(A.fiveRoundBouts - B.fiveRoundBouts), ad = Math.abs(A.archive.fights - B.archive.fights);
  if ((five && fd >= 1) || ad >= 5) {
    const more = five && fd >= 1 ? (A.fiveRoundBouts >= B.fiveRoundBouts ? A : B) : A.archive.fights >= B.archive.fights ? A : B;
    const lessS = more === A ? B : A;
    out.push({
      key: "experience", label: "Experience", weight: 0.3 + (five ? fd * 0.7 : 0) + ad / 8, lean: side(more),
      hook: five && fd >= 1 ? `${more.fiveRoundBouts} vs ${lessS.fiveRoundBouts} five-round fights` : `${more.archive.fights} vs ${lessS.archive.fights} archived bouts`,
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

/* ---- compact main-card selector ------------------------------------------
 * A scan-first card gets ONE matchup read and up to two KEY SIGNALS. The read
 * is built from the strongest factor(s) as qualitative analyst phrasing (no
 * numbers, no template intro); the signals are drawn only from factors the
 * read did not use, so no numerical comparison appears twice on a card. With
 * three or more factors the read pairs the top factor with the first factor
 * that leans the other way (FACT → CONTRAST); with two it states one and
 * leaves the other for a signal; with one it states that and shows nothing
 * else. No factor, no filler. */
export type Signal = { key: Factor["key"]; label: string; a: string; b: string; unit: string; delta: string | null; note: string | null };

function clauseFor(f: Factor, b: DeskBrief): string {
  const A = b.a, B = b.b;
  const who = (lean: "a" | "b" | null) => (lean === "a" ? last(A) : lean === "b" ? last(B) : null);
  const other = (lean: "a" | "b" | null) => (lean === "a" ? last(B) : lean === "b" ? last(A) : null);
  switch (f.key) {
    case "pace": return f.lean ? `${who(f.lean)} carries the higher measured striking pace` : "the two post similar measured striking pace";
    case "distance": return `${who(f.lean)} holds the reach edge${/opposite stances/.test(f.line) ? " and the open-stance angles" : ""}`;
    case "grappling": {
      const ta = num(A.fighter.career_td_avg), tb = num(B.fighter.career_td_avg);
      const wrestler = ta != null && (tb == null || ta >= tb) ? last(A) : last(B);
      if (/submission/.test(f.hook)) return `${who(f.lean)} carries the submission threat`;
      return who(f.lean) !== wrestler ? `${who(f.lean)} has stopped most takedowns on record` : `${wrestler} brings the takedown pressure`;
    }
    case "danger": return `${who(f.lean)} owns the stronger archived finishing profile`;
    case "durability": return f.lean ? `${other(f.lean)} has been stopped before in the archive` : "neither has been finished on record";
    case "experience": return /five-round/.test(f.hook) ? `${who(f.lean)} has the deeper five-round experience` : `${who(f.lean)} has the deeper book of archived tape`;
  }
}

export function compactRead(b: DeskBrief): { read: string; used: Factor["key"][]; watch: boolean } {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (b.tier === "watch") return { read: whatToWatch(b)[1] || whatToWatch(b)[0] || "", used: [], watch: true };
  const factors = thingsThatMatter(b, 6);
  if (!factors.length) return { read: b.mainTake[1] || "", used: [], watch: false };
  const primary = factors[0];
  if (factors.length >= 3) {
    const secondary = factors.slice(1).find((f) => f.lean && f.lean !== primary.lean) || factors[1];
    return { read: `${cap(clauseFor(primary, b))}; ${clauseFor(secondary, b)}.`, used: [primary.key, secondary.key], watch: false };
  }
  return { read: `${cap(clauseFor(primary, b))} in the available sample.`, used: [primary.key], watch: false };
}

export function compactSignals(b: DeskBrief, used: Factor["key"][], max = 2): Signal[] {
  const A = b.a, B = b.b, a = A.fighter, f = B.fighter;
  const val = (v: number | null | undefined, unit = "") => (v == null ? "—" : `${n1(v)}${unit}`);
  const out: Signal[] = [];
  for (const fac of thingsThatMatter(b, 6)) {
    if (used.includes(fac.key)) continue;
    let s: Signal | null = null;
    switch (fac.key) {
      case "pace": {
        const sa = num(a.career_slpm), sb = num(f.career_slpm);
        s = { key: fac.key, label: "Pace", a: val(sa), b: val(sb), unit: "Sig. strikes landed / min", delta: fac.lean && sa != null && sb != null ? `${fac.lean === "a" ? last(A) : last(B)} +${n1(Math.abs(sa - sb))}/min` : sa != null && sb != null ? "Similar output" : null, note: null };
        break;
      }
      case "distance": {
        const ra = num(a.reach_in), rb = num(f.reach_in);
        s = { key: fac.key, label: "Reach", a: ra == null ? "—" : `${n1(ra)}"`, b: rb == null ? "—" : `${n1(rb)}"`, unit: "Listed reach", delta: ra != null && rb != null ? `${ra > rb ? last(A) : last(B)} +${Math.round(Math.abs(ra - rb))}" reach` : null, note: a.stance && f.stance && a.stance !== f.stance ? "Opposite stances" : null };
        break;
      }
      case "grappling": {
        if (/submission/.test(fac.hook)) s = { key: fac.key, label: "Submissions", a: val(num(a.career_sub_avg)), b: val(num(f.career_sub_avg)), unit: "Submission attempts / 15", delta: null, note: null };
        else {
          const ta = num(a.career_td_avg), tb = num(f.career_td_avg);
          const wrestlerIsA = ta != null && (tb == null || ta >= tb);
          const def = num(wrestlerIsA ? f.career_td_def : a.career_td_def);
          s = { key: fac.key, label: "Takedowns", a: val(ta), b: val(tb), unit: "Takedowns landed / 15", delta: def != null ? `${wrestlerIsA ? last(B) : last(A)} stops ${pctOf(def)} on record` : null, note: null };
        }
        break;
      }
      case "danger": {
        const rate = (s: DeskSide) => (s.archive.w >= 3 ? `${Math.round(((s.archive.ko + s.archive.sub) / s.archive.w) * 100)}%` : "—");
        const r1 = (s: DeskSide) => s.lastResults.filter((r) => r.won && r.method && /R1/.test(r.method)).length;
        const lean = fac.lean === "a" ? A : B;
        s = { key: fac.key, label: "Finishes", a: rate(A), b: rate(B), unit: "Finish rate · archived wins", delta: r1(lean) >= 2 ? `${last(lean)} ${r1(lean)} R1 finishes in last ${lean.lastResults.length}` : null, note: null };
        break;
      }
      case "durability": {
        const t = (s: DeskSide) => (s.archive.fights >= 3 ? String(s.archive.finishedBy) : "—");
        s = { key: fac.key, label: "Durability", a: t(A), b: t(B), unit: "Times finished · archive", delta: null, note: null };
        break;
      }
      case "experience": {
        const five = /five-round/.test(fac.hook);
        s = { key: fac.key, label: "Experience", a: String(five ? A.fiveRoundBouts : A.archive.fights), b: String(five ? B.fiveRoundBouts : B.archive.fights), unit: five ? "Five-round fights · archive" : "Archived bouts", delta: null, note: null };
        break;
      }
    }
    /* A signal must carry a comparison: skip when both sides are unpublished, or when a durability count is identical on both sides (no contrast to scan). */
    if (s && !(s.a === "—" && s.b === "—") && !(s.key === "durability" && s.a === s.b)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
