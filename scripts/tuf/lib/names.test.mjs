/**
 * Pins the name matcher.
 *
 *   node --test scripts/tuf/lib/names.test.mjs
 *
 * Every "should match" case below is a real pair from this archive that was
 * being reported as a missing final because the two files spell one fighter
 * two ways. Every "must not match" case is a pair the looser rules could
 * plausibly bridge and must not — same surname, same given name, a surname
 * that is a prefix of another surname. The second list is the one that matters:
 * a matcher that says yes too often turns two people into one, which is a
 * worse failure than the gap it was written to close.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nameMatch, pairMatch } from './names.mjs';

const MATCH = [
  ['Tommy Speer', 'Tom Speer', 'given-name-variant'],
  ['Michael Trizano', 'Mike Trizano', 'given-name-variant'],
  ['Mohammed Usman', 'Mohammad Usman', 'given-name-variant'],
  ['Manvel Gamburyan', 'Manny Gamburyan', 'given-name-variant'],
  ['CB Dollaway', 'C. B. Dollaway', 'suffix-or-initials'],
  ['Khalil Rountree Jr.', 'Khalil Rountree', 'suffix-or-initials'],
  ['Marcio Alexandre Junior', 'Márcio Alexandre Jr', 'suffix-or-initials'],
  ['Brogan Walker', 'Brogan Walker-Sanchez', 'additional-surname'],
  ['Robert Valentin', 'Robert Valentin Frey', 'additional-surname'],
  ['Jose Quinonez', 'José Alberto Quiñónez', null],   // middle name inserted
  ['Guangyou Ning', 'Ning Guangyou', 'reversed-name-order'],
  ['Sai Wang', 'Wang Sai', 'reversed-name-order'],
  ['Antonio Carlos Junior', 'Antônio Carlos Júnior', 'exact'],
  ['Nicco Montano', 'Nicco Montaño', 'exact'],
];

const NO_MATCH = [
  ['Nate Diaz', 'Nick Diaz'],              // brothers
  ['Anderson Silva', 'Wanderlei Silva'],   // shared surname only
  ['Zhang Weili', 'Zhang Lipeng'],         // shared family name only
  ['Jose Aldo', 'Jose Quinonez'],          // shared given name only
  ['Chad Laprise', 'Chad Mendes'],
  ['Mike Brown', 'Mike Brownfield'],       // surname is a prefix of a surname
  ['Godofredo Pepey', 'Godofredo Castro'], // a real alias, but not derivable
  ['Kevin Lee', 'Kevin Holland'],
];

test('spellings of one fighter match, and the rule is named', () => {
  for (const [a, b, rule] of MATCH) {
    const r = nameMatch(a, b);
    assert.ok(r.same, `${a} and ${b} are one fighter and must match`);
    if (rule) assert.equal(r.rule, rule, `${a} ~ ${b} should match by ${rule}, matched by ${r.rule}`);
  }
});

test('two different fighters never match', () => {
  for (const [a, b] of NO_MATCH) {
    assert.equal(nameMatch(a, b).same, false, `${a} and ${b} are different people and must not match`);
  }
});

test('matching is symmetric', () => {
  for (const [a, b] of [...MATCH, ...NO_MATCH]) {
    assert.equal(nameMatch(a, b).same, nameMatch(b, a).same, `${a} / ${b} must match the same way in both directions`);
  }
});

test('a pair needs both corners, in either order', () => {
  assert.ok(pairMatch('Tommy Speer', 'Mac Danzig', 'Mac Danzig', 'Tom Speer').same, 'corners may be swapped');
  assert.equal(
    pairMatch('Tommy Speer', 'Mac Danzig', 'Tom Speer', 'Nate Diaz').same,
    false,
    'one matching corner is not a matching bout',
  );
});

test('an empty name matches nothing, including another empty name', () => {
  assert.equal(nameMatch('', 'Tom Speer').same, false);
  assert.equal(nameMatch('', '').same, false);
});

test('a lone shared given name is never enough, however written', () => {
  /* The additional-surname rule needs two agreeing tokens; this is the case it
   * would swallow if it needed only one. */
  assert.equal(nameMatch('Jose', 'Jose Quinonez').same, false);
  assert.equal(nameMatch('Silva', 'Anderson Silva').same, false);
});
