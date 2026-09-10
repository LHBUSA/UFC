import * as cheerio from 'cheerio';

const TRANSLIT = new Map(Object.entries({
  'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ß': 'ss', 'æ': 'ae',
  'œ': 'oe', 'ı': 'i', 'ŋ': 'n', 'ħ': 'h', 'ŧ': 't',
}));

export function normalizeName(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[łøđðþßæœıŋħŧ]/g, (c) => TRANSLIT.get(c) || c)
    .replace(/['’.`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clean($, node) {
  if (!node) return '';
  return $(node).text().replace(/\[[a-z0-9 ]+\]/gi, '').replace(/\s+/g, ' ').trim();
}

function wikiTitleFromHref(href) {
  if (!href || !href.startsWith('/wiki/')) return null;
  let title;
  try { title = decodeURIComponent(href.slice(6).split('#')[0]); }
  catch { return null; }
  if (!title || title.includes(':')) return null;
  return title.replaceAll('_', ' ');
}

function firstWikiTitle($, cell) {
  if (!cell) return null;
  for (const a of $(cell).find('a[href]').toArray()) {
    const title = wikiTitleFromHref($(a).attr('href'));
    if (title) return title;
  }
  return null;
}

function parseDate($, cell) {
  if (!cell) return null;
  const time = $(cell).find('time[datetime]').first().attr('datetime');
  if (time && /^\d{4}-\d{2}-\d{2}/.test(time)) return time.slice(0, 10);
  const bday = clean($, $(cell).find('.bday').first());
  if (/^\d{4}-\d{2}-\d{2}$/.test(bday)) return bday;
  const text = clean($, cell);
  const iso = text.match(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function parseClock(value) {
  const m = String(value || '').match(/\b(\d{1,2}):(\d{2})\b/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function resultEnum(value) {
  const n = normalizeName(value);
  if (n === 'w' || n.startsWith('win')) return 'win';
  if (n === 'l' || n.startsWith('loss')) return 'loss';
  if (n === 'd' || n.startsWith('draw')) return 'draw';
  if (n === 'nc' || n.startsWith('no contest')) return 'no_contest';
  return null;
}

function methodEnum(value) {
  const n = normalizeName(value);
  if (!n) return null;
  if (n.includes('decision')) {
    if (n.includes('split')) return 'DEC_S';
    if (n.includes('majority')) return 'DEC_M';
    return 'DEC_U';
  }
  if (n.includes('submission')) return 'SUB';
  if (n.includes('disqualification') || n.startsWith('dq')) return 'DQ';
  if (n.includes('no contest')) return 'NC';
  if (n.includes('draw')) return 'DRAW';
  if (['ko', 'tko', 'knockout', 'doctor stoppage', 'corner stoppage'].some((x) => n.includes(x))) return 'KO_TKO';
  return 'OTHER';
}

const PROMOTIONS = [
  [/^ufc\b|ultimate fighting championship/, 'ufc', 'Ultimate Fighting Championship'],
  [/^pride\b|pride fighting championships/, 'pride', 'PRIDE Fighting Championships'],
  [/^wec\b|world extreme cagefighting/, 'wec', 'World Extreme Cagefighting'],
  [/^strikeforce\b/, 'strikeforce', 'Strikeforce'],
  [/^bellator\b/, 'bellator', 'Bellator MMA'],
  [/^pfl\b|professional fighters league/, 'pfl', 'Professional Fighters League'],
  [/^wsof\b|world series of fighting/, 'wsof', 'World Series of Fighting'],
  [/^one\b|one championship/, 'one', 'ONE Championship'],
  [/^rizin\b/, 'rizin', 'Rizin Fighting Federation'],
  [/^ksw\b|konfrontacja sztuk walki/, 'ksw', 'KSW'],
  [/^cage warriors\b|^cwfc\b/, 'cage-warriors', 'Cage Warriors'],
  [/^lfa\b|legacy fighting alliance/, 'lfa', 'Legacy Fighting Alliance'],
  [/^invicta\b/, 'invicta', 'Invicta Fighting Championships'],
  [/^brave\b/, 'brave', 'BRAVE Combat Federation'],
  [/^oktagon\b/, 'oktagon', 'OKTAGON MMA'],
  [/^dream\b/, 'dream', 'DREAM'],
  [/^shooto\b/, 'shooto', 'Shooto'],
  [/^pancrase\b/, 'pancrase', 'Pancrase'],
  [/^m ?1\b/, 'm1', 'M-1 Global'],
];

export function promotionGuess(eventName) {
  const n = normalizeName(eventName);
  for (const [re, slug, display] of PROMOTIONS) if (re.test(n)) return { slug, name: display, recognized: true };
  const first = String(eventName || '').split(/\s*[:\-–—]\s*/, 1)[0].trim();
  const slug = normalizeName(first).replaceAll(' ', '-').slice(0, 80) || 'unknown';
  return { slug, name: first.slice(0, 160) || 'Unknown', recognized: false };
}

function canonicalHeader(value) {
  const n = normalizeName(value).replaceAll(' ', '_');
  return ({ res: 'result', result: 'result', record: 'record', opponent: 'opponent', method: 'method',
    event: 'event', date: 'date', round: 'round', time: 'time', location: 'location', notes: 'notes' })[n] || n;
}

function headerMap($, table) {
  for (const tr of $(table).find('tr').toArray()) {
    const cells = $(tr).children('th,td').toArray();
    if (!cells.length) continue;
    const map = new Map();
    cells.forEach((cell, i) => {
      const key = canonicalHeader(clean($, cell));
      if (key) map.set(key, i);
    });
    const required = ['result', 'opponent', 'method', 'event', 'date', 'round', 'time'];
    if (required.every((k) => map.has(k))) return { map, tr };
  }
  return null;
}

function infoboxDob($) {
  const bday = clean($, $('.infobox .bday').first());
  if (/^\d{4}-\d{2}-\d{2}$/.test(bday)) return bday;
  const raw = $('.infobox time[datetime]').first().attr('datetime');
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

export function parseMmaRecord(html) {
  const $ = cheerio.load(html || '');
  const candidates = [];
  for (const table of $('table').toArray()) {
    const h = headerMap($, table);
    if (h) candidates.push({ table, ...h, size: $(table).find('tr').length });
  }
  if (!candidates.length) return { dob: infoboxDob($), rows: [], table_count: 0 };
  candidates.sort((a, b) => b.size - a.size);
  const { table, map, tr: headerRow } = candidates[0];
  const rows = [];
  let started = false;
  let rowIndex = 0;
  for (const tr of $(table).find('tr').toArray()) {
    if (tr === headerRow) { started = true; continue; }
    if (!started) continue;
    const cells = $(tr).children('td').toArray();
    if (!cells.length) continue;
    rowIndex += 1;
    const cell = (key) => {
      const i = map.get(key);
      return Number.isInteger(i) && i < cells.length ? cells[i] : null;
    };
    const result = resultEnum(clean($, cell('result')));
    const opponent = clean($, cell('opponent'));
    const event = clean($, cell('event'));
    if (!result || !opponent || !event) continue;
    const methodRaw = clean($, cell('method')) || null;
    const roundRaw = clean($, cell('round'));
    const promotion = promotionGuess(event);
    rows.push({
      result,
      record_text: clean($, cell('record')) || null,
      opponent,
      opponent_wiki_title: firstWikiTitle($, cell('opponent')),
      method: methodEnum(methodRaw),
      method_raw: methodRaw,
      event,
      event_wiki_title: firstWikiTitle($, cell('event')),
      event_date: parseDate($, cell('date')),
      round: /^\d+$/.test(roundRaw) ? Number(roundRaw) : null,
      time_sec: parseClock(clean($, cell('time'))),
      location: clean($, cell('location')) || null,
      promotion_slug: promotion.slug,
      promotion_name: promotion.name,
      promotion_recognized: promotion.recognized,
      row_index: rowIndex,
    });
  }
  return { dob: infoboxDob($), rows, table_count: candidates.length };
}
