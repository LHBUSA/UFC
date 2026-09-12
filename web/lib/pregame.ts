import "server-only";
import { getFighterBouts, getRankings, type Bout, type Event, type Fighter, type RankingsSnapshot } from "@/lib/db";
import { getMatchupDna, type Insight, type MatchupDna } from "@/lib/dna";
import { archiveSummary, fmtRecord, weightClassLabel, METHOD_SHORT } from "@/lib/format";
import { buildRankingIndex, bestRank, rankForDivision, type RankingIndex } from "@/lib/rankingContext";

/* Pregame Desk brief builder.
 *
 * Every sentence below is anchored to stored evidence: the bout row, the two
 * fighter rows (UFC Stats career averages when present), the archived bout
 * history for each fighter, the dated official rankings snapshot and the
 * Fight DNA matchup comparison. Nothing is generated about camps, injuries,
 * odds or model output — those are not in the packet, so they are not in the
 * brief. When the packet is thin the brief degrades to a "what to watch"
 * card instead of forcing analysis. */

export type DeskTier = "marquee" | "supporting" | "watch";

export type DeskSide = {
  fighter: Fighter;
  rank: string | null;
  profile: string[];
  form: string[];
  keys: string[];
  archive: ReturnType<typeof archiveSummary>;
  lastResults: Array<{ opponent: string; won: boolean | null; method: string | null; date: string | null }>;
  streak: { kind: "W" | "L" | null; n: number };
  fiveRoundBouts: number;
};

export type DeskBrief = {
  bout: Bout;
  tier: DeskTier;
  stakes: string[];
  mainTake: string[];
  styleClash: string[];
  a: DeskSide;
  b: DeskSide;
  earlyRead: string[];
  ifItGoesLong: string[];
  resultChanges: string[];
  evidence: string[];
  coverage: string;
};

const n1 = (v: number | null | undefined) => (v == null ? null : Number(v).toFixed(1).replace(/\.0$/, ""));
const pct = (v: number | null | undefined) => (v == null ? null : `${Math.round(Number(v) * (Number(v) <= 1 ? 100 : 1))}%`);
const first = (f: Fighter) => f.name.split(" ").slice(-1)[0] || f.name;
const hasCareer = (f: Fighter) => f.career_slpm != null || f.career_td_avg != null || f.career_str_acc != null;

/* One ranking interpretation, shared with every other surface.
 *
 * This used to walk the snapshot itself and skip pound-for-pound entirely,
 * which meant the desk packet could call a fighter unranked while a badge two
 * pages away showed their P4P standing. It now asks the same resolver, about
 * the bout's own division, and a P4P standing arrives already labelled so it
 * can never read as a division rank in prose. */
function rankLabel(f: Fighter, index: RankingIndex | null, bout: Bout): string | null {
  const ctx = index?.byFighter.get(f.id);
  if (!ctx) return null;
  const { primary, secondary } = rankForDivision(ctx, { key: bout.weight_class, isWomens: bout.is_womens });
  const chosen = primary ?? secondary ?? bestRank(ctx);
  return chosen ? chosen.full : null;
}

