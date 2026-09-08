import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, Empty, JsonLd, Portrait } from "@/components/ui";
import {
  getStatusEvents, STATUS_LABEL, SOURCE_KIND_LABEL, UNAVAILABLE,
  diagnosisLine, hasDiagnosis, statusHeadline, fighterRef,
  type StatusEvent, type StatusState,
} from "@/lib/status";
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
  },
  twitter: { card: "summary_large_image", title: "UFC Injuries & Withdrawals — PropBetEdge" },
};

const VIEWS = [
  { key: "active", label: "Active", hint: "Current, as far as our sources say" },
  { key: "resolved", label: "Resolved", hint: "Ended by a later sourced update" },
  { key: "all", label: "All", hint: "Everything on file, including expired" },
] as const;

function factValue(value: string | null | undefined) {
  return value && value !== "—" ? value : "Not on file";
}

function FighterFacts({ fighter, event }: { fighter: Fighter | null; event: StatusEvent }) {
  const record = fighter ? fmtRecord(fighter) : fmtRecord(event);
  return (
    <div className={styles.facts} aria-label={`${event.fighter_name} profile details`}>
      <div className={styles.fact}><span>Record</span><b>{factValue(record)}</b></div>
      <div className={styles.fact}><span>Height</span><b>{factValue(fighter ? fmtHeight(fighter.height_in) : null)}</b></div>
      <div className={styles.fact}><span>Reach</span><b>{factValue(fighter ? fmtReach(fighter.reach_in) : null)}</b></div>
      <div className={styles.fact}><span>Stance</span><b>{factValue(fighter ? stanceLabel(fighter.stance) : null)}</b></div>
    </div>
  );
}

function StatusRow({ e, fighter, img }: { e: StatusEvent; fighter: Fighter | null; img?: PortraitSet | null }) {
  const unavailable = UNAVAILABLE.has(e.status_type) && e.state === "active";
  const href = `/fighters/${fighterSlug(fighter || fighterRef(e))}`;
  const visualFighter = fighter || { name: e.fighter_name };
  return (
    <article className={styles.row} data-state={e.state} data-type={e.status_type}>
      <div className={styles.visual}>
        <Link href={href} aria-label={`${e.fighter_name} fighter profile`}>
          <Portrait f={visualFighter} img={img} sizes="(max-width: 720px) 92px, 118px" className={styles.fighterPortrait} />
        </Link>
        {fighter?.nickname && <span className={styles.nickname}>“{fighter.nickname}”</span>}
      </div>

      <div className={styles.rowMain}>
        <div className={styles.badges}>
          <span className={styles.type} data-type={e.status_type}>{STATUS_LABEL[e.status_type]}</span>
          {e.state !== "active" && <span className={styles.state}>{e.state === "resolved" ? "Resolved" : "Expired"}</span>}
          {e.source_kind === "official" && <span className={styles.official}>Official</span>}
          {unavailable && <span className={styles.flag}>Unavailable</span>}
        </div>

        <h3><Link href={href}>{e.fighter_name}</Link></h3>
        <FighterFacts fighter={fighter} event={e} />
        <p className={styles.headline}>{statusHeadline(e)}</p>
        {e.status_detail && e.status_detail !== statusHeadline(e) && (
          <p className={styles.detail}>{e.status_detail}</p>
        )}

        {(e.status_type === "injury" || e.status_type === "illness" || e.status_type === "withdrawal") && (
          <p className={hasDiagnosis(e) ? styles.diagnosis : styles.noDiagnosis}>
            {diagnosisLine(e)}
          </p>
        )}
        {hasDiagnosis(e) && e.clinical_quote && (
          <blockquote className={styles.quote}>{e.clinical_quote}</blockquote>
        )}

        <div className={styles.relationships}>
          {e.replacement_fighter_name && <span>Replaced by <strong>{e.replacement_fighter_name}</strong></span>}
          {e.replaced_fighter_name && <span>Stepping in for <strong>{e.replaced_fighter_name}</strong></span>}
          {e.expected_return_note && <span>Expected back <strong>{e.expected_return_note}</strong></span>}
        </div>
      </div>

      <div className={styles.rowMeta}>
        <div className={styles.metaLabel}>Status receipt</div>
        {e.event_name && e.event_id && (
          <Link className={styles.event} href={`/events/${eventSlug({ name: e.event_name, event_date: e.event_date })}`}>
            {e.event_name}
          </Link>
        )}
        {e.event_date && <span className={styles.date}>Card · {fmtDate(e.event_date)}</span>}
        <div className={styles.metaRule} />
        <span className={styles.when}>Reported · {fmtDate(e.occurred_at)}</span>
        {e.source_published_at && <span className={styles.detected}>Publisher timestamp · {fmtDate(e.source_published_at)}</span>}
        <a className={styles.source} href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">
          {SOURCE_KIND_LABEL[e.source_kind]} · {e.source_name} ↗
        </a>
        <span className={styles.confidence}>Source confidence · {Math.round(Number(e.confidence || 0) * 100)}%</span>
      </div>
    </article>
  );
}

