/* ESPN MMA (UFC) public JSON — schedule and results source for the Worker.
 *
 * Decision 2026-09-05: ESPN is the primary source for events, bouts, results
 * and fighter identity; UFC Stats supplies round stats only. Field notes and
 * the endpoints verified live are in docs/scraper_notes.md ("ESPN").
 *
 * No auth. Plain fetch with a browser UA. site.api.espn.com returns 403 for
 * non-browser clients; site.web.api.espn.com and sports.core.api.espn.com do
 * not. Everything here uses the core API, which has stable $ref links.
 *
 * Every accessor validates the shape it needs and throws SchemaAssertionError
 * otherwise — never returns a half-parsed bout.
 */
import { SchemaAssertionError } from './ufcstats.mjs';
import ENUMS from './shared/enums.json' with { type: 'json' };

const CORE = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/* ESPN publishes slot rows named "Judge 1", "Judge 2" for bouts whose
 * officials have not been filed yet. Observed on this card's three finishes,
 * which carry no linescore at all, and on one decision before ESPN filled the
 * real names in. A slot is not an official and must never become a stored
 * judge identity or a /judges profile. */
const PLACEHOLDER_OFFICIAL = /^judge\s*\d+$/i;

function officialIdFromRef(ref) {
  const m = /\/officials\/(\d+)/.exec(String(ref || ''));
  return m ? m[1] : null;
}