function profileLines(f: Fighter): string[] {
  const out: string[] = [];
  if (!hasCareer(f)) return out;
  const slpm = f.career_slpm, sapm = f.career_sapm, acc = f.career_str_acc, def = f.career_str_def, td = f.career_td_avg, tdd = f.career_td_def, sub = f.career_sub_avg;
  if (slpm != null && sapm != null) {
    const diff = Number(slpm) - Number(sapm);
    if (Number(slpm) >= 4.5) out.push(`High-output striker: ${n1(slpm)} significant strikes landed per minute${diff >= 1 ? `, absorbing ${n1(sapm)} — a positive differential` : diff <= -1 ? `, but absorbing ${n1(sapm)} — a negative differential` : ` against ${n1(sapm)} absorbed`}.`);
    else if (Number(slpm) <= 3) out.push(`Selective striker: ${n1(slpm)} significant strikes landed per minute${acc != null ? ` at ${pct(acc)} accuracy` : ""}${diff >= 0.5 ? " with a positive differential" : ""}.`);
    else out.push(`Mid-volume striker: ${n1(slpm)} landed per minute against ${n1(sapm)} absorbed${acc != null ? `, ${pct(acc)} accuracy` : ""}.`);
  } else if (slpm != null) out.push(`${n1(slpm)} significant strikes landed per minute on record.`);
  if (def != null && Number(def) >= 0.6) out.push(`Hard to hit clean: ${pct(def)} significant-strike defense.`);
  else if (def != null && Number(def) <= 0.5) out.push(`Hittable: ${pct(def)} significant-strike defense, which raises the cost of exchanges.`);
  if (td != null && Number(td) >= 2.5) out.push(`Wrestling-led: ${n1(td)} takedowns landed per 15 minutes${f.career_td_acc != null ? ` at ${pct(f.career_td_acc)} accuracy` : ""}.`);
  else if (td != null && Number(td) > 0 && Number(td) < 1) out.push(`Rarely shoots: ${n1(td)} takedowns per 15 minutes, so the fight is likely to start on the feet by choice.`);
  if (tdd != null && Number(tdd) >= 0.75) out.push(`Difficult to take down: ${pct(tdd)} takedown defense.`);
  else if (tdd != null && Number(tdd) <= 0.55) out.push(`Takedown defense is the soft spot on paper: ${pct(tdd)} stopped.`);
  if (sub != null && Number(sub) >= 1) out.push(`Live submission threat: ${n1(sub)} attempts per 15 minutes.`);
  return out;
}

function formLines(side: DeskSide): string[] {
  const { archive, lastResults, streak, fighter } = side;
  const out: string[] = [];
  if (archive.fights >= 2) {
    const finishes = archive.ko + archive.sub;
    out.push(`${archive.w}-${archive.l}${archive.d ? `-${archive.d}` : ""} across ${archive.fights} archived bouts${archive.w ? `, ${finishes} of ${archive.w} wins by finish (${archive.ko} KO/TKO, ${archive.sub} submission)` : ""}.`);
    if (archive.finishedBy > 0) out.push(`Has been finished ${archive.finishedBy} time${archive.finishedBy === 1 ? "" : "s"} in the archive, so durability is part of the equation.`);
    else if (archive.l > 0) out.push(`Every archived loss went the distance — never finished in the stored record.`);
  }
  if (streak.kind && streak.n >= 2) out.push(`Arrives on a ${streak.n}-fight ${streak.kind === "W" ? "winning" : "losing"} streak.`);
  else if (lastResults[0]?.won === false) out.push(`Rebounding from a loss last time out${lastResults[0].opponent ? ` to ${lastResults[0].opponent}` : ""}.`);
  if (!out.length && fighter.record_w != null) out.push(`${fmtRecord(fighter)} professional record; bout-level archive coverage is still thin for this fighter.`);
  return out;
}

