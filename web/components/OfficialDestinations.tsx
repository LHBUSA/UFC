import { OFFICIAL_DESTINATIONS } from "@/lib/heritage";

/* "Official UFC" destination group. Clearly labeled as official, always
 * outbound, never mixed with PropBetEdge content. `keys` narrows the set for
 * compact placements; `compact` renders a single utility row. */
export function OfficialDestinations({ keys, compact = false, title = "Official UFC destinations", intro }: {
  keys?: ReadonlyArray<(typeof OFFICIAL_DESTINATIONS)[number]["key"]>; compact?: boolean; title?: string; intro?: string;
}) {
  const items = keys ? OFFICIAL_DESTINATIONS.filter((d) => keys.includes(d.key)) : [...OFFICIAL_DESTINATIONS];
  if (compact) {
    return (
      <div className="official-row" role="navigation" aria-label={title}>
        <span className="official-row-label">Official UFC</span>
        {items.map((d) => <a key={d.key} href={d.href} target="_blank" rel="noopener">{d.label} ↗</a>)}
      </div>
    );
  }
  return (
    <section className="official-love" aria-label={title}>
      <div><div className="eyebrow">Official destinations · not PropBetEdge content</div><h2>{title}</h2>{intro && <p className="dim sm mt-2" style={{ maxWidth: "70ch" }}>{intro}</p>}</div>
      <div className="official-love-links">
        {items.map((d) => <a key={d.key} href={d.href} target="_blank" rel="noopener"><b>{d.label} ↗</b><span>{d.note}</span></a>)}
      </div>
    </section>
  );
}
