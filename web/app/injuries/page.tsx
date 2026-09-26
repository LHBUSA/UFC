import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, Empty, JsonLd, Portrait } from "@/components/ui";
import {
  getStatusEvents, STATUS_LABEL, SOURCE_KIND_LABEL,
  diagnosisLine, hasDiagnosis, statusHeadline, fighterRef,
  type StatusEvent, type StatusState,
} from "@/lib/status";
import {
  groupStatusEvents, filterEpisodes, sortEpisodes, summarizeEpisodes,
  parseTypeFilter, episodeStateLabel, TYPE_FILTERS,
  type AvailabilityEpisode, type TypeFilterKey,
} from "@/lib/status-groups";
import {
  getFightersByIds, getImagesForFighters,
  type Fighter, type PortraitSet,
} from "@/lib/db";
import { fighterSlug, eventSlug } from "@/lib/slug";
import { fmtDate, fmtHeight, fmtReach, fmtRecord, stanceLabel } from "@/lib/format";
import { SITE } from "@/lib/site";
import styles from "./injuries.module.css";

export const revalidate = 120;

export const metadata: Metadata = {
  title: "UFC Injuries & Withdrawals — Fighter Status Tracker",
  description:
    "Structured UFC fighter availability: injuries, withdrawals, replacements, suspensions, visa issues and weight misses, each linked to the source that reported it. Where a source does not name an injury, this tracker says so rather than guessing.",
  alternates: { canonical: "/injuries" },
  openGraph: {
    title: "UFC Injuries & Withdrawals — PropBetEdge",
    description: "Every sourced fighter availability change, active and resolved.",
    url: `${SITE.url}/injuries`,
    images: [`${SITE.url}/opengraph-image`],
  },
  twitter: { card: "summary_large_image", site: SITE.twitter, title: "UFC Injuries & Withdrawals — PropBetEdge", images: [`${SITE.url}/opengraph-image`] },
};

const VIEWS = [
  { key: "active", label: "Active", hint: "Current, as far as our sources say" },
  { key: "resolved", label: "Resolved", hint: "Ended by a later sourced update" },
  { key: "all", label: "All", hint: "Everything on file, including expired" },
] as const;

type View = StatusState | "all";

const SHORT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const MEDICAL = new Set(["injury", "illness", "withdrawal"]);

function boardHref(view: View, type: TypeFilterKey) {
  const q = new URLSearchParams();
  if (view !== "active") q.set("view", view);
  if (type !== "all") q.set("type", type);
  const s = q.toString();
  return s ? `/injuries?${s}` : "/injuries";
}

/** Only what is on file. An absent reach is left out, not rendered as a cell. */
function profileLine(fighter: Fighter | null, e: StatusEvent): string[] {
  const clean = (v: string | null | undefined) => (v && v !== "—" ? v : null);
  return [
    clean(fighter ? fmtRecord(fighter) : fmtRecord(e)),
    clean(fighter ? fmtHeight(fighter.height_in) : null),
    fighter && clean(fmtReach(fighter.reach_in)) ? `${fmtReach(fighter.reach_in)} reach` : null,
    clean(fighter ? stanceLabel(fighter.stance) : null),
  ].filter((v): v is string => Boolean(v));
}

