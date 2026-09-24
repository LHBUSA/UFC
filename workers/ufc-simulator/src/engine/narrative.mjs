// Round reads: template sentences over facts already in the simulation
// packet. No model, no LLM, no number that is not in the round record.

function mmss(sec) { const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }

export function roundFacts(round, names) {
  const f1 = round.fighter_1, f2 = round.fighter_2;
  const facts = [];
  const vol = f1.sig_l === f2.sig_l ? null : f1.sig_l > f2.sig_l ? 0 : 1;
  if (vol != null) facts.push({ key: 'volume_leader', fighter: vol, values: [f1.sig_l, f2.sig_l] });
  for (const [side, f] of [[0, f1], [1, f2]]) {
    if (f.sig_l >= 10 && f.leg_l / f.sig_l >= 0.35) facts.push({ key: 'leg_attack', fighter: side, values: [f.leg_l, f.sig_l] });
    if (f.sig_l >= 10 && f.body_l / f.sig_l >= 0.3) facts.push({ key: 'body_attack', fighter: side, values: [f.body_l, f.sig_l] });
    if (f.td_l > 0) facts.push({ key: 'takedowns', fighter: side, values: [f.td_l, f.td_a, f.ctrl] });
    else if (f.td_a > 0) facts.push({ key: 'takedowns_stuffed', fighter: side, values: [f.td_a] });
    if (f.kd > 0) facts.push({ key: 'knockdown', fighter: side, values: [f.kd] });
    if (f.sub > 0) facts.push({ key: 'submission_attempts', fighter: side, values: [f.sub] });
    if (f.ctrl >= 120) facts.push({ key: 'control', fighter: side, values: [f.ctrl] });
  }
  const s1 = round.score.fighter_1, s2 = round.score.fighter_2;
  facts.push({ key: 'pbe_round', fighter: s1 > s2 ? 0 : s2 > s1 ? 1 : null, values: [s1, s2] });
  return facts;
}

export function roundRead(round, names, ending = null) {
  const n = (i) => names[i];
  const lines = [];
  for (const f of roundFacts(round, names)) {
    switch (f.key) {
      case 'volume_leader': lines.push(`${n(f.fighter)} out-lands ${n(1 - f.fighter)} ${f.values[f.fighter]} to ${f.values[1 - f.fighter]} in significant strikes.`); break;
      case 'leg_attack': lines.push(`${n(f.fighter)}'s leg attack is a feature: ${f.values[0]} of ${f.values[1]} landed strikes go to the legs.`); break;
      case 'body_attack': lines.push(`${n(f.fighter)} is working the body: ${f.values[0]} of ${f.values[1]} landed strikes.`); break;
      case 'takedowns': lines.push(`${n(f.fighter)} lands ${f.values[0]} of ${f.values[1]} takedowns${f.values[2] >= 30 ? ` with ${mmss(f.values[2])} of control` : ''}.`); break;
      case 'takedowns_stuffed': lines.push(`${n(f.fighter)} attempts ${f.values[0]} takedown${f.values[0] > 1 ? 's' : ''} without success.`); break;
      case 'knockdown': lines.push(`${n(f.fighter)} scores ${f.values[0] > 1 ? `${f.values[0]} knockdowns` : 'a knockdown'}.`); break;
      case 'submission_attempts': lines.push(`${n(f.fighter)} threatens ${f.values[0] > 1 ? `${f.values[0]} submissions` : 'a submission'}.`); break;
      case 'control': lines.push(`${n(f.fighter)} controls ${mmss(f.values[0])} of the round.`); break;
      case 'pbe_round': lines.push(f.fighter == null ? `PBE ROUND: even, 10-10.` : `PBE ROUND: ${n(f.fighter)} ${Math.max(f.values[0], f.values[1])}-${Math.min(f.values[0], f.values[1])}.`); break;
      default: break;
    }
  }
  if (ending) lines.push(ending);
  return lines;
}

export function endingLine(fight, names, precision) {
  const w = names[fight.winner - 1];
  if (fight.method === 'DEC') return `${w} wins on the PBE cards.`;
  if (fight.method === 'DRAW') return `PBE scores it a draw.`;
  const how = fight.method === 'KO_TKO' ? 'by KO/TKO' : 'by submission';
  return precision === 'round' ? `${w} wins ${how} in round ${fight.end_round}.` : `${w} wins ${how} at ${mmss(fight.end_time_sec)} of round ${fight.end_round}.`;
}

export function timeWindow(sec, L = 300) {
  const t = Math.floor(sec / (L / 3));
  return ['early', 'mid', 'late'][Math.min(2, t)];
}
