"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/site";

export function NavLinks({ className, onNavigate }: { className: string; onNavigate?: () => void }) {
  const path = usePathname() || "/";
  return (
    <nav className={className} aria-label="Primary">
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href) || (n.href === "/fight-week" && path.startsWith("/pregame"));
        return (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} onClick={onNavigate}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