export default async function InjuriesPage({ searchParams }: { searchParams: Promise<{ view?: string; type?: string }> }) {
  const sp = await searchParams;
  const view = (VIEWS.find((v) => v.key === sp.view)?.key ?? "active") as StatusState | "all";
  const rows = await getStatusEvents({ state: view, limit: 200 });
  const fighterIds = [...new Set(rows.map((r) => r.fighter_id).filter(Boolean))];
  const [fighters, images] = await Promise.all([
    getFightersByIds(fighterIds).catch(() => []),
    getImagesForFighters(fighterIds).catch(() => new Map<string, PortraitSet>()),
  ]);
  const fighterMap = new Map(fighters.map((f) => [f.id, f]));

  const active = rows.filter((r) => r.state === "active");
  const unavailable = active.filter((r) => UNAVAILABLE.has(r.status_type)).length;
  const named = rows.filter((r) => hasDiagnosis(r)).length;
  const unnamed = rows.filter(
    (r) => ["injury", "illness", "withdrawal"].includes(r.status_type) && !hasDiagnosis(r),
  ).length;

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Injuries & Withdrawals" }]} />

      <section className={styles.hero}>
        <div>
          <div className="eyebrow">Availability intelligence · source-backed, fighter by fighter</div>
          <h1>Injuries &amp; Withdrawals</h1>
          <p>
            A readable availability board instead of a rumor feed. Every fighter gets identity, profile context,
            current status, card linkage and a direct source receipt.
          </p>
          <p className={styles.rule}>
            <strong>No inferred diagnosis.</strong> If a source says a fighter is injured but does not name the
            injury, the page says exactly that. Named injuries only appear beside the sourced language that supports them.
          </p>
          <nav className={styles.filters} aria-label="Filter by state">
            {VIEWS.map((v) => (
              <Link
                key={v.key}
                href={v.key === "active" ? "/injuries" : `/injuries?view=${v.key}`}
                className={view === v.key ? styles.on : undefined}
                aria-current={view === v.key ? "page" : undefined}
                title={v.hint}
              >
                {v.label}
              </Link>
            ))}
          </nav>
        </div>
        <aside className={styles.heroAside}>
          <div><b>{active.length.toLocaleString()}</b><span>active status events</span></div>
          <div><b>{unavailable.toLocaleString()}</b><span>fighters unavailable</span></div>
          <div><b>{named.toLocaleString()}</b><span>named + quoted injuries</span></div>
          <div><b>{unnamed.toLocaleString()}</b><span>diagnosis not stated</span></div>
        </aside>
      </section>

      {rows.length ? (
        <section className={styles.list} aria-label="Fighter status events">
          {rows.map((e) => (
            <StatusRow key={e.id} e={e} fighter={fighterMap.get(e.fighter_id) || null} img={images.get(e.fighter_id)} />
          ))}
        </section>
      ) : (
        <Empty title="No status events on file yet">
          <p>
            No sourced availability changes match this view. When a verified change lands, it appears here with the
            fighter identity and the source that reported it.
          </p>
        </Empty>
      )}

      <section className={styles.method} id="methodology">
        <div className="eyebrow">Methodology · provenance over volume</div>
        <h2>How this tracker earns trust</h2>
        <div className={styles.methodGrid}>
          <p><strong>One sourced change per row.</strong> Publisher, timestamp, card context and the original link stay attached.</p>
          <p><strong>Official surfaces outrank reporting.</strong> Promotion and commission updates can replace an earlier report without erasing history.</p>
          <p><strong>Medical detail is quote-gated.</strong> No body part or diagnosis is filled from inference, imagery or commentary.</p>
          <p><strong>Resolved stays visible.</strong> Returns, reversals and replacements remain part of the audit trail instead of disappearing.</p>
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