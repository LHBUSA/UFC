import Link from "next/link";
import type { Bout, Event, FightTotals } from "@/lib/db";
import { buildBoutScorecard, wentToTheJudges } from "@/lib/judgeScoring";
import { matchupSlug } from "@/lib/slug";
import { fmtTime, METHOD_LABEL } from "@/lib/format";

/* Results intelligence for a completed card: per bout, the official result,
 * the ESPN whole-fight totals and the judges' final card totals — the same
 * stored rows and the same scorecard model the fight page renders, condensed
 * to one row per bout with the fight page one tap away.
 *
 * Every number on a row reads in ONE order: the fighter named first (the
 * winner, or fighter A when there is none), then the opponent. Only what is
 * stored is shown. A finish shows no cards (it never reached the judges); a
 * decision whose cards are not on file says so rather than printing blanks.
 * Totals are whole-fight figures and are never presented as rounds. */

const pair = (l: number | null, a: number | null) => (l == null ? "—" : a == null ? String(l) : `${l}/${a}`);
const ctrl = (s: number | null) => (s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

export function CardIntelligence({ bouts, e, totals }: { bouts: Bout[]; e: Event; totals: Map<string, FightTotals[]> }) {
  const done = bouts.filter((b) => b.result && b.status !== "cancelled");
  const rows = done.map((b) => {
    const r = b.result!;
    const firstIsA = !r.winner_id || r.winner_id === b.fighter_a.id;
    const first = firstIsA ? b.fighter_a : b.fighter_b;
    const second = firstIsA ? b.fighter_b : b.fighter_a;
    const t = totals.get(b.id) || [];
    const T1 = t.find((x) => x.fighter_id === first.id) || null;
    const T2 = t.find((x) => x.fighter_id === second.id) || null;
    const sheet = buildBoutScorecard({ method: r.method, scorecards: r.scorecards, winnerId: r.winner_id, fighterAId: b.fighter_a.id, fighterBId: b.fighter_b.id });
    return { b, r, first, second, T1: T1 && T2 ? T1 : null, T2: T1 && T2 ? T2 : null, sheet, firstIsA, judged: wentToTheJudges(r.method) };
  });
  const withTotals = rows.filter((x) => x.T1).length;
  const judged = rows.filter((x) => x.judged).length;
  const carded = rows.filter((x) => x.judged && x.sheet.hasOfficialScorecard).length;
  if (!withTotals && !carded) return null;

  return (
    <section className="segment ci" id="results-intelligence">
      <h3>Results intelligence <small>{withTotals} of {done.length} bouts with fight totals · {carded} of {judged} decisions carded</small></h3>
      <div className="ci-list">
        {rows.map(({ b, r, first, second, T1, T2, sheet, firstIsA, judged: j }) => (
          <Link key={b.id} href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`} className="ci-row">
            <div className="ci-res">
              <b>{first.name} <span className="dim">{r.winner_id ? "def." : "vs"}</span> {second.name}</b>
              <small>{METHOD_LABEL[r.method] || r.method}{r.round ? ` · R${r.round}` : ""}{r.time_sec != null ? ` · ${fmtTime(r.time_sec)}` : ""}{r.finish_detail ? ` · ${r.finish_detail}` : ""}</small>
            </div>
            {T1 && T2 ? (
              <div className="ci-tot" aria-label={`Fight totals, ${first.name} then ${second.name}`}>
                <span><em>Sig</em>{pair(T1.sig_str_landed, T1.sig_str_att)} · {pair(T2.sig_str_landed, T2.sig_str_att)}</span>
                <span><em>TD</em>{pair(T1.td_landed, T1.td_att)} · {pair(T2.td_landed, T2.td_att)}</span>
                <span><em>Ctrl</em>{ctrl(T1.ctrl_sec)} · {ctrl(T2.ctrl_sec)}</span>
                {T1.kd || T2.kd ? <span><em>KD</em>{T1.kd ?? 0} · {T2.kd ?? 0}</span> : null}
              </div>
            ) : <div className="ci-tot ci-none">Fight totals not on file</div>}
            {j ? (
              sheet.hasOfficialScorecard ? (
                <div className="ci-cards">
                  {sheet.cards.map((c) => {
                    const s1 = firstIsA ? c.fighterAScore : c.fighterBScore;
                    const s2 = firstIsA ? c.fighterBScore : c.fighterAScore;
                    return (
                      <span key={c.cardIndex} className={c.isDissent ? "dissent" : ""}>
                        {c.judge} <b>{s1 != null && s2 != null ? `${s1}-${s2}` : c.rawScore}</b>
                      </span>
                    );
                  })}
                </div>
              ) : <div className="ci-cards ci-none">Judges&apos; cards not on file</div>
            ) : null}
          </Link>
        ))}
      </div>
      <p className="ci-note">Each row reads fighter named first, then opponent. Totals are ESPN whole-fight figures, not round data; cards are the judges&apos; final totals. Tap a bout for the full scorecard, judge profiles and round analysis where it exists.</p>
    </section>
  );
}
