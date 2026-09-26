/* Training & Corner (migration 032) — the one assembly of a fighter's camp,
 * coaches and fighting-out-of facts, shared by the web fighter page and the
 * ufc-api Worker (/v1/ufc/fighters/{id}/training, ?include=training).
 *
 * Pure: no I/O, no framework imports (the Worker bundles this file).
 *
 * WORDING RULES (owner, 2026-09-26)
 *   * A camp seen only in our captures is "First observed <Mon YYYY>", never
 *     "Joined". "Joined" needs a STATED date from a cited source.
 *   * An observed affiliation change is "Camp affiliation changed", never
 *     "switched camps". Only a CAMP_CHANGED_CONFIRMED event is a switch.
 *   * NEW CAMP SINCE LAST UFC BOUT only when the chronology proves it
 *     (newCampSinceLastBout). No claim that a change helps or hurts.
 *   * Empty facts are null / []; nothing is filled in.
 */

export type Certainty = "STATED" | "OBSERVED";

export type EvidenceRow = {
  observation_id: string; source_key: string; source_url: string; certainty: Certainty;
  relationship_type: string | null; value_raw: string; external_ref: string | null;
  captured_at: string; last_confirmed_at: string; effective_from: string | null; source_published_at: string | null;
};

export type CurrentRow = {
  fighter_id: string;
  current_camp: { camp_id: string; name: string; slug: string; first_observed_at: string; last_confirmed_at: string; joined_on: string | null; certainty: Certainty; evidence: EvidenceRow[] } | null;
  fighting_out_of: PlaceFact | null;
  training_location: (PlaceFact & { camp_id: string | null; camp_name: string | null }) | null;
  coaches: { coach_id: string; name: string; slug: string; role: string; since: string | null; certainty: Certainty; source_key: string; source_url: string; captured_at: string }[];
  other_camps: { camp_id: string; name: string; slug: string; relationship_type: string; since: string | null; certainty: Certainty; source_key: string; source_url: string; captured_at: string }[];
  updated_at: string | null;
};

export type PlaceFact = {
  city: string | null; region: string | null; country: string | null; value_raw: string; certainty: Certainty;
  source_key: string; source_url: string; captured_at: string; source_published_at: string | null;
};

export type StintRow = {
  fighter_id: string; stint_no: number; camp_id: string; camp_name: string; camp_slug: string;
  stint_start_at: string; first_observed_at: string; last_confirmed_at: string; joined_on: string | null;
  certainty: Certainty; next_stint_start_at: string | null; next_first_observed_at: string | null;
  left_on: string | null; is_current: boolean; evidence: EvidenceRow[];
};

export type ChangeRow = {
  id: string; kind: "CAMP_CHANGED_CONFIRMED" | "AFFILIATION_CHANGED_OBSERVED" | "COACH_ADDED" | "COACH_REMOVED" | "FIGHTING_OUT_OF_CHANGED";
  previous_value: string | null; new_value: string | null; previous_camp_id: string | null; new_camp_id: string | null;
  supersedes_event_id: string | null; effective_on: string | null; observed_at: string; source_url: string;
};

export const TRAINING_STINT_COLS = "fighter_id,stint_no,camp_id,camp_name,camp_slug,stint_start_at,first_observed_at,last_confirmed_at,joined_on,certainty,next_stint_start_at,next_first_observed_at,left_on,is_current,evidence";
export const TRAINING_CHANGE_COLS = "id,kind,previous_value,new_value,previous_camp_id,new_camp_id,supersedes_event_id,effective_on,observed_at,source_url";

export const ROLE_LABEL: Record<string, string> = {
  HEAD: "Head coach", STRIKING: "Striking", BOXING: "Boxing", MUAY_THAI: "Muay Thai", KICKBOXING: "Kickboxing",
  WRESTLING: "Wrestling", GRAPPLING: "Grappling", BJJ: "Jiu-jitsu", STRENGTH_CONDITIONING: "Strength & conditioning",
  /* The source named the coach without a discipline. Never shown as "OTHER", never upgraded to a discipline. */
  OTHER: "Coach",
};

/** Customer copy for a coach role; the raw role stays in the data. */
export function roleLabel(role: string | null | undefined): string {
  return (role && ROLE_LABEL[role]) || "Coach";
}

/* Change events store "<coach> · <RAW_ROLE>" (SQL); render the role in customer words. */
function coachValue(v: string | null): string | null {
  if (!v) return v;
  const i = v.lastIndexOf(" · ");
  if (i < 0) return v;
  const role = v.slice(i + 3);
  return role in ROLE_LABEL ? (role === "OTHER" ? v.slice(0, i) : `${v.slice(0, i)} · ${ROLE_LABEL[role]}`) : v;
}

