/**
 * Editorial Packet V4.
 *
 * THE CONTRACT
 *
 * A fact is not a string. It is an object with a value, a family, a source and
 * an as-of date. Prose may only assert something that exists here as a fact,
 * and the gate checks that by matching the numbers in the finished body against
 * the numbers in this packet. That is what makes "no unsupported numbers"
 * enforceable rather than aspirational.
 *
 * AS-OF SAFETY
 *
 * A packet built for a story published in the past carries `as_of`, and every
 * loader filters to it. Today's odds, today's injury list and today's model
 * output must never appear in a 2024 story as though they existed then. The
 * V4 builder refuses to attach any family whose data cannot be proven to
 * predate `as_of`; for live stories `as_of` is null and every dynamic block
 * carries its own observation timestamp instead.
 *
 * DYNAMIC RESOLUTION
 *
 * Families are attached only when relevant and only when they have something to
 * say. A preview with no market observation does not get a market section
 * saying there is no market - it gets no market section. Writing paragraphs
 * about the absence of data is the other way to pad.
 */

/** Evidence families. A count of DISTINCT families is what gates depth. */
export const FAMILIES = [
  'core', 'recent_form', 'tale', 'fight_dna', 'market', 'model',
  'availability', 'weigh_in', 'result', 'officials', 'round_stats', 'historical', 'source_item',
];

let seq = 0;
const nextId = (family) => `${family}.${(++seq).toString(36)}`;

/** Reset between packets so ids are stable within one build. */
export function resetFactIds() { seq = 0; }

/**
 * @param {object} o
 * @param {string} o.family
 * @param {string} o.statement  prose-ready assertion, past or present tense
 * @param {*} [o.value]         the number or literal, when there is one
 * @param {object} o.source     {table, column?, row_id?} or {url, publisher, published_at}
 * @param {string} [o.as_of]    the date this fact was true as of
 */
export function fact({ family, statement, value = null, source, as_of = null, unit = null }) {
  if (!family || !statement || !source) throw new Error('a fact needs a family, a statement and a source');
  return { id: nextId(family), family, statement, value, unit, source, as_of };
}

/** Every distinct number a body is allowed to contain, for the gate. */
export function allowedNumbers(packet) {
  const out = new Set();
  const add = (v) => {
    if (v === null || v === undefined) return;
    const n = Number(v);
    if (Number.isFinite(n)) out.add(String(n));
  };
  for (const f of packet.facts) {
    add(f.value);
    /* Numbers written into the statement itself are supported by construction:
       the statement IS the sourced claim. Pulling them out here is what lets a
       composer quote "24-6-0" without the gate calling it unsupported. */
    for (const m of String(f.statement).matchAll(/\d+(?:\.\d+)?/g)) out.add(String(Number(m[0])));
  }
  return out;
}

export function familiesIn(packet) {
  return [...new Set(packet.facts.map((f) => f.family))];
}

/* ------------------------------------------------------------------ core -- */

const fmtDate = (d) => {
  if (!d) return null;
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) ? null : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const recordOf = (f) => `${f.record_w ?? 0}-${f.record_l ?? 0}-${f.record_d ?? 0}${f.record_nc ? ` (${f.record_nc} NC)` : ''}`;
const WEIGHT = {
  STRAWWEIGHT: 'strawweight', FLYWEIGHT: 'flyweight', BANTAMWEIGHT: 'bantamweight',
  FEATHERWEIGHT: 'featherweight', LIGHTWEIGHT: 'lightweight', WELTERWEIGHT: 'welterweight',
  MIDDLEWEIGHT: 'middleweight', LIGHT_HEAVYWEIGHT: 'light heavyweight', HEAVYWEIGHT: 'heavyweight',
  CATCHWEIGHT: 'catchweight', OPEN: 'open weight',
};
export const divisionLabel = (wc, womens) => (wc ? `${womens ? "women's " : ''}${WEIGHT[wc] ?? wc.toLowerCase()}` : 'an unlisted division');
const METHOD = { KO_TKO: 'KO/TKO', SUB: 'submission', DEC_U: 'unanimous decision', DEC_S: 'split decision', DEC_M: 'majority decision', DQ: 'disqualification', NC: 'no contest', DRAW: 'draw' };
export const methodLabel = (m) => METHOD[m] ?? String(m ?? '').toLowerCase();