/** One source receipt, exactly as that source reported it. */
function Receipt({ r }: { r: StatusEvent }) {
  const clinical = r.injury_type || r.body_part;
  const publisherDay = r.source_published_at?.slice(0, 10);
  return (
    <li className={styles.receipt}>
      <div className={styles.receiptHead}>
        <a className={styles.receiptLink} href={r.source_url} target="_blank" rel="noopener noreferrer nofollow">
          {r.source_name} <span aria-hidden="true">↗</span>
        </a>
        {r.source_kind === "official" && <span className={styles.official}>Official</span>}
        <span className={styles.type} data-type={r.status_type}>{STATUS_LABEL[r.status_type]}</span>
      </div>
      <div className={styles.receiptMeta}>
        <span>{SOURCE_KIND_LABEL[r.source_kind]}</span>
        <span>{fmtDate(r.occurred_at, SHORT)}</span>
        {publisherDay && publisherDay !== r.occurred_at?.slice(0, 10) && <span>Published {fmtDate(publisherDay, SHORT)}</span>}
        <span>Confidence {Math.round(Number(r.confidence || 0) * 100)}%</span>
      </div>
      {r.status_detail && r.status_detail !== r.clinical_quote && <p className={styles.receiptDetail}>{r.status_detail}</p>}
      {/* A clinical value and its quote render only on the receipt that made them. */}
      {clinical && <p className={styles.receiptClinical}>{diagnosisLine(r)}</p>}
      {clinical && r.clinical_quote && <blockquote className={styles.quote}>{r.clinical_quote}</blockquote>}
    </li>
  );
}

function EpisodeCard({ ep, fighter, img }: { ep: AvailabilityEpisode; fighter: Fighter | null; img?: PortraitSet | null }) {
  const p = ep.primary;
  const href = `/fighters/${fighterSlug(fighter || fighterRef(p))}`;
  const profile = profileLine(fighter, p);
  const tone = ep.state !== "active" ? "closed" : ep.unavailable ? "out" : ep.kind === "resolution" ? "clear" : "change";
  const n = ep.receipts.length;
  const c = ep.clinical;
  const eventHref = ep.event_id && ep.event_name
    ? `/events/${eventSlug({ name: ep.event_name, event_date: ep.event_date })}`
    : null;

  return (
    <article className={styles.card} data-tone={tone} data-type={ep.primaryType}>
      <Link className={styles.cardPhoto} href={href} aria-label={`${ep.fighter_name} fighter profile`}>
        <Portrait f={fighter || { name: ep.fighter_name }} img={img} sizes="(max-width: 680px) 64px, 92px" className={styles.cardPortrait} />
      </Link>

      <div className={styles.cardMain}>
        <div className={styles.badges}>
          <span className={styles.stateTag} data-tone={tone}>{episodeStateLabel(ep)}</span>
          {ep.types.map((t) => (
            <span key={t} className={styles.type} data-type={t}>{STATUS_LABEL[t]}</span>
          ))}
          {ep.hasOfficial && <span className={styles.official}>Official</span>}
        </div>

        <h3 className={styles.cardName}>
          <Link href={href}>{ep.fighter_name}</Link>
          {fighter?.nickname && <span className={styles.nick}>“{fighter.nickname}”</span>}
        </h3>
        {profile.length > 0 && <p className={styles.profile}>{profile.join(" · ")}</p>}

        <p className={styles.headline}>{statusHeadline(p)}</p>
        {/* A detail line on a receipt that carries clinical fields can restate them,
          * so the card leaves medical wording to the gated line below. The receipt
          * itself still shows it, under Sources. */}
        {p.status_detail && p.status_detail !== statusHeadline(p) && !p.injury_type && !p.body_part && (
          <p className={styles.detail}>{p.status_detail}</p>
        )}

        {MEDICAL.has(ep.primaryType) && (
          <>
            <p className={c.status === "stated" && c.diagnosed ? styles.diagnosis : styles.noDiagnosis}>{c.line}</p>
            {c.status === "stated" && hasDiagnosis(c.receipt) && c.receipt.clinical_quote && (
              <blockquote className={styles.quote}>
                {c.receipt.clinical_quote}
                <cite>{c.receipt.source_name}</cite>
              </blockquote>
            )}
          </>
        )}

        {(ep.replacement_fighter_name || ep.replaced_fighter_name || ep.expected_return_note) && (
          <div className={styles.relationships}>
            {ep.replacement_fighter_name && <span>Replaced by <strong>{ep.replacement_fighter_name}</strong></span>}
            {ep.replaced_fighter_name && <span>Stepping in for <strong>{ep.replaced_fighter_name}</strong></span>}
            {ep.expected_return_note && <span>Expected back <strong>{ep.expected_return_note}</strong></span>}
          </div>
        )}
      </div>

      <dl className={styles.context}>
        <div>
          <dt>Card</dt>
          <dd>
            {ep.event_name
              ? eventHref ? <Link className={styles.event} href={eventHref}>{ep.event_name}</Link> : <span className={styles.event}>{ep.event_name}</span>
              : <span className={styles.muted}>No card attached by the source</span>}
            {ep.event_date && <span className={styles.sub}>{fmtDate(ep.event_date)}</span>}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{fmtDate(ep.updatedAt, SHORT)}<span className={styles.sub}>{n} source receipt{n === 1 ? "" : "s"}</span></dd>
        </div>
        <div>
          <dt>Lead source</dt>
          <dd>
            <a className={styles.source} href={p.source_url} target="_blank" rel="noopener noreferrer nofollow">
              {p.source_name} <span aria-hidden="true">↗</span>
            </a>
            <span className={styles.sub}>{SOURCE_KIND_LABEL[p.source_kind]} · {Math.round(Number(p.confidence || 0) * 100)}%</span>
          </dd>
        </div>
      </dl>

      <details className={styles.sources}>
        <summary>
          <span>Sources ({n})</span>
          <span className={styles.sourcesHint}>{[...new Set(ep.receipts.map((r) => r.source_name))].join(" · ")}</span>
        </summary>
        <ul className={styles.receipts}>
          {ep.receipts.map((r) => <Receipt key={r.id} r={r} />)}
        </ul>
      </details>
    </article>
  );
}