export const RELATIONSHIP_LABEL: Record<string, string> = {
  PRIMARY_CAMP: "Primary camp", AFFILIATION: "Camp", TEMPORARY_CAMP: "Temporary camp", CROSS_TRAINING: "Cross-training", FIGHT_CAMP: "Fight camp",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 2026" from an ISO date/timestamp (UTC). */
export function monthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : null);

export function placeLabel(p: { city?: string | null; region?: string | null; country?: string | null } | null): string | null {
  if (!p) return null;
  const parts = [p.city, p.region, p.country].filter((x): x is string => Boolean(x && x.trim()));
  return parts.length ? parts.join(", ") : null;
}

/** When a stint began, in the words the evidence allows. */
export function stintStart(s: Pick<StintRow, "joined_on" | "first_observed_at" | "certainty">): { kind: "joined" | "first_observed"; date: string } {
  return s.joined_on ? { kind: "joined", date: s.joined_on } : { kind: "first_observed", date: day(s.first_observed_at)! };
}

export function startLabel(s: Pick<StintRow, "joined_on" | "first_observed_at" | "certainty">): string {
  const st = stintStart(s);
  return `${st.kind === "joined" ? "Joined" : "First observed"} ${monthYear(st.date)}`;
}

/**
 * NEW CAMP SINCE LAST UFC BOUT — only when chronology proves it:
 *   * a current stint exists and began AFTER the last completed UFC bout
 *     (its stated join date, else the day we first observed it), and
 *   * the stint immediately before it is proven to cover that bout: it began
 *     on or before the bout AND was still observed on or after it — or a
 *     CAMP_CHANGED_CONFIRMED event names it as the camp left for the current one.
 * Returns null otherwise. It never says what the change means for the fight.
 */
export function newCampSinceLastBout(stints: StintRow[], changes: ChangeRow[], lastBoutDate: string | null): null | {
  from: { camp_id: string; name: string; slug: string };
  to: { camp_id: string; name: string; slug: string; since: { kind: "joined" | "first_observed"; date: string } };
  last_bout_date: string; basis: "observed" | "confirmed";
} {
  if (!lastBoutDate) return null;
  const ordered = [...stints].sort((a, b) => a.stint_no - b.stint_no);
  const i = ordered.findIndex((s) => s.is_current);
  if (i < 1) return null;
  const cur = ordered[i];
  const prev = ordered[i - 1];
  if (prev.camp_id === cur.camp_id) return null;
  const since = stintStart(cur);
  if (!(since.date > lastBoutDate)) return null;
  const prevStart = prev.joined_on || day(prev.first_observed_at)!;
  if (!(prevStart <= lastBoutDate)) return null;
  const confirmed = changes.some((c) => c.kind === "CAMP_CHANGED_CONFIRMED" && c.new_camp_id === cur.camp_id && c.previous_camp_id === prev.camp_id);
  const spansBout = day(prev.last_confirmed_at)! >= lastBoutDate;
  if (!spansBout && !confirmed) return null;
  return {
    from: { camp_id: prev.camp_id, name: prev.camp_name, slug: prev.camp_slug },
    to: { camp_id: cur.camp_id, name: cur.camp_name, slug: cur.camp_slug, since },
    last_bout_date: lastBoutDate,
    basis: confirmed ? "confirmed" : "observed",
  };
}

export function changeLabel(c: ChangeRow): string {
  switch (c.kind) {
    case "CAMP_CHANGED_CONFIRMED": return c.previous_value ? `Switched camps: ${c.previous_value} → ${c.new_value}` : `Joined ${c.new_value}`;
    case "AFFILIATION_CHANGED_OBSERVED": return `Camp affiliation changed: ${c.previous_value} → ${c.new_value}`;
    case "COACH_ADDED": return `Coach added: ${coachValue(c.new_value)}`;
    case "COACH_REMOVED": return `Coach no longer listed: ${coachValue(c.previous_value)}`;
    case "FIGHTING_OUT_OF_CHANGED": return `Fighting out of changed: ${c.previous_value} → ${c.new_value}`;
  }
}

export type TrainingPayload = ReturnType<typeof trainingPayload>;

