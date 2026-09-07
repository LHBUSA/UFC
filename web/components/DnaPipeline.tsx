/* Fight DNA pipeline — the moat visual. The product is the system, not any
 * single stat: source record → normalized history → as-of reconstruction →
 * versioned feature system → confidence + provenance → matchup intelligence.
 * Every step lists what is actually implemented today (docs/FIGHT_DNA_CONTRACT.md). */

const STEPS: Array<{ n: string; title: string; items: string[]; tag?: string; hi?: boolean }> = [
  { n: "01", title: "Source record", items: ["events", "bouts", "results", "round stats"], tag: "Source" },
  { n: "02", title: "Normalized fight history", items: ["identity-matched fighters", "event-dated bouts", "per-round rows for both corners", "source URL + capture time on every row"] },
  { n: "03", title: "As-of reconstruction", items: ["only bouts before the date", "one snapshot per event date", "no future-fight contamination"] },
  { n: "04", title: "Fight DNA feature system", items: ["stance", "striking", "grappling", "finish", "round", "context"], tag: "PBE Derived", hi: true },
  { n: "05", title: "Confidence + provenance", items: ["sample bouts · rounds · seconds", "confidence tier per metric", "definition version", "source families"] },
  { n: "06", title: "Matchup intelligence", items: ["paired comparisons", "supported observations", "counter-case warnings"] },
];

export function DnaPipeline({ compact = false }: { compact?: boolean }) {
  return (
    <ol className={`dna-pipe${compact ? " compact" : ""}`} aria-label="Fight DNA pipeline">
      {STEPS.map((s) => (
        <li className={`dna-pipe-step${s.hi ? " hi" : ""}`} key={s.n}>
          <span className="n">{s.n}</span>
          <h4>{s.title}</h4>
          <ul>{s.items.map((i) => <li key={i}>{i}</li>)}</ul>
          {s.tag && <span className={`tag${s.hi ? " gold" : ""}`}>{s.tag}</span>}
        </li>
      ))}
    </ol>
  );
}
