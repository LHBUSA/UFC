import type { FightTotals } from "@/lib/db";

/* Whole-fight statistics, from ESPN.
 *
 * This is NOT round analysis and is deliberately not named like it. ESPN
 * publishes one set of numbers per fighter per fight, labelled in its own
 * payload as splits.type "total", with no round dimension anywhere in the
 * public graph. UFC Stats publishes the round decomposition. Both can be true
 * for the same bout and they are shown as two sections, because a reader who
 * cannot tell which source produced a number cannot judge what it is worth.
 *
 * So the header says ESPN, in the UI and not only in a comment.
 */

const fmtCtrl = (s: number | null): string =>
  s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const pair = (l: number | null, a: number | null): string =>
  l == null && a == null ? "—" : a == null ? String(l) : `${l ?? 0}/${a}`;

const pct = (l: number | null, a: number | null): string | null =>
  l == null || !a ? null : `${Math.round((l / a) * 100)}%`;

function Row({ label, a, b, hint }: { label: string; a: string; b: string; hint?: string }) {
  /* A row where neither corner has a value is not a row: it is an invitation
   * to read an em dash as a zero. */
  if (a === "—" && b === "—") return null;
  return (
    <tr>
      <td className="ft-a mono">{a}</td>
      <th scope="row">{label}{hint ? <small>{hint}</small> : null}</th>
      <td className="ft-b mono">{b}</td>
    </tr>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Array<[string, string, string]> }) {
  const live = rows.filter(([, a, b]) => !(a === "—" && b === "—"));
  if (!live.length) return null;
  return (
    <div className="ft-break">
      <h4>{title}</h4>
      <table className="ft-table">
        <tbody>{live.map(([l, a, b]) => <Row key={l} label={l} a={a} b={b} />)}</tbody>
      </table>
    </div>
  );
}

export function FightTotalsSection({
  totals, fighterAId, fighterBId, nameA, nameB,
}: {
  totals: FightTotals[];
  fighterAId: string;
  fighterBId: string;
  nameA: string;
  nameB: string;
}) {
  const A = totals.find((t) => t.fighter_id === fighterAId) || null;
  const B = totals.find((t) => t.fighter_id === fighterBId) || null;
  /* Both corners or nothing. One fighter's totals would read as a complete
   * account of a fight in which the other man threw nothing. */
  if (!A || !B) return null;

  const src = A.source_family === "espn" ? "ESPN" : "UFC Stats";

  return (
    <section className="segment" id="fight-totals">
      <h3>Fight totals <small>{src} · final</small></h3>
      <div className="card ft-card">
        <div className="ft-head">
          <span className="ft-n a">{nameA}</span>
          <span className="ft-mid">Whole fight</span>
          <span className="ft-n b">{nameB}</span>
        </div>

        <table className="ft-table ft-main">
          <tbody>
            <Row label="Knockdowns" a={A.kd == null ? "—" : String(A.kd)} b={B.kd == null ? "—" : String(B.kd)} />
            <Row
              label="Sig. strikes"
              hint={pct(A.sig_str_landed, A.sig_str_att) && pct(B.sig_str_landed, B.sig_str_att)
                ? `${pct(A.sig_str_landed, A.sig_str_att)} · ${pct(B.sig_str_landed, B.sig_str_att)}`
                : undefined}
              a={pair(A.sig_str_landed, A.sig_str_att)}
              b={pair(B.sig_str_landed, B.sig_str_att)}
            />
            <Row label="Total strikes" a={pair(A.total_str_landed, A.total_str_att)} b={pair(B.total_str_landed, B.total_str_att)} />
            <Row label="Takedowns" a={pair(A.td_landed, A.td_att)} b={pair(B.td_landed, B.td_att)} />
            <Row label="Control" a={fmtCtrl(A.ctrl_sec)} b={fmtCtrl(B.ctrl_sec)} />
            <Row label="Reversals" a={A.rev == null ? "—" : String(A.rev)} b={B.rev == null ? "—" : String(B.rev)} />
          </tbody>
        </table>

        {/* Progressive detail. The default view stays the six lines above; the
            breakdowns are here for a reader who wants them and folded away for
            one who does not. */}
        <details className="ft-more">
          <summary>Target and position breakdown</summary>
          <div className="ft-breaks">
            <Breakdown
              title="Targets"
              rows={[
                ["Head", pair(A.head_landed, A.head_att), pair(B.head_landed, B.head_att)],
                ["Body", pair(A.body_landed, A.body_att), pair(B.body_landed, B.body_att)],
                ["Leg", pair(A.leg_landed, A.leg_att), pair(B.leg_landed, B.leg_att)],
              ]}
            />
            <Breakdown
              title="Position"
              rows={[
                ["Distance", pair(A.distance_landed, A.distance_att), pair(B.distance_landed, B.distance_att)],
                ["Clinch", pair(A.clinch_landed, A.clinch_att), pair(B.clinch_landed, B.clinch_att)],
                ["Ground", pair(A.ground_landed, A.ground_att), pair(B.ground_landed, B.ground_att)],
              ]}
            />
          </div>
          <p className="ft-note">
            Both breakdowns decompose the same significant-strike totals, once by target and once by position,
            so each adds back to the sig. strikes line above.
          </p>
        </details>

        <div className="ft-prov">
          Fight totals · <a href={A.source_url} target="_blank" rel="noopener">{src} ↗</a>
          {A.source_updated_at ? <> · source updated <time dateTime={A.source_updated_at}>{new Date(A.source_updated_at).toISOString().replace("T", " ").slice(0, 16)}Z</time></> : null}
          <span className="ft-prov-sep"> · </span>
          Whole-fight figures. {src} publishes no per-round split, so these are not round data.
        </div>
      </div>
    </section>
  );
}
