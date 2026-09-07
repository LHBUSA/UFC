"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/* Mobile menu controller.
 *
 * Root cause of the "tap, then dismiss" bug: the drawer is a CSS-only
 * checkbox toggle (#mnav-toggle:checked ~ .mnav). The header lives in the
 * root layout, so a client-side route change keeps the checkbox checked and
 * the open drawer stays stacked above the new page until the user taps the
 * hamburger again. This controller closes the drawer as part of the click
 * flow (any link inside it), again when the pathname actually changes, on
 * Escape, and it releases the body scroll lock it applies while open. */
export function MobileNav({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  const toggle = () => document.getElementById("mnav-toggle") as HTMLInputElement | null;
  const close = () => {
    const t = toggle();
    if (t && t.checked) { t.checked = false; t.dispatchEvent(new Event("change", { bubbles: true })); }
    document.documentElement.classList.remove("mnav-open");
  };

  /* Close on navigation complete (covers links, back/forward and programmatic pushes). */
  useEffect(() => { close(); }, [pathname]);

  useEffect(() => {
    const t = toggle();
    if (!t) return;
    const onChange = () => { document.documentElement.classList.toggle("mnav-open", t.checked); if (t.checked) ref.current?.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true }); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && t.checked) { close(); document.querySelector<HTMLElement>(".menu-btn")?.focus(); } };
    t.addEventListener("change", onChange);
    document.addEventListener("keydown", onKey);
    return () => { t.removeEventListener("change", onChange); document.removeEventListener("keydown", onKey); document.documentElement.classList.remove("mnav-open"); };
  }, []);

  /* Close as part of the click flow so the destination is visible immediately; the Link navigation still proceeds. */
  const onClickCapture = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("a")) close(); };

  return <div className="mnav" ref={ref} onClickCapture={onClickCapture}>{children}</div>;
}
