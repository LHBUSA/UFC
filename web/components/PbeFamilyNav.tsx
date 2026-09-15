import Link from "next/link";

/* The PBE product family, one role per page. Links only: no page's content is
 * repeated here, and nothing in it reads or reveals a call. */

export type PbeFamilyPage = "model" | "algo" | "picks" | "record";

const FAMILY: ReadonlyArray<{ key: PbeFamilyPage; href: string; name: string; role: string; pro?: boolean }> = [
  { key: "picks", href: "/algo/card", name: "PBE Picks", role: "The current calls: probability, odds and PBE Edge", pro: true },
  { key: "record", href: "/algo/record", name: "Track Record", role: "Every locked call, graded and never edited", pro: true },
  { key: "algo", href: "/algo", name: "How PBE Algo calls a fight", role: "Eligibility, no-call rules, lock and grading" },
  { key: "model", href: "/model", name: "PBE Fight Model", role: "The evidence: backtest, calibration, leakage proof" },
];

export function PbeFamilyNav({ current, title = "The PBE product family" }: { current: PbeFamilyPage; title?: string }) {
  return (
    <nav className="pbe-family" aria-label="PBE product family">
      <div className="pbe-family-title">{title}</div>
      <ul>
        {FAMILY.map((f) => (
          <li key={f.key}>
            <Link href={f.href} aria-current={f.key === current ? "page" : undefined} className={f.key === "picks" ? "flagship" : undefined}>
              <span className="pbe-family-name">{f.name}{f.pro && <em>PRO</em>}</span>
              <span className="pbe-family-role">{f.role}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
