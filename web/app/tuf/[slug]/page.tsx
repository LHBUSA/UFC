import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd, Avatar } from "@/components/ui";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";
import { getFightersByIds, type PortraitSet } from "@/lib/db";
import {
  allBouts,
  commissionRecord,
  countsTowardsRecord,
  finaleIntegration,
  fighterIdFor,
  linkSeasonNames,
  linkedFinale,
  portraitsFor,
  seasonBySlug,
  seasons,
  episodesFor,
  scheduledBoutsNow,
  type EpisodeBout,
  type EvidenceSource,
  type FieldSource,
  type LinkedFighter,
  type ScheduledBoutNow,
  type SeasonDetail,
  type TimelineEvent,
  type TufBout,
} from "@/lib/tuf";
import { classState, displayDate, recapWinners, resultState, summarizeBouts, summaryPhrases, type ClassState, type ResultState } from "@/lib/tufBoutState";
import { stageLabel } from "@/lib/tufFormat";
import { buildEpisodeViews, rosterMarks, sourceLabel, sourceLabels, type AiredBout } from "@/lib/tufTimeline";
import type { ShapedBout } from "@/lib/tufFinaleShape";

/* /tuf/[slug] — one season.
 *
 * Every section renders the season's own data through generic parts: its
 * declared competition format, its sourced timeline, the bracket as the single
 * record of house results, and the finale card read live from our fight
 * records. Nothing here is specific to one season, and nothing professional is
 * copied out of the database. */
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return seasons().map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const s = seasonBySlug(slug);
  if (!s) return { title: { absolute: "Not found | PropBetEdge UFC" } };
  const champs = s.winners.map((w) => w.fighter).join(", ");
  const title = `${s.name} | PropBetEdge UFC`;
  const description = s.season_state === "ongoing"
    ? `${s.name}: coaches ${s.coaches.join(" and ")}, ${s.weight_classes.join(" and ")}. Season in progress.`
    : `${s.name}: coaches ${s.coaches.join(" and ") || "rotating"}, ${s.weight_classes.join(" and ")}${champs ? `, won by ${champs}` : ""}.`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/tuf/${s.slug}` },
    openGraph: { title, description, type: "website", url: `${SITE.url}/tuf/${s.slug}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

const STAFF_ORDER: Record<string, number> = { head: 0, assistant: 1, guest: 2, other: 3 };
const STAFF_LABEL: Record<string, string> = { head: "head coach", assistant: "assistant coach", guest: "guest coach", other: "staff" };

const STAGE_LABEL: Record<string, string> = { elimination: "Elimination fight", round_of_16: "Opening round", quarter_final: "Quarterfinal", semi_final: "Semifinal", final: "Final" };
const EVENT_LABEL: Record<string, string> = {
  replacement: "Replacement", withdrawal: "Withdrawal", injury: "Injury", wildcard: "Wild card", missed_weight: "Missed weight",
  medical_postponement: "Medical postponement", catchweight: "Catchweight", coin_toss: "Coin toss", coach_challenge: "Coaches challenge",
  team_selection: "Team draft", elimination_without_fight: "Sent home", weight_issue: "Weight", trade: "Team move",
  matchup_ordered: "Matchup ordered", replacement_return: "Return", staff_change: "Staff", alternate_named: "Alternate",
  semi_final_matchups_announced: "Semi-final matchups",
  forfeit: "Forfeit", medical_clearance: "Medical",
};

const CLASS_LABEL: Record<ClassState, string> = {
  professional: "Professional",
  exhibition: "Exhibition",
  unresolved: "Classification unresolved",
};
/* The result axis, kept apart from classification. Only a result that some
 * source other than the season draft states is called verified. */
const RESULT_LABEL: Record<ResultState, { text: string; title: string }> = {
  verified: { text: "Result verified", title: "The winner is stated by an official source or our own result records." },
  reported: { text: "Winner reported", title: "Primary result source not yet verified: only the season record states this winner." },
  scheduled: { text: "Scheduled", title: "An announced bout that has not been fought." },
  unknown: { text: "Result not recorded", title: "No source loaded states a winner." },
};

function fieldSourceLabel(src: FieldSource, episode: number | null): string {
  if (src.family === "paramount_plus_episode_metadata") {
    const printed = Object.entries(src.printed_names ?? {}).map(([name, as]) => `${name} listed as ${as}`).join("; ");
    return `Episode ${episode ?? ""} listing on Paramount+${printed ? ` (${printed})` : ""}`;
  }
  return "Corrected from UFC.com";
}
/* Listing evidence is recorded against the network's data endpoint; a reader is
 * sent to the show page that renders it. */
function sourceHref(src: { family: string; url?: string }): string | undefined {
  return src.family === "paramount_plus_episode_metadata" ? "https://www.paramountplus.com/shows/the-ultimate-fighter/" : src.url;
}

/* An announced bout. The committed "scheduled" is checked against our records
 * at render: once the result row exists, or the bout is cancelled or its date
 * has passed, it is not shown as upcoming. */
function ScheduledResult({ event, date, now, today }: { event: string; date: string; now?: ScheduledBoutNow; today: string }) {
  const href = `/events/${eventSlug({ name: event, event_date: date })}`;
  if (now?.has_result) {
    return (
      <span className="tuf-res">
        <b>Fought {displayDate(date)}</b> · result on <Link href={href}>the event page</Link>
      </span>
    );
  }
  if (now?.status === "cancelled") return <span className="tuf-res tuf-none">No longer on the card in our records</span>;
  if (date < today) return <span className="tuf-res tuf-none">Result pending · {displayDate(date)}</span>;
  return (
    <span className="tuf-res tuf-sched">
      <b>Scheduled</b> · {displayDate(date)} · <Link href={href}>{event}</Link>
    </span>
  );
}

/* A name, with its canonical portrait when one exists. The fallback is the
 * shared Avatar's initials treatment rather than a grey box or a stand-in
 * face — a wrong face is worse than no face. */
