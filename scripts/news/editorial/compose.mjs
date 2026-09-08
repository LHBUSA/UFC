/**
 * The V4 composer: packet in, article out.
 *
 * WHY THIS IS DETERMINISTIC
 *
 * A language model given a thin packet produces fluent filler, because fluency
 * is what it is for. That is precisely the failure being fixed. So the composer
 * builds prose from facts it can point at, and the only sentences available to
 * it are ones a fact supports. A section with no facts does not exist.
 *
 * That constraint is what makes the depth real: 1,400 words here means 1,400
 * words of sourced material, because there is no other way to reach 1,400
 * words. It cannot pad, so a thin packet produces a short piece, which fails its
 * class floor, which drops it to wire. The pressure runs toward honesty.
 *
 * COMPARISON, NOT ENUMERATION
 *
 * The first draft of this file listed nine attributes per fighter in a row and
 * read exactly like the database output it was drawing from. Naming the two or
 * three axes on which the fighters actually differ is an argument; reciting
 * every column is a table with full stops in it. The prose below compares; the
 * modules carry the columns.
 */

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h); };
const pick = (pool, seed, salt = 0) => pool[(hash(seed) + salt * 7919) % pool.length];
const byFamily = (packet, family) => packet.facts.filter((f) => f.family === family);
const sentences = (facts) => facts.map((f) => f.statement);

function para(facts, { lead = null } = {}) {
  const s = sentences(facts).filter(Boolean);
  if (!s.length) return null;
  return [lead, ...s].filter(Boolean).join(' ');
}

const H2 = {
  why: ['Why it matters', 'Why the change matters', 'What this changes'],
  numbers: ['The numbers behind the matchup', 'What the record actually shows', 'Reading the tape'],
  dna: ['Where the Fight DNA profiles diverge', 'The profiles, side by side', 'What the movement data says'],
  market: ['The market read', 'What the books are pricing', 'The market before and after'],
  form: ['Recent form', 'How each of them arrived here', 'The run-up'],
  weigh: ['What the weight miss changes', 'On the scale', 'The reading and what it costs'],
  avail: ['The availability picture', 'What the card looks like now', 'Who is actually fighting'],
  result: ['How it played out', 'The finish, and the road to it', 'What happened'],
  officials: ['The officials', 'How it was scored', 'The scorecards'],
  rounds: ['Inside the fight', 'What the round sheet shows', 'The statistical record'],
  counter: ['The counter-case', 'The case against', 'Where this read could be wrong'],
  next: ['What to watch next', 'What changes next', 'What happens from here'],
};

/* ---- modules -----------------------------------------------------------
 *
 * A module carries FIGURES. The prose beside it carries the ARGUMENT. That
 * split is deliberate: the first preview built here put the market sentence in
 * a paragraph and then again in the module underneath, and the duplicate gate
 * caught it. A reader who wants the number scans the table; a reader who wants
 * the read follows the sentence. Neither should have to read the other twice.
 */

const pctOrDash = (v, dp = 0) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(dp)}%`);
const numOrDash = (v, dp = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(dp));

function tapeModule(metrics, fighters) {
  const [a, b] = fighters.map((f) => metrics?.[f.id]).filter(Boolean);
  if (!a || !b) return null;
  const rows = [
    ['Age', a.age ?? '—', b.age ?? '—'],
    ['Reach', a.reach ? `${a.reach}"` : '—', b.reach ? `${b.reach}"` : '—'],
    ['Stance', a.stance ?? '—', b.stance ?? '—'],
    ['Strikes landed / min', numOrDash(a.slpm), numOrDash(b.slpm)],
    ['Strikes absorbed / min', numOrDash(a.sapm), numOrDash(b.sapm)],
    ['Striking defence', pctOrDash(a.strDef), pctOrDash(b.strDef)],
    ['Takedowns / 15 min', numOrDash(a.tdAvg), numOrDash(b.tdAvg)],
    ['Takedown defence', pctOrDash(a.tdDef), pctOrDash(b.tdDef)],
  ].filter((r) => r[1] !== '—' || r[2] !== '—');
  if (rows.length < 4) return null;
  return ['### The tape', '', `| | ${a.name} | ${b.name} |`, '|---|---|---|', ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`), ''].join('\n');
}

