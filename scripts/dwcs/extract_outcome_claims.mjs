#!/usr/bin/env node
/* Contender Series outcome claims from ALREADY-CAPTURED official articles.
 *
 *   node scripts/dwcs/extract_outcome_claims.mjs --html-dir <dir of captured UFC.com article HTML> \
 *        [--espn-dir <dir of captured ESPN roundup JSON>] --out <claims.json>
 *
 * This is not a crawler. It reads pages that were captured once, by hand, for
 * the 2026-09-12 source scout, and it never fetches UFC.com. It reads the
 * canonical database (read-only) for the cards the articles describe.
 *
 * The rule it exists to enforce: a contract is NEVER inferred from a win.
 * A claim is emitted only when an official article sentence explicitly says a
 * named fighter was awarded a contract (or a developmental deal, or a TUF
 * invite), and that name resolves to exactly one fighter on the card the
 * article is about. Everything the extractor is not sure of is dropped or held
 * for review, because a public "Contract awarded" badge that is wrong is worse
 * than no badge:
 *
 *   - speculative / negated / historical sentences are skipped outright
 *     ("hoping for a contract", "did not earn", "returning", "in 2019", ...)
 *   - a sentence naming BOTH fighters of one bout is skipped (who got the
 *     deal is then a reading, not a statement)
 *   - a surname alone counts only when it is capitalised in the text and
 *     unique among the fighters in the article's scope
 *   - aggregate counts ("44 contracts this season") never create a claim
 *   - a claim naming a fighter who did not WIN that bout is held as `review`
 *     (the statement may be true — losers have been signed — but a sentence
 *     disagreeing with the stored result is exactly what extraction gets wrong)
 *   - a season recap (no week) never places a fighter with more than one DWCS
 *     appearance: "second chance" paragraphs attach later contracts to earlier
 *     wins
 *   - ESPN roundups are an attributed, non-official second source: agreement is
 *     recorded as corroboration, an ESPN-only name is `secondary_only`, and a
 *     fighter the two sources place at different events is `conflicted` on
 *     both sides. None of those is eligible for display.
 *
 * `eligible` is TRIAGE, not display: nothing is shown until an operator records
 * a resolution in ufc_dwcs_outcome_resolutions (migration 20260913000006).
 *
 * Output rows match public.ufc_dwcs_outcome_claims. Excerpts are capped at 200
 * characters: evidentiary, never the article.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const HTML_DIR = opt('--html-dir');
const ESPN_DIR = opt('--espn-dir');
const OUT = opt('--out');
if (!HTML_DIR || !OUT) { console.error('usage: --html-dir DIR [--espn-dir DIR] --out FILE'); process.exit(2); }

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
const env = Object.fromEntries((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').replace(/^﻿/, '')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const BASE = (process.env.SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, Accept: 'application/json', ...(KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}) };
async function getAll(p) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${BASE}/rest/v1/${p}&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) throw new Error(`${p} ${r.status}`);
    const rows = await r.json(); out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}

/* ---- canonical cards ---------------------------------------------------- */
const events = (await getAll('ufc_events?select=id,name,event_date&name=ilike.*contender%20series*&order=event_date.asc'))
  .filter((e) => !/road to ufc/i.test(e.name));
