"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, type NavPlace } from "@/lib/site";
import { Dropdown, type MenuGroup } from "./Menu";

/* Primary navigation.
 *
 * Desktop: Fight Week · Schedule · Fighters · Rankings · News · More ▾.
 * "Home" is the logo; "Pro" is the Go Pro CTA — both routes stay, only the
 * duplicate text links leave the bar. Secondary destinations live in an
 * accessible More menu grouped by purpose. Mobile: primary items, then the
 * same secondary routes under a "More" heading, all with large tap targets. */

function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  if (href.includes("#")) return false;
  if (href === "/fight-week") return path.startsWith("/fight-week") || path.startsWith("/pregame");
  if (href === "/#notable-voices") return path.startsWith("/voices");
  return path.startsWith(href);
}

const byPlace = (place: NavPlace) => NAV.filter((n) => (n.place || "primary") === place);

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
        {primary.map((n) => <Link key={n.href} href={n.href} aria-current={isActive(path, n.href) ? "page" : undefined} onClick={onNavigate}>{n.label}</Link>)}
        <div className="mnav-group" aria-label="More">
          <div className="mnav-heading">More</div>
          {more.map((n) => <Link key={n.href} href={n.href} aria-current={isActive(path, n.href) || (n.href === "/#notable-voices" && voicesActive) ? "page" : undefined} onClick={onNavigate}>{n.label}<small>{n.group}</small></Link>)}
        </div>
      </nav>
    );
  }

  return (
    <nav className={className} aria-label="Primary">
      {primary.map((n) => <Link key={n.href} href={n.href} aria-current={isActive(path, n.href) ? "page" : undefined} onClick={onNavigate}>{n.label}</Link>)}
      <Dropdown id="nav-more" label="More" groups={moreGroups()} active={moreActive} className="nav-more" />
    </nav>
  );
}
