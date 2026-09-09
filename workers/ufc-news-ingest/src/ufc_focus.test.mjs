/* The focus filter's job is to be cheap and to fail in the safe direction.
 *
 * Every "must survive" case below is a real headline shape from the production
 * wire or from the four enabled feeds. They are here because the expensive
 * mistake is rejecting a UFC story, not tolerating a boxing one: a rejected
 * story never publishes and nobody finds out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFocus, initialState } from './ufc_focus.mjs';

test('a named rival promotion with no UFC anchor is rejected', () => {
  const f = classifyFocus(
    'Roberto Satoshi: RIZIN co-promoting with PFL, MVP opens doors for dream fights', '',
    { ufcFighterCount: 1, taxonomyLabels: ['other'] },
  );
  assert.equal(f.ok, false);
  assert.equal(f.verdict, 'foreign_sport');
  assert.deepEqual(f.foreign.sort(), ['pfl', 'rizin']);
});

test('two boxers in a headline with no boxing word are still rejected', () => {
  /* The case that broke the first version of this filter. "Title Fight Preview
   * | Ryan Garcia vs Conor Benn" contains no boxing keyword whatsoever; the
   * only usable signal is that neither name is in ufc_fighters. */
  const f = classifyFocus(
    'Title Fight Preview | Ryan Garcia vs Conor Benn', '',
    { ufcFighterCount: 0, taxonomyLabels: ['other'] },
  );
  assert.equal(f.ok, false);
  assert.equal(f.verdict, 'no_ufc_link');
  assert.deepEqual(f.foreign, [], 'rejected on entity evidence, not on a keyword');
});

test('every clause of the no_ufc_link rule is load-bearing on its own', () => {
  const matchup = 'Title Fight Preview | Someone Unknown vs Someone Else';
  /* all four clauses hold: rejected */
  assert.equal(classifyFocus(matchup, '', { ufcFighterCount: 0, taxonomyLabels: ['other'] }).ok, false);
  /* a known fighter alone rescues it */
  assert.equal(classifyFocus(matchup, '', { ufcFighterCount: 1, taxonomyLabels: ['other'] }).ok, true);
  /* a UFC anchor alone rescues it - a signing our tables never heard of */
  assert.equal(classifyFocus(`${matchup} at UFC 331`, '', { ufcFighterCount: 0, taxonomyLabels: ['other'] }).ok, true);
  /* a substantive label alone rescues it */
  assert.equal(classifyFocus(matchup, 'pulled out with an injury', { ufcFighterCount: 0, taxonomyLabels: ['withdrawal'] }).ok, true);
  /* not a matchup: the rule must not fire, whatever else is true */
  assert.equal(classifyFocus('Someone Unknown announces next opponent', '', { ufcFighterCount: 0, taxonomyLabels: ['other'] }).ok, true);
});

test('surname-only headlines are never rejected for resolving no fighter', () => {
  /* findFighterMentions matches multi-token names only, so an ordinary headline
   * like this resolves ZERO fighters. Rejecting on that count would bin a large
   * share of real UFC news, which is why the entity rule needs the matchup
   * shape before it will fire. */
  for (const title of [
    'Pereira eyes a summer return',
    'Jones spotted training in Albuquerque',
    'Adesanya hints at a move back up',
  ]) {
    const f = classifyFocus(title, '', { ufcFighterCount: 0, taxonomyLabels: ['other'] });
    assert.equal(f.ok, true, `"${title}" must survive: ${f.reason}`);
  }
});

test('without a fighter index the entity rule is disabled, not inverted', () => {
  /* A caller that cannot look fighters up must degrade to keyword-only. The
   * opposite - treating "unknown" as "zero" - would reject the entire wire. */
  const f = classifyFocus('Title Fight Preview | Ryan Garcia vs Conor Benn', '', { ufcFighterCount: null });
  assert.equal(f.ok, true, 'null must mean "not looked up", never "no fighters"');
});

test('a UFC story survives even when it names another promotion', () => {
  /* This is the asymmetry the module is built around. A boxing name is
   * evidence, never proof; the UFC anchor overrides it. */
  const f = classifyFocus(
    'Dana White shuts down boxing crossover talk ahead of UFC 331',
    'The UFC president was asked about a WBC title bout.',
    { ufcFighterCount: 0, taxonomyLabels: ['other'] },
  );
  assert.equal(f.ok, true);
  assert.ok(f.foreign.includes('boxing'), 'boxing should still be detected');
  assert.equal(f.anchored, true);
});

test('ordinary UFC headlines that never say "UFC" survive', () => {
  /* The most dangerous possible bug in this file would be requiring the string
   * "UFC". Most real headlines do not contain it. */
  const survivors = [
    'Pereira out of the main event with a broken hand',
    'Makhachev vs Tsarukyan rebooked for December',
    'Shevchenko misses weight by two pounds',
    'Song Yadong climbs to No. 3 after consecutive stoppages',
    'Dvalishvili signs new four-fight deal',
  ];
  for (const title of survivors) {
    const f = classifyFocus(title, '', { ufcFighterCount: 1, taxonomyLabels: ['other'] });
    assert.equal(f.ok, true, `"${title}" was rejected: ${f.reason}`);
  }
});

test('obvious non-news is skipped', () => {
  for (const title of [
    'Top 10 knockouts of 2025',
    'Conor McGregor net worth revealed',
    'Full episode: the MMA Hour with Ariel Helwani',
    'Bonus code unlocks odds boost for UFC 331',
  ]) {
    const f = classifyFocus(title, '', { ufcFighterCount: 1, taxonomyLabels: ['other'] });
    assert.equal(f.ok, false, `"${title}" should be skipped`);
    assert.equal(f.verdict, 'not_news');
  }
});

test('a rejected item is stored but can never be scored', () => {
  /* Rejection means the row exists and is terminal, not that it vanishes. The
   * wire renders raw items and an operator inspecting a bad call needs the row. */
  const rejected = initialState(classifyFocus(
    'Title Fight Preview | Ryan Garcia vs Conor Benn', '', { ufcFighterCount: 0, taxonomyLabels: ['other'] },
  ));
  assert.equal(rejected.state, 'skipped');
  assert.match(rejected.state_reason, /no_ufc_link/);

  const accepted = initialState(classifyFocus(
    'Pereira out of the main event with a broken hand', '', { ufcFighterCount: 1, taxonomyLabels: ['injury'] },
  ));
  assert.equal(accepted.state, 'new');
  assert.equal(accepted.state_reason, null);
});

test('empty and junk input is skipped rather than thrown on', () => {
  for (const bad of [undefined, null, '', '   ', 'x']) {
    const f = classifyFocus(bad, '', { ufcFighterCount: 0 });
    assert.equal(f.ok, false);
    assert.equal(f.verdict, 'not_news');
  }
});
