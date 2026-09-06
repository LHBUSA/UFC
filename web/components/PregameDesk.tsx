import Link from "next/link";
import type { Bout, Event } from "@/lib/db";
import { eventSlug, matchupSlug } from "@/lib/slug";
import { fmtRecord, weightClassLabel } from "@/lib/format";

function totalFights(f: Bout["fighter_a"]): number | null {
  if (f.record_w == null) return null;
  return (f.record_w || 0) + (f.record_l || 0) + (f.record_d || 0) + (f.record_nc || 0);
}

function readFight(b: Bout): Array<{ label: string; text: string }> {
  const a = b.fighter_a, c = b.fighter_b;
  const reads: Array<{ label: string; text: string }> = [];
  const reachA = a.reach_in == null ? null : Number(a.reach_in);
  const reachB = c.reach_in == null ? null : Number(c.reach_in);
  if (reachA != null && reachB != null && Math.abs(reachA - reachB) >= 2) {
    const longer = reachA > reachB ? a : c;
    reads.push({ label: "Range", text: `${longer.name} owns a ${Math.abs(reachA - reachB).toFixed(1).replace(/\.0$/, "")}-inch listed reach advantage. That does not decide the fight, but it changes the distance problem the other side has to solve.` });
  }
  const hA = a.height_in == null ? null : Number(a.height_in), hB = c.height_in == null ? null : Number(c.height_in);
  if (hA != null && hB != null && Math.abs(hA - hB) >= 3 && reads.length < 3) {
    const taller = hA > hB ? a : c;
    reads.push({ label: "Frame", text: `${taller.name} is listed ${Math.abs(hA - hB).toFixed(0)} inches taller. Watch how that frame affects entries, clinch position and the space available to attack.` });
  }
  if (a.stance && c.stance && a.stance !== c.stance && reads.length < 3) {
    reads.push({ label: "Stance", text: `${a.name} (${a.stance.toLowerCase().replace("_", " ")}) and ${c.name} (${c.stance.toLowerCase().replace("_", " ")}) create an opposite-look matchup. Lead-foot position and open-side attacks become part of the geometry from the first exchange.` });
  }
  const af = totalFights(a), bf = totalFights(c);
  if (af != null && bf != null && Math.abs(af - bf) >= 6 && reads.length < 3) {
    const veteran = af > bf ? a : c;
    reads.push({ label: "Experience", text: `${veteran.name} enters with ${Math.abs(af - bf)} more recorded professional bouts. Experience is not an automatic edge, but it is meaningful context when the fight changes shape under pressure.` });
  }
  if ((b.is_title || b.scheduled_rounds === 5) && reads.length < 3) {
    reads.push({ label: "Five-round tax", text: `This is scheduled for five rounds. Pace management, recoverability and the ability to make adjustments after the first ten minutes matter more here than in a standard three-round assignment.` });
  }
  if (b.short_notice_days != null && b.short_notice_days <= 14 && reads.length < 3) {
    reads.push({ label: "Short notice", text: `A short-notice window of ${b.short_notice_days} days is recorded for this matchup. Treat preparation time as a real uncertainty rather than pretending the normal camp assumptions apply.` });
  }
  if (!reads.length) reads.push({ label: "Read the tape", text: `The stored physical and record data do not create an obvious pre-fight contrast. That is useful too: the matchup should be read through the full Fight DNA and recent-fight evidence instead of forcing a superficial angle.` });
  return reads;
}

export function PregameDesk({ event, bouts, limit = 3 }: { event: Event; bouts: Bout[]; limit?: number }) {
  const live = bouts.filter((b) => b.status !== "cancelled" && !b.result).slice(0, limit);
  if (!live.length) return null;
  return (
    <section className="pregame-desk" aria-labelledby="pregame-title">
      <div className="pregame-head">
        <div>
          <div className="eyebrow">Fight-week intelligence</div>
          <h2 id="pregame-title">Pregame Desk</h2>
          <p>What matters before the first horn — built from the card, fighter records and verified matchup data already in PropBetEdge.</p>
        </div>
        <Link href={`/events/${eventSlug(event)}`} className="btn">Full card →</Link>
      </div>
      <div className="pregame-grid">
        {live.map((b, index) => (
          <article className="pregame-fight" key={b.id}>
            <div className="pregame-kicker">{index === 0 ? "Main-event read" : weightClassLabel(b.weight_class, b.is_womens)}</div>
            <h3>{b.fighter_a.name} <span>vs</span> {b.fighter_b.name}</h3>
            <div className="pregame-records"><b>{fmtRecord(b.fighter_a)}</b><i /> <b>{fmtRecord(b.fighter_b)}</b></div>
            <div className="pregame-reads">
              {readFight(b).map((r) => <div key={r.label}><strong>{r.label}</strong><p>{r.text}</p></div>)}
            </div>
            <Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, event)}`} className="pregame-link">Open matchup intelligence →</Link>
          </article>
        ))}
      </div>
      <p className="pregame-note">Pregame Desk is evidence-led commentary, not a pick generator. Odds, model output and injury/camp claims are shown only when a verified source exists.</p>
    </section>
  );
}
