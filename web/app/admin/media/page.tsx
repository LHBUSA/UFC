/* Fighter portrait review queue.
 *
 * Lists in-scope fighters (ranked, next 3 cards, homepage featured, active
 * roster) that have no portrait cleared for high-visibility surfaces, highest
 * priority first, with every candidate's image, source, rights, attribution,
 * scores and identity evidence. Approve promotes a candidate into
 * ufc_fighter_media_assets; reject records a reason; quarantine blocks the
 * image for every fighter, permanently until lifted.
 *
 * Access: owner/admin session only. Anyone else gets a 404, and every action
 * re-checks the role server-side. noindex on every response. */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fighterSlug } from "@/lib/slug";
import { portraitFromAsset } from "@/lib/fighterMedia";
import { MediaAdminError, currentMediaReviewer, getReviewQueue, type CandidateRow, type QueueFighter, type QueueFilter } from "@/lib/fighterMediaAdmin";
import { quarantineAssetAction, refreshPublicPortraitsAction, reviewCandidateAction } from "./actions";
import s from "./media.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Portrait review",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

const FILTERS: Array<{ key: QueueFilter; label: string }> = [
  { key: "all", label: "All in scope" },
  { key: "ranked", label: "Ranked" },
  { key: "next_card", label: "Next card" },
  { key: "upcoming", label: "Next 3 cards" },
  { key: "featured", label: "Homepage featured" },
  { key: "active", label: "Active roster" },
  { key: "legacy", label: "Had a photo before" },
];

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(Number(v) * 100)}%`);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || "";

export default async function MediaReview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const reviewer = await currentMediaReviewer();
  if (!reviewer) notFound();
  const sp = await searchParams;
  const filter = (FILTERS.find((f) => f.key === one(sp.filter))?.key || "all") as QueueFilter;
  const withCandidatesOnly = one(sp.has) === "1";
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { filter, has: withCandidatesOnly ? "1" : undefined, page: String(page), ...over };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "" && !(k === "filter" && v === "all") && !(k === "page" && v === "1")) p.set(k, String(v));
    const str = p.toString();
    return `/admin/media${str ? `?${str}` : ""}`;
  };
  const returnTo = qs({});

  let queue: Awaited<ReturnType<typeof getReviewQueue>> | null = null;
  let loadError: string | null = null;
  try {
    queue = await getReviewQueue({ filter, page, withCandidatesOnly });
  } catch (e) {
    loadError = e instanceof MediaAdminError ? e.message : "The review queue could not be loaded.";
  }

  return (
    <div className={`wrap page ${s.page}`}>
      <div className={s.head}>
        <div>
          <div className="eyebrow">Internal · {reviewer}</div>
          <h1>Fighter portrait review</h1>
          <p className="faint sm">
            Only approved, identity-verified portraits reach public pages. High-visibility surfaces also need a commercial-use grant.
            When in doubt, reject or leave pending: the branded placeholder is always acceptable, a wrong face never is.
          </p>
        </div>
        <div className={s.headActions}>
          <Link href="/admin/media/coverage" className="btn">Coverage report</Link>
          <form action={refreshPublicPortraitsAction}>
            <input type="hidden" name="return_to" value={returnTo} />
            <button className="btn ghost" type="submit">Refresh public portrait cache</button>
          </form>
        </div>
      </div>

      {one(sp.done) && <div className={s.flashOk} role="status">Done: {one(sp.done)}</div>}
      {one(sp.error) && <div className={s.flashErr} role="alert">{one(sp.error)}</div>}

      <nav className={s.filters} aria-label="Queue filter">
        {FILTERS.map((f) => <Link key={f.key} href={qs({ filter: f.key, page: 1 })} aria-current={f.key === filter ? "true" : undefined}>{f.label}</Link>)}
        <Link href={qs({ has: withCandidatesOnly ? undefined : "1", page: 1 })} className={s.toggle}>{withCandidatesOnly ? "☑" : "☐"} with pending candidates only</Link>
      </nav>

      {loadError && <div className={s.flashErr} role="alert">{loadError}</div>}
      {queue && (
        <>
          <p className="faint sm">
            {queue.total.toLocaleString()} fighters without a high-visibility portrait in this view · page {queue.page} / {queue.pages}
            {queue.nextEvents.length ? <> · cards in scope: {queue.nextEvents.map((e) => e.name).join(" · ")}</> : null}
          </p>
          {queue.fighters.length === 0 && <p>Nothing to review in this view.</p>}
          {queue.fighters.map((q) => <FighterBlock key={q.fighter.id} q={q} returnTo={returnTo} />)}
          {queue.pages > 1 && (
            <nav className="pager" aria-label="Pagination">
              {queue.page > 1 && <Link className="btn" href={qs({ page: queue.page - 1 })}>← Previous</Link>}
              <span className="btn ghost mono">{queue.page} / {queue.pages}</span>
              {queue.page < queue.pages && <Link className="btn" href={qs({ page: queue.page + 1 })}>Next →</Link>}
            </nav>
          )}
        </>
      )}
    </div>
  );
}

function FighterBlock({ q, returnTo }: { q: QueueFighter; returnTo: string }) {
  const f = q.fighter;
  const pending = q.candidates.filter((c) => c.status === "pending");
  const decided = q.candidates.filter((c) => c.status !== "pending");
  return (
    <section className={s.fighter} id={f.id}>
      <header className={s.fighterHead}>
        <div>
          <h2><Link href={`/fighters/${fighterSlug(f)}`} target="_blank">{f.name}</Link>{f.nickname ? <span className="faint"> “{f.nickname}”</span> : null}</h2>
          <div className={s.meta}>
            <span>DOB {f.dob || "unknown"}</span>
            <span>{f.record_w ?? "?"}-{f.record_l ?? "?"}-{f.record_d ?? 0}</span>
            {f.espn_athlete_id && <a href={`https://www.espn.com/mma/fighter/_/id/${f.espn_athlete_id}`} target="_blank" rel="noopener nofollow">ESPN {f.espn_athlete_id}</a>}
            {f.ufcstats_id && <a href={`http://ufcstats.com/fighter-details/${f.ufcstats_id}`} target="_blank" rel="noopener nofollow">UFC Stats</a>}
            <span className="mono">{f.id}</span>
          </div>
        </div>
        <div className={s.chips}>
          <span className={s.priority}>priority {q.priority}</span>
          {q.reasons.map((r) => <span key={r} className={s.chip}>{r.replace(/_/g, " ")}</span>)}
          <span className={q.state === "standard_only" ? s.stateWarn : s.stateMissing}>{q.state === "standard_only" ? "standard surfaces only" : "no approved portrait"}</span>
        </div>
      </header>

      {q.current && (
        <div className={s.current}>
          <img src={portraitFromAsset(q.current).thumb} alt="" referrerPolicy="no-referrer" loading="lazy" />
          <div>
            <b>Current approved portrait</b> ({q.current.source_name}, {q.current.license_label || q.current.license_type}, {q.current.commercial_use_allowed ? "commercial" : "no commercial grant"}, {q.current.surface_policy})
            <form action={quarantineAssetAction} className={s.inline}>
              <input type="hidden" name="asset_id" value={q.current.id} />
              <input type="hidden" name="fighter_id" value={f.id} />
              <input type="hidden" name="return_to" value={returnTo} />
              <input name="reason" placeholder="Reason (required)" required maxLength={500} />
              <button type="submit" className={s.danger}>Quarantine current</button>
            </form>
          </div>
        </div>
      )}

      {pending.length === 0 && <p className="faint sm">No pending candidates. Run <code>node scripts/media/fighter_portrait_queue.mjs --apply</code> or source one manually.</p>}
      <div className={s.grid}>
        {pending.map((c) => <CandidateCard key={c.id} c={c} fighterName={f.name} returnTo={returnTo} />)}
      </div>
      {decided.length > 0 && (
        <details className={s.decided}>
          <summary>{decided.length} decided candidate{decided.length === 1 ? "" : "s"}</summary>
          <ul>{decided.map((c) => <li key={c.id}><b>{c.status}</b> · {c.source_name} · <a href={c.source_url} target="_blank" rel="noopener nofollow">source</a> · {c.review_reason || "—"} · {c.reviewed_by || ""}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

function EvidenceSummary({ e }: { e: Record<string, unknown> }) {
  const bits: string[] = [];
  if (e.method) bits.push(`method ${e.method}`);
  if (e.dob_match === true) bits.push("DOB match");
  if (e.dob_match === false) bits.push("DOB MISMATCH");
  if (Array.isArray(e.name_match) && e.name_match.length) bits.push(`name in ${(e.name_match as string[]).join("/")}`);
  if (e.athlete_id_match === true) bits.push("ESPN id match");
  if (e.name_exact === true) bits.push("exact name");
  if (e.name_exact === false) bits.push("NAME MISMATCH");
  if (e.headshot_alt_match === false) bits.push("headshot alt mismatch");
  if (typeof e.wikidata_qid === "string") bits.push(e.wikidata_qid);
  return <span>{bits.length ? bits.join(" · ") : <b className={s.bad}>no recorded identity evidence</b>}</span>;
}

function CandidateCard({ c, fighterName, returnTo }: { c: CandidateRow; fighterName: string; returnTo: string }) {
  const conf = Number(c.identity_confidence);
  const qid = typeof c.identity_evidence?.wikidata_qid === "string" ? c.identity_evidence.wikidata_qid : null;
  return (
    <article className={s.card}>
      <a href={c.image_url} target="_blank" rel="noopener nofollow noreferrer" className={s.thumb}>
        <img src={c.thumbnail_url || c.image_url} alt={`Candidate portrait for ${fighterName}`} referrerPolicy="no-referrer" loading="lazy" />
      </a>
      <dl className={s.facts}>
        <dt>Source</dt><dd><a href={c.source_url} target="_blank" rel="noopener nofollow">{c.source_name}</a> <span className="faint">({c.source_type}, {c.discovered_by})</span></dd>
        <dt>Rights</dt><dd>{c.license_label || c.license_type} · {c.commercial_use_allowed ? <b className={s.good}>commercial</b> : <b className={s.bad}>no commercial grant</b>} · {c.derivative_use_allowed ? "derivatives ok" : "no derivatives"} · surfaces: {c.proposed_surface_policy}</dd>
        <dt>Attribution</dt><dd>{c.attribution_required ? (c.attribution_text || <b className={s.bad}>required, missing</b>) : "not required"}{!c.attribution_required && c.attribution_text ? ` (${c.attribution_text})` : ""}</dd>
        <dt>Scores</dt><dd>identity <b className={conf >= 0.85 ? s.good : conf >= 0.6 ? s.warn : s.bad}>{pct(conf)}</b> · suitability {c.suitability_score ?? "—"} · priority {c.priority_score}{c.width && c.height ? ` · ${c.width}×${c.height}` : ""}</dd>
        <dt>Identity</dt><dd><EvidenceSummary e={c.identity_evidence || {}} />{qid ? <> · <a href={`https://www.wikidata.org/wiki/${qid}`} target="_blank" rel="noopener nofollow">Wikidata</a></> : null}</dd>
        {c.flags?.length ? <><dt>Flags</dt><dd className={s.warn}>{c.flags.join(", ")}</dd></> : null}
      </dl>
      <details className={s.evidence}><summary>Identity evidence (raw)</summary><pre>{JSON.stringify(c.identity_evidence, null, 2)}</pre></details>

      <form action={reviewCandidateAction} className={s.approve}>
        <input type="hidden" name="candidate_id" value={c.id} />
        <input type="hidden" name="fighter_id" value={c.fighter_id} />
        <input type="hidden" name="action" value="approve" />
        <input type="hidden" name="return_to" value={returnTo} />
        <label><input type="checkbox" name="confirm_identity" value="yes" required /> I checked the face: this is {fighterName}</label>
        <label><input type="checkbox" name="make_primary" value="no" /> keep the current primary</label>
        <input name="reason" placeholder="Note (optional)" maxLength={500} />
        <button type="submit" className={s.ok}>Approve</button>
      </form>
      <form action={reviewCandidateAction} className={s.decline}>
        <input type="hidden" name="candidate_id" value={c.id} />
        <input type="hidden" name="fighter_id" value={c.fighter_id} />
        <input type="hidden" name="return_to" value={returnTo} />
        <input name="reason" placeholder="Reason (required)" required maxLength={500} />
        <button type="submit" name="action" value="reject">Reject</button>
        <button type="submit" name="action" value="quarantine" className={s.danger} title="Blocks this image for every fighter">Quarantine</button>
      </form>
    </article>
  );
}