export class Espn {
  constructor({ minIntervalMs = 250 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.subrequests = 0;
  }

  async json(url) {
    const wait = this.minIntervalMs - (Date.now() - this.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const u = String(url).replace(/^http:/, 'https:');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.subrequests += 1;
      let res;
      try {
        res = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 0 } });
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(res.status)) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      if (res.status !== 200) throw new SchemaAssertionError(u, `ESPN HTTP ${res.status}`);
      return res.json();
    }
    throw new SchemaAssertionError(u, 'ESPN gave up after 4 attempts');
  }

  /* Event refs for a calendar year (or a YYYYMMDD / YYYYMMDD-YYYYMMDD range). */
  async eventRefs(dates) {
    const j = await this.json(`${CORE}/events?dates=${dates}&limit=200`);
    if (!Array.isArray(j?.items)) throw new SchemaAssertionError(`${CORE}/events?dates=${dates}`, 'events.items missing');
    return j.items.map((i) => i.$ref);
  }

  /* Full event with inline competitions. */
  async event(refOrId) {
    const url = String(refOrId).startsWith('http') ? refOrId : `${CORE}/events/${refOrId}?lang=en&region=us`;
    const ev = await this.json(url);
    for (const k of ['id', 'date', 'name', 'competitions', 'status']) {
      if (ev?.[k] === undefined) throw new SchemaAssertionError(url, `event.${k} missing`);
    }
    if (!Array.isArray(ev.competitions)) throw new SchemaAssertionError(url, 'event.competitions not a list');
    let venue = null;
    if (ev.venues?.[0]?.$ref) {
      const v = await this.json(ev.venues[0].$ref);
      venue = { name: v.fullName || null, city: v.address?.city || null, region: v.address?.state || null, country: v.address?.country || null };
    }
    return { url, raw: ev, venue };
  }

  /* Normalised bout rows from an event payload. Results require one status
   * call per competition (the inline status is only a $ref). */
  async bouts(evPayload) {
    const { url, raw } = evPayload;
    const out = [];
    evPayload.skipped = [];
    for (const c of raw.competitions) {
      /* ESPN publishes placeholder competitions on announced cards (seen on
       * Contender Series weeks: no type, no second competitor). A placeholder
       * is not a bout; skip it with a note instead of aborting the run. A
       * COMPLETED competition missing these fields is still an assertion. */
      const completedFlag = c?.status?.type?.completed === true;
      const placeholder = c?.type === undefined || !Array.isArray(c?.competitors) || c.competitors.length !== 2
        || c.competitors.some((x) => !x?.athlete?.$ref);
      if (placeholder && !completedFlag) { evPayload.skipped.push(String(c?.id || '?')); continue; }
      for (const k of ['id', 'competitors', 'type', 'matchNumber', 'status']) {
        if (c?.[k] === undefined) throw new SchemaAssertionError(url, `competition.${k} missing (competition ${c?.id})`);
      }
      if (!Array.isArray(c.competitors) || c.competitors.length !== 2) throw new SchemaAssertionError(url, `competition ${c.id} needs exactly 2 competitors`);
      const comps = [...c.competitors].sort((a, b) => Number(a.order) - Number(b.order));
      const fighters = comps.map((x) => {
        const id = String(x.id || '');
        if (!/^\d+$/.test(id) || !x.athlete?.$ref) throw new SchemaAssertionError(url, `competitor without athlete id in competition ${c.id}`);
        return { espn_athlete_id: id, athlete_ref: x.athlete.$ref, winner: x.winner === true };
      });
      const st = await this.json(c.status.$ref);
      const stType = st?.type?.name;
      if (!stType) throw new SchemaAssertionError(c.status.$ref, 'status.type.name missing');
      const completed = st.type.completed === true && st.type.state === 'post';
      const seg = c.cardSegment?.description || null;
      const cardPos = seg ? (ENUMS.espn.card_segment_map[seg] ?? null) : null;
      if (seg && cardPos === null) throw new SchemaAssertionError(url, `unknown cardSegment ${JSON.stringify(seg)}`);
      let result = null;
      if (completed) {
        const r = st.result;
        if (!r?.displayName) throw new SchemaAssertionError(c.status.$ref, `completed bout without result (status ${stType})`);
        result = {
          method_raw: r.displayName,
          finish_detail: r.description || null,
          target: r.target?.description || null,
          round: Number.isInteger(st.period) ? st.period : null,
          time: st.displayClock || null,
          winner_espn_athlete_id: fighters.find((f) => f.winner)?.espn_athlete_id || null,
        };
      }
      /* ESPN matchNumber 1 = main event and lists competitions last-fight-first
       * (verified 2026-09-05 on event 600056266: matchNumber 1 = Kape vs
       * Royval). Our bout_order is main event = highest, so invert. */
      out.push({
        espn_competition_id: String(c.id),
        espn_match_number: Number(c.matchNumber),
        bout_order: raw.competitions.length + 1 - Number(c.matchNumber),
        weight_class_raw: c.type?.text || c.type?.abbreviation || '',
        time_format: c.description || null,
        scheduled_rounds: Number.isInteger(c.format?.regulation?.periods) ? c.format.regulation.periods : null,
        card_position: cardPos,
        status_name: stType,             // STATUS_SCHEDULED | STATUS_FINAL | STATUS_CANCELED | ...
        completed,
        fighters,
        result,
        officials_ref: c.officials?.$ref || null,
        source_url: c.$ref || url,
      });
    }
    return out;
  }

  /* Referee and judges for a competition, from the single officials call.
   *
   * ESPN files an official's role in position.name ('Referee' | 'Judge').
   * Judges keep ESPN's own `order`, which is what makes judge_1/2/3 stable
   * across runs: the source decides the ordering, not the order two linescore
   * responses happened to arrive in. */
  async officiating(officialsRef) {
    if (!officialsRef) return { referee: null, judges: [] };
    const j = await this.json(officialsRef);
    const items = Array.isArray(j?.items) ? j.items : [];
    const nameOf = (o) => `${o?.firstName || ''} ${o?.lastName || ''}`.trim();
    const ref = items.find((o) => o?.position?.name === 'Referee');
    const judges = items
      .filter((o) => o?.position?.name === 'Judge')
      .map((o) => ({ id: String(o.id), name: nameOf(o), order: Number.isFinite(Number(o.order)) ? Number(o.order) : 99 }))
      .sort((a, b) => a.order - b.order);
    return { referee: ref ? nameOf(ref) || null : null, judges };
  }

  /* Official judge card TOTALS for a judged bout.
   *
   * These are final card totals and nothing else. ESPN reports every judge
   * linescore at period 0 — there is no per-round judge score anywhere in the
   * public graph — so this must never be presented, stored or reshaped as a
   * round-by-round card. Verified across the 2019, 2023, 2024 and 2026
   * archives: period is 0 in every linescore returned.
   *
   * A card is only emitted when BOTH corners carry a score from the SAME
   * official. The join is on official.$ref, not on display order, because the
   * two linescore responses are per competitor and ESPN's per-response
   * ordering is not guaranteed to agree.
   *
   * The pair is written in ESPN's competitor order, consistently for every
   * card of the bout. It is deliberately NOT pre-oriented to fighter_a: the
   * archive stores a bare pair and lib/judgeScoring.ts derives orientation
   * from the recorded winner and the bout's full tally. Feeding that resolver
   * a consistent pair is what keeps one scorecard model instead of two. */
  async scorecards(competitionRef, competitorIds, judges) {
    const base = String(competitionRef).split('?')[0].replace(/^http:/, 'https:');
    if (!/\/competitions\/\d+$/.test(base) || competitorIds.length !== 2) {
      return { cards: [], rejected: [], scoredJudges: 0 };
    }
    const judgeById = new Map(judges.map((x) => [x.id, x]));
    const byOfficial = new Map();
    for (const cid of competitorIds) {
      const j = await this.json(`${base}/competitors/${cid}/linescores`);
      for (const item of (j?.items || [])) {
        for (const ls of (item?.linescores || [])) {
          const oid = officialIdFromRef(ls?.official?.$ref);
          const value = Number(ls?.value);
          if (!oid || !Number.isInteger(value)) continue;
          if (!byOfficial.has(oid)) byOfficial.set(oid, {});
          byOfficial.get(oid)[cid] = value;
        }
      }
    }

    const cards = [];
    const rejected = [];
    const ordered = [...byOfficial.keys()]
      .sort((a, b) => (judgeById.get(a)?.order ?? 99) - (judgeById.get(b)?.order ?? 99));
    for (const oid of ordered) {
      const pair = byOfficial.get(oid);
      const first = pair[competitorIds[0]];
      const second = pair[competitorIds[1]];
      /* Half a card is not a card. */
      if (!Number.isInteger(first) || !Number.isInteger(second)) {
        rejected.push({ official_id: oid, name: judgeById.get(oid)?.name || null, reason: 'one_sided_linescore' });
        continue;
      }
      const name = judgeById.get(oid)?.name || '';
      /* ESPN publishes "Judge 1"/"Judge 2" placeholder officials on bouts
       * whose officials have not been filed. Those are slots, not people, and
       * storing one would invent a judge identity and a /judges profile for
       * somebody who does not exist. Drop the card and report it. */
      if (!name) { rejected.push({ official_id: oid, name: null, reason: 'unnamed_official' }); continue; }
      if (PLACEHOLDER_OFFICIAL.test(name)) { rejected.push({ official_id: oid, name, reason: 'placeholder_official' }); continue; }
      cards.push({ judge: name, score: `${first}-${second}` });
    }
    return { cards, rejected, scoredJudges: byOfficial.size };
  }

  /* Athlete identity + physicals. */
  async athlete(refOrId) {
    const url = String(refOrId).startsWith('http') ? refOrId : `${CORE}/athletes/${refOrId}?lang=en&region=us`;
    const a = await this.json(url);
    if (!a?.id || !a?.fullName) throw new SchemaAssertionError(url, 'athlete id/fullName missing');
    let record = null;
    if (a.records?.$ref) {
      try {
        const r = await this.json(a.records.$ref);
        const overall = (r?.items || []).find((x) => x?.name === 'overall' || x?.type === 'total');
        record = overall?.summary || null;
      } catch (_) { record = null; }
    }
    return {
      espn_athlete_id: String(a.id),
      name: a.fullName,
      display_name: a.displayName || a.fullName,
      nickname: a.nickname || null,
      dob: a.dateOfBirth ? String(a.dateOfBirth).slice(0, 10) : null,
      /* ESPN publishes 0 for an unknown reach/height/weight (seen: reach 0.0
       * on athlete 5210642). Zero is never a real value here; store null. */
      height_in: typeof a.height === 'number' && a.height > 0 ? a.height : null,
      reach_in: typeof a.reach === 'number' && a.reach > 0 ? a.reach : null,
      weight_lbs: typeof a.weight === 'number' && a.weight > 0 ? a.weight : null,
      stance_raw: a.stance?.text || null,
      weight_class_raw: a.weightClass?.text || null,
      active: a.active === true,
      record,
      source_url: url,
    };
  }
}