const evMeta = new Map(events.map((e) => {
  const season = Number(e.name.match(/season\s*(\d+)/i)?.[1]) || null;
  const week = Number(e.name.match(/week\s*(\d+)/i)?.[1]) || null;
  return [e.id, { ...e, season, week, brazil: /brazil/i.test(e.name) }];
}));
const bouts = [];
for (let i = 0; i < events.length; i += 50) {
  bouts.push(...await getAll(`ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,result:ufc_bout_results(winner_id,method)&event_id=in.(${events.slice(i, i + 50).map((e) => e.id).join(',')})&order=id.asc`));
}
const fids = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];
const fighters = new Map();
for (let i = 0; i < fids.length; i += 150) {
  for (const f of await getAll(`ufc_fighters?select=id,name&id=in.(${fids.slice(i, i + 150).join(',')})&order=id.asc`)) fighters.set(f.id, f);
}

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'");
const norm = (s) => fold(s).toLowerCase().replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim();
const SUFFIX = new Set(['jr', 'jr.', 'sr', 'ii', 'iii', 'iv']);
const PARTICLE = new Set(['de', 'da', 'do', 'dos', 'das', 'van', 'von', 'der', 'del', 'la', 'le', 'el', 'al', 'st', 'st.', 'di', 'du', 'ter', 'bin', 'ben']);
function surnameOf(name) {
  const t = fold(name).split(/\s+/).filter((x) => !SUFFIX.has(x.toLowerCase()));
  if (t.length < 2) return null;
  const last = t[t.length - 1];
  return t.length >= 3 && PARTICLE.has(t[t.length - 2].toLowerCase()) ? `${t[t.length - 2]} ${last}` : last;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Fighters in scope for (season, week|null). Each carries its bout. */
function scope(season, week) {
  const evs = [...evMeta.values()].filter((e) => !e.brazil && e.season === season && (week == null || e.week === week));
  const rows = [];
  for (const b of bouts.filter((x) => evs.some((e) => e.id === x.event_id))) {
    for (const fid of [b.fighter_a_id, b.fighter_b_id]) {
      const f = fighters.get(fid);
      if (f) rows.push({ fighter: f, bout: b, event: evMeta.get(b.event_id), opponentId: fid === b.fighter_a_id ? b.fighter_b_id : b.fighter_a_id });
    }
  }
  return rows;
}

/* First names of every DWCS fighter: a capitalised first name standing before
 * a surname means the sentence is naming SOMEONE ELSE with that surname. */
const FIRST_NAMES = new Set([...fighters.values()].map((f) => fold(f.name).split(/\s+/)[0].toLowerCase()));

const APPEARANCES = bouts.reduce((m, b) => { for (const f of [b.fighter_a_id, b.fighter_b_id]) m.set(f, (m.get(f) || 0) + 1); return m; }, new Map());

function namesIn(sentence, rows, weekKnown = true) {
  const text = fold(sentence);
  const normText = norm(text);
  const hits = new Map();
  for (const r of rows) {
    const full = norm(r.fighter.name);
    if (full && new RegExp(`(^|[^a-z])${esc(full)}($|[^a-z])`).test(normText)) hits.set(r.fighter.id, { r, via: 'full_name' });
  }
  /* Surname-only matching is allowed only when the LAST name token is unique
   * in scope: "Silva" is never matched while both a Danny Silva and an Igor
   * da Silva are on the card. */
  const lastCount = new Map();
  for (const r of rows) { const l = fold(r.fighter.name).split(/\s+/).filter((x) => !SUFFIX.has(x.toLowerCase())).pop()?.toLowerCase(); if (l) lastCount.set(l, (lastCount.get(l) || 0) + 1); }
  for (const r of rows) {
    if (hits.has(r.fighter.id)) continue;
    const s = surnameOf(r.fighter.name);
    if (!s || s.length < 3 || lastCount.get(s.split(' ').pop().toLowerCase()) !== 1) continue;
    const own = fold(r.fighter.name).toLowerCase().split(/\s+/);
    /* Case-sensitive: "Young" the fighter, never "young" the adjective. */
    const re = new RegExp(`(?:^|[^A-Za-z'])(?:([A-Za-z][A-Za-z'-]*)\\s+)?${esc(s)}(?:'s)?(?=$|[^A-Za-z])`, 'g');
    for (const m of text.matchAll(re)) {
      const prev = (m[1] || '').toLowerCase();
      if (prev && PARTICLE.has(prev)) continue;                                   // "Igor da Silva"
      if (prev && FIRST_NAMES.has(prev) && !own.includes(prev)) continue;         // another fighter's full name
      hits.set(r.fighter.id, { r, via: 'surname_unique_in_scope' });
      break;
    }
  }
  /* A fighter with two bouts in scope (a season recap naming a fighter who
   * appeared twice that season) cannot be tied to one bout by the sentence
   * alone. Dropped, not guessed. */
  const perFighter = rows.reduce((m, r) => m.set(r.fighter.id, (m.get(r.fighter.id) || 0) + 1), new Map());
  return [...hits.values()].filter((h) => perFighter.get(h.r.fighter.id) === 1
    /* An article without a week (a season recap) cannot place a fighter who
     * appeared on DWCS more than once: the 2021 Season 1 recap credits
     * Nzechukwu and Espinosa's 2018 "second chance" contracts in a paragraph
     * that would otherwise attach them to their 2017 wins. */
    && (weekKnown || (APPEARANCES.get(h.r.fighter.id) || 0) === 1));
}

/* "deal" only as a noun meaning a contract ("a UFC deal", "earned deals"),
 * never "a handful to deal with" or "a great deal of grappling". */
const CONTRACT = /\bcontracts?\b|\b(?:ufc|developmental|earn(?:ed|s)?|awarded|secured|inked|handed out|given)\s+(?:ufc\s+)?deals?\b|\badded to the (?:ufc )?roster\b|\bjoin(?:ed|s|ing)? the (?:ufc )?roster\b|\bon the ufc roster\b/i;
const DEVELOPMENTAL = /\bdevelopmental\b/i;
const TUF = /\bultimate fighter\b|\bTUF\b/;
const HEDGE = /\b(?:not|no|never|without|nor|n't|miss(?:ed|es|ing)?|fell short|denied|pass(?:ed|es)? on|pantomim\w*|hop(?:e|es|ed|ing)|chance|could|would|might|may|should|shot at|seek(?:s|ing)?|looking to|vy(?:ing)?|compet(?:e|es|ing) for|fighting for|in search of|bids?|will|aim(?:s|ing)?|audition|goal|dream|wants?|wanted|try|tried|attempt|prior|previous(?:ly)?|last (?:year|season)|before|former(?:ly)?|already|again|return(?:s|ed|ing)?|if|unless|rematch|another|next|following season|second chances?|looks? to|looking forward)\b|['’]t\b|\b(?:19|20)\d\d\b/i;

/* Sentences, then clauses: a name counts only in the clause that carries the
 * contract statement ("X secured his spot, while Y and Z got contracts"). */
function sentences(block) {
  return fold(block).split(/(?<=[.!?])\s+(?=[A-Z"“])/)
    .flatMap((s) => s.split(/,\s+while\s+|;\s+|,?\s+but\s+|,\s+however,?\s+|,\s+whereas\s+/i))
    .map((s) => s.trim()).filter(Boolean);
}
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const text = (x) => fold(x.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&#x27;/g, "'").replace(/&quot;/g, '"')).replace(/\s+/g, ' ').trim();

function parseArticle(file) {
  const s = fs.readFileSync(file, 'utf8');
  const g = (re) => s.match(re)?.[1] || null;
  const title = text(g(/<h1[^>]*>([\s\S]*?)<\/h1>/) || '');
  const url = g(/og:url" content="([^"]*)/);
  const published = g(/article:published_time" content="([^"]*)/);
  const credit = text(g(/c-hero__article-credit">([\s\S]*?)<\/div>/) || '');
  /* S1/S2 pages carry the 2018 site-migration time as published_time; the
   * byline's display date is the real one. Prefer it whenever it is earlier. */
  const cm = credit.match(/([A-Z][a-z]{2,4})\.? (\d{1,2}), (\d{4})/);
  const creditDate = cm && MONTH[cm[1].toLowerCase().slice(0, 4)] ? `${cm[3]}-${String(MONTH[cm[1].toLowerCase().slice(0, 4)] ?? MONTH[cm[1].toLowerCase().slice(0, 3)]).padStart(2, '0')}-${cm[2].padStart(2, '0')}` : null;
  const pubDate = published ? published.slice(0, 10) : null;
  const sourceDate = creditDate && (!pubDate || creditDate < pubDate) ? creditDate : pubDate;
  const a = s.indexOf('l-two-col__content'); const b = s.indexOf('Up Next', a);
  const body = s.slice(a > 0 ? a : 0, b > 0 ? b : s.length);
  const blocks = [...body.matchAll(/<(p|h2|h3|h4|li)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({ tag: m[1], t: text(m[2]) })).filter((x) => x.t && !/fight pass/i.test(x.t));
  return { file: path.basename(file), title, url, published, sourceDate, blocks };
}

function articleScope(art) {
  const hay = `${art.title} ${art.url || ''}`;
  let season = Number(hay.match(/season[\s-]*(\d{1,2})/i)?.[1]) || null;
  if (!season && /dwtncs|tuesday night contender/i.test(hay) && art.sourceDate) season = Number(art.sourceDate.slice(0, 4)) - 2016;
  let week = Number(hay.match(/(?:week|episode)[\s-]*(\d{1,2})/i)?.[1]) || null;
  if (!week) { const o = hay.toLowerCase().match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) week\b/); if (o) week = ORD[o[1]]; }
  if (!week && /finale/i.test(hay) && season) week = Math.max(...[...evMeta.values()].filter((e) => e.season === season && e.week).map((e) => e.week));
  return { season, week };
}

const claims = [];
const skipped = { articles: [], hedged: 0, both_corners: 0, no_name: 0 };
const files = fs.readdirSync(HTML_DIR).filter((f) => f.endsWith('.html')).map((f) => path.join(HTML_DIR, f));
for (const file of files) {
  const art = parseArticle(file);
  if (!art.url || /preview|weigh-in|updates to|free fights/i.test(art.title)) { skipped.articles.push({ file: art.file, reason: 'not a results/contract article' }); continue; }
  const sc = articleScope(art);
  if (!sc.season) { skipped.articles.push({ file: art.file, reason: 'no season identity' }); continue; }
  let week = sc.week;
  for (const blk of art.blocks) {
    /* Multi-episode pages (Season 5) announce the week in a heading. */
    if (/^h[234]$/.test(blk.tag) || blk.t.length < 60) {
      const m = blk.t.match(/^(?:week|episode)\s*(\d{1,2})\b/i) || blk.t.match(/\b(?:week|episode)\s*(\d{1,2})\s*(?:results|recap|$)/i);
      if (m && !sc.week) week = Number(m[1]);
    }
    for (const sent of sentences(blk.t)) {
      const developmental = DEVELOPMENTAL.test(sent);
      const tuf = TUF.test(sent) && /\binvit/i.test(sent);
      if (!CONTRACT.test(sent) && !tuf) continue;
      if (/\b\d+\s+(?:contracts|deals)\b/i.test(sent) && !/[A-Z][a-z]+ [A-Z][a-z]+/.test(sent.replace(/^[A-Z][a-z]+ /, ''))) continue; // pure aggregate
      if (HEDGE.test(sent)) { skipped.hedged += 1; continue; }
      const rows = scope(sc.season, week);
      const hits = namesIn(sent, rows, week != null);
      if (!hits.length) { skipped.no_name += 1; continue; }
      const boutsNamed = new Map();
      for (const h of hits) boutsNamed.set(h.r.bout.id, (boutsNamed.get(h.r.bout.id) || 0) + 1);
      if ([...boutsNamed.values()].some((n) => n > 1)) { skipped.both_corners += 1; continue; }
      for (const h of hits) {
        const r = h.r;
        const won = r.bout.result && (Array.isArray(r.bout.result) ? r.bout.result[0] : r.bout.result)?.winner_id === r.fighter.id;
        const at = sent.toLowerCase().indexOf(norm(surnameOf(r.fighter.name) || r.fighter.name).split(' ').pop());
        const start = Math.max(0, Math.min(at - 80, sent.length - 200));
        const excerpt = (start > 0 ? '…' : '') + sent.slice(start, start + 200).trim() + (start + 200 < sent.length ? '…' : '');
        claims.push({
          fighter_id: r.fighter.id, event_id: r.event.id, bout_id: r.bout.id,
          claim_type: tuf ? 'tuf_invite' : developmental ? 'developmental_deal' : 'contract_awarded',
          source_url: art.url, source_title: art.title, source_date: art.sourceDate, source_family: 'ufc.com',
          source_excerpt_short: excerpt, claim_status: won ? 'eligible' : 'review',
          review_reason: won ? null : 'claim names a fighter the stored result does not record as the winner',
          evidence: { match: h.via, file: art.file, fighter_name: r.fighter.name, event: r.event.name, article_scope: { season: sc.season, week: sc.week ?? week } },
        });
      }
    }
  }
}

/* One row per (fighter, event, claim type, source URL). */
const seen = new Set();
const uniq = claims.filter((c) => { const k = `${c.fighter_id}|${c.event_id}|${c.claim_type}|${c.source_url}`; if (seen.has(k)) return false; seen.add(k); return true; });

/* ESPN season roundups: an attributed but NOT official second source.
 *
 *   - names the same fighter for the same week as UFC.com -> corroboration,
 *     recorded on the UFC.com claim; no extra public row
 *   - names a fighter for a week UFC.com does not         -> `secondary_only`
 *     (kept as evidence, never eligible: ESPN is not the official source,
 *     and an unmatched UFC.com sentence is a recall gap, not a contradiction)
 *   - names a fighter for a DIFFERENT event than UFC.com   -> a real conflict:
 *     both rows become `conflicted` and nothing is eligible for that fighter */
const secondary = [];
if (ESPN_DIR && fs.existsSync(ESPN_DIR)) {
  for (const f of fs.readdirSync(ESPN_DIR).filter((x) => /^espn_\d+\.json$/.test(x))) {
    const j = JSON.parse(fs.readFileSync(path.join(ESPN_DIR, f), 'utf8'));
    const h = j.headlines?.[0]; if (!h?.story) continue;
    const season = Number(String(h.headline).match(/season\s*(\d+)/i)?.[1]); if (!season) continue;
    const t = text(h.story);
    const url = h.links?.web?.href || `https://www.espn.com/mma/story/_/id/${h.id || f.match(/\d+/)[0]}`;
    /* Season 6-9 roundups differ in punctuation: "Week 3 results:" with bullet
     * rows, or "Week 3 results" followed by plain sentences. */
    for (const part of t.split(/(?=Week \d+ results:?\s)/)) {
      const wk = Number(part.match(/^Week (\d+) results:?\s/)?.[1]); if (!wk) continue;
      const sents = part.split(/\*+|\s\+|(?<=[a-z]{3}\.)\s+(?=[A-Z])/).map((x) => x.trim())
        .filter((x) => /(?:awarded|given|earned) (?:a |UFC )*(?:UFC )?contracts?/i.test(x) && !HEDGE.test(x));
      for (const sent of sents) {
        for (const hit of namesIn(sent, scope(season, wk))) {
          const mine = uniq.filter((c) => c.fighter_id === hit.r.fighter.id && c.claim_type === 'contract_awarded');
          const same = mine.filter((c) => c.event_id === hit.r.event.id);
          const elsewhere = mine.filter((c) => c.event_id !== hit.r.event.id);
          if (same.length) {
            for (const c of same) c.evidence.corroborated_by = [...new Set([...(c.evidence.corroborated_by || []), url])];
            continue;
          }
          const status = elsewhere.length ? 'conflicted' : 'secondary_only';
          for (const c of elsewhere) { c.claim_status = 'conflicted'; c.review_reason = `ESPN places this contract at ${hit.r.event.name}`; }
          secondary.push({
            fighter_id: hit.r.fighter.id, event_id: hit.r.event.id, bout_id: hit.r.bout.id, claim_type: 'contract_awarded',
            source_url: url, source_title: h.headline, source_date: String(h.published || '').slice(0, 10) || null,
            source_family: 'espn.com', source_excerpt_short: sent.slice(0, 200), claim_status: status,
            review_reason: status === 'conflicted' ? `UFC.com places this contract at ${elsewhere[0].evidence.event}` : 'named by ESPN only; no captured UFC.com sentence names this fighter for this week',
            evidence: { match: hit.via, file: f, fighter_name: hit.r.fighter.name, event: hit.r.event.name },
          });
        }
      }
    }
  }
}
const conflicts = secondary;

const rows = [...uniq, ...conflicts].map((c) => ({ id: crypto.createHash('sha256').update(`${c.fighter_id}|${c.event_id}|${c.claim_type}|${c.source_url}`).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'), ...c }));
const by = (k) => rows.reduce((a, r) => ((a[r[k]] = (a[r[k]] || 0) + 1), a), {});
const summary = { articles: files.length, articles_skipped: skipped.articles.length, claims: rows.length, by_status: by('claim_status'), by_type: by('claim_type'), by_source: by('source_family'), sentences_hedged: skipped.hedged, sentences_both_corners: skipped.both_corners, sentences_no_card_name: skipped.no_name };
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), summary, skipped_articles: skipped.articles, claims: rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