export default async function InjuriesPage({ searchParams }: { searchParams: Promise<{ view?: string; type?: string }> }) {
  const sp = await searchParams;
  const view = (VIEWS.find((v) => v.key === sp.view)?.key ?? "active") as View;
  const type = parseTypeFilter(sp.type);

  /* Receipts in, episodes out. Rows are never altered: grouping only decides
   * which card a receipt is listed under. See lib/status-groups.ts. */
  const rows = await getStatusEvents({ state: view, limit: 200 });
  const allEpisodes = groupStatusEvents(rows);
  const episodes = sortEpisodes(filterEpisodes(allEpisodes, type), view);
  const summary = summarizeEpisodes(episodes);

  const fighterIds = [...new Set(episodes.map((ep) => ep.fighter_id).filter(Boolean))];
  const [fighters, images] = await Promise.all([
    getFightersByIds(fighterIds).catch(() => []),
    getImagesForFighters(fighterIds).catch(() => new Map<string, PortraitSet>()),
  ]);
  const fighterMap = new Map(fighters.map((f) => [f.id, f]));

  const viewLabel = VIEWS.find((v) => v.key === view)!.label.toLowerCase();
  const typeLabel = TYPE_FILTERS.find((f) => f.key === type)!.label;

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Injuries & Withdrawals" }]} />

      <section className={styles.hero}>
        <div>
          <div className="eyebrow">Availability intelligence · source-backed, fighter by fighter</div>
          <h1>Injuries &amp; Withdrawals</h1>
          <p>
            One card per availability episode, not one per headline. When six outlets report the same withdrawal,
            you see the fighter once — and every one of those six receipts stays a click away.
          </p>
          <p className={styles.rule}>
            <strong>No inferred diagnosis.</strong> If a source says a fighter is injured but does not name the
            injury, the page says exactly that. Named injuries only appear beside the sourced language that supports them.
          </p>
        </div>
        <aside className={styles.heroAside} aria-label={`Board totals, ${viewLabel} view`}>
          <div><b>{summary.fighters.toLocaleString()}</b><span>{view === "active" ? "current fighters" : `fighters · ${viewLabel}`}</span></div>
          <div><b>{summary.unavailableFighters.toLocaleString()}</b><span>unavailable now</span></div>
          <div><b>{summary.verifiedDiagnoses.toLocaleString()}</b><span>verified diagnoses</span></div>
          <div><b>{summary.receipts.toLocaleString()}</b><span>source receipts</span></div>
        </aside>
      </section>

      <div className={styles.controls}>
        <nav className={styles.filters} aria-label="Filter by state">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={boardHref(v.key, type)}
              className={view === v.key ? styles.on : undefined}
              aria-current={view === v.key ? "page" : undefined}
              title={v.hint}
            >
              {v.label}
            </Link>
          ))}
        </nav>
        <nav className={`${styles.filters} ${styles.typeFilters}`} aria-label="Filter by type">
          {TYPE_FILTERS.map((f) => {
            const count = filterEpisodes(allEpisodes, f.key).length;
            return (
              <Link
                key={f.key}
                href={boardHref(view, f.key)}
                className={type === f.key ? styles.on : undefined}
                aria-current={type === f.key ? "true" : undefined}
                data-empty={count === 0 ? "true" : undefined}
              >
                {f.label} <span className={styles.count}>{count}</span>
              </Link>
            );
          })}
        </nav>
        <p className={styles.tally} role="status">
          {summary.episodes.toLocaleString()} episode{summary.episodes === 1 ? "" : "s"} · {summary.fighters.toLocaleString()} fighter{summary.fighters === 1 ? "" : "s"} · {summary.receipts.toLocaleString()} receipt{summary.receipts === 1 ? "" : "s"}
          {type !== "all" && <> · filtered to {typeLabel.toLowerCase()}</>}
        </p>
      </div>

      {episodes.length ? (
        <section className={styles.board} aria-label="Fighter availability episodes">
          {episodes.map((ep) => (
            <EpisodeCard key={ep.key} ep={ep} fighter={fighterMap.get(ep.fighter_id) || null} img={images.get(ep.fighter_id)} />
          ))}
        </section>
      ) : (
        /* Empty wraps its children in a <p>; passing a <p> nests them, which the
         * parser un-nests and React then reports as hydration error #418. */
        <Empty
          title={type === "all" ? "No availability episodes on file yet" : `No ${typeLabel.toLowerCase()} in this view`}
          cta={type !== "all" ? { href: boardHref(view, "all"), label: "Show all types" } : undefined}
        >
          No sourced availability changes match this view. When a verified change lands, it appears here with the
          fighter identity and every source that reported it.
        </Empty>
      )}

      <section className={styles.method} id="methodology">
        <div className="eyebrow">Methodology · provenance over volume</div>
        <h2>How this tracker earns trust</h2>
        <div className={styles.methodGrid}>
          <p><strong>One availability episode, every receipt retained.</strong> Corroborating reports of the same event are consolidated into one card for readability. Nothing is deleted: each publisher, timestamp, confidence score and original link stays inspectable under Sources.</p>
          <p><strong>Conservative grouping.</strong> Reports merge only for the same fighter and the same card, or the same condition reported in the same stretch of days. A suspension, a visa issue and a missed weight are never folded into an injury.</p>
          <p><strong>Official surfaces outrank reporting.</strong> The lead source is chosen in a fixed order — official UFC, athletic commission, desk correction, then reporting — and then by confidence and recency. A confirmed withdrawal leads over the injury report behind it.</p>
          <p><strong>Medical detail is quote-gated.</strong> No body part or diagnosis is filled from inference, imagery or commentary, and fragments from different reports are never stitched into a stronger claim. If sources disagree, no diagnosis is shown.</p>
          <p><strong>Resolved stays visible.</strong> Returns, reversals and replacements remain part of the audit trail instead of disappearing.</p>
          <p><strong>Counts mean people.</strong> The totals above count fighters and episodes. Source receipts are counted separately, so seventeen reports never read as seventeen injured fighters.</p>
        </div>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "UFC Injuries & Withdrawals",
        url: `${SITE.url}/injuries`,
        description: "Sourced UFC fighter availability events: injuries, withdrawals, replacements, suspensions and returns.",
        isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
      }} />
    </div>
  );
}