function dnaModule(dna, fighters) {
  const [a, b] = fighters.map((f) => dna?.[f.id]).filter(Boolean);
  if (!a || !b) return null;
  const signed = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);
  const rows = [
    ['Sig. strikes landed / min', numOrDash(a.slpm), numOrDash(b.slpm)],
    ['Strike differential / min', signed(a.diff), signed(b.diff)],
    ['Takedowns / 15 min', numOrDash(a.tdPer15), numOrDash(b.tdPer15)],
    ['Control share', a.control === null ? '—' : `${(a.control * 100).toFixed(1)}%`, b.control === null ? '—' : `${(b.control * 100).toFixed(1)}%`],
    ['Wins inside the distance', a.finish === null ? '—' : `${(a.finish * 100).toFixed(0)}%`, b.finish === null ? '—' : `${(b.finish * 100).toFixed(0)}%`],
    ['Stat-covered bouts', a.sample, b.sample],
    ['Coverage grade', a.coverage ?? '—', b.coverage ?? '—'],
  ];
  return ['### Fight DNA snapshot', '', `| | ${a.name} | ${b.name} |`, '|---|---|---|', ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`), ''].join('\n');
}

function numbersModule(packet, usedFactIds) {
  const scored = packet.facts
    .filter((f) => f.value !== null && f.value !== undefined && Number.isFinite(Number(f.value)))
    .filter((f) => !usedFactIds.has(f.id))
    .filter((f) => ['market', 'weigh_in', 'recent_form', 'result'].includes(f.family));
  if (scored.length < 3) return null;
  const rank = { weigh_in: 0, market: 1, result: 2, recent_form: 3 };
  const chosen = scored.sort((a, b) => (rank[a.family] ?? 9) - (rank[b.family] ?? 9)).slice(0, 5);
  for (const f of chosen) usedFactIds.add(f.id);
  const unit = (f) => (f.unit === '%' ? '%' : f.unit && f.unit !== 'per_min' && f.unit !== 'minutes' ? ` ${f.unit}` : '');
  return ['### Numbers that matter', '', '| | |', '|---|---|',
    ...chosen.map((f) => `| **${f.value}${unit(f)}** | ${f.statement.replace(/\s+/g, ' ')} |`), ''].join('\n');
}

function marketModule(sides, observedAt, stale) {
  if (!sides || !sides.length) return null;
  return ['### Market watch', '',
    '| Corner | De-vigged | Books |', '|---|---|---|',
    ...sides.map((s) => `| ${s.name} | ${(s.devig * 100).toFixed(1)}% | ${s.books} |`),
    '', `Observed ${observedAt} UTC${stale ? ' — **stale**' : ''}.`, ''].join('\n');
}

function weighModule(packet) {
  const w = byFamily(packet, 'weigh_in');
  if (!w.length) return null;
  return ['### On the scale', '', ...w.map((f) => `- ${f.statement}`), ''].join('\n');
}

/**
 * Scorecards only, as a table, and only when there are scorecards. The referee
 * line belongs to the prose; putting it here as well is the duplication the
 * market module already had to have removed.
 */
function scorecardModule(packet) {
  const cards = byFamily(packet, 'officials').filter((f) => / scored it /.test(f.statement));
  if (!cards.length) return null;
  const rows = cards.map((f) => {
    const m = f.statement.match(/^(.*) scored it (.*)\.$/);
    return m ? `| ${m[1]} | ${m[2]} |` : `| ${f.statement} | |`;
  });
  return ['### Official scorecard', '', '| Judge | Card |', '|---|---|', ...rows, ''].join('\n');
}

/* ---- comparative prose ------------------------------------------------- */

const inchWord = (n) => `${n} ${n === 1 ? 'inch' : 'inches'}`;

function tapeProse(metrics, fighters) {
  const [a, b] = fighters.map((f) => metrics?.[f.id]).filter(Boolean);
  if (!a || !b) return null;
  const out = [];

  if (a.reach && b.reach) {
    const d = Math.abs(a.reach - b.reach);
    const longer = a.reach > b.reach ? a : b;
    const shorter = a.reach > b.reach ? b : a;
    out.push(d >= 2
      ? `${longer.name} has ${inchWord(d)} of reach on ${shorter.name}, ${longer.reach} to ${shorter.reach}. That is the kind of gap that decides who gets to fight at their preferred range rather than one that only shows up on the tale of the tape.`
      : `Neither man owns the range. ${a.reach} inches to ${b.reach} is close enough that reach will not settle where this is fought.`);
  }
  if (a.slpm && b.slpm) {
    const busier = a.slpm > b.slpm ? a : b;
    const quieter = a.slpm > b.slpm ? b : a;
    const gap = Math.abs(a.slpm - b.slpm);
    out.push(gap >= 1
      ? `${busier.name} is much the busier striker, ${busier.slpm} significant strikes a minute against ${quieter.slpm}. Over a three-round fight that is a different volume of work entirely.`
      : `Output is close, ${a.slpm} a minute to ${b.slpm}, so this will not be won on volume alone.`);
  }
  if (a.sapm && b.sapm && a.slpm && b.slpm) {
    const net = (x) => Number((x.slpm - x.sapm).toFixed(2));
    const na = net(a);
    const nb = net(b);
    const better = na > nb ? a : b;
    const phrase = (n) => (n > 0 ? `${n} to the good` : `${Math.abs(n)} underwater`);
    out.push(`Netting off what each absorbs, ${a.name} is ${phrase(na)} a minute and ${b.name} ${phrase(nb)}, which puts ${better.name} ahead on the exchange that actually decides rounds.`);
  }
  if (a.tdAvg !== null && b.tdAvg !== null && (a.tdAvg || b.tdAvg)) {
    const grappler = a.tdAvg > b.tdAvg ? a : b;
    const other = a.tdAvg > b.tdAvg ? b : a;
    if (grappler.tdAvg >= 0.8 && other.tdDef !== null && other.tdDef !== undefined) {
      out.push(`${grappler.name} is the likelier of the two to change levels, at ${grappler.tdAvg} takedowns per 15 minutes, and ${other.name} has turned away ${other.tdDef}% of the takedowns aimed at them.`);
    }
  }
  if (a.age && b.age && Math.abs(a.age - b.age) >= 4) {
    const younger = a.age < b.age ? a : b;
    const older = a.age < b.age ? b : a;
    out.push(`${younger.name} is ${Math.abs(a.age - b.age)} years the younger, ${younger.age} to ${older.age}.`);
  }
  return out.length ? out.join(' ') : null;
}

function dnaProse(dna, fighters) {
  const have = fighters.map((f) => dna?.[f.id]).filter(Boolean);
  const [a, b] = have;
  if (!a) return null;
  /* One-sided is common and still worth writing: a profile for the fighter we
     have, with the absence of the other stated rather than papered over.
     Returning null here threw away the half of the evidence that existed. */
  if (!b) {
    const missing = fighters.find((f) => !dna?.[f.id]);
    const parts = [`Fight DNA has a pre-fight profile for ${a.name} and none for ${missing ? missing.name : 'the opponent'}, so this is half a comparison and should be read as one.`];
    if (a.diff !== null) parts.push(`${a.name} is ${a.diff > 0 ? `plus ${a.diff.toFixed(2)}` : `minus ${Math.abs(a.diff).toFixed(2)}`} significant strikes a minute across ${a.sample} stat-covered bouts, graded ${a.coverage} coverage.`);
    if (a.control !== null) parts.push(`Control time runs at ${(a.control * 100).toFixed(1)}% of observed fight time.`);
    if (a.finish !== null) parts.push(`${(a.finish * 100).toFixed(0)}% of the recorded wins came inside the distance.`);
    return parts.join(' ');
  }
  const out = ['Fight DNA is rebuilt from bouts that had already happened at the time, so these are pre-fight profiles rather than career averages carrying later results backwards.'];

  if (a.diff !== null && b.diff !== null) {
    const ahead = a.diff > b.diff ? a : b;
    const behind = a.diff > b.diff ? b : a;
    const say = (x) => (x.diff > 0 ? `plus ${x.diff.toFixed(2)}` : `minus ${Math.abs(x.diff).toFixed(2)}`);
    out.push(`The clearest split is the strike differential: ${ahead.name} at ${say(ahead)} significant strikes a minute in the covered sample, ${behind.name} at ${say(behind)}. A differential is a harder number than raw output because it prices what a fighter gives back.`);
  }
  if (a.control !== null && b.control !== null) {
    const ctrl = a.control > b.control ? a : b;
    const oth = a.control > b.control ? b : a;
    out.push(ctrl.control > 0.05
      ? `${ctrl.name} has held control for ${(ctrl.control * 100).toFixed(1)}% of observed fight time against ${(oth.control * 100).toFixed(1)}% for ${oth.name}. That is where a fight like this gets taken away from whoever wants it standing.`
      : `Neither has built a control game worth the name, ${(a.control * 100).toFixed(1)}% and ${(b.control * 100).toFixed(1)}% of observed time, so this is very likely settled on the feet.`);
  }
  if (a.finish !== null && b.finish !== null) {
    out.push(`${(a.finish * 100).toFixed(0)}% of ${a.name}'s recorded wins came inside the distance, against ${(b.finish * 100).toFixed(0)}% of ${b.name}'s.`);
  }
  const thin = [a, b].filter((x) => x.sample <= 6);
  if (thin.length) {
    out.push(`The caveat travels with the numbers: ${thin.map((x) => `${x.name} on ${x.sample} stat-covered bouts`).join(' and ')}, graded ${thin[0].coverage} coverage. That is a small base, and one more fight moves it.`);
  }
  return out.join(' ');
}

function formProse(packet, fighters) {
  const facts = byFamily(packet, 'recent_form');
  if (!facts.length) return null;
  const byName = new Map();
  for (const f of facts) {
    const who = fighters.find((x) => f.statement.includes(x.name));
    const k = who?.name ?? 'other';
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f.statement);
  }
  return [...byName.values()].map((v) => v.join(' ')).join(' ');
}

function marketProse(packet) {
  const facts = byFamily(packet, 'market');
  if (!facts.length) return null;
  const head = facts[0].statement;
  const stamp = facts.find((f) => /observed|stale/.test(f.statement));
  const disp = facts.find((f) => /disagree by/.test(f.statement));
  const out = [head];
  if (disp) out.push(`${disp.statement} Dispersion that wide usually means the books are pricing different information, not the same information differently.`);
  if (stamp && /stale/.test(stamp.statement)) out.push(`${stamp.statement} Treat it as the last thing observed rather than the current number.`);
  return out.join(' ');
}

/* ---- the lede ---------------------------------------------------------- */

function lede(packet, { angle }) {
  const core = byFamily(packet, 'core');
  const src = byFamily(packet, 'source_item');
  const avail = byFamily(packet, 'availability');
  const result = byFamily(packet, 'result');
  const weigh = byFamily(packet, 'weigh_in');
  const parts = [];

  if (avail.length) parts.push(avail[0].statement);
  else if (weigh.length) parts.push(weigh.slice(0, 2).map((f) => f.statement).join(' '));
  else if (result.length) parts.push(result[0].statement);
  else if (src.length) parts.push(src[0].statement);

  const matchup = core.find((f) => / meets /.test(f.statement));
  const eventF = core.find((f) => /is scheduled for/.test(f.statement));
  if (matchup) parts.push(matchup.statement);
  if (eventF) parts.push(eventF.statement);
  const records = core.filter((f) => /is listed at/.test(f.statement));
  if (records.length) parts.push(records.map((f) => f.statement).join(' '));
  if (angle) parts.push(angle);
  return parts.filter(Boolean).join(' ');
}

/* ---- the composer ------------------------------------------------------ */

export function compose(packet, { slug, publicationClass, angle = null, metrics = null, dna = null }) {
  const used = new Set();
  const out = [];
  const headings = [];
  const modules = [];
  const seed = slug || packet.story_type;
  const fighters = packet.entities.fighters ?? [];

  const section = (key, text) => {
    if (!text) return;
    const h = pick(H2[key], seed, headings.length);
    headings.push(h);
    out.push(`## ${h}`, '', text, '');
  };

  if (publicationClass === 'wire') {
    const core = byFamily(packet, 'core');
    const src = byFamily(packet, 'source_item');
    const avail = byFamily(packet, 'availability');
    const body = [src[0]?.statement, ...sentences(avail).slice(0, 2), ...sentences(core).slice(0, 2)].filter(Boolean).join(' ');
    [...src, ...avail, ...core].forEach((f) => used.add(f.id));
    return { body_md: body, headings: [], word_count: body.split(/\s+/).filter(Boolean).length, used_fact_ids: [...used], modules: [] };
  }

  out.push(lede(packet, { angle }), '');
  [...byFamily(packet, 'core'), ...byFamily(packet, 'source_item')].forEach((f) => used.add(f.id));

  const avail = byFamily(packet, 'availability');
  if (avail.length) { section('avail', para(avail)); avail.forEach((f) => used.add(f.id)); }

  const result = byFamily(packet, 'result');
  if (result.length) { section('result', para(result)); result.forEach((f) => used.add(f.id)); }

  const weigh = byFamily(packet, 'weigh_in');
  if (weigh.length) {
    section('weigh', para(weigh));
    weigh.forEach((f) => used.add(f.id));
    const mod = weighModule(packet);
    if (mod) { out.push(mod); modules.push('on_the_scale'); }
  }

  const form = formProse(packet, fighters);
  if (form) { section('form', form); byFamily(packet, 'recent_form').forEach((f) => used.add(f.id)); }

  const tape = tapeProse(metrics, fighters);
  if (tape) {
    section('numbers', tape);
    byFamily(packet, 'tale').forEach((f) => used.add(f.id));
    const mod = tapeModule(metrics, fighters);
    if (mod) { out.push(mod); modules.push('the_tape'); }
  }

  const dnaText = dnaProse(dna, fighters);
  if (dnaText) {
    section('dna', dnaText);
    byFamily(packet, 'fight_dna').forEach((f) => used.add(f.id));
    const mod = dnaModule(dna, fighters);
    if (mod) { out.push(mod); modules.push('fight_dna_snapshot'); }
  }

  const marketText = marketProse(packet);
  if (marketText) {
    section('market', marketText);
    byFamily(packet, 'market').forEach((f) => used.add(f.id));
    const mod = marketModule(packet.entities.marketSides, packet.entities.marketObservedAt, packet.entities.marketStale);
    if (mod) { out.push(mod); modules.push('market_watch'); }
  }

  const rounds = byFamily(packet, 'round_stats');
  if (rounds.length) {
    section('rounds', para(rounds, { lead: "The round sheet is the only account of the fight that is not somebody's impression of it." }));
    rounds.forEach((f) => used.add(f.id));
  }

  const officials = byFamily(packet, 'officials');
  if (officials.length) {
    section('officials', para(officials));
    officials.forEach((f) => used.add(f.id));
    const mod = scorecardModule(packet);
    if (mod) { out.push(mod); modules.push('official_scorecard'); }
  }

  const numbers = numbersModule(packet, used);
  if (numbers) { out.push(numbers); modules.push('numbers_that_matter'); }

  const counter = counterCase(packet, { metrics, dna, fighters });
  if (counter) {
    const h = pick(H2.counter, seed, headings.length);
    headings.push(h);
    out.push(`## ${h}`, '', counter, '');
  }

  const next = whatNext(packet);
  if (next.length) {
    const h = pick(H2.next, seed, headings.length);
    headings.push(h);
    out.push(`## ${h}`, '', ...next.map((n) => `- ${n}`), '');
    modules.push('what_changes_next');
  }

  const body_md = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    body_md,
    headings,
    word_count: body_md.replace(/^#{1,3}.*$/gm, ' ').replace(/[|#*_>-]/g, ' ').split(/\s+/).filter(Boolean).length,
    used_fact_ids: [...used],
    modules,
  };
}