/**
 * Core: who, what, when, where. Always present; a story with no core is not a
 * story about a fight.
 */
export function coreFacts({ event, bout, fighters }) {
  const out = [];
  const src = (table, row_id) => ({ table, row_id });
  if (event) {
    out.push(fact({
      family: 'core',
      statement: `${event.name} is scheduled for ${fmtDate(event.event_date)}${event.city ? ` in ${[event.city, event.region, event.country].filter(Boolean).join(', ')}` : ''}.`,
      value: event.event_date,
      source: src('ufc_events', event.id),
      as_of: event.event_date,
    }));
  }
  if (bout && fighters?.length === 2) {
    const [a, b] = fighters;
    out.push(fact({
      family: 'core',
      statement: `${a.name} meets ${b.name} at ${divisionLabel(bout.weight_class, bout.is_womens)}${bout.is_title ? ' with the title on the line' : ''}, scheduled for ${bout.scheduled_rounds ?? 3} rounds.`,
      source: src('ufc_bouts', bout.id),
      as_of: event?.event_date ?? null,
    }));
    for (const f of fighters) {
      out.push(fact({
        family: 'core',
        statement: `${f.name} is listed at ${recordOf(f)}.`,
        value: f.record_w,
        source: src('ufc_fighters', f.id),
      }));
    }
  }
  return out;
}

/**
 * Per-fighter metric map, keyed by fighter id.
 *
 * The facts array is the provenance record; this is the shape the composer
 * reads to write comparative prose. Both are derived from the same row in the
 * same pass, so a number in the table and a number in the sentence cannot
 * drift apart.
 */