function keysFor(me: DeskSide, them: DeskSide): string[] {
  const a = me.fighter, b = them.fighter, keys: string[] = [];
  const reachA = a.reach_in == null ? null : Number(a.reach_in), reachB = b.reach_in == null ? null : Number(b.reach_in);
  if (reachA != null && reachB != null && reachA - reachB >= 2) keys.push(`Fight at the end of the ${Math.round(reachA - reachB)}-inch reach edge: make ${first(b)} cross distance to land.`);
  if (a.career_td_avg != null && Number(a.career_td_avg) >= 2 && b.career_td_def != null && Number(b.career_td_def) <= 0.65) keys.push(`Take the fight down early — ${first(b)} has stopped only ${pct(b.career_td_def)} of takedowns on record.`);
  if (a.career_str_acc != null && Number(a.career_str_acc) >= 0.48 && b.career_str_def != null && Number(b.career_str_def) <= 0.55) keys.push(`Land the clean shot: ${pct(a.career_str_acc)} accuracy against a ${pct(b.career_str_def)} defense is a favorable exchange rate.`);
  if (a.career_slpm != null && b.career_slpm != null && Number(a.career_slpm) - Number(b.career_slpm) >= 1.2) keys.push(`Win the volume battle — ${n1(a.career_slpm)} landed per minute against ${n1(b.career_slpm)} for ${first(b)}.`);
  if (a.career_td_def != null && Number(a.career_td_def) >= 0.75 && b.career_td_avg != null && Number(b.career_td_avg) >= 1.5) keys.push(`Keep it standing: ${pct(a.career_td_def)} takedown defense against a ${n1(b.career_td_avg)}-per-15 wrestler.`);
  if (me.archive.w >= 2 && (me.archive.ko + me.archive.sub) / me.archive.w >= 0.6 && them.archive.finishedBy > 0) keys.push(`Push for the finish: ${Math.round(((me.archive.ko + me.archive.sub) / me.archive.w) * 100)}% of archived wins ended early and ${first(b)} has been stopped before.`);
  if (a.career_sub_avg != null && Number(a.career_sub_avg) >= 1) keys.push(`Hunt the submission once a scramble starts — ${n1(a.career_sub_avg)} attempts per 15 minutes on record.`);
  if (!keys.length) {
    if (a.stance && b.stance && a.stance !== b.stance) keys.push(`Control the open-stance lead-foot battle and the angle it creates for the rear hand.`);
    keys.push(`Impose the phase of the fight the stored numbers say ${first(a)} controls, and refuse the one they do not.`);
  }
  return keys.slice(0, 3);
}

function styleClash(A: DeskSide, B: DeskSide, dna: MatchupDna | null): string[] {
  const a = A.fighter, b = B.fighter, out: string[] = [];
  const wrestlerA = a.career_td_avg != null && Number(a.career_td_avg) >= 2, wrestlerB = b.career_td_avg != null && Number(b.career_td_avg) >= 2;
  const volumeA = a.career_slpm != null && Number(a.career_slpm) >= 4.5, volumeB = b.career_slpm != null && Number(b.career_slpm) >= 4.5;
  if (wrestlerA && !wrestlerB) out.push(`${first(a)}'s wrestling (${n1(a.career_td_avg)} takedowns per 15) against ${first(b)}'s striking is the central exchange${b.career_td_def != null ? `: ${first(b)} stops ${pct(b.career_td_def)} of attempts on record` : ""}.`);
  else if (wrestlerB && !wrestlerA) out.push(`${first(b)}'s wrestling (${n1(b.career_td_avg)} takedowns per 15) against ${first(a)}'s striking is the central exchange${a.career_td_def != null ? `: ${first(a)} stops ${pct(a.career_td_def)} of attempts on record` : ""}.`);
  else if (wrestlerA && wrestlerB) out.push(`Two grapplers by the numbers (${n1(a.career_td_avg)} and ${n1(b.career_td_avg)} takedowns per 15). Whoever wins the first clinch battle sets the terms for the rest.`);
  else if (volumeA && volumeB) out.push(`Volume against volume: ${n1(a.career_slpm)} and ${n1(b.career_slpm)} significant strikes per minute. Defense and accuracy, not output, separate them.`);
  else if (volumeA || volumeB) { const v = volumeA ? a : b, o = volumeA ? b : a; out.push(`${first(v)}'s output (${n1(v.career_slpm)} per minute) against ${first(o)}'s ${o.career_slpm != null ? `more selective ${n1(o.career_slpm)}` : "lower volume"}: pace versus precision.`); }
  if (a.stance && b.stance && a.stance !== b.stance) out.push(`Opposite stances create an open-side geometry from the first exchange — lead-foot position and the rear-hand lane matter more than usual.`);
  if (dna) {
    const pick = dna.insights.filter((i) => i.confidence !== "insufficient" && i.value != null && i.explanation).slice(0, 2);
    for (const i of pick) out.push(`${i.explanation} (${i.label}, Fight DNA ${i.confidence} confidence)`);
  }
  if (!out.length) out.push(`The stored career numbers do not draw a sharp contrast between these two, which usually means the fight is decided by adjustments rather than a single dominant phase.`);
  return out.slice(0, 3);
}

