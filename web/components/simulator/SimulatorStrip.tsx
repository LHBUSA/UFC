/* Fighter comparison strip (portraits via components/ui). Kept apart from
 * SimulatorViews so the result components stay renderable in unit tests. */
import Link from "next/link";
import { Avatar } from "@/components/ui";
import type { PortraitSet } from "@/lib/db";
import type { SimGate } from "@/lib/simulatorView";
import { GateBadge, TierChip } from "./SimulatorViews";
import s from "@/app/simulator/simulator.module.css";

export type StripFighter = { id: string; name: string; record: string | null; stance: string | null; reach_in: number | null; img: PortraitSet | null; tier: string | null; href: string | null };

export function FighterStrip({ left, right, gate }: { left: StripFighter; right: StripFighter; gate: SimGate | null }) {
  const card = (f: StripFighter, align: "l" | "r") => (
    <div className={`${s.fighter} ${align === "r" ? s.fighterR : ""}`}>
      <Avatar f={f} img={f.img} size={72} className={s.avatar} />
      <div className={s.fighterText}>
        {f.href ? <Link href={f.href} className={s.fighterName}>{f.name}</Link> : <span className={s.fighterName}>{f.name}</span>}
        <div className={s.fighterMeta}>{[f.record, f.stance ? f.stance.toLowerCase() : null, f.reach_in ? `${f.reach_in}" reach` : null].filter(Boolean).join(" · ")}</div>
        <div className={s.fighterMeta}>Fight DNA <TierChip tier={f.tier} /></div>
      </div>
    </div>
  );
  return (
    <div className={s.strip}>
      {card(left, "l")}
      <div className={s.vs}>{gate ? <GateBadge gate={gate} /> : null}<span>VS</span></div>
      {card(right, "r")}
    </div>
  );
}