export function taleMetrics({ fighters, eventDate }) {
  const out = {};
  for (const f of fighters ?? []) {
    const age = f.dob && eventDate
      ? Math.floor((Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${f.dob}T00:00:00Z`)) / (365.2425 * 86400000))
      : null;
    out[f.id] = {
      name: f.name,
      age: Number.isFinite(age) ? age : null,
      reach: f.reach_in ?? null,
      height: f.height_in ?? null,
      stance: f.stance ? String(f.stance).toLowerCase().replace('_', ' ') : null,
      slpm: f.career_slpm ?? null,
      sapm: f.career_sapm ?? null,
      strAcc: f.career_str_acc ?? null,
      strDef: f.career_str_def ?? null,
      tdAvg: f.career_td_avg ?? null,
      tdAcc: f.career_td_acc ?? null,
      tdDef: f.career_td_def ?? null,
      subAvg: f.career_sub_avg ?? null,
    };
  }
  return out;
}

export function dnaMetrics({ fighters, snapshots, asOf }) {
  const out = {};
  for (const f of fighters ?? []) {
    const snap = (snapshots ?? [])
      .filter((s) => s.fighter_id === f.id)
      .filter((s) => !asOf || s.as_of_date <= asOf)
      .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))[0];
    if (!snap) continue;
    const m = (k) => { const v = snap.metrics?.[k]?.value; return v === null || v === undefined ? null : Number(v); };
    out[f.id] = {
      name: f.name,
      asOf: snap.as_of_date,
      sample: snap.sample_stat_bouts ?? 0,
      coverage: snap.coverage_status,
      slpm: m('sig_landed_per_min'),
      sapm: m('sig_absorbed_per_min'),
      diff: m('sig_diff_per_min'),
      acc: m('sig_accuracy'),
      def: m('sig_defense'),
      tdPer15: m('td_landed_per_15'),
      control: m('control_share'),
      finish: m('finish_rate'),
      kd: m('knockdowns_per_15'),
    };
  }
  return out;
}

/** Tale of the tape. Only the fields actually held; nothing estimated. */
export function taleFacts({ fighters, eventDate }) {
  const out = [];
  for (const f of fighters ?? []) {
    const src = { table: 'ufc_fighters', row_id: f.id };
    if (f.dob && eventDate) {
      const age = Math.floor((Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${f.dob}T00:00:00Z`)) / (365.2425 * 86400000));
      if (Number.isFinite(age)) out.push(fact({ family: 'tale', statement: `${f.name} is ${age} on fight night.`, value: age, unit: 'years', source: src, as_of: eventDate }));
    }
    if (f.reach_in) out.push(fact({ family: 'tale', statement: `${f.name} carries a ${f.reach_in}-inch reach.`, value: f.reach_in, unit: 'in', source: src }));
    if (f.height_in) out.push(fact({ family: 'tale', statement: `${f.name} stands ${Math.floor(f.height_in / 12)}'${f.height_in % 12}".`, value: f.height_in, unit: 'in', source: src }));
    if (f.stance) out.push(fact({ family: 'tale', statement: `${f.name} fights ${String(f.stance).toLowerCase().replace('_', ' ')}.`, source: src }));
    if (f.career_slpm) out.push(fact({ family: 'tale', statement: `${f.name} lands ${f.career_slpm} significant strikes a minute.`, value: f.career_slpm, unit: 'per_min', source: { ...src, column: 'career_slpm' } }));
    if (f.career_sapm) out.push(fact({ family: 'tale', statement: `${f.name} absorbs ${f.career_sapm} a minute.`, value: f.career_sapm, unit: 'per_min', source: { ...src, column: 'career_sapm' } }));
    /* career_str_def and career_td_def are stored as whole percentages (58, not
       0.58). Multiplying by 100 produced "5300% striking defence" in the first
       preview, which the number gate caught. */
    if (f.career_str_def) out.push(fact({ family: 'tale', statement: `${f.name} has a ${Math.round(f.career_str_def)}% striking defence figure on record.`, value: Math.round(f.career_str_def), unit: '%', source: { ...src, column: 'career_str_def' } }));
    /* A derived metric is allowed as a fact when the rule is documented and the
       inputs are sourced. Net striking is landed minus absorbed per minute -
       one subtraction over two stored columns - and having it here rather than
       computed inside the composer is what lets the number gate recognise it. */
    if (f.career_slpm && f.career_sapm) {
      const net = Number((f.career_slpm - f.career_sapm).toFixed(2));
      out.push(fact({
        family: 'tale',
        statement: `${f.name} nets ${net > 0 ? `${net}` : `${net}`} significant strikes a minute once what ${f.name.split(' ')[0]} absorbs is taken off.`,
        value: net,
        unit: 'per_min',
        source: { ...src, column: 'career_slpm - career_sapm', rule: 'net_significant_strikes_per_minute = career_slpm - career_sapm' },
      }));
    }
    if (f.career_td_avg) out.push(fact({ family: 'tale', statement: `${f.name} averages ${f.career_td_avg} takedowns per 15 minutes.`, value: f.career_td_avg, source: { ...src, column: 'career_td_avg' } }));
    if (f.career_td_def) out.push(fact({ family: 'tale', statement: `${f.name} defends ${Math.round(f.career_td_def)}% of takedowns aimed at ${f.is_womens ? 'her' : 'them'}.`, value: Math.round(f.career_td_def), unit: '%', source: { ...src, column: 'career_td_def' } }));
  }
  return out;
}

/**
 * Recent form, as of a date. `bouts` must already be filtered to
 * event_date < asOf by the loader; this function asserts it rather than
 * trusting it, because a form section is the easiest place for a future result
 * to slip into a historical story.
 */
