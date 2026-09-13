/* node --test scripts/videos/tuf.test.mjs
 *
 * Titles are real official-channel titles captured 2026-09-12. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tufTag } from './tuf.mjs';

test('a video that is not about TUF gets no tag', () => {
  assert.equal(tufTag({ title: 'UFC 292: Sterling vs O\'Malley | Official Weigh-Ins' }), null);
  assert.equal(tufTag({ title: 'Noche UFC Countdown', playlistTitle: 'Noche UFC' }), null);
});

test('season from the title number, the hashtag, or the team pairing', () => {
  assert.equal(tufTag({ title: 'The Ultimate Fighter 18: Duke vs Pennington Pre-fight Interviews' }).season, 'tuf-18');
  assert.equal(tufTag({ title: "\"I think Imanol's better\" 👀 #tuf33" }).season, 'tuf-33');
  assert.equal(tufTag({ title: 'Islam Makhachev makes a guest appearance on the latest episode of TUF 31 👀' }).season, 'tuf-31');
  const r = tufTag({ title: 'The Ultimate Fighter Recap: Episode 5 | Team Peña vs Team Nunes | Season 30' });
  assert.deepEqual([r.season, r.episode, r.kind], ['tuf-30', 5, 'episode_recap']);
});

test('the playlist names the season when the title does not', () => {
  const r = tufTag({ title: 'Coach Conor with the FRESH cut! ✂️', playlistTitle: 'The Ultimate Fighter: Team McGregor vs Team Chandler' });
  assert.equal(r.season, 'tuf-31');
  assert.equal(r.evidence.season.from, 'playlist');
  assert.equal(r.kind, 'coach_clip');
});

test('Team Cormier is two seasons; the pairing decides which', () => {
  assert.equal(tufTag({ title: 'x', playlistTitle: 'The Ultimate Fighter: Team Cormier vs Team Sonnen' }).season, 'tuf-33');
  assert.equal(tufTag({ title: 'x', playlistTitle: 'The Ultimate Fighter: Team Cormier vs Team Bisping' }).season, 'tuf-34');
});

test('international editions are not mistaken for US seasons', () => {
  assert.equal(tufTag({ title: "The Ultimate Fighter Brazil 3: Chael Sonnen's Sneak Peek" }).season, 'tuf-brazil-3');
  assert.equal(tufTag({ title: 'The Ultimate Fighter Latin America: Masio Fullen' }).season, 'tuf-latam-1');
  assert.equal(tufTag({ title: 'The Ultimate Fighter Nations Finale: Post-fight Press Conference Highlights' }).season, 'tuf-nations-1');
});

test('kinds: finale, retrospective, preview, free fight, and an unlabelled short', () => {
  assert.equal(tufTag({ title: 'The Ultimate Fighter Finale: ATT vs Blackzilians - Official Weigh-in' }).kind, 'finale');
  assert.equal(tufTag({ title: 'TUF Moments: Rampage vs Rashad' }).kind, 'retrospective');
  assert.equal(tufTag({ title: 'The Ultimate Fighter 19: Season Preview' }).kind, 'episode_preview');
  assert.equal(tufTag({ title: 'Free Fight: Michael Bisping vs Josh Haynes | TUF 3 Finale' }).kind, 'free_fight');
  const short = tufTag({ title: 'What a fight! 🚨 #tuf33', durationSec: 42 });
  assert.equal(short.kind, 'short_clip');
  assert.equal(short.evidence.kind.from, 'duration');
});

test('an episode number is read only when the title states one', () => {
  assert.equal(tufTag({ title: 'TUF Rewind: Tresean Gore and Bryan Battle Set to Finally Meet' }).episode, null);
});
