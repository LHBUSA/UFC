/* Editorial input digest: the one fact that decides whether the premium desk
 * may spend a model call on an article.
 *
 * OWNER RULE (2026-09-29, Newsroom V4): premium prose is bought ONCE per
 * genuinely new editorial input. The input is what the model would see -- the
 * reader-visible fact block plus the deterministic draft -- and nothing else.
 * So:
 *
 *   new digest, never decided        -> ONE automatic call
 *   same digest, already passed      -> 0 calls
 *   same digest, previously held     -> 0 calls (no automatic retry)
 *   materially changed facts         -> new digest -> ONE new call
 *   explicit admin re-edit (force)   -> may call again, deliberately
 *   legacy row's first digest        -> 0 calls (recorded 'legacy_baseline':
 *                                       legacy upgrade / generator change)
 *
 * Before this, eligibility was "model_version lacks the desk stamp", and the
 * writer reset the stamp on every fact-hash refresh while a held attempt left
 * no trace -- so the same article was re-bought, or re-held, every cron.
 *
 * STORAGE. No migration: both the digest and the decision live in the row's
 * existing `sources` jsonb array as two entries,
 *
 *   {kind:'editorial_input', version, digest}      stamped by the WRITER
 *   {kind:'editorial_desk',  version, decisions[]} stamped by the DESK
 *
 * The writers carry the desk entry forward when they refresh a row, so a
 * decision survives the refresh that used to erase it. Both kinds are stripped
 * from what the model is shown (a hex digest is full of digits, and the
 * numbers gate treats every digit in the packet as an allowed number).
 *
 * VOLATILE fields (timestamps, run ids) are removed at every depth, so a
 * re-run that restates the same facts yields the same digest.
 */
import { createHash } from 'node:crypto';

export const DIGEST_VERSION = 'ufc-editorial-digest/1';
export const INPUT_KIND = 'editorial_input';
export const DESK_KIND = 'editorial_desk';
const EDITORIAL_KINDS = new Set([INPUT_KIND, DESK_KIND]);
/* Generator bookkeeping, not facts: a salt bump changes these and must not
 * make an unchanged story look new. */
const DERIVED_SOURCE_KINDS = new Set(['fact_block', 'feature_block']);
const VOLATILE_KEYS = new Set([
  'generated_at', 'fetched_at', 'observed_at', 'updated_at', 'retrieved_at',
  'captured_at', 'checked_at', 'run_at', 'run_id', 'request_id', 'response_id',
]);
const MAX_DECISIONS = 8;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export function stripVolatile(v) {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!VOLATILE_KEYS.has(k)) out[k] = stripVolatile(x);
    return out;
  }
  return v;
}

const list = (sources) => (Array.isArray(sources) ? sources : []);

/** Sources as the MODEL may see them: no editorial bookkeeping. */
export function modelVisibleSources(sources) {
  if (!Array.isArray(sources)) return sources;
  return sources.filter((s) => !(s && EDITORIAL_KINDS.has(s.kind)));
}

/** The digest of what the desk would be given for this article. */
export function editorialDigest(article) {
  const material = {
    v: DIGEST_VERSION,
    slug: article.slug || null,
    story_type: article.story_type || null,
    headline: String(article.headline || ''),
    dek: String(article.dek || ''),
    body_md: String(article.body_md || ''),
    fact_block: stripVolatile(article.fact_block ?? null),
    sources: stripVolatile(list(article.sources).filter((s) => !(s && (EDITORIAL_KINDS.has(s.kind) || DERIVED_SOURCE_KINDS.has(s.kind))))),
  };
  return createHash('sha256').update(canonical(material), 'utf8').digest('hex');
}

export const inputEntry = (sources) => list(sources).find((s) => s && s.kind === INPUT_KIND) || null;
export const deskEntry = (sources) => list(sources).find((s) => s && s.kind === DESK_KIND) || null;

/** The desk's recorded decision for this digest, if any. */
export function decisionFor(sources, digest) {
  const d = deskEntry(sources);
  if (!d || !Array.isArray(d.decisions) || !digest) return null;
  return d.decisions.find((x) => x && x.digest === digest) || null;
}

/**
 * The writer's side: stamp the digest of the draft being stored, and carry the
 * desk's decision history forward from the row being replaced.
 */