function earlyRead(A: DeskSide, B: DeskSide, bout: Bout): string[] {
  const out: string[] = [];
  const r1 = (s: DeskSide) => s.lastResults.filter((r) => r.won && r.method && /R1/.test(r.method)).length;
  const a1 = r1(A), b1 = r1(B);
  if (a1 >= 2 || b1 >= 2) { const s = a1 >= b1 ? A : B; out.push(`${first(s.fighter)} has ${Math.max(a1, b1)} first-round finishes in the last ${s.lastResults.length} archived results — the opening minutes carry real finishing risk.`); }
  const wr = [A, B].find((s) => s.fighter.career_td_avg != null && Number(s.fighter.career_td_avg) >= 2);
  if (wr) out.push(`Watch the first takedown attempt from ${first(wr.fighter)}: whether it lands, and how expensive it looks, tells you the shape of the fight.`);
  const reachA = A.fighter.reach_in == null ? null : Number(A.fighter.reach_in), reachB = B.fighter.reach_in == null ? null : Number(B.fighter.reach_in);
  if (reachA != null && reachB != null && Math.abs(reachA - reachB) >= 3) { const l = reachA > reachB ? A : B; out.push(`Who sets the range in round one: ${first(l.fighter)} holds the longer reach, so early success for the shorter fighter usually requires feints and fast entries.`); }
  if (bout.is_title) out.push(`Title-fight nerves are real: the first round often decides who is willing to lead.`);
  if (!out.length) out.push(`Read the first two minutes for who is willing to lead and who is countering; the stored numbers do not flag a lopsided early-round finisher.`);
  return out.slice(0, 3);
}

function ifItGoesLong(A: DeskSide, B: DeskSide, bout: Bout, dna: MatchupDna | null): string[] {
  const out: string[] = [];
  const five = bout.is_title || bout.scheduled_rounds === 5;
  if (five) {
    out.push(`Scheduled for five rounds: 25 minutes changes the pace math, and a fighter who banks two early rounds can afford to manage the fourth.`);
    const exp = [A, B].map((s) => `${first(s.fighter)} ${s.fiveRoundBouts}`).join(" · ");
    out.push(`Archived five-round experience: ${exp}.`);
  } else out.push(`Three rounds only: a slow first round is expensive, and round three is often fought by whoever has the gas tank and the lead on the cards.`);
  const dec = (s: DeskSide) => (s.archive.w ? Math.round((s.archive.dec / s.archive.w) * 100) : null);
  const da = dec(A), db = dec(B);
  if (da != null && db != null) out.push(`Decision share of archived wins: ${first(A.fighter)} ${da}%, ${first(B.fighter)} ${db}% — ${Math.abs(da - db) >= 30 ? `${da > db ? first(A.fighter) : first(B.fighter)} is far more used to winning on the cards` : "both have shown they can win late without a finish"}.`);
  if (dna) {
    const pace = dna.insights.find((i) => /pace|retention|round 3|championship/i.test(i.label) && i.confidence !== "insufficient" && i.explanation);
    if (pace) out.push(`${pace.explanation} (${pace.label}, Fight DNA ${pace.confidence} confidence)`);
  }
  return out.slice(0, 3);
}

