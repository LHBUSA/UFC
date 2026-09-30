import { SITE_SOURCE, preferredSourceDeeplink } from "@/lib/preferredSource";

/* Our own Preferred Sources control. The href is the documented Google
 * deeplink, so the control works before hydration and with the SDK blocked;
 * PreferredSourceMount upgrades clicks to Google's in-page flow when ready. */
export function PreferredSource({ surface = "footer" }: { surface?: "footer" | "article" }) {
  const link = {
    href: preferredSourceDeeplink(SITE_SOURCE),
    target: "_blank",
    rel: "noopener",
    "data-pbe-preferred-source": "",
    "data-surface": surface,
    "data-sport": "ufc",
    "aria-label": "Add PropBetEdge UFC as a preferred source in Google Search (opens Google)",
  };

  if (surface === "article") {
    return (
      <aside className="pbe-psrc pbe-psrc--article" aria-labelledby="pbe-psrc-article-title">
        <div className="pbe-psrc-copy">
          <strong id="pbe-psrc-article-title">Enjoy PropBetEdge reporting?</strong>
          <span>Make us a preferred source in Google.</span>
        </div>
        <a className="pbe-psrc-btn" {...link}>Add PropBetEdge</a>
      </aside>
    );
  }

  return (
    <div className="pbe-psrc pbe-psrc--footer">
      <div className="pbe-psrc-copy">
        <span className="pbe-psrc-eyebrow">Google Search</span>
        <strong>Make PropBetEdge a preferred source</strong>
        <span>See more PropBetEdge UFC reporting in Google.</span>
      </div>
      <a className="pbe-psrc-btn" {...link}>Add as preferred source</a>
    </div>
  );
}