export function stampEditorialInput(sources, article, existingSources = null) {
  const base = list(sources).filter((s) => !(s && EDITORIAL_KINDS.has(s.kind)));
  const digest = editorialDigest({ ...article, sources: base });
  let carried = deskEntry(existingSources);
  /* LEGACY UPGRADE BUYS NOTHING. A row written before digests existed that is
   * now being refreshed is either a generator/version change or a legacy row
   * catching up -- the owner rule says neither earns a model call. Its first
   * digest is recorded as a baseline decision, so only a LATER material change
   * (a digest the desk has never seen) is eligible. An admin re-edit can still
   * deliberately buy one. */
  if (Array.isArray(existingSources) && !inputEntry(existingSources)) {
    const withBaseline = recordDecision(carried ? [carried] : [], {
      digest, outcome: 'legacy_baseline', trigger: 'writer_refresh', attempts: 0, at: new Date().toISOString(),
    });
    carried = deskEntry(withBaseline);
  }
  return {
    digest,
    sources: [...base, { kind: INPUT_KIND, version: DIGEST_VERSION, digest }, ...(carried ? [carried] : [])],
  };
}

/** The desk's side: record a decision against a digest (newest first, capped). */
export function recordDecision(sources, decision) {
  const prev = deskEntry(sources);
  const prior = (prev && Array.isArray(prev.decisions) ? prev.decisions : []).filter((x) => x && x.digest !== decision.digest);
  const entry = { kind: DESK_KIND, version: DIGEST_VERSION, decisions: [decision, ...prior].slice(0, MAX_DECISIONS) };
  return [...list(sources).filter((s) => !(s && s.kind === DESK_KIND)), entry];
}

/**
 * On a writer refresh: may the published desk prose stay?
 *
 * Only when the new deterministic input is IDENTICAL (same digest) to the one
 * the desk already edited successfully. Then nothing the model saw changed and
 * reverting to template prose would only re-buy the same edit. Any material
 * change produces a new digest, the template goes back up, and the desk gets
 * its one call for the new facts.
 */
export function keepDeskProse(existing, digest) {
  if (!existing) return false;
  if (!isDeskProse(existing.model_version)) return false;
  /* The LATEST decision, not any: after A->B->A the prose on the row is B's
   * edit, and keeping it over facts A would be the stale-prose bug. */
  const latest = latestDecision(existing.sources);
  return Boolean(latest && latest.digest === digest && latest.outcome === 'passed');
}

export const isDeskProse = (modelVersion) => /\/editorial-desk-/.test(String(modelVersion || ''));

export function latestDecision(sources) {
  const d = deskEntry(sources);
  return d && Array.isArray(d.decisions) && d.decisions[0] ? d.decisions[0] : null;
}

/**
 * The desk's side: may an AUTOMATIC pass spend a call on this row?
 *
 *   no writer digest            -> no  (legacy row: a legacy upgrade buys nothing;
 *                                       it gets a digest on its next real refresh)
 *   row prose != stamped draft  -> no  (someone else's prose; not ours to re-edit)
 *   digest held/failed before   -> no  (one attempt per digest, never retried)
 *   digest passed and current   -> no  (already edited)
 *   otherwise                   -> yes, exactly one call
 */
export function automaticEligibility(article) {
  const input = inputEntry(article.sources);
  if (!input || !input.digest || input.version !== DIGEST_VERSION) return { eligible: false, reason: 'no_digest', digest: null };
  const digest = input.digest;
  const prior = decisionFor(article.sources, digest);
  if (prior && prior.outcome !== 'passed') return { eligible: false, reason: `digest_${prior.outcome}`, digest };
  if (prior && latestDecision(article.sources)?.digest === digest && isDeskProse(article.model_version)) {
    return { eligible: false, reason: 'digest_passed', digest };
  }
  if (isDeskProse(article.model_version)) return { eligible: false, reason: 'desk_prose_present', digest };
  if (editorialDigest(article) !== digest) return { eligible: false, reason: 'prose_not_stamped_draft', digest };
  return { eligible: true, reason: prior ? 'facts_reverted_to_earlier_digest' : 'new_editorial_digest', digest };
}