function resultChanges(A: DeskSide, B: DeskSide, bout: Bout, event: Event): string[] {
  const out: string[] = [];
  const wc = weightClassLabel(bout.weight_class, bout.is_womens);
  if (bout.is_title) out.push(`The ${wc} title is on the line: the winner holds the belt and the division's next matchmaking runs through them.`);
  const ranked = [A, B].filter((s) => s.rank);
  if (ranked.length === 2) out.push(`Ranked against ranked (${A.rank} vs ${B.rank}): the winner moves up the ${wc} ladder and the loser drops behind whoever is next in line.`);
  else if (ranked.length === 1) { const r = ranked[0], u = r === A ? B : A; out.push(`${first(u.fighter)} is fighting for a number: beating ${r.rank} ${first(r.fighter)} is the fastest route into the ${wc} rankings.`); }
  for (const s of [A, B]) {
    if (s.streak.kind === "L" && s.streak.n >= 2) out.push(`${first(s.fighter)} needs this one: a third straight loss changes a career, a win resets the conversation.`);
    else if (s.lastResults[0]?.won === false) out.push(`For ${first(s.fighter)} this is a rebound fight after the last loss.`);
    else if (s.streak.kind === "W" && s.streak.n >= 3) out.push(`${first(s.fighter)} can extend a ${s.streak.n}-fight winning streak and force the title conversation.`);
  }
  if (bout.bout_order === 1 || bout.card_position === "MAIN") out.push(`As the ${event.name} main event, the result is the headline that follows both fighters into their next booking.`);
  if (!out.length) out.push(`Neither fighter is ranked in the stored snapshot; the winner earns momentum and the loser a rebuild.`);
  return out.slice(0, 3);
}

function mainTake(A: DeskSide, B: DeskSide, bout: Bout): string[] {
  const a = A.fighter, b = B.fighter;
  const wc = weightClassLabel(bout.weight_class, bout.is_womens);
  const lead = `${a.name} (${fmtRecord(a)}${A.rank ? `, ${A.rank}` : ""}) meets ${b.name} (${fmtRecord(b)}${B.rank ? `, ${B.rank}` : ""}) at ${wc}${bout.is_title ? " for the title" : ""}.`;
  const contrasts: string[] = [];
  if (a.career_td_avg != null && b.career_td_avg != null && Math.abs(Number(a.career_td_avg) - Number(b.career_td_avg)) >= 1.5) contrasts.push(`a grappling gap (${n1(a.career_td_avg)} vs ${n1(b.career_td_avg)} takedowns per 15)`);
  if (a.career_slpm != null && b.career_slpm != null && Math.abs(Number(a.career_slpm) - Number(b.career_slpm)) >= 1.2) contrasts.push(`a volume gap (${n1(a.career_slpm)} vs ${n1(b.career_slpm)} strikes per minute)`);
  const fa = A.archive.w ? (A.archive.ko + A.archive.sub) / A.archive.w : null, fb = B.archive.w ? (B.archive.ko + B.archive.sub) / B.archive.w : null;
  if (fa != null && fb != null && Math.abs(fa - fb) >= 0.35) contrasts.push(`a finishing gap (${Math.round(fa * 100)}% vs ${Math.round(fb * 100)}% of archived wins)`);
  const second = contrasts.length
    ? `The evidence points to ${contrasts.join(" and ")}; that is the read to test in the first five minutes.`
    : `The stored numbers are close enough that this is a fight about execution and adjustments rather than one obvious mismatch.`;
  return [lead, second];
}

async function side(f: Fighter, index: RankingIndex | null, bout: Bout, asOf: string | null = null): Promise<DeskSide> {
  const bouts = await getFighterBouts(f.id).catch(() => [] as Awaited<ReturnType<typeof getFighterBouts>>);
  /* asOf: for an archived pregame page, form is limited to results before the event date. */
  const done = bouts.filter((x) => x.result && x.id !== bout.id && (!asOf || (x.event?.event_date && x.event.event_date < asOf)));
  const archive = archiveSummary(f.id, done);
  const lastResults = done.slice(0, 5).map((x) => {
    const r = x.result!;
    const won = r.winner_id ? r.winner_id === f.id : null;
    const opp = x.fighter_a.id === f.id ? x.fighter_b.name : x.fighter_a.name;
    return { opponent: opp, won, method: r.method ? `${METHOD_SHORT[r.method] || r.method}${r.round ? ` R${r.round}` : ""}` : null, date: x.event?.event_date || null };
  });
  let streak: DeskSide["streak"] = { kind: null, n: 0 };
  for (const r of lastResults) {
    if (r.won == null) break;
    const k: "W" | "L" = r.won ? "W" : "L";
    if (!streak.kind) streak = { kind: k, n: 1 };
    else if (streak.kind === k) streak.n += 1;
    else break;
  }
  const s: DeskSide = { fighter: f, rank: rankLabel(f, index, bout), profile: profileLines(f), form: [], keys: [], archive, lastResults, streak, fiveRoundBouts: done.filter((x) => x.scheduled_rounds === 5 || x.is_title).length };
  s.form = formLines(s);
  return s;
}