export function recentFormFacts({ fighters, bouts, asOf }) {
  const out = [];
  for (const f of fighters ?? []) {
    const mine = (bouts ?? [])
      .filter((b) => b.fighter_id === f.id)
      .filter((b) => !asOf || b.event_date < asOf)
      .sort((x, y) => y.event_date.localeCompare(x.event_date))
      .slice(0, 5);
    if (!mine.length) continue;
    if (asOf && mine.some((b) => b.event_date >= asOf)) throw new Error(`recentFormFacts received a bout dated on or after ${asOf} for ${f.name}`);

    const w = mine.filter((b) => b.outcome === 'W').length;
    const l = mine.filter((b) => b.outcome === 'L').length;
    out.push(fact({
      family: 'recent_form',
      statement: `Over ${f.name}'s last ${mine.length} recorded bouts the archive holds ${w} ${w === 1 ? 'win' : 'wins'} and ${l} ${l === 1 ? 'loss' : 'losses'}.`,
      value: w,
      source: { table: 'ufc_fighter_bout_features', row_id: f.id },
      as_of: asOf,
    }));
    const last = mine[0];
    out.push(fact({
      family: 'recent_form',
      statement: `${f.name}'s most recent recorded result is a ${last.outcome === 'W' ? 'win' : last.outcome === 'L' ? 'loss' : 'no-decision'} by ${methodLabel(last.method)} on ${fmtDate(last.event_date)}.`,
      source: { table: 'ufc_fighter_bout_features', row_id: `${f.id}:${last.bout_id}` },
      as_of: last.event_date,
    }));
    const finishes = mine.filter((b) => b.outcome === 'W' && (b.method === 'KO_TKO' || b.method === 'SUB')).length;
    if (finishes) {
      out.push(fact({
        family: 'recent_form',
        statement: `${finishes} of ${f.name}'s ${w === 1 ? 'win came' : 'wins came'} inside the distance.`,
        value: finishes,
        source: { table: 'ufc_fighter_bout_features', row_id: f.id },
        as_of: asOf,
      }));
    }
  }
  return out;
}

/** Fight DNA, from an as-of snapshot. Never a snapshot dated after the bout. */
export function fightDnaFacts({ fighters, snapshots, asOf }) {
  const out = [];
  for (const f of fighters ?? []) {
    const snap = (snapshots ?? [])
      .filter((s) => s.fighter_id === f.id)
      .filter((s) => !asOf || s.as_of_date <= asOf)
      .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))[0];
    if (!snap) continue;
    if (asOf && snap.as_of_date > asOf) throw new Error(`fightDnaFacts selected a snapshot dated after ${asOf}`);

    const src = { table: 'ufc_fighter_dna_snapshots', row_id: `${f.id}@${snap.as_of_date}`, as_of: snap.as_of_date };
    const m = (k) => { const v = snap.metrics?.[k]?.value; return v === null || v === undefined ? null : Number(v); };
    const sample = snap.sample_stat_bouts ?? 0;
    if (sample < 2) continue;

    const slpm = m('sig_landed_per_min');
    const diff = m('sig_diff_per_min');
    const ctrl = m('control_share');
    const tdl = m('td_landed_per_15');
    const fin = m('finish_rate');
    if (slpm !== null) out.push(fact({ family: 'fight_dna', statement: `Fight DNA has ${f.name} landing ${slpm.toFixed(2)} significant strikes a minute across ${sample} stat-covered bouts.`, value: slpm, source: src, as_of: snap.as_of_date }));
    if (diff !== null) out.push(fact({ family: 'fight_dna', statement: `${f.name}'s significant-strike differential is ${diff > 0 ? '+' : ''}${diff.toFixed(2)} a minute.`, value: diff, source: src, as_of: snap.as_of_date }));
    if (tdl !== null && tdl > 0) out.push(fact({ family: 'fight_dna', statement: `${f.name} lands ${tdl.toFixed(2)} takedowns per 15 minutes in the same sample.`, value: tdl, source: src, as_of: snap.as_of_date }));
    if (ctrl !== null && ctrl > 0) out.push(fact({ family: 'fight_dna', statement: `${f.name} holds control for ${(ctrl * 100).toFixed(1)}% of observed fight time.`, value: Number((ctrl * 100).toFixed(1)), unit: '%', source: src, as_of: snap.as_of_date }));
    if (fin !== null) out.push(fact({ family: 'fight_dna', statement: `${(fin * 100).toFixed(0)}% of ${f.name}'s recorded wins came inside the distance.`, value: Number((fin * 100).toFixed(0)), unit: '%', source: src, as_of: snap.as_of_date }));
    out.push(fact({ family: 'fight_dna', statement: `That profile rests on ${sample} stat-covered bouts, graded ${snap.coverage_status} coverage.`, value: sample, source: src, as_of: snap.as_of_date }));
  }
  return out;
}

