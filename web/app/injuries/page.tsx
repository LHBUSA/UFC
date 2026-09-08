import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, Empty, JsonLd } from "@/components/ui";
import {
  getStatusEvents, STATUS_LABEL, SOURCE_KIND_LABEL, UNAVAILABLE,
  diagnosisLine, hasDiagnosis, statusHeadline, fighterRef,
  type StatusEvent, type StatusState,
} from "@/lib/status";
import { fighterSlug, eventSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
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

function StatusRow({ e }: { e: StatusEvent }) {
  const unavailable = UNAVAILABLE.has(e.status_type) && e.state === "active";
  return (
    <article className={styles.row} data-state={e.state} data-type={e.status_type}>
      <div className={styles.rowMain}>
        <div className={styles.badges}>
          <span className={styles.type} data-type={e.status_type}>{STATUS_LABEL[e.status_type]}</span>
          {e.state !== "active" && <span className={styles.state}>{e.state === "resolved" ? "Resolved" : "Expired"}</span>}
          {e.source_kind === "official" && <span className={styles.official}>Official</span>}
        </div>

        <h3>
          <Link href={`/fighters/${fighterSlug(fighterRef(e))}`}>{e.fighter_name}</Link>
        </h3>
        <p className={styles.headline}>{statusHeadline(e)}</p>

        {/* The diagnosis line is deliberately a sentence and not a blank. A
            reader must be able to tell "we know it is a torn ACL" from "nobody
            has said what it is" — those are different states of knowledge, and
            only one of them is a claim we are making. */}
        {(e.status_type === "injury" || e.status_type === "illness" || e.status_type === "withdrawal") && (
          <p className={hasDiagnosis(e) ? styles.diagnosis : styles.noDiagnosis}>
            {diagnosisLine(e)}
          </p>
        )}
        {hasDiagnosis(e) && e.clinical_quote && (
          <blockquote className={styles.quote}>{e.clinical_quote}</blockquote>
        )}

        {e.replacement_fighter_name && (
          <p className={styles.rel}>Replaced by {e.replacement_fighter_name}</p>
        )}
        {e.replaced_fighter_name && (
          <p className={styles.rel}>Stepping in for {e.replaced_fighter_name}</p>
        )}
        {e.expected_return_note && <p className={styles.rel}>Expected back: {e.expected_return_note}</p>}
      </div>

      <div className={styles.rowMeta}>
        {e.event_name && e.event_id && (
          <Link className={styles.event} href={`/events/${eventSlug({ name: e.event_name, event_date: e.event_date })}`}>
            {e.event_name}
          </Link>
        )}
        {e.event_date && <span className={styles.date}>Card · {fmtDate(e.event_date)}</span>}
        <span className={styles.when}>Reported · {fmtDate(e.occurred_at)}</span>
        <a className={styles.source} href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">
          {SOURCE_KIND_LABEL[e.source_kind]} · {e.source_name} ↗
        </a>
        {unavailable && <span className={styles.flag}>Unavailable</span>}
      </div>
    </article>
  );
}

export default async function InjuriesPage({ searchParams }: { searchParams: Promise<{ view?: string; type?: string }> }) {
  const sp = await searchParams;
  const view = (VIEWS.find((v) => v.key === sp.view)?.key ?? "active") as StatusState | "all";
  const rows = await getStatusEvents({ state: view, limit: 200 });

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
          <div className="eyebrow">Availability · who is out, and what is actually known</div>
          <h1>Injuries &amp; Withdrawals</h1>
          <p>
            Structured fighter status: injuries, illnesses, withdrawals, replacements, suspensions, visa and travel
            issues, missed weight and returns. Each row is one sourced change, linked to the article or official
            update that reported it.
          </p>
          <p className={styles.rule}>
            <strong>This tracker never infers a diagnosis.</strong> When a report says a fighter is out with an
            injury but does not say what the injury is, that is what you will read here. A named injury appears only
            with the sentence that stated it. A guessed body part attached to a real athlete would be a medical claim
            we invented, and no amount of page polish is worth one.
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
          <b>{active.length.toLocaleString()}</b><span>active status events</span>
          <b style={{ marginTop: 16 }}>{unavailable.toLocaleString()}</b><span>fighters currently unavailable</span>
          <b style={{ marginTop: 16 }}>{named.toLocaleString()}</b><span>with a named, quoted injury</span>
          <b style={{ marginTop: 16 }}>{unnamed.toLocaleString()}</b><span>where no diagnosis was stated</span>
        </aside>
      </section>

      {rows.length ? (
        <section className={styles.list} aria-label="Fighter status events">
          {rows.map((e) => <StatusRow key={e.id} e={e} />)}
        </section>
      ) : (
        <Empty title="No status events on file yet">
          <p>
            The fighter-status tables are defined but not yet populated in this environment. Availability changes
            appear here as soon as the collector runs — and only ever with the source that reported them.
          </p>
        </Empty>
      )}

      <section className={styles.method} id="methodology">
        <h2>How this is built</h2>
        <ul>
          <li><strong>Sourced, one row per change.</strong> Every event carries the article URL, the publisher, when they published and when we detected it.</li>
          <li><strong>Official surfaces outrank the wire.</strong> When UFC.com amends its own card that is the promotion changing a fact, not a report about it, and it is labelled <em>Official</em>.</li>
          <li><strong>No inferred diagnosis, ever.</strong> <code>injury_type</code> stays empty unless a source names the injury in words, and the sentence that named it is stored beside the claim.</li>
          <li><strong>Attribution beats coverage.</strong> When a headline mentions several fighters and it is not clear which one the change is about, nothing is recorded — a healthy fighter shown as injured is a worse error than a missing row.</li>
          <li><strong>Resolved is kept.</strong> A withdrawal that was later reversed stays readable as history; it just stops counting as current.</li>
        </ul>
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
