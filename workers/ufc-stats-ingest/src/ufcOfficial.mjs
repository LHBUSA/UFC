/* UFC's official fight statistics feed (the JSON behind UFC.com event pages).
 *
 * WHY THIS SOURCE IS ALLOWED INTO ufc_bout_round_stats
 * ----------------------------------------------------
 * UFC Stats (ufcstats.com) and this feed publish the same official FightMetric
 * round observations. UFC Stats has fronted every automated read with a
 * challenge since 2026-09 (canaries 2026-09-10, -13, -14, all challenged), so
 * completed cards stopped receiving round rows. This feed is not access
 * controlled, publishes per-fighter PER-ROUND statistics directly
 * (LiveFightDetail.RoundStats[].Rounds[]) — nothing here is decomposed from a
 * fight total — and marks when they are official (OfficialStats: true).
 *
 * Equivalence was measured before any write (docs/ops/evidence/
 * ufc_official_round_feed_equivalence_2026-09-14.json): 23 bouts on two cards
 * whose UFC Stats rows the archive already held, every stored column of every
 * round and corner compared (2,156 cells), 0 mismatches; winner, finish round and finish time
 * agreed on every bout.
 *
 * WHAT THIS MODULE DOES NOT DO
 *   - no names-only identity: both corners must map exactly (canonical name or a
 *     stored alias), and the official result must agree with our stored result;
 *   - no partial fights: Status "Final", OfficialStats true, every round from 1
 *     to the finish present for both corners;
 *   - no derived numbers: every column is copied from the feed's own round
 *     object; a missing value stays null.
 *
 * Pure: no network, no clock. The Worker fetches and writes.
 */
import { normalize } from './shared/alias_resolver.mjs';
import { OFFICIAL_IDENTITY_OVERRIDES } from './officialIdentityOverrides.mjs';

export const OFFICIAL_BASE = 'https://d29dxerjsp82wz.cloudfront.net/api/v3';
export const officialFightUrl = (id) => `${OFFICIAL_BASE}/fight/live/${id}.json`;
export const officialEventUrl = (id) => `${OFFICIAL_BASE}/event/live/${id}.json`;
export const ufcComEventUrl = (slug) => `https://www.ufc.com/event/${slug}`;
export const OFFICIAL_METHOD = 'ufc_official_feed';

/* ufc_bout_round_stats column <- feed round field. Significant head/body/leg and
 * distance/clinch/ground are the SIGNIFICANT-strike breakdowns, as on UFC Stats. */
export const ROUND_COLUMNS = [
  ['kd', 'Knockdowns'],
  ['sig_str_landed', 'SigStrikesLanded'], ['sig_str_att', 'SigStrikesAttempted'],
  ['total_str_landed', 'TotalStrikesLanded'], ['total_str_att', 'TotalStrikesAttempted'],
  ['td_landed', 'TakedownsLanded'], ['td_att', 'TakedownsAttempted'],
  ['sub_att', 'SubmissionsAttempted'], ['rev', 'Reversals'],
  ['ctrl_sec', 'ControlTime', 'mmss'],
  ['head_landed', 'SigHeadStrikesLanded'], ['head_att', 'SigHeadStrikesAttempted'],
  ['body_landed', 'SigBodyStrikesLanded'], ['body_att', 'SigBodyStrikesAttempted'],
  ['leg_landed', 'SigLegStrikesLanded'], ['leg_att', 'SigLegStrikesAttempted'],
  ['distance_landed', 'SigDistanceStrikesLanded'], ['distance_att', 'SigDistanceStrikesAttempted'],
  ['clinch_landed', 'SigClinchStrikesLanded'], ['clinch_att', 'SigClinchStrikesAttempted'],
  ['ground_landed', 'SigGroundStrikesLanded'], ['ground_att', 'SigGroundStrikesAttempted'],
];