/**
 * Market. Only from observations that exist, with their real timestamp, and
 * with staleness stated rather than hidden.
 */
export const STALE_AFTER_MINUTES = 12 * 60;

export function marketFacts({ observations, fighters, asOf, now = new Date() }) {
  const usable = (observations ?? []).filter((o) => o.market_key === 'h2h' && o.outcome_fighter_id && o.price != null)
    .filter((o) => !asOf || (o.observed_at && o.observed_at.slice(0, 10) <= asOf));
  if (!usable.length) return [];

  const latestPerBook = new Map();
  for (const o of usable) {
    const k = `${o.bookmaker_key}|${o.outcome_fighter_id}`;
    const prev = latestPerBook.get(k);
    if (!prev || (prev.observed_at || '') <= (o.observed_at || '')) latestPerBook.set(k, o);
  }
  const bySide = new Map();
  for (const o of latestPerBook.values()) {
    if (!bySide.has(o.outcome_fighter_id)) bySide.set(o.outcome_fighter_id, []);
    bySide.get(o.outcome_fighter_id).push(o);
  }
  if (bySide.size !== 2) return [];

  const implied = (p) => (p > 0 ? 100 / (p + 100) : -p / (-p + 100));
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const observedAt = usable.map((o) => o.observed_at).filter(Boolean).sort().slice(-1)[0];
  const ageMin = observedAt ? Math.round((now.getTime() - Date.parse(observedAt)) / 60000) : null;
  const stale = ageMin !== null && ageMin > STALE_AFTER_MINUTES;

  const out = [];
  const sides = [...bySide.entries()].map(([fid, rows]) => ({
    fid,
    name: (fighters ?? []).find((f) => f.id === fid)?.name ?? 'the other corner',
    books: rows.length,
    med: median(rows.map((r) => implied(r.price))),
    spread: Math.max(...rows.map((r) => implied(r.price))) - Math.min(...rows.map((r) => implied(r.price))),
  }));
  const total = sides.reduce((a, s) => a + s.med, 0);
  for (const s of sides) s.devig = s.med / total;
  sides.sort((a, b) => b.devig - a.devig);

  const src = { table: 'ufc_market_observations', observed_at: observedAt };
  out.push(fact({
    family: 'market',
    statement: `Across ${Math.min(...sides.map((s) => s.books))} book${Math.min(...sides.map((s) => s.books)) === 1 ? '' : 's'} the median de-vigged price makes ${sides[0].name} a ${(sides[0].devig * 100).toFixed(1)}% favourite, ${sides[1].name} at ${(sides[1].devig * 100).toFixed(1)}%.`,
    value: Number((sides[0].devig * 100).toFixed(1)),
    unit: '%',
    source: src,
    as_of: observedAt,
  }));
  out.push(fact({
    family: 'market',
    statement: stale
      ? `That reading was last observed ${observedAt} UTC, ${Math.round(ageMin / 60)} hours ago, and is stale.`
      : `That reading was observed ${observedAt} UTC.`,
    value: ageMin,
    unit: 'minutes',
    source: src,
    as_of: observedAt,
  }));
  const disp = Math.max(...sides.map((s) => s.spread));
  if (disp > 0.02) {
    out.push(fact({
      family: 'market',
      statement: `The books disagree by ${(disp * 100).toFixed(1)} points on the favourite, which is wide for a two-way market.`,
      value: Number((disp * 100).toFixed(1)),
      unit: 'pts',
      source: src,
      as_of: observedAt,
    }));
  }
  return out;
}