function Name({
  name,
  linked,
  faces,
  size = 0,
}: {
  name: string;
  linked: Map<string, LinkedFighter>;
  faces?: Map<string, PortraitSet>;
  size?: number;
}) {
  const f = linked.get(name);
  const img = faces?.get(name) ?? null;
  const label = f ? (
    <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(f)}`}>
      {name}
    </Link>
  ) : (
    <span className="tuf-name">{name}</span>
  );
  if (!size) return label;
  return (
    <span className="tuf-person">
      <Avatar f={{ name }} img={img} size={size} className="tuf-face" />
      {label}
    </span>
  );
}

/* Where the result and the classification come from, stated separately. */
function Evidence({ b }: { b: TufBout }) {
  const result = sourceLabels(b.result_sources);
  const cls = sourceLabels(b.classification_basis?.affirmative);
  const corroborating = sourceLabels(b.classification_basis?.corroborating);
  if (!result.length && !cls.length) return null;
  return (
    <span className="tuf-evidence">
      {result.length ? <span><b>Result source</b> {result.join(", ")}</span> : null}
      {cls.length ? (
        <span>
          <b>{CLASS_LABEL[classState(b)]} basis</b> {cls.join(", ")}
          {corroborating.length ? <em> · corroborated by {corroborating.join(", ")}</em> : null}
        </span>
      ) : null}
    </span>
  );
}

/* Secondary detail beside a primary record's less specific method ("doctor
 * stoppage" under a commission's "TKO"). Kept off the result line and carrying
 * its own source, so it never reads as part of the verified result. */
function MethodDetailNote({ b }: { b: TufBout }) {
  const d = b.method_detail;
  if (!d) return null;
  const primary = b.result_sources?.some((x) => x.family === "athletic_commission") ? "the commission record" : "the primary record";
  return (
    <span className="tuf-bout-note tuf-method-detail">
      Secondary detail: {d.value} <em>· {sourceLabel(d.source)}; not stated in {primary}</em>
    </span>
  );
}

const foldName = (x: string) => x.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/* What the commission record adds to a house bout. The record is the source;
 * the bracket row already carries the result it states. */
function CommissionDetail({ b }: { b: TufBout }) {
  const hit = commissionRecord(b.commission_record_id);
  if (!hit) return null;
  const { record } = hit;
  /* A normalization is not a correction: the draft's detail was not shown to be wrong. */
  const corrections = (b.corrections ?? []).filter((c) => c.kind !== "method_normalization");
  const normalized = (b.corrections ?? []).filter((c) => c.kind === "method_normalization");
  const loser = b.winner === b.a ? b.b : b.a;
  let cards: string | null = null;
  if (record.scorecards) {
    const [first, second] = record.scorecards.order;
    const winnerFirst = foldName(String(b.winner)).includes(foldName(first)) || foldName(loser).includes(foldName(second));
    cards = record.scorecards.cards.map((c) => {
      const [x, y] = c.score.split("-");
      return `${winnerFirst ? `${x}-${y}` : `${y}-${x}`} (${c.judge})`;
    }).join(" · ");
  }
  return (
    <span className="tuf-evidence">
      <span><b>Fought</b> {displayDate(record.date)}</span>
      {cards ? <span><b>Judges</b> {cards}</span> : null}
      {record.referee ? <span><b>Referee</b> {record.referee}</span> : null}
      {record.remarks.map((r, i) => <span key={i}><b>Commission remark</b> {r.quote}</span>)}
      {corrections.length ? (
        <span><b>Corrected by the commission record</b> {corrections.map((c) => `${c.field} ${c.old ?? "—"} → ${c.new ?? "—"}`).join("; ")}</span>
      ) : null}
      {normalized.length ? (
        <span><b>Method as the commission prints it</b> {normalized.map((c) => `${c.new ?? "—"} (draft: ${c.old ?? "—"})`).join("; ")}</span>
      ) : null}
    </span>
  );
}

function BoutRow({
  b, linked, faces, recaps, now, today, showEvidence = true,
}: {
  b: TufBout; linked: Map<string, LinkedFighter>; faces?: Map<string, PortraitSet>;
  recaps: Map<string, string>; now: Map<string, ScheduledBoutNow>; today: string; showEvidence?: boolean;
}) {
  const pro = countsTowardsRecord(b);
  const result = resultState(b, recaps);
  const cls = classState(b);
  return (
    <li className={`tuf-bout${pro ? " is-pro" : ""}`}>
      <span className="tuf-bout-names">
        <Name name={b.a} linked={linked} faces={faces} size={28} />
        <em>vs</em>
        <Name name={b.b} linked={linked} faces={faces} size={28} />
      </span>
      <span className="tuf-bout-meta">
        {result === "scheduled" && b.scheduled ? (
          <ScheduledResult event={b.scheduled.event} date={b.scheduled.date} now={now.get(b.scheduled.ufc_bout_id)} today={today} />
        ) : b.winner ? (
          <span className="tuf-res">
            <b>{b.winner}</b>
            {b.method ? ` · ${b.method}` : ""}
            {b.round ? ` · R${b.round}` : ""}
            {b.time ? ` ${b.time}` : ""}
          </span>
        ) : (
          <span className="tuf-res tuf-none">Result not recorded</span>
        )}
        {result === "verified" || result === "reported" ? (
          <span className={`tuf-rstate is-${result}`} title={RESULT_LABEL[result].title}>{RESULT_LABEL[result].text}</span>
        ) : null}
        <span className={`tuf-class tuf-class-${cls}`}>{CLASS_LABEL[cls]}</span>
        {typeof b.points === "number" ? <span className="tuf-ep">{b.points} pts</span> : null}
        {b.episode ? <a className="tuf-ep" href={`#ep-${b.episode}`}>Episode {b.episode}</a> : null}
      </span>
      {(b.replacement || b.tournament_deciding || b.wildcard || b.result_note) && (
        <span className="tuf-bout-note">
          {b.tournament_deciding ? <b>Tournament-deciding bout. </b> : null}
          {b.wildcard ? <b>Wild Card bout. </b> : null}
          {b.result_note ? `${b.result_note} ` : null}
          {b.replacement}
        </span>
      )}
      <MethodDetailNote b={b} />
      {showEvidence ? <Evidence b={b} /> : null}
      {showEvidence ? <CommissionDetail b={b} /> : null}
      {b.sources?.length ? (
        <span className="tuf-bout-src">
          {b.sources.map((src) => (
            <a key={src.repair} href={sourceHref(src)} rel="nofollow noopener" target="_blank" title={src.quote}>
              {fieldSourceLabel(src, b.episode)}
            </a>
          ))}
        </span>
      ) : null}
    </li>
  );
}