/**
 * A counter-case made of real tension: the market disagreeing with the profile,
 * a thin sample under a confident number, a career average pulling the other
 * way from the as-of one. Never invented, and omitted when the packet genuinely
 * holds nothing that disagrees with itself.
 */
function counterCase(packet, { metrics, dna, fighters }) {
  const bits = [];
  const market = byFamily(packet, 'market');
  const dnaPair = fighters.map((f) => dna?.[f.id]).filter(Boolean);

  const thin = dnaPair.filter((x) => x.sample <= 5);
  if (thin.length) {
    bits.push(`Start with the sample. ${thin.map((x) => `${x.name} has ${x.sample} stat-covered bouts behind ${x.name.split(' ')[0]}'s profile`).join(', and ')}. Numbers built on that base are directional, not precise, and a single atypical performance rewrites them.`);
  }

  if (market.length && dnaPair.length === 2) {
    const fav = market[0].statement.match(/makes ([^)]+?) a ([\d.]+)% favourite/);
    if (fav) {
      const favName = fav[1];
      const other = dnaPair.find((x) => !favName.includes(x.name.split(' ')[0]));
      const better = dnaPair.slice().sort((a, b) => (b.diff ?? -99) - (a.diff ?? -99))[0];
      if (better && !favName.includes(better.name.split(' ')[0])) {
        bits.push(`And the two sources disagree. The market makes ${favName} the favourite while the better strike differential in the covered sample belongs to ${better.name}. Where a price and an archive disagree, the price usually knows something the archive cannot: late camp reports, an injury that never got written down, and the weight of money from people closer to it than we are.`);
      } else if (other) {
        bits.push(`The market and the movement data agree here, which is worth naming because agreement is not confirmation. Both are reading the same public record, so they can be wrong together.`);
      }
    }
  }

  const stale = market.find((f) => /stale/.test(f.statement));
  if (stale) bits.push('The quoted price is stale, so it is the last observation rather than the current number.');

  if (!dnaPair.length && byFamily(packet, 'recent_form').length) {
    bits.push('There is no stat-covered Fight DNA profile behind this one, so the form line is doing all the work, and a five-fight window is a small window.');
  }

  const tapePair = fighters.map((f) => metrics?.[f.id]).filter(Boolean);
  if (tapePair.length === 2 && dnaPair.length === 2) {
    const careerBetter = tapePair.slice().sort((a, b) => ((b.slpm ?? 0) - (b.sapm ?? 0)) - ((a.slpm ?? 0) - (a.sapm ?? 0)))[0];
    const asOfBetter = dnaPair.slice().sort((a, b) => (b.diff ?? -99) - (a.diff ?? -99))[0];
    if (careerBetter && asOfBetter && careerBetter.name !== asOfBetter.name) {
      bits.push(`One more tension worth flagging: the career numbers favour ${careerBetter.name} on net striking while the as-of profile favours ${asOfBetter.name}. Those measure different windows, and which one is right depends on whether you think the recent sample is signal or noise.`);
    }
  }
  return bits.length ? bits.join(' ') : null;
}