export function mmssToSeconds(t) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(t ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const fullName = (n) => [n?.FirstName, n?.LastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');

/** Fight ids listed on a UFC.com event page (data-fmid on each bout). */
export function fightIdsFromUfcComPage(html) {
  return [...new Set([...String(html || '').matchAll(/data-fmid="(\d+)"/g)].map((m) => m[1]))];
}

/** One official event document -> { id, name, date, status, fightIds }. */
export function parseOfficialEvent(doc) {
  const e = doc?.LiveEventDetail;
  if (!e || !Array.isArray(e.FightCard)) return { error: 'not an official event document' };
  return { id: String(e.EventId), name: String(e.Name || ''), date: String(e.StartTime || '').slice(0, 10), status: e.Status || null, fightIds: e.FightCard.map((f) => String(f.FightId)) };
}

/** One official fight document -> a flat, validated-shape record. */
export function parseOfficialFight(doc) {
  const f = doc?.LiveFightDetail;
  if (!f || !Array.isArray(f.Fighters)) return { error: 'not an official fight document' };
  const fighters = f.Fighters.map((x) => ({ official_id: String(x.FighterId), name: fullName(x.Name), first: String(x.Name?.FirstName || '').trim(), last: String(x.Name?.LastName || '').trim(),
    dob: /^\d{4}-\d{2}-\d{2}$/.test(String(x.DOB || '')) ? String(x.DOB) : null, outcome: x.Outcome?.Outcome || null }));
  const rounds = [];
  const shape = [];
  for (const block of f.RoundStats || []) {
    for (const r of block.Rounds || []) {
      const row = { official_fighter_id: String(block.FighterId), round: count(r.RoundNumber) };
      for (const [col, key, kind] of ROUND_COLUMNS) {
        const raw = r[key];
        const v = kind === 'mmss' ? (raw == null ? null : mmssToSeconds(raw)) : (raw == null ? null : count(raw));
        if (raw != null && v == null) shape.push(`round ${r.RoundNumber} ${key}=${JSON.stringify(raw)} is not a valid ${kind === 'mmss' ? 'm:ss' : 'count'}`);
        row[col] = v;
      }
      rounds.push(row);
    }
  }
  return {
    fight_id: String(f.FightId),
    event: { id: String(f.Event?.EventId ?? ''), name: String(f.Event?.Name || ''), date: String(f.Event?.StartTime || '').slice(0, 10) },
    status: f.Status || null,
    official: f.OfficialStats === true,
    possible_rounds: count(f.RuleSet?.PossibleRounds),
    result: { method: f.Result?.Method || null, round: count(f.Result?.EndingRound), time_sec: mmssToSeconds(f.Result?.EndingTime) },
    fighters, rounds, shape_problems: shape,
  };
}

/** Is the feed's fight finished and officially scored, with round detail? */
export function officialReadiness(parsed) {
  if (parsed.status !== 'Final') return { ready: false, reason: `official feed status ${parsed.status || 'unknown'}` };
  if (!parsed.official) return { ready: false, reason: 'official feed has not marked the statistics official yet' };
  if (!parsed.rounds.length) return { ready: false, reason: 'official feed has no round statistics yet' };
  return { ready: true };
}

/* Contender Series numbering. The official feed names a card "DWCS 10.1";
 * our canonical name is "Dana White's Contender Series: Season 10, Week 1". Both
 * reduce to the same (season, week) pair or to nothing. */
export function contenderSeasonWeek(name) {
  const s = String(name || '');
  const feed = /^\s*DWCS\s+(\d{1,2})\.(\d{1,2})\s*$/i.exec(s);
  if (feed) return { season: Number(feed[1]), week: Number(feed[2]) };
  const ours = /contender series(?:\s+\d{4})?\s*:\s*season\s+(\d{1,2})\s*,\s*week\s+(\d{1,2})\s*$/i.exec(s);
  return ours ? { season: Number(ours[1]), week: Number(ours[2]) } : null;
}

/* Same card: date within a day (UTC start vs local event date) and one of
 *   - the same Contender Series season AND week (both sides must parse),
 *   - the same numbered UFC event,
 *   - the same event name after normalization. */
export function sameOfficialEvent(official, ours) {
  if (!official?.date || !ours?.event_date) return false;
  const days = Math.abs(Date.parse(official.date) - Date.parse(ours.event_date)) / 86400e3;
  if (days > 1) return false;
  const da = contenderSeasonWeek(official.name), db = contenderSeasonWeek(ours.name);
  if (da || db) return Boolean(da && db && da.season === db.season && da.week === db.week);
  const na = /\bufc\s*(\d+)\b/i.exec(official.name), nb = /\bufc\s*(\d+)\b/i.exec(ours.name);
  if (na || nb) return Boolean(na && nb && na[1] === nb[1]);
  return normalize(official.name) === normalize(ours.name);
}

/* Common short forms of first names, explicit and reviewable. Used ONLY inside
 * the DOB-corroborated second tier below, never as identity on its own. */
const SHORT_FIRST_NAMES = {
  nick: ['nicholas', 'nicolas', 'nikolas', 'nickolas'], mike: ['michael'], chris: ['christopher', 'christian'], alex: ['alexander', 'alexandre', 'alexis', 'alejandro'],
  matt: ['matthew'], tom: ['thomas'], tommy: ['thomas'], joe: ['joseph'], dan: ['daniel'], danny: ['daniel'], rob: ['robert'], bob: ['robert'], bobby: ['robert'],
  bill: ['william'], will: ['william'], jim: ['james'], jimmy: ['james'], tony: ['anthony', 'antonio'], ben: ['benjamin'], sam: ['samuel'], josh: ['joshua'],
  jon: ['jonathan'], jake: ['jacob'], zach: ['zachary'], andy: ['andrew'], drew: ['andrew'], steve: ['steven', 'stephen'], dave: ['david'], ed: ['edward', 'eduardo'],
  greg: ['gregory'], jeff: ['jeffrey'], rick: ['richard', 'ricardo'], ricky: ['richard', 'ricardo'], rich: ['richard'], pat: ['patrick'], ron: ['ronald'],
  tim: ['timothy'], vince: ['vincent'], charlie: ['charles'], nate: ['nathan', 'nathaniel'], manny: ['manuel'], gabe: ['gabriel'], max: ['maxwell', 'maximilian', 'maximiliano'],
};
const sameFirstName = (a, b) => a === b || (SHORT_FIRST_NAMES[a] || []).includes(b) || (SHORT_FIRST_NAMES[b] || []).includes(a)
  || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/* The exact names one of our fighters is known by: canonical name and stored aliases. */
export function knownNames(fighter, aliases = []) {
  return new Set([fighter?.name, ...aliases].map(normalize).filter(Boolean));
}

/**
 * Map the feed's two fighters onto our two corners. Exact only: a feed name
 * (first last, or last first for family-name-first renderings) must equal a
 * known name of exactly one of our corners, and the mapping must be one-to-one.
 * Returns { map: Map(official_id -> our fighter id), via } or { problem }.
 */
export function mapOfficialFighters(parsed, fighterA, fighterB, aliasesById = new Map(), overrides = OFFICIAL_IDENTITY_OVERRIDES) {
  if (parsed.fighters.length !== 2) return { problem: `official fight lists ${parsed.fighters.length} fighters` };
  const ours = [fighterA, fighterB].map((f) => ({ f, names: knownNames(f, aliasesById.get(f?.id) || []) }));
  const compact = (s) => normalize(s).replace(/ /g, '');
  const exact = parsed.fighters.map((x) => {
    /* Audited exception (officialIdentityOverrides.mjs): exact official fight +
     * fighter id, one of our corners, identical compact name. */
    const ov = (overrides || []).find((o) => o.official_fight_id === String(parsed.fight_id) && o.official_fighter_id === x.official_id);
    if (ov) {
      const o = ours.find((z) => z.f?.id === ov.fighter_id);
      if (o && compact(o.f.name) && compact(o.f.name) === compact(x.name)) return { x, hits: [o], how: 'audited_override', override: ov };
      return { x, hits: [], how: null, override_rejected: ov.key };
    }
    const forms = [[normalize(x.name), 'name'], [normalize(`${x.last} ${x.first}`), 'family_name_first']].filter(([n]) => n);
    const hits = ours.filter((o) => forms.some(([n]) => o.names.has(n)));
    return { x, hits, how: hits.length === 1 ? forms.find(([n]) => hits[0].names.has(n))[1] : null };
  });
  if (exact.some((e) => e.hits.length > 1)) return { problem: 'an official fighter matches both of our corners' };
  const rejected = exact.find((e) => e.override_rejected);
  if (rejected) return { problem: `audited override ${rejected.override_rejected} does not apply to this bout` };
  if (exact.some((e) => e.how === 'audited_override') && !exact.every((e) => e.how === 'audited_override' || (e.hits.length === 1 && e.how !== 'audited_override'))) {
    return { problem: 'an audited override requires the other corner to match exactly' };
  }
  if (exact.filter((e) => e.how === 'audited_override').length > 1) return { problem: 'at most one corner may use an audited override' };
  /* Second tier, for ONE corner only: the other corner matched exactly, and this
   * one is the same person under a registered form of the name — a middle name
   * ("Douglas Henrique Rodrigues" / "Douglas Rodrigues") or the full form of a
   * short first name ("Nicholas Galanti" / "Nick Galanti"): identical date of
   * birth on both sides, identical last name token, first name identical, a
   * listed short form (SHORT_FIRST_NAMES) or a 3+ letter prefix, and every other
   * token of our name present in the official name. Never a name-only match; the
   * result must still agree. */
  const missing = exact.filter((e) => e.hits.length === 0);
  if (missing.length === 1) {
    const matched = exact.find((e) => e.hits.length === 1);
    const other = ours.find((o) => o.f.id !== matched.hits[0].f.id);
    const x = missing[0].x;
    const tokOfficial = normalize(x.name).split(' ').filter(Boolean);
    const tokOurs = normalize(other.f?.name).split(' ').filter(Boolean);
    const dobOk = Boolean(x.dob && other.f?.dob && x.dob === String(other.f.dob).slice(0, 10));
    const firstOk = sameFirstName(tokOurs[0] || '', tokOfficial[0] || '');
    const tokensOk = tokOurs.length >= 2 && tokOfficial.length >= 2 && firstOk
      && tokOurs[tokOurs.length - 1] === tokOfficial[tokOfficial.length - 1] && tokOurs.slice(1).every((t) => tokOfficial.slice(1).includes(t));
    if (dobOk && tokensOk) { missing[0].hits = [other]; missing[0].how = 'dob_and_registered_name'; }
    else return { problem: `official fighter "${x.name}" matches 0 of our corners exactly${x.dob ? '' : ' (no official DOB)'}` };
  } else if (missing.length === 2) {
    return { problem: `official fighter "${missing[0].x.name}" matches 0 of our corners exactly` };
  }
  const map = new Map();
  const via = [];
  for (const { x, hits, how } of exact) {
    map.set(x.official_id, hits[0].f.id);
    const ov = exact.find((e) => e.x === x)?.override;
    via.push({ official_id: x.official_id, official_name: x.name, fighter_id: hits[0].f.id, fighter_name: hits[0].f.name,
      via: how === 'name' && normalize(hits[0].f.name) !== normalize(x.name) ? 'alias' : how, ...(how === 'dob_and_registered_name' ? { dob: x.dob } : {}),
      ...(ov ? { override: ov.key, official_dob: x.dob, canonical_dob: ov.canonical_dob, discrepancy: ov.discrepancy } : {}) });
  }
  if (new Set(map.values()).size !== 2) return { problem: 'both official fighters map to the same corner' };
  return { map, via };
}

/**
 * Everything that must be true before a single round row is written.
 * `result` is our stored result: { winner_id, round, time_sec }.
 */
export function validateOfficialFight({ parsed, mapping, result }) {
  const problems = [...(parsed.shape_problems || [])];
  if (!mapping?.map) return [...problems, mapping?.problem || 'fighters not mapped'];
  const winners = parsed.fighters.filter((x) => x.outcome === 'Win');
  const feedWinner = winners.length === 1 ? mapping.map.get(winners[0].official_id) : null;
  if (winners.length > 1) problems.push('official feed lists more than one winner');
  if (result) {
    if ((feedWinner ?? null) !== (result.winner_id ?? null)) problems.push(`winner disagreement: stored ${result.winner_id ?? 'none'} vs official ${feedWinner ?? 'none'}`);
    if (result.round != null && parsed.result.round != null && result.round !== parsed.result.round) problems.push(`finish round disagreement: stored ${result.round} vs official ${parsed.result.round}`);
    if (result.time_sec != null && parsed.result.time_sec != null && result.time_sec !== parsed.result.time_sec) problems.push(`finish time disagreement: stored ${result.time_sec}s vs official ${parsed.result.time_sec}s`);
  } else {
    problems.push('no stored result to validate against');
  }
  const byRound = new Map();
  for (const r of parsed.rounds) {
    if (!mapping.map.has(r.official_fighter_id)) problems.push(`round row for a fighter not in the fight: ${r.official_fighter_id}`);
    if (r.round == null) { problems.push('round row without a round number'); continue; }
    if (!byRound.has(r.round)) byRound.set(r.round, new Set());
    const set = byRound.get(r.round);
    if (set.has(r.official_fighter_id)) problems.push(`round ${r.round} repeats fighter ${r.official_fighter_id}`);
    set.add(r.official_fighter_id);
  }
  const nums = [...byRound.keys()].sort((a, b) => a - b);
  nums.forEach((n, i) => { if (n !== i + 1) problems.push(`rounds not contiguous from 1: ${nums.join(',')}`); });
  for (const [n, corners] of byRound) if (corners.size !== 2) problems.push(`round ${n} has ${corners.size} corner(s)`);
  const finish = parsed.result.round ?? result?.round ?? null;
  if (finish != null && nums.length && nums[nums.length - 1] > finish) problems.push(`round rows beyond the finish round ${finish}`);
  if (finish != null && nums.length && nums[nums.length - 1] < finish) problems.push(`round rows stop at ${nums[nums.length - 1]} before the finish round ${finish}`);
  return [...new Set(problems)];
}

/** Rows for ufc_bout_round_stats. Only called after validateOfficialFight() passed. */
export function officialRoundRows(parsed, mapping, boutId, sourceUrl, capturedAt) {
  return parsed.rounds.map(({ official_fighter_id, ...r }) => ({
    ...r, bout_id: boutId, fighter_id: mapping.map.get(official_fighter_id), source_url: sourceUrl, captured_at: capturedAt,
  }));
}
