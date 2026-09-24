"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, navFor } from "@/lib/site";
import { Dropdown, type MenuGroup } from "./Menu";

/* Primary navigation.
 *
 * Desktop: Fight Week · PBE PICKS · (FIGHT SIMULATOR, once its route ships) ·
 * Schedule · Fighters · Rankings · News · More ▾. "Home" is the logo; "Pro" is
 * the Go Pro CTA — both routes stay, only the duplicate text links leave the
 * bar. Store and the other secondary destinations live in an accessible More
 * menu grouped by purpose. Mobile: primary items, then the same secondary
 * routes under a "More" heading, all with large tap targets. Pending slots
 * (lib/site.ts) are filtered by navFor and never render as links. */

function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  if (href.includes("#")) return false;
  if (href === "/fight-week") return path.startsWith("/fight-week") || path.startsWith("/pregame");
  if (href === "/#notable-voices") return path.startsWith("/voices");
  /* /algo (method) must not light up while the reader is on /algo/card (PBE PICKS). */
  if (href === "/algo") return path === "/algo" || path.startsWith("/algo/record");
  return path.startsWith(href);
}

const byPlace = navFor;

/* PBE PICKS keeps its exact label and route; only its presentation differs. */
function PrimaryLink({ n, path, onNavigate }: { n: (typeof NAV)[number]; path: string; onNavigate?: () => void }) {
  const current = isActive(path, n.href) ? "page" : undefined;
  if (!n.flagship) return <Link href={n.href} aria-current={current} onClick={onNavigate}>{n.label}</Link>;
  if (n.badge) {
    return (
      <Link href={n.href} aria-current={current} onClick={onNavigate} className="nav-pbe-picks" data-nav-badge={n.badge}>
        <i className="nav-signal" aria-hidden="true" />
        <span>{n.label}</span>
        <span className="nav-pro">{n.badge}</span>
      </Link>
    );
  }
  return (
    <Link href={n.href} aria-current={current} onClick={onNavigate} className="nav-pbe-picks">
      <i className="nav-signal" aria-hidden="true" />
      <span>{n.label}</span>
      <span className="nav-pro">PRO</span>
    </Link>
  );
}

export function moreGroups(): MenuGroup[] {
  const groups = new Map<string, MenuGroup>();
  for (const n of byPlace("more")) {
    const key = n.group || "More";
    if (!groups.has(key)) groups.set(key, { heading: key, items: [] });
    groups.get(key)!.items.push({ href: n.href, label: n.label });
  }
  return [...groups.values()];
}

export function NavLinks({ className, onNavigate, variant = "desktop" }: { className: string; onNavigate?: () => void; variant?: "desktop" | "mobile" }) {
  const path = usePathname() || "/";
  const primary = byPlace("primary");
  const more = byPlace("more");
  const voicesActive = path.startsWith("/voices");
  const moreActive = more.some((n) => isActive(path, n.href)) || voicesActive;

  if (variant === "mobile") {
    return (
      <nav className={className} aria-label="Primary">
        {primary.map((n) => <PrimaryLink key={n.href} n={n} path={path} onNavigate={onNavigate} />)}
        <div className="mnav-group" aria-label="More">
          <div className="mnav-heading">More</div>
          {more.map((n) => <Link key={n.href} href={n.href} aria-current={isActive(path, n.href) || (n.href === "/#notable-voices" && voicesActive) ? "page" : undefined} onClick={onNavigate}>{n.label}<small>{n.group}</small></Link>)}
        </div>
      </nav>
    );
  }

  return (
    <nav className={className} aria-label="Primary">
      {primary.map((n) => <PrimaryLink key={n.href} n={n} path={path} onNavigate={onNavigate} />)}
      <Dropdown id="nav-more" label="More" groups={moreGroups()} active={moreActive} className="nav-more" />
    </nav>
  );
}