function whatNext(packet) {
  const out = [];
  const core = byFamily(packet, 'core');
  const eventF = core.find((f) => /is scheduled for/.test(f.statement));
  if (eventF) out.push(`${eventF.statement.replace(/\.$/, '')}, which is the next hard checkpoint.`);
  if (byFamily(packet, 'weigh_in').length) out.push('The official weigh-in reading and any catchweight agreement, which change the bout contract rather than just the story.');
  if (byFamily(packet, 'market').length) out.push('Whether the price moves once the news is fully absorbed. A line that does not move has already priced it.');
  if (byFamily(packet, 'availability').length) out.push('A confirmed replacement or a formal withdrawal, either of which supersedes everything above.');
  if (byFamily(packet, 'result').length) out.push('Whether the result draws an appeal or a commission review, the only thing that would change it.');
  if (byFamily(packet, 'fight_dna').length) out.push('The next stat-covered bout for either man, which is what moves a profile this thin.');
  return out.slice(0, 5);
}

/* ---- headline, dek ----------------------------------------------------- */

const HEADLINE_MAX = 110;

export function headlineFor(packet, { publicationClass }) {
  const names = (packet.entities.fighters ?? []).map((f) => f.name);
  const ev = packet.entities.event;
  const weigh = byFamily(packet, 'weigh_in').find((f) => /over the/.test(f.statement));
  const result = byFamily(packet, 'result')[0];
  const avail = byFamily(packet, 'availability')[0];
  const src = byFamily(packet, 'source_item')[0];

  let h;
  if (weigh) h = `${names[0] ?? 'A fighter'} misses weight by ${weigh.value} pounds for ${ev?.name ?? 'the card'}`;
  else if (avail) h = avail.statement.replace(/\.$/, '');
  else if (result) h = result.statement.replace(/\.$/, '');
  else if (names.length === 2) h = `${names[0]} vs ${names[1]}: what the numbers say before ${ev?.name ?? 'fight night'}`;
  else if (src) h = src.statement.replace(/^.*published "/, '').replace(/"[^"]*$/, '');
  else h = ev?.name ?? 'PropBetEdge fight intelligence';

  h = h.replace(/\s+/g, ' ').trim();
  if (h.length > HEADLINE_MAX) h = `${h.slice(0, HEADLINE_MAX - 1).replace(/[\s,;:]+\S*$/, '')}…`;
  return h;
}

export function dekFor(packet) {
  /* source_item is the last resort rather than the first: on a wire item it is
     often the only family present, and a dek that just restates the publisher
     line is still better than an empty one in a feed. */
  const first = byFamily(packet, 'weigh_in')[0] || byFamily(packet, 'availability')[0] || byFamily(packet, 'result')[0]
    || byFamily(packet, 'fight_dna')[0] || byFamily(packet, 'core')[0] || byFamily(packet, 'source_item')[0];
  const second = byFamily(packet, 'market')[0] || byFamily(packet, 'recent_form')[0] || byFamily(packet, 'tale')[0]
    || byFamily(packet, 'core')[1] || byFamily(packet, 'source_item')[0];
  let d = [first?.statement, second?.statement].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (d.length > 175) d = `${d.slice(0, 174).replace(/[\s,;:]+\S*$/, '')}…`;
  return d;
}

export { HEADLINE_MAX };