/** Sourced availability. Never a diagnosis that was not published. */
/**
 * The same market computation as marketFacts, returned as structure rather than
 * sentences, so the Market Watch table and the market paragraph are guaranteed
 * to be the same reading.
 */
export function marketSummary({ observations, fighters, asOf, now = new Date() }) {
  const usable = (observations ?? []).filter((o) => o.market_key === 'h2h' && o.outcome_fighter_id && o.price != null)
    .filter((o) => !asOf || (o.observed_at && o.observed_at.slice(0, 10) <= asOf));
  if (!usable.length) return null;
  const latestPerBook = new Map();
  for (const o of usable) {
    const k = `${o.bookmaker_key}|${o.outcome_fighter_id}`;
    const prev = latestPerBook.get(k);
    if (!prev || (prev.observed_at || '') <= (o.observed_at || '')) latestPerBook.set(k, o);
  }
  const bySide = new Map();
  for (const o of latestPerBook.values()) {
    if (!bySide.has(o.outcome_fighter_id)) bySide.set(o.outcome_fighter_id, []);
    bySide.get(o.outcome_fighter_id).push(o);
  }
  if (bySide.size !== 2) return null;
  const implied = (p) => (p > 0 ? 100 / (p + 100) : -p / (-p + 100));
  const median = (xs) => { const s2 = [...xs].sort((a, b) => a - b); const m = s2.length >> 1; return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2; };
  const observedAt = usable.map((o) => o.observed_at).filter(Boolean).sort().slice(-1)[0];
  const ageMin = observedAt ? Math.round((now.getTime() - Date.parse(observedAt)) / 60000) : null;
  const sides = [...bySide.entries()].map(([fid, rows]) => ({
    fid,
    name: (fighters ?? []).find((f) => f.id === fid)?.name ?? 'the other corner',
    books: rows.length,
    med: median(rows.map((r) => implied(r.price))),
  }));
  const total = sides.reduce((a, x) => a + x.med, 0);
  for (const x of sides) x.devig = x.med / total;
  sides.sort((a, b) => b.devig - a.devig);
  return { sides, observedAt, stale: ageMin !== null && ageMin > STALE_AFTER_MINUTES, ageMin };
}

export function availabilityFacts({ statusEvents, asOf }) {
  const out = [];
  for (const e of (statusEvents ?? []).filter((x) => !asOf || (x.detected_at || '').slice(0, 10) <= asOf)) {
    out.push(fact({
      family: 'availability',
      statement: e.statement,
      source: { url: e.source_url, publisher: e.publisher, published_at: e.published_at },
      as_of: (e.published_at || e.detected_at || '').slice(0, 10) || null,
    }));
  }
  return out;
}

/** Weigh-ins. limit_basis is required; a limit is never derived from division. */
export function weighInFacts({ readings }) {
  const out = [];
  for (const r of readings ?? []) {
    if (r.weight_lb == null) continue;
    const src = { table: 'ufc_weigh_in_results', row_id: r.id, source_url: r.source_url, publisher: r.publisher };
    out.push(fact({ family: 'weigh_in', statement: `${r.fighter_name} weighed in at ${r.weight_lb} pounds.`, value: r.weight_lb, unit: 'lb', source: src, as_of: (r.clock_time || '').slice(0, 10) || null }));
    if (r.limit_lb != null && r.limit_basis) {
      const over = Number((r.weight_lb - r.limit_lb).toFixed(1));
      out.push(fact({
        family: 'weigh_in',
        statement: over > 0
          ? `That is ${over} pounds over the ${r.limit_lb}-pound limit for the bout, a limit recorded from ${r.limit_basis}.`
          : `That makes the ${r.limit_lb}-pound limit, recorded from ${r.limit_basis}.`,
        value: over > 0 ? over : r.limit_lb,
        unit: 'lb',
        source: src,
      }));
    }
  }
  return out;
}

