/* Fighter portrait coverage: how much of the product has an approved face.
 * Same data as /admin/media/coverage.json and scripts/media/fighter_portrait_coverage.mjs. */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MediaAdminError, currentMediaReviewer, getCoverage, type Coverage } from "@/lib/fighterMediaAdmin";
import s from "../media.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Portrait coverage",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

const share = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "—");

export default async function CoveragePage() {
  if (!(await currentMediaReviewer())) notFound();
  let c: Coverage | null = null;
  let err: string | null = null;
  try { c = await getCoverage(); } catch (e) { err = e instanceof MediaAdminError ? e.message : "Coverage could not be computed."; }

  return (
    <div className={`wrap page ${s.page}`}>
      <div className={s.head}>
        <div>
          <div className="eyebrow">Internal</div>
          <h1>Fighter portrait coverage</h1>
          {c && <p className="faint sm">Generated {c.generated_at}. High-visibility = approved, verified, primary and commercial-cleared. Standard-only = approved but restricted to archive/index surfaces.</p>}
        </div>
        <div className={s.headActions}>
          <Link href="/admin/media" className="btn">Review queue</Link>
          <Link href="/admin/media/coverage.json" className="btn ghost">JSON</Link>
        </div>
      </div>
      {err && <div className={s.flashErr} role="alert">{err}</div>}
      {c && (
        <>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <tbody>
                <tr><th>Total fighters</th><td className={s.num}>{c.total_fighters?.toLocaleString() ?? "—"}</td></tr>
                <tr><th>Fighters with an approved portrait (any surface)</th><td className={s.num}>{c.approved_portraits}</td></tr>
                <tr><th>… cleared for high-visibility surfaces</th><td className={s.num}>{c.approved_high_visibility}</td></tr>
                <tr><th>Pending candidates</th><td className={s.num}>{c.candidates.pending || 0}</td></tr>
                <tr><th>Approved / rejected / quarantined candidates</th><td className={s.num}>{c.candidates.approved || 0} / {c.candidates.rejected || 0} / {c.candidates.quarantined || 0}</td></tr>
                <tr><th>Active quarantine entries</th><td className={s.num}>{c.quarantine_active ?? "—"}</td></tr>
                <tr><th>Assets quarantined</th><td className={s.num}>{c.assets_quarantined ?? "—"}</td></tr>
              </tbody>
            </table>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>Group</th><th className={s.num}>Fighters</th><th className={s.num}>High-visibility portrait</th><th className={s.num}>Standard only</th><th className={s.num}>Placeholder</th></tr></thead>
              <tbody>
                {c.groups.map((g) => (
                  <tr key={g.key}>
                    <td><Link href={`/admin/media?filter=${g.key === "scope" ? "all" : g.key}`}>{g.label}</Link></td>
                    <td className={s.num}>{g.total}</td>
                    <td className={s.num}>{g.highVisibility} ({share(g.highVisibility, g.total)})</td>
                    <td className={s.num}>{g.standardOnly}</td>
                    <td className={s.num}>{g.total - g.highVisibility - g.standardOnly}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
