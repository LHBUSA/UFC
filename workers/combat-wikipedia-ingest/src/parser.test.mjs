import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, parseMmaRecord, promotionGuess } from './parser.js';

const HTML = `
<html><body>
<table class="infobox"><tr><td><span class="bday">1990-07-02</span></td></tr></table>
<h2>Mixed martial arts record</h2>
<table>
<tr><th>Res.</th><th>Record</th><th>Opponent</th><th>Method</th><th>Event</th><th>Date</th><th>Round</th><th>Time</th><th>Location</th></tr>
<tr><td>Win</td><td>18-1</td><td><a href="/wiki/Holly_Holm">Holly Holm</a></td><td>Submission (rear-naked choke)</td><td><a href="/wiki/UFC_300">UFC 300</a></td><td><span>2024-04-13</span></td><td>2</td><td>3:06</td><td>Las Vegas</td></tr>
<tr><td>Win</td><td>17-1</td><td><a href="/wiki/Aspen_Ladd">Aspen Ladd</a></td><td>Decision (unanimous)</td><td><a href="/wiki/2023_Professional_Fighters_League_season">PFL 10</a></td><td><time datetime="2023-11-24">November 24, 2023</time></td><td>5</td><td>5:00</td><td>Washington</td></tr>
</table>
<h2>Kickboxing record</h2>
<table>
<tr><th>Res.</th><th>Record</th><th>Opponent</th><th>Method</th><th>Event</th><th>Date</th><th>Round</th><th>Time</th><th>Location</th></tr>
${Array.from({ length: 8 }, (_, i) => `<tr><td>Win</td><td>${i + 1}-0</td><td>Wrong Sport ${i}</td><td>Decision</td><td>Glory ${i}</td><td>2020-01-0${(i % 8) + 1}</td><td>3</td><td>3:00</td><td>Tokyo</td></tr>`).join('')}
</table>
</body></html>`;

test('normalization handles common fighter name variants', () => {
  assert.equal(normalizeName("Joanna Jędrzejczyk"), 'joanna jedrzejczyk');
  assert.equal(normalizeName("O'Malley"), 'omalley');
});

test('MMA section wins even when another combat-sport table is larger', () => {
  const p = parseMmaRecord(HTML);
  assert.equal(p.dob, '1990-07-02');
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => r.opponent), ['Holly Holm', 'Aspen Ladd']);
  assert.equal(p.rows[0].promotion_slug, 'ufc');
  assert.equal(p.rows[0].method, 'SUB');
  assert.equal(p.rows[0].time_sec, 186);
  assert.equal(p.rows[1].promotion_slug, 'pfl');
  assert.equal(p.rows[1].event_date, '2023-11-24');
});

test('major promotion mapping stays explicit', () => {
  assert.equal(promotionGuess('Bellator 271').slug, 'bellator');
  assert.equal(promotionGuess('KSW 102').slug, 'ksw');
  assert.equal(promotionGuess('ONE Championship 168').slug, 'one');
  assert.equal(promotionGuess('Rizin 49').slug, 'rizin');
  assert.equal(promotionGuess('Some Regional Show 9').recognized, false);
});
