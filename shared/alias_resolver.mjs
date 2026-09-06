/* PropBetEdge UFC — fighter alias resolution (JS side).
 *
 * Mirror of shared/alias_resolver.py. normalize() and tokenSortRatio() MUST
 * agree byte-for-byte with the Python side; shared/tests runs the same
 * fixtures against both.
 *
 * Match order (kickoff brief):
 *   1. ufcstats_id link            -> matched
 *   2. exact normalized + key      -> matched   (key = weight_class | dob | record)
 *   3. fuzzy >= 90 + dob|record    -> matched
 *   4. otherwise                   -> review row for ufc_alias_review_queue
 * Never auto-merge on name alone.
 */

export const FUZZY_THRESHOLD = 90;
export const REVIEW_FLOOR = 80;

export function normalize(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.`]/g, '')   /* apostrophes and periods vanish: O'Malley -> omalley */
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSort(name) {
  return normalize(name).split(' ').filter(Boolean).sort().join(' ');
}

function lcsLen(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    const cur = [0];
    for (let j = 1; j <= b.length; j += 1) {
      cur.push(a[i] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function ratio(a, b) {
  if (!a && !b) return 100;
  if (!a || !b) return 0;
  return (200 * lcsLen(a, b)) / (a.length + b.length);
}

export function tokenSortRatio(a, b) {
  return ratio(tokenSort(a), tokenSort(b));
}

function normRecord(rec) {
  if (!rec) return null;
  const m = String(rec).match(/(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function normDob(dob) {
  if (!dob) return null;
  const s = String(dob).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* DOB is stable and decisive; record / weight class decide only when DOB could not be
 * compared. A record disagreement never overrides a DOB match (records drift between
 * sources). Mirrors _keys_agree in alias_resolver.py. */
function keysAgree(reasons, allowWeightClass) {
  if (reasons.includes('dob')) return true;
  if (reasons.includes('!dob')) return false;
  const keys = allowWeightClass ? ['record', 'weight_class'] : ['record'];
  if (keys.some((k) => reasons.includes(`!${k}`))) return false;
  return keys.some((k) => reasons.includes(k));
}

/* fighters: [{ id, ufcstats_id, name, nickname, dob, record, weight_classes:[], aliases:[] }] */
export class AliasResolver {
  constructor(fighters = [], threshold = FUZZY_THRESHOLD) {
    this.threshold = threshold;
    this.byId = new Map();
    this.byUfcstats = new Map();
    this.byNorm = new Map();
    this.tokenIndex = new Map();
    this.norms = new Map();
    for (const f of fighters) this.add(f);
  }

  add(f) {
    const fighter = {
      ...f,
      weight_classes: new Set(f.weight_classes || []),
      aliases: new Set(f.aliases || []),
    };
    this.byId.set(f.id, fighter);
    if (f.ufcstats_id) this.byUfcstats.set(f.ufcstats_id, f.id);
    const raws = new Set([f.name, ...fighter.aliases]);
    for (const raw of raws) {
      const n = normalize(raw);
      if (!n) continue;
      if (!this.byNorm.has(n)) this.byNorm.set(n, new Set());
      this.byNorm.get(n).add(f.id);
      if (!this.norms.has(f.id)) this.norms.set(f.id, new Set());
      this.norms.get(f.id).add(n);
      for (const tok of n.split(' ')) {
        if (tok.length < 2) continue;
        if (!this.tokenIndex.has(tok)) this.tokenIndex.set(tok, new Set());
        this.tokenIndex.get(tok).add(f.id);
      }
    }
  }

  secondKeyAgreement(f, weightClass, dob, record) {
    const agree = [], disagree = [];
    if (weightClass && f.weight_classes.size) {
      (f.weight_classes.has(weightClass) ? agree : disagree).push('weight_class');
    }
    if (dob) {
      const d = normDob(dob);
      if (d && f.dob) (d === normDob(f.dob) ? agree : disagree).push('dob');
    }
    if (record) {
      const r = normRecord(record);
      if (r && f.record) (r === normRecord(f.record) ? agree : disagree).push('record');
    }
    return { agree, disagree };
  }

  resolve(rawName, source, { ufcstats_id = null, weight_class = null, dob = null, record = null, context = {} } = {}) {
    if (ufcstats_id && this.byUfcstats.has(ufcstats_id)) {
      const fid = this.byUfcstats.get(ufcstats_id);
      return { status: 'matched', fighter_id: fid, method: 'ufcstats_id', score: 100,
        candidates: [{ fighter_id: fid, score: 100, reasons: ['ufcstats_id'] }] };
    }
    const n = normalize(rawName);
    if (!n) return { status: 'unmatched', candidates: [] };

    const exactIds = [...(this.byNorm.get(n) || [])].sort();
    const candidates = [];
    for (const fid of exactIds) {
      const { agree, disagree } = this.secondKeyAgreement(this.byId.get(fid), weight_class, dob, record);
      candidates.push({ fighter_id: fid, score: 100, reasons: ['exact_normalized', ...agree, ...disagree.map((d) => `!${d}`)] });
    }
    const agreeing = candidates.filter((c) => keysAgree(c.reasons, true));
    if (agreeing.length === 1) {
      return { status: 'matched', fighter_id: agreeing[0].fighter_id, method: 'exact_normalized', score: 100, candidates };
    }

    const exclude = new Set(exactIds);
    for (const [fid, score] of this.fuzzyCandidates(n, exclude)) {
      const { agree, disagree } = this.secondKeyAgreement(this.byId.get(fid), null, dob, record);
      candidates.push({ fighter_id: fid, score, reasons: ['fuzzy', ...agree, ...disagree.map((d) => `!${d}`)] });
    }
    const strong = candidates.filter((c) => c.reasons.includes('fuzzy') && c.score >= this.threshold && keysAgree(c.reasons, false));
    if (strong.length === 1 && agreeing.length === 0) {
      return { status: 'matched', fighter_id: strong[0].fighter_id, method: 'fuzzy_second_key', score: strong[0].score, candidates };
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.fighter_id < b.fighter_id ? -1 : 1));
    const listed = candidates.filter((c) => c.score >= REVIEW_FLOOR).slice(0, 5);
    if (!listed.length) return { status: 'unmatched', candidates };
    const review_row = {
      raw_name: rawName,
      source,
      candidate_fighter_ids: listed.map((c) => c.fighter_id),
      context: {
        reason: listed.length > 1 ? 'ambiguous' : 'no_second_key',
        normalized: n, weight_class, dob, record,
        candidates: listed.map((c) => ({ fighter_id: c.fighter_id, score: Math.round(c.score * 10) / 10, reasons: c.reasons })),
        ...context,
      },
    };
    return { status: 'review', candidates, review_row };
  }

  fuzzyCandidates(n, exclude) {
    const pool = new Set();
    for (const tok of n.split(' ')) for (const id of this.tokenIndex.get(tok) || []) pool.add(id);
    const out = [];
    for (const fid of pool) {
      if (exclude.has(fid)) continue;
      let best = 0;
      for (const alias of this.norms.get(fid)) best = Math.max(best, tokenSortRatio(n, alias));
      if (best >= REVIEW_FLOOR) out.push([fid, best]);
    }
    out.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    return out;
  }
}

export function aliasRowsForFighter(fighterId, name, nickname) {
  const rows = [];
  const n = normalize(name);
  if (n) rows.push({ fighter_id: fighterId, alias: name, source: 'ufcstats', normalized: n });
  const nn = normalize(nickname);
  if (nn && nn !== n) rows.push({ fighter_id: fighterId, alias: nickname, source: 'ufcstats_nickname', normalized: nn });
  return rows;
}