/** Official result and officials. */
export function resultFacts({ result, bout, fighters, referee, scorecards }) {
  const out = [];
  if (!result) return out;
  const winner = (fighters ?? []).find((f) => f.id === result.winner_id);
  const loser = (fighters ?? []).find((f) => f.id !== result.winner_id);
  const src = { table: 'ufc_bout_results', row_id: bout?.id };
  if (winner) {
    out.push(fact({
      family: 'result',
      statement: `${winner.name} beat ${loser?.name ?? 'the opponent'} by ${methodLabel(result.method)}${result.round ? ` in round ${result.round}` : ''}${result.time_sec != null ? ` at ${Math.floor(result.time_sec / 60)}:${String(result.time_sec % 60).padStart(2, '0')}` : ''}.`,
      source: src,
    }));
  } else {
    out.push(fact({ family: 'result', statement: `The bout was recorded as a ${methodLabel(result.method)}.`, source: src }));
  }
  if (referee) out.push(fact({ family: 'officials', statement: `${referee} was the third man in the cage.`, source: { table: 'ufc_bout_results', column: 'referee', row_id: bout?.id } }));
  for (const c of scorecards ?? []) {
    out.push(fact({ family: 'officials', statement: `${c.judge} scored it ${c.score}.`, source: { table: 'ufc_bout_results', column: 'scorecards', row_id: bout?.id } }));
  }
  return out;
}

/**
 * What actually happened inside the fight, from the stored round rows.
 *
 * This is the family a results story lives on. Without it a result is one
 * sentence plus context, which is how the first results preview came out at 268
 * words and correctly refused to call itself an article.
 */