/** The API contract (and the page's input). Empty facts are null / []. */
export function trainingPayload({ current, stints, changes, lastBoutDate = null }: {
  current: CurrentRow | null; stints: StintRow[]; changes: ChangeRow[]; lastBoutDate?: string | null;
}) {
  const cc = current?.current_camp || null;
  const ordered = [...stints].sort((a, b) => b.stint_no - a.stint_no); // newest first
  const provenance: { fact: string; source_key: string; source_url: string; certainty: Certainty; captured_at: string; last_confirmed_at?: string; source_published_at?: string | null }[] = [];
  for (const e of cc?.evidence || []) provenance.push({ fact: "current_camp", source_key: e.source_key, source_url: e.source_url, certainty: e.certainty, captured_at: e.captured_at, last_confirmed_at: e.last_confirmed_at, source_published_at: e.source_published_at });
  const place = (fact: string, p: PlaceFact | null) => { if (p) provenance.push({ fact, source_key: p.source_key, source_url: p.source_url, certainty: p.certainty, captured_at: p.captured_at, source_published_at: p.source_published_at }); };
  place("fighting_out_of", current?.fighting_out_of || null);
  place("training_location", current?.training_location || null);
  for (const c of current?.coaches || []) provenance.push({ fact: `coach:${c.slug}:${c.role}`, source_key: c.source_key, source_url: c.source_url, certainty: c.certainty, captured_at: c.captured_at });
  for (const c of current?.other_camps || []) provenance.push({ fact: `camp:${c.slug}:${c.relationship_type}`, source_key: c.source_key, source_url: c.source_url, certainty: c.certainty, captured_at: c.captured_at });

  const superseded = new Set(changes.map((c) => c.supersedes_event_id).filter(Boolean));
  return {
    current_camp: cc ? {
      camp_id: cc.camp_id, name: cc.name, slug: cc.slug, certainty: cc.certainty,
      since: stintStart({ joined_on: cc.joined_on, first_observed_at: cc.first_observed_at, certainty: cc.certainty }),
      first_observed_at: cc.first_observed_at, last_confirmed_at: cc.last_confirmed_at,
    } : null,
    fighting_out_of: current?.fighting_out_of ? { ...pick(current.fighting_out_of), label: placeLabel(current.fighting_out_of) } : null,
    training_location: current?.training_location ? { ...pick(current.training_location), camp_id: current.training_location.camp_id, camp_name: current.training_location.camp_name, label: placeLabel(current.training_location) } : null,
    coaches: (current?.coaches || []).map((c) => ({ coach_id: c.coach_id, name: c.name, slug: c.slug, role: c.role, role_label: roleLabel(c.role), role_specified: c.role !== "OTHER", since: c.since, certainty: c.certainty })),
    other_camps: (current?.other_camps || []).map((c) => ({ camp_id: c.camp_id, name: c.name, slug: c.slug, relationship_type: c.relationship_type, relationship_label: RELATIONSHIP_LABEL[c.relationship_type] || c.relationship_type, since: c.since, certainty: c.certainty })),
    camp_history: ordered.map((s) => ({
      camp_id: s.camp_id, name: s.camp_name, slug: s.camp_slug, certainty: s.certainty, is_current: s.is_current,
      from: stintStart(s),
      /* A closed OBSERVED stint ends where our observations of it end; a STATED end date wins. */
      to: s.is_current ? null : s.left_on ? { kind: "left" as const, date: s.left_on } : { kind: "last_observed" as const, date: day(s.last_confirmed_at)! },
      sources: s.evidence.map((e) => ({ source_key: e.source_key, source_url: e.source_url, certainty: e.certainty, captured_at: e.captured_at })),
    })),
    changes: [...changes].sort((a, b) => b.observed_at.localeCompare(a.observed_at)).map((c) => ({
      id: c.id, kind: c.kind, label: changeLabel(c),
      previous_value: c.kind.startsWith("COACH_") ? coachValue(c.previous_value) : c.previous_value,
      new_value: c.kind.startsWith("COACH_") ? coachValue(c.new_value) : c.new_value,
      effective_on: c.effective_on, observed_at: c.observed_at, source_url: c.source_url,
      supersedes_event_id: c.supersedes_event_id, superseded_by_confirmation: superseded.has(c.id),
    })),
    new_camp_since_last_bout: newCampSinceLastBout(stints, changes, lastBoutDate),
    updated_at: current?.updated_at ?? null,
    provenance,
  };
}

function pick(p: PlaceFact) {
  return { city: p.city, region: p.region, country: p.country, certainty: p.certainty };
}

/** Year span for a timeline row: "2026 – present", "2023 – 2026", "2026". */
export function yearSpan(from: { date: string }, to: { date: string } | null): string {
  const a = from.date.slice(0, 4);
  if (!to) return `${a} – present`;
  const b = to.date.slice(0, 4);
  return a === b ? a : `${a} – ${b}`;
}
