"use client";

/* A plain link that also records a first-party click event. The destination URL
 * is untouched (no tracking parameters, no redirect hop), so there is no
 * duplicate URL for anyone to crawl, and navigation never waits on the beacon. */
export function HousePromoLink({ href, placement, campaign, dest, slug, track, className, newTab = false, children }: {
  href: string; placement: "end"; campaign: string; dest: string; slug: string; track: boolean;
  className?: string; newTab?: boolean; children: React.ReactNode;
}) {
  const onClick = () => {
    if (!track) return;
    try {
      const body = JSON.stringify({ event: "click", placement, campaign, dest, slug });
      if (!navigator.sendBeacon?.("/api/ufc/house-promo", new Blob([body], { type: "application/json" }))) {
        void fetch("/api/ufc/house-promo", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
      }
    } catch { /* never block navigation */ }
  };
  return (
    <a href={href} className={className} onClick={onClick} {...(newTab ? { target: "_blank", rel: "noopener" } : {})} data-promo-dest={dest}>
      {children}
    </a>
  );
}
