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
    for (const c of raw.competitions) {
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

  /* Referee name for a competition, or null. */
  async referee(officialsRef) {
    if (!officialsRef) return null;
    const j = await this.json(officialsRef);
    const ref = (j?.items || []).find((o) => o?.position?.name === 'Referee');
    return ref ? `${ref.firstName || ''} ${ref.lastName || ''}`.trim() || null : null;
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