export type DeskBriefOptions = { includeCompleted?: boolean; asOf?: string | null };

export async function buildDeskBriefs(event: Event, bouts: Bout[], limit = 3, opts: DeskBriefOptions = {}): Promise<DeskBrief[]> {
  const live = bouts.filter((b) => b.status !== "cancelled" && (opts.includeCompleted || !b.result)).slice(0, limit);
  if (!live.length) return [];
  const snap = await getRankings().catch(() => null);
  /* Indexed ONCE for the whole packet, then shared by every side. */
  const rankIndex = buildRankingIndex(snap);
  return Promise.all(live.map(async (bout, index) => {
    const [A, B, dnaRes] = await Promise.all([side(bout.fighter_a, rankIndex, bout, opts.asOf || null), side(bout.fighter_b, rankIndex, bout, opts.asOf || null), index === 0 ? getMatchupDna(bout.fighter_a.id, bout.fighter_b.id, opts.asOf || null).catch(() => null) : Promise.resolve(null)]);
    const dna = dnaRes && dnaRes.status === "ok" ? dnaRes.data : null;
    A.keys = keysFor(A, B); B.keys = keysFor(B, A);
    const thin = (!hasCareer(bout.fighter_a) && A.archive.fights < 2) || (!hasCareer(bout.fighter_b) && B.archive.fights < 2);
    const tier: DeskTier = thin ? "watch" : index === 0 ? "marquee" : "supporting";
    const stakes: string[] = [];
    if (bout.is_title) stakes.push("Title fight");
    if (A.rank || B.rank) stakes.push("Rankings implications");
    if ([A, B].some((s) => s.lastResults[0]?.won === false)) stakes.push("Rebound fight");
    if ([A, B].some((s) => s.streak.kind === "W" && s.streak.n >= 3)) stakes.push("Momentum");
    if (index === 0) stakes.push("Main event");
    if (bout.scheduled_rounds === 5 && !bout.is_title) stakes.push("Five rounds");
    const evidence = [
      `Records and physicals: PropBetEdge fighter rows.`,
      hasCareer(bout.fighter_a) || hasCareer(bout.fighter_b) ? `Career striking/grappling rates: UFC Stats career averages stored per fighter.` : `UFC Stats career averages not on file for both fighters.`,
      `Form and finish profile: ${A.archive.fights + B.archive.fights} archived bouts with results.`,
      snap ? `Rankings: official UFC snapshot ${snap.snapshot_date}.` : `Rankings snapshot unavailable.`,
      dna ? `Fight DNA matchup comparison loaded (${dna.insights.length} insights).` : index === 0 ? `Fight DNA matchup comparison not available for this pairing.` : `Fight DNA consulted for the marquee fight only.`,
    ];
    const coverage = thin ? "Limited packet: one fighter has no UFC Stats averages and fewer than two archived results. Showing what to watch, not a full desk read." : "Full packet: career rates, archived results, rankings snapshot" + (dna ? " and Fight DNA" : "") + ".";
    return {
      bout, tier, stakes, a: A, b: B, evidence, coverage,
      mainTake: mainTake(A, B, bout),
      styleClash: thin ? [] : styleClash(A, B, dna),
      earlyRead: earlyRead(A, B, bout),
      ifItGoesLong: thin ? [] : ifItGoesLong(A, B, bout, dna),
      resultChanges: resultChanges(A, B, bout, event),
    };
  }));
}

export type { Insight };
