/* The number gate has TWO ways to be wrong and this pins both.
 *
 * Too strict was the live failure: factNumbers only accepted a value whose
 * WHOLE scalar parsed as a number, so "28-5-0", 5'11" and "UFC 324" contributed
 * nothing, while the prose side tokenised inside strings -- and a fighter's own
 * win count was reported as invented. Too loose is the failure the fix could
 * have caused: tokenising every string would admit UUID and URL digits, letting
 * a slug number pass as a statistic.
 *
 * Both directions are asserted here, because fixing one by breaking the other
 * is the obvious wrong move and it would look like a success. */
import { factNumbers } from '../src/packet.mjs';
const packet = {
  primary: { name: 'X', fighter_id: '91218960-ded4-4375-890a-f3208575b374', record: '19-3-0' },
  bout: { bout_id: 'c8e30df9-21f1-46a9-907f-087e8c3d7b63' },
  hero: { url: 'https://upload.wikimedia.org/x/469714/portrait.jpg', thumbnail: 'https://i.ytimg.com/vi/kszuZx8/hq720.jpg' },
  video: { video_id: 'kszuZx8Gc9o', channel_id: 'UCYXJFtx4SUkrb2p8mhLPzQ' },
  trigger: { url: 'https://www.mmamania.com/ufc-odds/469714/noche-ufc-best-props' },
  source: { excerpt: 'nothing here should be class A' },
};
const fn = factNumbers(packet);
const mustReject = ['469714','91218960','4375','720','8','21','63'];
const mustAccept = ['19','3','0'];
let bad = 0;
console.log('MUST BE REJECTED (identifier/URL digits are not facts):');
for (const t of mustReject) { const c = fn.get(String(Number(t))); const ok = c !== 'A'; if(!ok) bad++;
  console.log(`  ${ok?'ok  ':'LEAK'} ${t.padEnd(9)} -> ${c ?? 'class C'}`); }
console.log('MUST BE ACCEPTED (the record is a real fact):');
for (const t of mustAccept) { const c = fn.get(String(Number(t))); const ok = c === 'A'; if(!ok) bad++;
  console.log(`  ${ok?'ok  ':'FAIL'} ${t.padEnd(9)} -> ${c ?? 'class C'}`); }
console.log(bad ? `\n${bad} PROBLEM(S)` : '\nguard holds: identifiers contribute nothing, facts contribute');
