import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, Empty, JsonLd, Portrait } from "@/components/ui";
import {
  getUpcomingEvents, getFightersByIds,
  type Fighter, type PortraitSet,
} from "@/lib/db";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import {
  getWeighIns, getWeighInSummary, getWeighInHistory, getWeighInEvents, pickDeskEvent, getBookedCard,
  deskWindow, bookedCoverage, shouldPoll, supersessionLabel,
  RESULT_LABEL, RESULT_TONE, SOURCE_KIND_LABEL,
  weightCell, limitCell, deltaCell, classCell, sortForTable, isLive, freshness,
  updateLine, timelineKind, clockTime, WEIGHIN_REVALIDATE,
  type WeighIn,
} from "@/lib/weighins";
import { fighterSlug } from "@/lib/slug";
import { fmtDate, fmtHeight, fmtReach, fmtRecord, stanceLabel } from "@/lib/format";
import { SITE } from "@/lib/site";
import { WeighInAutoRefresh } from "@/components/WeighInAutoRefresh";
import styles from "./weighins.module.css";

export const revalidate = 15;

export const metadata: Metadata = {
  title: "UFC Official Weigh-In Results — Live Desk",
  description:
    "Live and recent official UFC weigh-in results: every fighter's scale reading against the applicable limit, misses, catchweights, withdrawals and corrections, each with its source.",
  alternates: { canonical: "/weigh-ins" },
  openGraph: { title: "UFC Weigh-Ins — PropBetEdge", description: "Structured official weigh-in results, updated from sourced readings.", url: `${SITE.url}/weigh-ins` },
  twitter: { card: "summary_large_image", title: "UFC Weigh-Ins — PropBetEdge" },
};

type BoutGroup = { key: string; boutId: string | null; rows: WeighIn[] };

function groupByBout(rows: WeighIn[]): BoutGroup[] {
  const groups = new Map<string, BoutGroup>();
  for (const row of rows) {
    const key = row.bout_id || `row:${row.id}`;
    const current = groups.get(key);
    if (current) current.rows.push(row);
    else groups.set(key, { key, boutId: row.bout_id, rows: [row] });
  }
  return [...groups.values()];
}

function profileValue(value: string) {
  return value === "—" ? "Not on file" : value;
}

function FighterReading({ w, fighter, img, superLabel }: { w: WeighIn; fighter: Fighter | null; img?: PortraitSet | null; superLabel?: string | null }) {
  const weight = weightCell(w);
  const limit = limitCell(w);
  const delta = deltaCell(w);
  const tone = RESULT_TONE[w.result];
  const href = `/fighters/${fighterSlug(fighter || { name: w.fighter_name, espn_athlete_id: w.fighter_espn_athlete_id, ufcstats_id: w.fighter_ufcstats_id })}`;
  const visualFighter = fighter || { name: w.fighter_name };

  return (
    <section className={styles.reading} data-tone={tone} aria-label={`${w.fighter_name} weigh-in result`}>
      <div className={styles.fighterTop}>
        <Link href={href} aria-label={`${w.fighter_name} fighter profile`}>
          <Portrait f={visualFighter} img={img} sizes="(max-width: 680px) 82px, 104px" className={styles.fighterPortrait} />
        </Link>
        <div className={styles.fighterIdentity}>
          <div className={styles.statusLine}>
            <span className={styles.badge} data-tone={tone}>{RESULT_LABEL[w.result]}</span>
            {w.is_correction && <span className={styles.corrected}>{superLabel || "Corrected"}</span>}
            {w.attempt_number > 1 && <span className={styles.attempt}>Attempt {w.attempt_number}</span>}
          </div>
          <h3><Link href={href}>{w.fighter_name}</Link></h3>
          {fighter?.nickname && <p className={styles.nickname}>“{fighter.nickname}”</p>}
          <div className={styles.profileFacts}>
            <span><small>Record</small><b>{profileValue(fighter ? fmtRecord(fighter) : "—")}</b></span>
            <span><small>Height</small><b>{profileValue(fighter ? fmtHeight(fighter.height_in) : "—")}</b></span>
            <span><small>Reach</small><b>{profileValue(fighter ? fmtReach(fighter.reach_in) : "—")}</b></span>
            <span><small>Stance</small><b>{profileValue(fighter ? stanceLabel(fighter.stance) : "—")}</b></span>
          </div>
        </div>
      </div>

      <div className={styles.scaleGrid}>
        <div className={styles.scalePrimary}>
          <span>Official weight</span>
          <b className={weight.known ? styles.weight : styles.weightUnknown}>{weight.text}</b>
        </div>
        <div className={styles.scaleMetric}>
          <span>Applicable limit</span>
          <b className={limit.known ? styles.limit : styles.limitUnknown}>{limit.text}</b>
          {limit.note && <small>{limit.note}</small>}
        </div>
        <div className={styles.scaleMetric} data-alert={delta.over ? "true" : undefined}>
          <span>Delta</span>
          <b className={delta.over ? styles.over : styles.under}>{delta.text}</b>
          {w.catchweight_lbs != null && <small>Catchweight agreed</small>}
        </div>
      </div>

      <div className={styles.receipt}>
        <span>{clockTime(w.weighed_at || w.source_published_at) || "Timestamp not published"}</span>
        <a href={w.source_url} target="_blank" rel="noopener noreferrer nofollow">
          {SOURCE_KIND_LABEL[w.source_kind]} · {w.source_name} ↗
        </a>
      </div>
    </section>
  );
}