function SourceTags({ sources }: { sources?: EvidenceSource[] }) {
  const labels = sourceLabels(sources);
  return labels.length ? <small className="tuf-srctag">{labels.join(" · ")}</small> : null;
}

/* A professional bout from our records, linked, with its cards and rounds. */
function RecordBout({ b, event, title }: { b: ShapedBout; event: { name: string; event_date: string }; title?: string }) {
  const fight = `/fights/${matchupSlug(b.a, b.b, event)}`;
  return (
    <li className="tuf-bout is-pro">
      <span className="tuf-bout-names">
        <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(b.a)}`}>{b.a.name}</Link>
        <em>vs</em>
        <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(b.b)}`}>{b.b.name}</Link>
      </span>
      <span className="tuf-bout-meta">
        {b.winner ? (
          <span className="tuf-res">
            <b>{b.winner.name}</b>
            {b.method ? ` · ${b.method}` : ""}
            {b.round ? ` · R${b.round}` : ""}
            {b.time ? ` ${b.time}` : ""}
          </span>
        ) : (
          <span className="tuf-res tuf-none">No result in our records</span>
        )}
        {b.winner ? <span className="tuf-rstate is-verified" title={RESULT_LABEL.verified.title}>Result verified</span> : null}
        {title ? <span className="tuf-class tuf-class-professional">{title}</span> : null}
        <Link className="tuf-ep" href={fight}>Fight page</Link>
      </span>
      {b.scorecards.length || b.rounds_recorded ? (
        <span className="tuf-evidence">
          {b.scorecards.length ? (
            <span><b>Judges</b> {b.scorecards.map((c) => `${c.score}${c.judge ? ` (${c.judge})` : ""}`).join(" · ")}</span>
          ) : null}
          {b.rounds_recorded ? (
            <span><b>Round stats</b> <Link href={`${fight}#round-by-round`}>{b.rounds_recorded} round{b.rounds_recorded === 1 ? "" : "s"} recorded</Link></span>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

function EpisodeBoutLine({ x, linked, recaps }: { x: AiredBout; linked: Map<string, LinkedFighter>; recaps: Map<string, string> }) {
  const b = x.bout;
  const result = resultState(b, recaps);
  const cls = classState(b);
  return (
    <div className="tuf-ep-bout">
      <span className="tuf-bout-names">
        <Name name={b.a} linked={linked} />
        <em>vs</em>
        <Name name={b.b} linked={linked} />
      </span>
      <span className="tuf-bout-meta">
        {b.winner ? (
          <span className="tuf-res"><b>{b.winner}</b>{b.method ? ` · ${b.method}` : ""}{b.round ? ` · R${b.round}` : ""}{b.time ? ` ${b.time}` : ""}</span>
        ) : <span className="tuf-res tuf-none">Result not recorded</span>}
        {result === "verified" || result === "reported" ? <span className={`tuf-rstate is-${result}`} title={RESULT_LABEL[result].title}>{RESULT_LABEL[result].text}</span> : null}
        <span className={`tuf-class tuf-class-${cls}`}>{CLASS_LABEL[cls]}</span>
        <span className="tuf-ep">{x.weight_class} · {x.stage_label}</span>
        {b.fight_date ? <span className="tuf-ep">Fought {displayDate(b.fight_date)}</span> : null}
      </span>
      <MethodDetailNote b={b} />
      {x.recap?.weigh_ins.length ? (
        <span className="tuf-weighins">
          {x.recap.weigh_ins.map((w, j) => (
            <span key={j} className={`tuf-weighin${w.missed_weight ? " is-miss" : ""}`}>
              {w.fighter} <b>{w.weight_lbs != null ? `${w.weight_lbs} lb` : w.weight_text ?? "weight not stated"}</b>
              {w.missed_weight ? <em>{w.made_weight_on_retry ? "missed, made it on the retry" : "missed weight"}</em> : null}
            </span>
          ))}
        </span>
      ) : null}
      {x.recap?.fight_pick ? <span className="tuf-bout-note">Fight picked by {x.recap.fight_pick.chosen_by}</span> : null}
      {x.recap?.result?.contradiction ? <span className="tuf-bout-note">The recap contradicts itself here: {x.recap.result.contradiction}</span> : null}
      {b.episode_sources?.length ? <SourceTags sources={b.episode_sources} /> : null}
    </div>
  );
}

function RecapOnlyBout({ b, linkedById }: { b: EpisodeBout; linkedById: Map<string, LinkedFighter> }) {
  const aF = b.a_fighter_id ? linkedById.get(b.a_fighter_id) : undefined;
  const bF = b.b_fighter_id ? linkedById.get(b.b_fighter_id) : undefined;
  const nameOf = (printed: string, f?: LinkedFighter) => (f ? <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(f)}`}>{printed}</Link> : <span className="tuf-name">{printed}</span>);
  return (
    <div className="tuf-ep-bout">
      <span className="tuf-bout-names">{nameOf(b.a, aF)}<em>vs</em>{nameOf(b.b, bF)}</span>
      <span className="tuf-bout-meta">
        {b.result?.winner ? (
          <span className="tuf-res"><b>{b.result.winner}</b>{b.result.method ? ` · ${b.result.method}` : ""}{b.result.round ? ` · R${b.result.round}` : ""}{b.result.time ? ` ${b.result.time}` : ""}</span>
        ) : <span className="tuf-res tuf-none">Result not stated in the recap</span>}
        {b.stage ? <span className="tuf-ep">{STAGE_LABEL[b.stage] ?? b.stage}</span> : null}
      </span>
      {b.weigh_ins.length ? (
        <span className="tuf-weighins">
          {b.weigh_ins.map((w, j) => (
            <span key={j} className={`tuf-weighin${w.missed_weight ? " is-miss" : ""}`}>
              {w.fighter} <b>{w.weight_lbs != null ? `${w.weight_lbs} lb` : w.weight_text ?? "weight not stated"}</b>
              {w.missed_weight ? <em>{w.made_weight_on_retry ? "missed, made it on the retry" : "missed weight"}</em> : null}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function EventLine({ e, linked }: { e: TimelineEvent; linked: Map<string, LinkedFighter> }) {
  return (
    <li className={`tuf-tl-event is-${e.type}`}>
      <b>{EVENT_LABEL[e.type] ?? e.type}</b>
      {e.fighters.length ? (
        <span className="tuf-tl-who">
          {e.fighters.map((f, i) => <span key={f}>{i ? ", " : ""}<Name name={f} linked={linked} /></span>)}
        </span>
      ) : null}
      <span className="tuf-tl-detail">{e.detail}</span>
      <SourceTags sources={e.sources} />
    </li>
  );
}

function summaryOf(x: AiredBout) {
  const b = x.bout;
  return b.winner ? `${b.winner} def. ${b.winner === b.a ? b.b : b.a}` : `${b.a} vs ${b.b}`;
}

export default async function TufSeason({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = seasonBySlug(slug);
  if (!s) notFound();
  const season = s as SeasonDetail;

  const bouts = allBouts(season);
  const names = [
    ...bouts.flatMap((b) => [b.a, b.b]),
    ...(season.bracket ?? []).flatMap((wc) => wc.stages.flatMap((st) => (st.disputed ?? []).flatMap((b) => [b.a, b.b]))),
    ...(season.teams ?? []).flatMap((t) => t.roster.map((r) => r.name)),
    ...(season.pre_draft_cast ?? []).map((p) => p.name),
    ...(season.coaches_full ?? []).map((c) => c.name),
    ...season.coaches,
    ...season.winners.map((w) => w.fighter),
    ...(season.champions ?? []).map((c) => c.fighter),
    ...(season.final_bouts ?? []).flatMap((f) => [f.a, f.b]),
    ...(season.timeline_events ?? []).flatMap((e) => e.fighters),
  ];
  const contestantIds = [
    ...(season.teams ?? []).flatMap((t) => t.roster.map((r) => r.fighter_id ?? fighterIdFor(season.slug, r.name))),
    ...(season.pre_draft_cast ?? []).map((p) => p.fighter_id ?? fighterIdFor(season.slug, p.name)),
    ...bouts.flatMap((b) => [b.a_fighter_id, b.b_fighter_id]),
  ].filter(Boolean) as string[];
  const [linked, finale] = await Promise.all([linkSeasonNames(season.slug, names), linkedFinale(season.finale_event, season.finale_date)]);
  const [faces, integration] = await Promise.all([
    portraitsFor(linked),
    finaleIntegration(season, finale, contestantIds, (season.coach_fighter_ids ?? []).filter(Boolean) as string[]).catch(() => null),
  ]);
  const eps = episodesFor(season.slug);
  const epIds = [...new Set((eps?.episodes ?? []).flatMap((e) => (e.bouts ?? []).flatMap((b) => [b.a_fighter_id, b.b_fighter_id])).filter(Boolean))] as string[];
  const linkedById = new Map([...linked.values()].map((f) => [f.id, f]));
  const missingIds = epIds.filter((id) => !linkedById.has(id));
  if (missingIds.length) {
    for (const f of await getFightersByIds(missingIds).catch(() => [])) linkedById.set(f.id, f);
  }

  const recaps = recapWinners(eps);
  const summary = summaryPhrases(summarizeBouts(bouts, recaps));
  const today = new Date().toISOString().slice(0, 10);
  const scheduledIds = [
    ...bouts.flatMap((b) => (b.scheduled ? [b.scheduled.ufc_bout_id] : [])),
    ...(season.final_bouts ?? []).flatMap((f) => (f.status === "scheduled" && f.ufc_bout_id ? [f.ufc_bout_id] : [])),
  ];
  const now = await scheduledBoutsNow(scheduledIds);
  const timeline = buildEpisodeViews(season, eps);
  const marks = rosterMarks(season);
  const format = season.competition_format;
  const ov = season.overview;
  const premiere = ov?.premiere?.date ?? eps?.episodes.find((e) => e.episode_number === 1)?.air_date ?? null;
  const staff = (season.coaches_full?.length ? season.coaches_full : season.coaches.map((name) => ({ name, team: null, role: "head" as const })))
    .filter((c) => c.role !== "other")
    .sort((x, y) => STAFF_ORDER[x.role] - STAFF_ORDER[y.role]);

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow={`Season ${season.number} · ${season.year}`}
            title={season.name}
            lede={
              season.season_state === "ongoing"
                ? "This season is still airing. No tournament winner exists yet, and none is shown."
                : season.coaches.length
                  ? `${season.coaches.join(" against ")}, ${season.weight_classes.join(" and ").toLowerCase()}.`
                  : season.coaches_note || ""
            }
            crumbs={[{ name: "The Ultimate Fighter", href: "/tuf" }, { name: `Season ${season.number}` }]}
          />
        </div>
      </div>

      {/* ---- overview: sourced season facts only ---- */}
      <section className="wrap tuf-section">
        <dl className="tuf-overview">
          {format || ov?.format ? (
            <div><dt>Format</dt><dd>{format?.label ?? ov?.format?.value}</dd></div>
          ) : null}
          {premiere ? <div><dt>Premiere</dt><dd>{displayDate(premiere)}<small className="tuf-srctag">{ov?.premiere?.basis ?? "episode 1 air date"}</small></dd></div> : null}
          {season.finale_date ? <div><dt>Finale</dt><dd>{displayDate(season.finale_date)}<small className="tuf-srctag">{season.finale_event}</small></dd></div> : null}
          {ov?.filming?.value ? <div><dt>Filmed</dt><dd>{ov.filming.value}<SourceTags sources={ov.filming.sources} /></dd></div> : null}
          {ov?.fight_window?.start ? <div><dt>House fights</dt><dd>{displayDate(ov.fight_window.start)} – {displayDate(ov.fight_window.end)}<small className="tuf-srctag">{ov.fight_window.basis}</small></dd></div> : null}
          <div><dt>Divisions</dt><dd>{season.weight_classes.join(" · ")}</dd></div>
          {ov?.cast_size?.value ? <div><dt>Cast</dt><dd>{ov.cast_size.value} fighters<SourceTags sources={ov.cast_size.sources} /></dd></div> : null}
          {ov?.network?.value ? <div><dt>Network</dt><dd>{ov.network.value}<SourceTags sources={ov.network.sources} /></dd></div> : null}
          {ov?.hosts?.value ? <div><dt>Hosts</dt><dd>{ov.hosts.value}<SourceTags sources={ov.hosts.sources} /></dd></div> : null}
          {season.coaches.length ? <div><dt>Coaches</dt><dd>{season.coaches.join(" · ")}</dd></div> : null}
          <div><dt>State</dt><dd>{season.season_state === "ongoing" ? "In progress" : "Completed"}</dd></div>
        </dl>
      </section>

      {/* ---- hero: coaches and champions ---- */}
      <section className="wrap tuf-hero">
        <div className="tuf-hero-side">
          <h2>Coaches</h2>
          {season.coaches.length ? (
            <ul className="tuf-people">
              {staff.map((c, i) => (
                <li key={`${c.name}-${i}`} className={c.role === "head" ? "is-head" : ""}>
                  <Name name={c.name} linked={linked} faces={faces} size={c.role === "head" ? 56 : 34} />
                  <small>
                    {[
                      c.team,
                      "discipline" in c && c.discipline ? `${c.discipline} coach` : STAFF_LABEL[c.role],
                      "from_episode" in c && c.from_episode ? `from episode ${c.from_episode}` : null,
                    ].filter(Boolean).join(" · ")}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tuf-none">{season.coaches_note || "Coaches unrecorded for this season."}</p>
          )}
        </div>
        <div className="tuf-hero-side">
          <h2>Champions</h2>
          {season.season_state === "ongoing" ? (
            <p className="tuf-none">The season has not finished. A winner will appear when one exists.</p>
          ) : season.champions?.length ? (
            <ul className="tuf-people">
              {season.champions.map((c) => (
                <li key={c.weight_class} className="is-head">
                  <Name name={c.fighter} linked={linked} faces={faces} size={56} />
                  <small>
                    {c.weight_class}
                    {c.won_tournament ? " · won the tournament" : ""}
                    {c.received_title ? ` · ${c.received_title}` : c.received_contract ? " · awarded a UFC contract" : " · contract not recorded"}
                  </small>
                </li>
              ))}
            </ul>
          ) : season.winners.length ? (
            <ul className="tuf-people">
              {season.winners.map((w) => (
                <li key={w.weight_class} className="is-head">
                  <Name name={w.fighter} linked={linked} faces={faces} size={56} />
                  <small>{w.weight_class}</small>
                </li>
              ))}
            </ul>
          ) : season.finalists?.length ? (
            <div>
              <p className="tuf-none">Winner unverified — sources disagree. Finalists:</p>
              <ul className="tuf-people">
                {season.finalists.map((f) => (
                  <li key={f.weight_class}>
                    {f.fighters.join(" vs ")}
                    <small>{f.weight_class}</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="tuf-none">No winner recorded for this season.</p>
          )}
          {season.winner_note ? <p className="tuf-fine">{season.winner_note}</p> : null}
        </div>
      </section>

      {/* ---- finale: read from our fight records, never copied ---- */}
      <section className="wrap tuf-section" id="finale">
        <div className="tuf-section-head">
          <h2>Finale</h2>
          {integration ? (
            <p>Professional bouts from our fight records, on a sanctioned card. They are separate from the house bouts below, which never count toward a professional record.</p>
          ) : null}
        </div>
        {finale ? (
          <p className="tuf-linkcard">
            <Link href={`/events/${eventSlug(finale)}`}>
              <b>{finale.name}</b>
              <span>{finale.event_date ? displayDate(finale.event_date) : null}</span>
            </Link>
            {integration?.debuts.debuted_here ? (
              <small>
                {integration.debuts.debuted_here === integration.debuts.contestants
                  ? `All ${integration.debuts.contestants} contestants`
                  : `${integration.debuts.debuted_here} of ${integration.debuts.contestants} contestants`} made their UFC debut on this card, by our records.
              </small>
            ) : null}
          </p>
        ) : season.unresolved_finale ? (
          <p className="tuf-none">
            <b>Finale not linked.</b> {season.unresolved_finale.why_wrong ? `${season.unresolved_finale.why_wrong} ` : ""}
            {season.unresolved_finale.blocker}
            {season.unresolved_finale.candidate_card ? ` Candidate card: ${season.unresolved_finale.candidate_card}.` : ""}
          </p>
        ) : season.finale_event ? (
          <p className="tuf-none">
            <b>{season.finale_event}</b>
            {season.finale_date ? ` · ${season.finale_date}` : ""} — the card is not loaded into our database yet, so it is
            named rather than linked. Nothing is invented in the meantime.
          </p>
        ) : (
          <p className="tuf-none">No finale card recorded for this season.</p>
        )}

        {integration && integration.finals.length && integration.finals.every((f) => f.winner) ? (
          <>
            <h3 className="tuf-subhead">Tournament finals</h3>
            <ul className="tuf-bouts">
              {integration.finals.map((f) => <RecordBout key={f.id} b={f} event={integration.event} title={`${f.season_weight_class} final`} />)}
            </ul>
          </>
        ) : season.final_bouts?.length ? (
          <>
            <h3 className="tuf-subhead">Tournament finals</h3>
            <p className="tuf-fine">Each matched to the exact finalist-versus-finalist bout in our own records — not to a champion appearing somewhere on a card.
              {season.final_bouts.some((f) => f.status === "scheduled") ? " A scheduled final has no winner until its result exists." : ""}</p>
            <ul className="tuf-bouts">
              {season.final_bouts.map((f, i) => (
                <li className="tuf-bout is-pro" key={`f-${i}`}>
                  <span className="tuf-bout-names">
                    <Name name={f.a} linked={linked} />
                    <em>vs</em>
                    <Name name={f.b} linked={linked} />
                  </span>
                  <span className="tuf-bout-meta">
                    {f.status === "scheduled" ? (
                      <ScheduledResult event={f.event} date={f.date} now={f.ufc_bout_id ? now.get(f.ufc_bout_id) : undefined} today={today} />
                    ) : (
                      <span className="tuf-res">
                        {f.winner ? <b>{f.winner}</b> : null}
                        {f.method ? ` · ${f.method}` : ""}
                        {f.round ? ` · R${f.round}` : ""}
                      </span>
                    )}
                    <span className="tuf-class tuf-class-professional">{f.weight_class}</span>
                    {f.status === "scheduled" ? null : <span className="tuf-ep">{f.event} · {f.date}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {integration?.castBouts.length ? (
          <>
            <h3 className="tuf-subhead">Castmates on the same card</h3>
            <ul className="tuf-bouts">
              {integration.castBouts.map((b) => <RecordBout key={b.id} b={b} event={integration.event} />)}
            </ul>
          </>
        ) : null}
        {integration?.otherBouts.length ? (
          <details className="tuf-restcard">
            <summary>Rest of the card · {integration.otherBouts.length} bout{integration.otherBouts.length === 1 ? "" : "s"}</summary>
            <ul className="tuf-bouts">
              {integration.otherBouts.map((b) => <RecordBout key={b.id} b={b} event={integration.event} />)}
            </ul>
          </details>
        ) : null}
        {integration?.coachFight ? (
          <>
            <h3 className="tuf-subhead">The coaches&rsquo; fight</h3>
            <p className="tuf-linkcard">
              <Link href={`/events/${eventSlug(integration.coachFight.event)}`}>
                <b>{integration.coachFight.event.name}</b>
                <span>{displayDate(integration.coachFight.event.event_date)}</span>
              </Link>
            </p>
            <ul className="tuf-bouts">
              <RecordBout b={integration.coachFight} event={integration.coachFight.event} />
            </ul>
          </>
        ) : null}
      </section>

      {/* ---- teams ---- */}
      {season.teams?.length ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>Teams</h2>
            <p>
              {season.teams.some((t) => t.roster.some((r) => r.pick)) ? "As originally drafted, in pick order. Moves and exits link to the episode they happened in. " : ""}
              Contestants link to their canonical profile where one exists.
            </p>
          </div>
          <div className="tuf-teams">
            {season.teams.map((t) => (
              <div className="tuf-team" key={t.name}>
                <h3>
                  {t.name}
                  {t.region ? <small>{t.region}</small> : null}
                </h3>
                <ul>
                  {t.roster.map((r) => (
                    <li key={r.name} className={r.status === "withdrawn" ? "is-withdrawn" : ""}>
                      <Name name={r.name} linked={linked} faces={faces} size={34} />
                      {r.country || r.pick || r.status ? (
                        <small>
                          {[
                            r.pick ? `Pick ${r.pick}` : null,
                            r.country,
                            r.status === "withdrawn" ? "Withdrew" : r.status === "replacement" ? "Replacement" : null,
                          ].filter(Boolean).join(" · ")}
                        </small>
                      ) : null}
                      {marks.get(r.name)?.length ? (
                        <span className="tuf-marks">
                          {marks.get(r.name)!.map((m, i) => (
                            m.episode ? (
                              <a key={i} className={`tuf-mark is-${m.kind}`} href={`#ep-${m.episode}`}>{m.label} · Ep {m.episode}</a>
                            ) : (
                              <a key={i} className={`tuf-mark is-${m.kind}`} href="#ep-unplaced">{m.label}{m.unresolved ? " · episode unresolved" : ""}</a>
                            )
                          ))}
                        </span>
                      ) : null}
                      {r.note ? <em>{r.note}</em> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {season.pre_draft_cast?.length ? (
            <div className="tuf-team tuf-predraft">
              <h3>Before the draft<small>left before the teams were picked — no bout</small></h3>
              <ul>
                {season.pre_draft_cast.map((p) => (
                  <li key={p.name}>
                    <Name name={p.name} linked={linked} faces={faces} size={34} />
                    <small>{[p.weight_class, p.exit === "injury" ? "Injured out" : p.exit === "left_show" ? "Left the show" : p.exit === "forfeit" ? "Forfeited" : p.exit].filter(Boolean).join(" · ")}</small>
                    <span className="tuf-marks"><a className="tuf-mark is-elimination" href={`#ep-${p.episode}`}>Episode {p.episode}</a></span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {season.teams.find((t) => t.pick_basis)?.pick_basis ? <p className="tuf-fine">{season.teams.find((t) => t.pick_basis)!.pick_basis}</p> : null}
        </section>
      ) : null}

      {/* ---- team competition (a season decided on points, not a bracket) ---- */}
      {season.team_competition ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>Team competition</h2>
            <p>{season.team_competition.note}</p>
          </div>

          {season.team_competition.standings?.length ? (
            <div className="tuf-standings">
              {season.team_competition.standings.map((row, i) => (
                <div className={`tuf-standing${i === 0 ? " is-winner" : ""}`} key={row.team}>
                  <span className="tuf-standing-team">{row.team}</span>
                  <span className="tuf-standing-pts">{row.points ?? "—"} pts</span>
                  <span className="tuf-standing-wins">{row.wins ?? "—"} wins</span>
                </div>
              ))}
            </div>
          ) : null}

          {season.team_competition.concluding_bout ? (
            <div className="tuf-concluding">
              <h3>Concluding bout</h3>
              <p className="tuf-concluding-note">{season.team_competition.concluding_bout.note}</p>
              <div className="tuf-concluding-bout">
                <span className="tuf-concluding-names">
                  <b>{season.team_competition.concluding_bout.winner}</b>
                  {" def. "}
                  {season.team_competition.concluding_bout.winner === season.team_competition.concluding_bout.a
                    ? season.team_competition.concluding_bout.b
                    : season.team_competition.concluding_bout.a}
                </span>
                <span className="tuf-concluding-meta">
                  {[
                    season.team_competition.concluding_bout.method,
                    season.team_competition.concluding_bout.round ? `R${season.team_competition.concluding_bout.round}` : null,
                    season.team_competition.concluding_bout.weight_class,
                  ].filter(Boolean).join(" · ")}
                </span>
                <span className="tuf-concluding-event">
                  {season.team_competition.concluding_bout.event}
                  {season.team_competition.concluding_bout.date ? ` · ${season.team_competition.concluding_bout.date}` : ""}
                </span>
                {season.team_competition.concluding_bout.verified_against ? (
                  <span className="tuf-concluding-verified">
                    Verified against {season.team_competition.concluding_bout.verified_against}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ---- season timeline: episode by episode, facts referenced not copied ---- */}
      {timeline.episodes.length ? (
        <section className="wrap tuf-section" id="episodes">
          <div className="tuf-section-head">
            <h2>Season timeline</h2>
            <p>
              Episode by episode: the bouts that aired and the sourced competition events. Results are the tournament&rsquo;s own record below; an episode only says where they aired.
              {timeline.episodes.some((v) => v.episode.air_date) ? " Air dates are shown only where the network listing and an independent source give the same day." : ""}
            </p>
          </div>
          <ol className="tuf-episodes">
            {timeline.episodes.map((v) => {
              const e = v.episode;
              return (
                <li key={e.episode_number} className={`tuf-episode${v.hasFacts ? "" : " is-empty"}`} id={`ep-${e.episode_number}`}>
                  <details>
                    <summary>
                      <span className="tuf-ep-num">Ep {e.episode_number}</span>
                      <span className="tuf-ep-title">{e.title ?? <em className="tuf-none">Title not listed</em>}</span>
                      {e.air_date ? <span className="tuf-ep-date">{displayDate(e.air_date)}</span> : e.air_date_resolution?.status === "unresolved" ? <span className="tuf-ep-date">Air date unresolved</span> : null}
                      {v.hasFacts ? (
                        <span className="tuf-ep-sum">
                          {[
                            ...v.bouts.map(summaryOf),
                            ...v.recapOnlyBouts.map((b) => (b.result?.winner ? `${b.result.winner} def. ${b.result.winner === b.a ? b.b : b.a}` : `${b.a} vs ${b.b}`)),
                            ...v.events.map((x) => `${EVENT_LABEL[x.type] ?? x.type}${x.fighters.length ? `: ${x.fighters.join(", ")}` : ""}`),
                          ].join(" · ")}
                        </span>
                      ) : (
                        <span className="tuf-ep-sum tuf-none">Episode details not yet sourced.</span>
                      )}
                    </summary>
                    <div className="tuf-ep-body">
                      {v.bouts.length ? <h4 className="tuf-ep-h">Fights</h4> : null}
                      {v.bouts.map((x, i) => <EpisodeBoutLine key={`b-${i}`} x={x} linked={linked} recaps={recaps} />)}
                      {v.recapOnlyBouts.map((b, i) => <RecapOnlyBout key={`r-${i}`} b={b} linkedById={linkedById} />)}
                      {v.events.length ? (
                        <>
                          <h4 className="tuf-ep-h">Competition events</h4>
                          <ul className="tuf-tl-events">
                            {v.events.map((x) => <EventLine key={x.id} e={x} linked={linked} />)}
                          </ul>
                        </>
                      ) : null}
                      {v.recapEvents.length ? (
                        <ul className="tuf-ep-events">
                          {v.recapEvents.map((x, j) => (
                            <li key={j}><b>{EVENT_LABEL[x.type] ?? x.type}</b> {x.text}</li>
                          ))}
                        </ul>
                      ) : null}
                      {!v.hasFacts ? <span className="tuf-fine">Episode details not yet sourced.</span> : null}
                      {e.air_date_resolution?.status === "resolved" ? (
                        <span className="tuf-fine tuf-ep-provenance">
                          Aired {displayDate(e.air_date)}: the network listing and {e.air_date_resolution.independent_source?.family === "wikipedia" ? "Wikipedia" : e.air_date_resolution.independent_source?.family}
                          {e.air_date_resolution.independent_source?.cites ? ` (citing ${e.air_date_resolution.independent_source.cites.split(" (")[0]})` : ""} agree.
                          {e.air_date_resolution.network_display_date && e.air_date_resolution.network_display_date !== e.air_date ? ` The network displays ${displayDate(e.air_date_resolution.network_display_date)}.` : ""}
                        </span>
                      ) : null}
                      {e.air_date_resolution?.status === "unresolved" ? (
                        <span className="tuf-fine tuf-ep-provenance">
                          Air date unresolved: {e.air_date_resolution.why}.
                        </span>
                      ) : null}
                      {e.recap_url ? (
                        <a className="tuf-ep-src" href={e.recap_url} rel="nofollow noopener" target="_blank">
                          Official recap on UFC.com{e.recap_byline_date ? ` · ${e.recap_byline_date}` : ""}
                        </a>
                      ) : null}
                    </div>
                  </details>
                </li>
              );
            })}
            {eps?.finale_broadcast ? (
              <li className="tuf-episode is-finale" id="ep-finale">
                <a className="tuf-ep-finale" href="#finale">
                  <span className="tuf-ep-num">Finale</span>
                  <span className="tuf-ep-title">{eps.finale_broadcast.title}</span>
                  {eps.finale_broadcast.air_date ? <span className="tuf-ep-date">{displayDate(eps.finale_broadcast.air_date)}</span> : null}
                  <span className="tuf-ep-sum">Live broadcast of the finale card — professional bouts, shown above.</span>
                </a>
              </li>
            ) : null}
          </ol>
          {timeline.unplacedEvents.length ? (
            <div className="tuf-unplaced" id="ep-unplaced">
              <h3 className="tuf-subhead">Episode not settled</h3>
              <ul className="tuf-tl-events">
                {timeline.unplacedEvents.map((x) => (
                  <li key={x.id} className={`tuf-tl-event is-${x.type}`}>
                    <b>{EVENT_LABEL[x.type] ?? x.type}</b>
                    <span className="tuf-tl-who">{x.fighters.map((f, i) => <span key={f}>{i ? ", " : ""}<Name name={f} linked={linked} /></span>)}</span>
                    <span className="tuf-tl-detail">{x.detail}</span>
                    <SourceTags sources={x.sources} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {eps?.missing_recaps?.length ? (
            <p className="tuf-fine">
              {eps.missing_recaps.map((m) => `UFC.com published no recap for episode ${m.episode_number}; its bouts appear in the bracket only.`).join(" ")}
            </p>
          ) : null}
          {eps?.source_defects?.length ? (
            <p className="tuf-fine">
              Known source defects kept as found: {eps.source_defects.map((d) => d.detail.split(". ")[0]).join("; ")}.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ---- tournament, in the season's own format ---- */}
      {season.bracket?.length ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>{season.team_competition ? "Series results" : "Tournament"}</h2>
            {summary.length ? <p className="tuf-summary">{summary.join(" · ")}</p> : null}
            {format ? <p><b>{format.label}.</b> {[...(format.steps ?? []).map((st) => st.rule), ...format.phases.map((p) => p.rule)].filter(Boolean).join(" ")}</p> : null}
            <p>
              Result and classification are separate. A reported winner comes from the season record alone; a verified
              one is stated by an official source or our own result records. Only sourced professional bouts count
              toward a professional record — house exhibitions and unresolved house bouts never do.
            </p>
          </div>
          {season.bracket.map((wc) => (
            <div className="tuf-bracket" key={wc.weight_class}>
              <h3>{wc.weight_class}</h3>
              {wc.stages.map((st) => (
                <div className="tuf-stage" key={st.stage}>
                  <div className="tuf-stage-head">
                    <h4>{stageLabel(format, st.stage, st.label)}</h4>
                    {st.status === "unverified" ? <span className="tuf-pill tuf-pill-thin">Unverified</span> : null}
                  </div>
                  {st.note ? <p className="tuf-fine">{st.note}</p> : null}
                  {st.bouts.length ? (
                    <ul className="tuf-bouts">
                      {st.bouts.map((b, i) => (
                        <BoutRow key={`${b.a}-${b.b}-${i}`} b={b} linked={linked} faces={faces} recaps={recaps} now={now} today={today} />
                      ))}
                    </ul>
                  ) : (
                    <p className="tuf-none">Not recorded. Nothing is reconstructed for this round.</p>
                  )}
                  {st.disputed?.length ? (
                    <div className="tuf-disputed">
                      <h5>Listed by a source but not reconciled</h5>
                      <ul className="tuf-bouts">
                        {st.disputed.map((b, i) => (
                          <li key={`d-${i}`} className="tuf-bout is-disputed">
                            <span className="tuf-bout-names">
                              <Name name={b.a} linked={linked} />
                              <em>vs</em>
                              <Name name={b.b} linked={linked} />
                            </span>
                            <span className="tuf-bout-meta">
                              <span className="tuf-class tuf-class-unverified">Not counted</span>
                            </span>
                            <span className="tuf-bout-note">{b.dispute}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : (
        <section className="wrap tuf-section">
          <div className="tuf-section-head"><h2>Tournament</h2></div>
          <p className="tuf-none">
            The bracket for this season has not been loaded. Season metadata, coaches and champions above are sourced;
            the round-by-round tournament is not yet in the archive.
          </p>
        </section>
      )}

      {/* ---- provenance ---- */}
      <section className="wrap tuf-section">
        {season._conflicts?.length ? (
          <div className="tuf-conflicts">
            <h2>Where sources disagree</h2>
            {season._conflicts.map((c, i) => (
              <p key={i}>
                <b>{c.field}</b> — {c.detail}
              </p>
            ))}
          </div>
        ) : null}
        {season.name_corrections?.length ? (
          <div className="tuf-conflicts">
            <h2>Name corrections</h2>
            {season.name_corrections.map((c) => (
              <p key={c.draft_name}>
                <b>{c.name}</b> — the season record printed &ldquo;{c.draft_name}&rdquo;.{" "}
                {c.kind === "source_correction"
                  ? `Corrected to the name ESPN and the broadcaster's episode listing use; "${c.draft_name}" is not attested by a first-party source and is not treated as an alias.`
                  : "A misspelling of the name ESPN and the broadcaster's episode listing use."}
              </p>
            ))}
          </div>
        ) : null}
        {season._provenance ? (
          <p className="tuf-note">
            Season data from <a href={season._provenance.primary} rel="nofollow noopener" target="_blank">the season record</a>,
            retrieved {season._provenance.retrieved}. {season._provenance.note}
          </p>
        ) : null}
      </section>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "TVSeason",
          name: season.name,
          seasonNumber: season.number,
          datePublished: premiere ?? String(season.year),
          partOfSeries: { "@type": "TVSeries", name: "The Ultimate Fighter" },
          url: `${SITE.url}/tuf/${season.slug}`,
        }}
      />
    </>
  );
}
