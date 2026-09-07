import { SITE } from "@/lib/site";

/* Developer cross-link to the commercial UFC Intelligence API.
 *
 * Positioning matters here. This site is the application; ufc.proptechusa.ai
 * is the engine. The copy says the two are built on the same intelligence
 * layer, which is true, rather than claiming this product runs on the
 * commercial API, which is not verified and would be a harder claim to
 * defend. Wording changes should keep that distinction.
 *
 * Deliberately restrained: one heading, one sentence, one link. It sits below
 * the fan-facing content on every page that uses it. */
export function ApiCta({
  eyebrow = "Building a UFC product?",
  heading = "Events, fighters, rankings, round-level stats, Fight DNA and Matchup DNA are available through the UFC Intelligence API.",
  variant = "wide",
}: {
  eyebrow?: string;
  heading?: string;
  variant?: "wide" | "inline";
}) {
  return (
    <aside className={`api-cta api-cta-${variant}`} aria-label="UFC Intelligence API">
      <div className="api-cta-body">
        <div className="eyebrow">{eyebrow}</div>
        <p>{heading}</p>
        <p className="api-cta-note">Built on the same UFC intelligence layer that powers this site.</p>
      </div>
      <div className="api-cta-actions">
        <a className="btn gold" href={SITE.ufcApi} target="_blank" rel="noopener">Explore the API →</a>
        <a className="api-cta-docs" href={SITE.ufcApiDocs} target="_blank" rel="noopener">API docs ↗</a>
      </div>
    </aside>
  );
}