function BoutCard({ group, fighters, images, labels }: { group: BoutGroup; fighters: Map<string, Fighter>; images: Map<string, PortraitSet>; labels: Map<string, string | null> }) {
  const first = group.rows[0];
  return (
    <article className={styles.boutCard} id={group.boutId ? `bout-${group.boutId}` : undefined}>
      <header className={styles.boutHead}>
        <div>
          <span>{first.card_position ? first.card_position.replace(/_/g, " ") : "Card"}{first.bout_order != null ? ` · Bout ${first.bout_order}` : ""}</span>
          <h2>{first.weight_class_raw || classCell(first)}</h2>
        </div>
        <div className={styles.boutLimit}>
          <small>Contract</small>
          <b>{limitCell(first).text}</b>
        </div>
      </header>
      <div className={styles.readings}>
        {group.rows.map((w) => (
          <FighterReading key={w.id} w={w} fighter={fighters.get(w.fighter_id) || null} img={images.get(w.fighter_id)} superLabel={labels.get(w.id)} />
        ))}
      </div>
    </article>
  );
}

export default async function WeighInsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const sp = await searchParams;
  const [upcoming, covered] = await Promise.all([
    getUpcomingEvents(6).catch(() => []),
    getWeighInEvents(12).catch(() => []),
  ]);
  const upcomingDesk = upcoming.map((e) => ({ id: e.id, name: e.name, event_date: e.event_date }));
  const selected = sp.event ? covered.find((e) => e.event_id === sp.event) : null;
  const desk = selected
    ? {
        eventId: selected.event_id,
        eventName: selected.event_name,
        eventDate: selected.event_date,
        state: upcomingDesk.some((e) => e.id === selected.event_id) ? "upcoming" as const : "recent" as const,
      }
    : pickDeskEvent(upcomingDesk, covered);

  const [rows, summary, fullHistory, booked] = desk
    ? await Promise.all([
        getWeighIns(desk.eventId).catch(() => []),
        getWeighInSummary(desk.eventId).catch(() => null),
        getWeighInHistory(desk.eventId, 400).catch(() => []),
        getBookedCard(desk.eventId).catch(() => []),
      ])
    : [[], null, [], []];
  const history = fullHistory.slice(0, 18);

  const table = sortForTable(rows);
  /* Coverage is measured against the booked card: before the first reading
   * the summary view has no row at all, and "0 expected" would be a lie. */
  const bookedIds = [...new Set(booked.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]).filter((x): x is string => Boolean(x)))];
  const coverage = bookedCoverage(bookedIds, rows);
  const win = desk?.state === "upcoming" ? deskWindow(desk.eventDate) : { open: false, sessionLive: false, sessionFinished: false };
  const poll = shouldPoll(win, coverage, summary?.pending ?? 0);
  /* Confirmation vs correction: compare against the reading it superseded. */
  const priorWeight = new Map(fullHistory.map((h) => [h.id, h.official_weight_lbs]));
  /* The reading that replaced each superseded row: a same-weight replacement
   * is a confirmation, and the trail must not call it a correction. */
  const replacedBy = new Map(fullHistory.filter((h) => h.supersedes_id).map((h) => [h.supersedes_id as string, h]));
  const supersededNote = (h: (typeof history)[number]) => {
    const by = replacedBy.get(h.id);
    if (by && Number(by.official_weight_lbs) === Number(h.official_weight_lbs)) return ` · confirmed by ${by.source_name}`;
    if (by) return ` · corrected by ${by.source_name}`;
    return " · later corrected";
  };
  const labels = new Map(rows.map((w) => [w.id, w.supersedes_id ? supersessionLabel(w.official_weight_lbs, priorWeight.get(w.supersedes_id), w.source_kind) : null]));
  const historyKind = (h: (typeof history)[number]) => {
    if (h.supersedes_id && priorWeight.has(h.supersedes_id) && Number(priorWeight.get(h.supersedes_id)) === Number(h.official_weight_lbs)) {
      return `${h.source_kind === "official" ? "OFFICIAL" : h.source_kind.toUpperCase()} CONFIRMATION`;
    }
    return timelineKind({ ...(h as unknown as WeighIn), is_correction: Boolean(h.supersedes_id) });
  };

  const fighterIds = [...new Set([...table.map((r) => r.fighter_id), ...bookedIds].filter(Boolean))];
  const [fighters, images] = await Promise.all([
    getFightersByIds(fighterIds).catch(() => []),
    getVerifiedDisplayImagesForFighters(fighterIds).catch(() => new Map<string, PortraitSet>()),
  ]);
  const fighterMap = new Map(fighters.map((f) => [f.id, f]));
  const boutGroups = groupByBout(table);
  const live = poll || isLive(summary);
  const expectedCount = coverage.expected || summary?.expected || 0;
  const weighedCount = summary?.weighed ?? 0;
  const pendingCount = coverage.expected ? coverage.pendingIds.length : (summary?.pending ?? 0);
  const pendingNames = coverage.pendingIds.map((id) => fighterMap.get(id)?.name).filter(Boolean) as string[];
  const missed = table.filter((r) => r.result === "missed");
  const cutoff = new Date(Date.now() - 21 * 86400e3).toISOString().slice(0, 10);
  const recentCovered = covered.filter((e) => e.event_date && e.event_date >= cutoff);
  const sourceStamp = summary?.newest_source_published_at || summary?.last_source_update || null;
  const sourceStampIsPublisher = Boolean(summary?.newest_source_published_at);

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Weigh-Ins" }]} />
      <WeighInAutoRefresh seconds={WEIGHIN_REVALIDATE} enabled={poll} />

      <section className={styles.hero}>
        <div className={styles.heroMain}>
          <div className={styles.eyebrow}>
            <span className={live ? styles.dotLive : styles.dotIdle} aria-hidden="true" />
            {live ? "Live · official weigh-ins" : "Official weigh-ins"}
          </div>
          <h1>Official Weigh-Ins</h1>
          {desk ? (
            <p className={styles.event}>
              {desk.eventName}
              {desk.eventDate && <span className={styles.eventDate}> · {fmtDate(desk.eventDate)}</span>}
              {desk.state === "recent" && <span className={styles.eventNote}> · covered archive</span>}
            </p>
          ) : <p className={styles.event}>No card on file</p>}
          {desk && expectedCount > 0 && (
            <p className={styles.freshness} data-testid="weighin-coverage">
              <strong>{weighedCount} weighed / {expectedCount} expected</strong>
              {pendingCount > 0 && <span className={styles.freshNote}> · {pendingCount} awaiting a sourced reading</span>}
              {poll && <span className={styles.freshNote}> · checking every {WEIGHIN_REVALIDATE}s</span>}
            </p>
          )}
          <p className={styles.freshness}>
            {sourceStampIsPublisher ? "Latest source publication" : "Latest verified capture"}: <strong>{freshness(sourceStamp)}</strong>
            <span className={styles.freshNote}>
              {sourceStampIsPublisher ? " — publisher timestamp retained." : " — verified source; publication time was not retained."}
            </span>
          </p>
        </div>

        <aside className={styles.counters} aria-label="Weigh-in coverage">
          {[
            { n: expectedCount, l: "expected" },
            { n: weighedCount, l: "weighed" },
            { n: summary?.made ?? 0, l: "made", tone: "ok" },
            { n: summary?.missed ?? 0, l: "missed", tone: summary?.missed ? "alert" : undefined },
            { n: pendingCount, l: "pending", tone: "neutral" },
          ].map((c) => <div key={c.l} className={styles.counter} data-tone={c.tone}><b>{c.n}</b><span>{c.l}</span></div>)}
        </aside>
      </section>

      {missed.length > 0 && (
        <section className={styles.missStrip} aria-label="Missed weight">
          <span className={styles.missLabel}>Missed weight</span>
          <ul>{missed.map((m) => <li key={m.id}>{updateLine(m)}</li>)}</ul>
        </section>
      )}

      {table.length ? (
        <div className={styles.layout}>
          <section className={styles.boutList} aria-label="Weigh-in results by bout">
            {win.open && pendingNames.length > 0 && (
              <p className={styles.panelNote} data-testid="weighin-pending">Awaiting a sourced reading: {pendingNames.join(", ")}</p>
            )}
            {boutGroups.map((group) => <BoutCard key={group.key} group={group} fighters={fighterMap} images={images} labels={labels} />)}
          </section>

          <aside className={styles.timeline} aria-label="Weigh-in timeline">
            <div className={styles.timelineHead}>
              <div><span>Source trail</span><h2>Timeline</h2></div>
              <b>{history.length}</b>
            </div>
            {history.length ? (
              <ol>
                {history.map((h) => (
                  <li key={h.id} data-kind={h.result}>
                    <span className={styles.tKind}>{historyKind(h)}</span>
                    <span className={styles.tLine}>{updateLine({ ...(h as unknown as WeighIn), fighter_name: h.fighter_name })}</span>
                    <span className={styles.tMeta}>
                      {clockTime(h.occurred_at) ?? "time not published"} ·{" "}
                      <a href={h.source_url} target="_blank" rel="noopener noreferrer nofollow">{h.source_name}</a>
                      {h.superseded_at && <em>{supersededNote(h)}</em>}
                    </span>
                  </li>
                ))}
              </ol>
            ) : <p className={styles.tEmpty}>No readings recorded yet.</p>}
          </aside>
        </div>
      ) : win.open && expectedCount > 0 ? (
        <Empty title="Waiting for verified scale readings">
          <p data-testid="weighin-waiting">{weighedCount} weighed / {expectedCount} expected. Readings appear here as soon as a verified source reports them — this page checks every {WEIGHIN_REVALIDATE} seconds, no refresh needed. No weight or contractual limit is ever guessed.</p>
          {pendingNames.length > 0 && <p className={styles.panelNote}>On the scale: {pendingNames.join(", ")}</p>}
        </Empty>
      ) : (
        <Empty title="Official weigh-in result not recorded yet">
          <p>No sourced scale readings are on file for this card yet. The desk stays empty rather than guessing a weight or contractual limit.</p>
        </Empty>
      )}

      <section className={styles.archive} aria-labelledby="recent-weighins-heading">
        <div className="eyebrow">21-day archive · official results</div>
        <h2 id="recent-weighins-heading">Recent official weigh-ins</h2>
        <p className={styles.panelNote}>Every covered card stays selectable after the next fight week begins.</p>
        {recentCovered.length ? (
          <div className={styles.archiveGrid}>
            {recentCovered.map((e) => (
              <Link key={e.event_id} href={`/weigh-ins?event=${encodeURIComponent(e.event_id)}`} className={styles.panel}>
                <div className={styles.panelHead}>
                  <h3>{e.event_name}</h3>
                  <span className={styles.eventNote}>{e.event_date ? fmtDate(e.event_date) : "date unavailable"}</span>
                </div>
                <div className={styles.panelCounts}>
                  <span className={styles.panelCount}><b>{e.weighed}</b><span>weighed</span></span>
                  <span className={styles.panelCount} data-tone="ok"><b>{e.made}</b><span>made</span></span>
                  <span className={styles.panelCount} data-tone={e.missed ? "alert" : undefined}><b>{e.missed}</b><span>missed</span></span>
                </div>
                <p className={styles.panelNote}>
                  {e.newest_source_published_at ? `Source timestamp · ${fmtDate(e.newest_source_published_at)}` : "Official source retained · publication time unavailable"}
                </p>
              </Link>
            ))}
          </div>
        ) : <p className={styles.tEmpty}>No official weigh-in cards are on file in the last 21 days.</p>}
      </section>

      <section className={styles.method}>
        <div className="eyebrow">Rules behind the numbers</div>
        <h2>How this desk works</h2>
        <div className={styles.methodGrid}>
          <p><strong>Official sources first.</strong> Promotion results, athletic commissions, then established reporting.</p>
          <p><strong>Class is not the limit.</strong> Title, non-title allowance and catchweight contracts remain distinct.</p>
          <p><strong>No scale-photo inference.</strong> If a source reports a miss without a number, the number stays empty.</p>
          <p><strong>Corrections stay visible.</strong> Revised readings append to the trail instead of overwriting history.</p>
        </div>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "UFC Official Weigh-In Results",
        url: `${SITE.url}/weigh-ins`,
        description: "Official UFC weigh-in results with contracted limits, misses, catchweights and corrections.",
        isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
        ...(desk?.eventName ? { about: { "@type": "SportsEvent", name: desk.eventName, startDate: desk.eventDate ?? undefined } } : {}),
      }} />
    </div>
  );
}