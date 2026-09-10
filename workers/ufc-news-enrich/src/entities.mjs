/* Who is this story ABOUT?
 *
 * This is a publication gate, not a tagging convenience. The failure it exists
 * to stop is already in our database: two articles headlined "Jon Jones
 * comparison headlines DWCS contract report", where Jones is a yardstick and
 * the story is a prospect's signing. Get this wrong and the headline is wrong,
 * the hero image is wrong, and the entity graph learns the wrong thing.
 *
 * THREE ROLES, NOT ONE LIST
 *   primary     the subject. Exactly one, or the item is held.
 *   secondary   materially involved - the booked opponent, the other side of a
 *               replacement. Belongs in fighter_ids and the graph.
 *   mentioned   named in passing, quoted about someone else, or used as a
 *               comparison. Belongs in the record and NOWHERE ELSE.
 *
 * HOW THE DECISION IS MADE. The scorer proposes a name from the headline's
 * grammar; the alias resolver turns names into ids; and confidence is built
 * from agreement between independent signals rather than asserted by the model.
 * When they disagree, the item is held. Holding costs one story; guessing costs
 * the reader's trust in every story.
 */
import { loadFighterIndex, findFighterMentions, surname } from '../../../scripts/news/lib.mjs';

let cached = null;
let cachedAt = 0;
const INDEX_TTL_MS = 10 * 60 * 1000;

/** The fighter index is thousands of rows; one load per isolate per 10 minutes. */
async function index(sb, { now = Date.now() } = {}) {
  if (cached && now - cachedAt < INDEX_TTL_MS) return cached;
  cached = await loadFighterIndex(sb);
  cachedAt = now;
  return cached;
}

/** Resolve a plain name to a fighter id via the alias resolver. */
function resolveName(idx, name) {
  if (!name) return null;
  const r = idx.resolver.resolve(name, 'news');
  if (r.status === 'matched') return r.fighter_id;
  const exact = (r.candidates || []).filter((c) => c.reasons.includes('exact_normalized'));
  return exact.length === 1 ? exact[0].fighter_id : null;
}

/**
 * @returns {{primary_fighter_id, secondary_fighter_ids, mentioned_fighter_ids,
 *            confidence, reason, signals}}
 */
export async function resolvePrimary(sb, env, item, relevance, { now = Date.now() } = {}) {
  const idx = await index(sb, { now });
  const title = String(item.title || '');
  const summary = String(item.summary || '');

  /* Signal 1: whoever the scorer named, resolved against our roster. */
  const proposedId = resolveName(idx, relevance?.primary_fighter_name);

  /* Signal 2: fighters named in the TITLE. The title is what the story is
   * about; a summary routinely names the card's headliner regardless. */
  const titleIds = findFighterMentions(title, idx).map((m) => m.fighter_id);

  /* Signal 3: everyone named anywhere, plus whatever ingest already linked. */
  const bodyIds = findFighterMentions(`${title}. ${summary}`, idx).map((m) => m.fighter_id);
  const allIds = [...new Set([...(item.fighter_ids || []), ...bodyIds, ...titleIds, proposedId].filter(Boolean))];

  /* Signal 4: the bout this item is attached to, if ingest linked one. */
  let boutIds = [];
  if (item.bout_id) {
    const b = await sb.select('ufc_bouts', `select=fighter_a_id,fighter_b_id&id=eq.${item.bout_id}&limit=1`);
    if (b[0]) boutIds = [b[0].fighter_a_id, b[0].fighter_b_id].filter(Boolean);
  }

  /* The scorer read the article and named a subject we could not resolve. That
   * is a different situation from "the scorer named nobody", and conflating
   * them is what lets a comparison fighter win by default. */
  const namedButUnresolved = Boolean(relevance?.primary_fighter_name) && !proposedId;

  const signals = {
    scorer_named: relevance?.primary_fighter_name || null,
    scorer_resolved: Boolean(proposedId),
    in_title: titleIds.length,
    linked_total: allIds.length,
    named_but_unresolved: namedButUnresolved,
    bout_linked: boutIds.length > 0,
  };

  /* --- decide ------------------------------------------------------- */
  let primary = null;
  let confidence = 0;
  let reason = '';

  if (proposedId && titleIds.includes(proposedId)) {
    /* Strongest case: two independent signals agree, and the subject is named
     * in the headline. */
    primary = proposedId; confidence = 0.95;
    reason = 'the scorer named the subject and the headline names them too';
  } else if (proposedId && boutIds.includes(proposedId)) {
    primary = proposedId; confidence = 0.85;
    reason = 'the scorer named a fighter in the bout this item is linked to';
  } else if (proposedId) {
    /* Common and legitimate: surname-only headlines resolve no full names, so
     * the scorer is the only signal. Trust it, but not as far. */
    primary = proposedId; confidence = 0.75;
    reason = 'the scorer named a fighter our roster knows; the headline carries no matching full name';
  } else if (namedButUnresolved) {
    /* THE COMPARISON-SUBJECT TRAP, and the reason this branch exists at all.
     *
     * The scorer read the story and said it is about someone - and that someone
     * is not on our roster, or is spelled in a way the resolver cannot match.
     * Falling back to whoever the headline names is precisely how "Jon Jones
     * comparison headlines DWCS contract report" was written about Jones: he is
     * the only name our tables knew, so he won by default.
     *
     * A story whose subject we cannot identify is a story we hold. */
    primary = null; confidence = 0.35;
    reason = `the story is about ${relevance.primary_fighter_name}, who does not resolve to our roster; refusing to substitute a fighter the headline merely mentions`;
  } else if (titleIds.length === 1) {
    primary = titleIds[0]; confidence = 0.8;
    reason = 'exactly one known fighter is named in the headline';
  } else if (titleIds.length === 2 && boutIds.length === 2 && titleIds.every((id) => boutIds.includes(id))) {
    /* "A vs B" for a bout we actually have. Both are subjects of a matchup
     * story; the first named is the conventional lead and the other becomes
     * secondary, so nothing is lost either way. */
    primary = titleIds[0]; confidence = 0.7;
    reason = 'a matchup headline for a bout in our schedule; the first-named fighter leads';
  } else if (titleIds.length > 1) {
    primary = null; confidence = 0.4;
    reason = `${titleIds.length} fighters share the headline, no scorer subject, and no single bout ties them together`;
  } else {
    primary = null; confidence = 0.2;
    reason = 'no fighter in this item resolves to our roster';
  }

  /* Secondary: materially involved. The booked opponent counts; a name in a
   * quote does not. */
  const secondary = [...new Set(boutIds.filter((id) => id !== primary))];
  const mentioned = allIds.filter((id) => id !== primary && !secondary.includes(id));

  /* A named comparison that never became the subject is worth recording
   * explicitly - it is the evidence that the gate worked. */
  if (primary && proposedId && proposedId !== primary) {
    reason += `; ${relevance.primary_fighter_name} recorded as mentioned only`;
  }

  return {
    primary_fighter_id: primary,
    secondary_fighter_ids: secondary,
    mentioned_fighter_ids: mentioned,
    confidence,
    reason,
    signals,
    primary_surname: primary ? surname((idx.byId.get(primary) || {}).name || '') : null,
  };
}