export function roundStatFacts({ rows, fighters, bout }) {
  const out = [];
  if (!rows?.length || !fighters?.length) return out;
  const src = { table: 'ufc_bout_round_stats', row_id: bout?.id };
  const per = new Map();
  for (const r of rows) {
    const t = per.get(r.fighter_id) ?? { sig: 0, sigAtt: 0, td: 0, tdAtt: 0, ctrl: 0, kd: 0, sub: 0, rounds: 0 };
    t.sig += r.sig_str_landed ?? 0; t.sigAtt += r.sig_str_att ?? 0;
    t.td += r.td_landed ?? 0; t.tdAtt += r.td_att ?? 0;
    t.ctrl += r.ctrl_sec ?? 0; t.kd += r.kd ?? 0; t.sub += r.sub_att ?? 0; t.rounds += 1;
    per.set(r.fighter_id, t);
  }
  const named = (fighters ?? []).filter((f) => per.has(f.id));
  if (named.length !== 2) return out;
  for (const f of named) {
    const t = per.get(f.id);
    const acc = t.sigAtt ? Math.round((t.sig / t.sigAtt) * 100) : null;
    out.push(fact({ family: 'round_stats', statement: `${f.name} landed ${t.sig} significant strikes of ${t.sigAtt} thrown${acc !== null ? `, ${acc}% accuracy` : ''}.`, value: t.sig, source: src }));
    if (t.tdAtt) out.push(fact({ family: 'round_stats', statement: `${f.name} went ${t.td} for ${t.tdAtt} on takedowns.`, value: t.td, source: src }));
    if (t.ctrl) out.push(fact({ family: 'round_stats', statement: `${f.name} accumulated ${Math.floor(t.ctrl / 60)}:${String(t.ctrl % 60).padStart(2, '0')} of control time.`, value: t.ctrl, unit: 'sec', source: src }));
    if (t.kd) out.push(fact({ family: 'round_stats', statement: `${f.name} scored ${t.kd} ${t.kd === 1 ? 'knockdown' : 'knockdowns'}.`, value: t.kd, source: src }));
    if (t.sub) out.push(fact({ family: 'round_stats', statement: `${f.name} threw ${t.sub} submission ${t.sub === 1 ? 'attempt' : 'attempts'}.`, value: t.sub, source: src }));
  }
  /* Round by round. Totals say who won the fight; the round sheet says when. */
  const rounds = [...new Set(rows.map((r) => r.round))].sort((x, y) => x - y);
  for (const rd of rounds) {
    const inRound = rows.filter((r) => r.round === rd);
    if (inRound.length !== 2) continue;
    const [x, y] = named.map((f) => ({ f, r: inRound.find((r) => r.fighter_id === f.id) })).filter((o) => o.r);
    if (!x || !y) continue;
    const xs = x.r.sig_str_landed ?? 0;
    const ys = y.r.sig_str_landed ?? 0;
    const bits = [`Round ${rd}: ${x.f.name} ${xs}, ${y.f.name} ${ys} on significant strikes`];
    const ctrl = [x, y].filter((o) => (o.r.ctrl_sec ?? 0) >= 30);
    if (ctrl.length === 1) bits.push(`${ctrl[0].f.name} holding ${Math.floor(ctrl[0].r.ctrl_sec / 60)}:${String(ctrl[0].r.ctrl_sec % 60).padStart(2, '0')} of control`);
    const kds = [x, y].filter((o) => (o.r.kd ?? 0) > 0);
    for (const k of kds) bits.push(`${k.f.name} scoring a knockdown`);
    out.push(fact({
      family: 'round_stats',
      statement: `${bits.join(', ')}.`,
      value: Math.abs(xs - ys),
      source: { ...src, column: `round_${rd}` },
    }));
  }

  const [a, b] = named.map((f) => ({ f, t: per.get(f.id) }));
  const diff = a.t.sig - b.t.sig;
  out.push(fact({
    family: 'round_stats',
    statement: diff === 0
      ? `The two finished level on significant strikes at ${a.t.sig} apiece.`
      : `${(diff > 0 ? a : b).f.name} out-landed ${(diff > 0 ? b : a).f.name} by ${Math.abs(diff)} significant strikes across ${Math.max(a.t.rounds, b.t.rounds)} scored rounds.`,
    value: Math.abs(diff),
    source: src,
  }));
  return out;
}

/** A source item is itself a fact: someone published something, at a time. */
export function sourceItemFacts({ item }) {
  if (!item) return [];
  return [fact({
    family: 'source_item',
    statement: `${item.publisher} published "${item.title}"${item.published_at ? ` on ${fmtDate(item.published_at)}` : ''}.`,
    source: { url: item.url, publisher: item.publisher, published_at: item.published_at },
    as_of: (item.published_at || '').slice(0, 10) || null,
  })];
}

/**
 * Assemble. `parts` is a list of fact arrays; empty families simply do not
 * appear, which is what keeps an absent market from becoming a paragraph about
 * an absent market.
 */
export function buildPacket({ storyType, asOf = null, live = false, entities = {}, parts = [], links = [] }) {
  const facts = parts.flat().filter(Boolean);
  const families = [...new Set(facts.map((f) => f.family))];
  if (asOf) {
    for (const f of facts) {
      if (f.as_of && f.as_of.slice(0, 10) > asOf) {
        throw new Error(`as-of leak: ${f.family} fact dated ${f.as_of} in a packet as of ${asOf}`);
      }
    }
  }
  return {
    version: 4,
    story_type: storyType,
    as_of: asOf,
    live,
    built_at: new Date().toISOString(),
    entities,
    facts,
    families,
    fact_count: facts.length,
    links,
  };
}
