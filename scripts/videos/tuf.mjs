/* The Ultimate Fighter tag for official videos.
 *
 * TUF videos go through the same pipeline as every other official video; this
 * only answers "which season, which episode, what kind" so the archive can
 * find them. It never links a video to a bout: an in-house fight has no row in
 * ufc_bouts, and a finale bout is linked by the existing event/bout resolver
 * like any other card. The tag rides in source_metadata.tuf, so no column,
 * enum value or migration is needed.
 *
 * Every field is derived from text the publisher wrote (title, then the
 * playlist the video sits in, then the description) and records which text it
 * came from. Nothing is guessed from the upload date.
 */
import SEASONS from '../../web/data/tuf/seasons.json' with { type: 'json' };

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const IS_TUF = /ultimate\s+fighter|\btuf\s?\d{0,2}\b|#tuf\d*/i;

/* "Team Cormier vs. Team Sonnen" -> "cormier sonnen", for matching the team
 * pairing a title or playlist prints. Order-insensitive. */
function pairingKey(text) {
  const m = fold(text).match(/team\s+([a-z][a-z' -]*?)\s+vs\.?\s+team\s+([a-z][a-z' -]*?)(?=$|[^a-z' -])/);
  return m ? [m[1].trim(), m[2].trim()].sort().join('|') : null;
}

const US = SEASONS.seasons.filter((s) => s.edition === 'us');
const BY_PAIRING = new Map();
for (const s of SEASONS.seasons) {
  const k = pairingKey(s.name);
  if (!k) continue;
  if (!BY_PAIRING.has(k)) BY_PAIRING.set(k, []);
  BY_PAIRING.get(k).push(s.slug);
}
const EDITIONS = [
  [/\bbrazil\s*(\d)?\b|\bbrasil\s*(\d)?\b/i, (m) => `tuf-brazil-${m[1] || m[2] || 1}`],
  [/\blatin\s+america\s*(\d)?\b|\blatinoam[eé]rica\s*(\d)?\b/i, (m) => `tuf-latam-${m[1] || m[2] || 1}`],
  [/\bnations\b/i, () => 'tuf-nations-1'],
  [/\bchina\b/i, () => 'tuf-china-1'],
  [/\bthe\s+smashes\b/i, () => 'tuf-smashes-1'],
];

function seasonFrom(text) {
  if (!text || !IS_TUF.test(text)) return null;
  for (const [re, slug] of EDITIONS) {
    const m = text.match(re);
    if (m) return { slug: slug(m), rule: 'edition name' };
  }
  const num = text.match(/\b(?:the\s+ultimate\s+fighter|tuf)\s*#?(\d{1,2})\b/i) || text.match(/#tuf(\d{1,2})\b/i) || text.match(/\bseason\s+(\d{1,2})\b/i);
  if (num && US.some((s) => s.number === Number(num[1]))) return { slug: `tuf-${Number(num[1])}`, rule: 'season number' };
  const k = pairingKey(text);
  if (k && BY_PAIRING.get(k)?.length === 1) return { slug: BY_PAIRING.get(k)[0], rule: 'team pairing' };
  return null;
}

/* Ordered: first match wins. */
const KINDS = [
  ['free_fight', /\bfree\s?fight\b|\bfull\s?fight\b/i],
  ['finale', /\bfinale\b/i],
  ['episode_recap', /\brecap\b|\baftermath\b|\bafter\s+tuf\b/i],
  ['episode_preview', /\bpreview\b|\bsneak\s+peek\b|\btrailer\b|\bon this season\b|\bnext week\b|\bpromo\b/i],
  ['weigh_in', /\bweigh[\s-]?ins?\b/i],
  ['retrospective', /\btuf\s+moments\b|\brewind\b|\brelives?\b|\bgreatest\b|\bflashback\b|\bthrowback\b|\bhistory\b|\blook\s+back\b/i],
  ['coach_clip', /\bcoach(?:es|ing)?\b/i],
  ['contestant_interview', /\binterviews?\b|\btalks?\b|\bget to know\b|\bmeet\b/i],
];

/**
 * { season, episode, kind, evidence } for a TUF video, or null for a video
 * that is not about The Ultimate Fighter.
 */
export function tufTag({ title, description, playlistTitle, durationSec } = {}) {
  const t = String(title || '');
  const p = String(playlistTitle || '');
  const d = String(description || '').slice(0, 600);
  if (!IS_TUF.test(t) && !IS_TUF.test(p)) return null;

  const evidence = {};
  let season = seasonFrom(t);
  if (season) evidence.season = { from: 'title', rule: season.rule };
  else if ((season = seasonFrom(p))) evidence.season = { from: 'playlist', rule: season.rule };
  else if ((season = seasonFrom(d))) evidence.season = { from: 'description', rule: season.rule };

  const ep = t.match(/\bep(?:isode|\.)?\s*(\d{1,2})\b/i);
  if (ep) evidence.episode = { from: 'title' };

  let kind = null;
  for (const [k, re] of KINDS) {
    if (re.test(t)) { kind = k; evidence.kind = { from: 'title', pattern: String(re) }; break; }
  }
  if (!kind && Number.isFinite(durationSec) && durationSec > 0 && durationSec <= 60) {
    kind = 'short_clip';
    evidence.kind = { from: 'duration', seconds: durationSec };
  }

  return {
    season: season?.slug ?? null,
    episode: ep ? Number(ep[1]) : null,
    kind: kind ?? 'other',
    evidence,
  };
}
