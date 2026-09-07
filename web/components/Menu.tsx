"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/* Accessible dropdown used by the global "More ▾" menu and the Fight Week
 * "Jump to fight ▾" control. Click or Enter/Space opens (not hover-only),
 * arrow keys move between items, Escape closes and returns focus to the
 * trigger, clicking outside closes, and any navigation closes. Groups render
 * with small headings so the menu reads as deliberate structure. */

export type MenuItem = { href: string; label: string; note?: string; external?: boolean };
export type MenuGroup = { heading?: string; items: MenuItem[] };

export function Dropdown({ label, groups, active = false, align = "left", className = "", panelClassName = "", id }: { label: React.ReactNode; groups: MenuGroup[]; active?: boolean; align?: "left" | "right"; className?: string; panelClassName?: string; id?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const panelId = id ? `${id}-menu` : `${uid}-menu`;
  const pathname = usePathname();

  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);

  /* Close on route change. */
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const items = () => [...(wrap.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') || [])];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(true); return; }
      const list = items(); if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLAnchorElement);
      if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === "Tab") { /* leaving the menu closes it without trapping focus */ setTimeout(() => { if (wrap.current && !wrap.current.contains(document.activeElement)) setOpen(false); }, 0); }
    };
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    /* Move focus into the menu when opened from the keyboard. */
    const first = items()[0];
    if (first && btn.current === document.activeElement) first.focus();
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open, close]);

  return (
    <div className={`dd${open ? " open" : ""}${active ? " active" : ""} ${className}`} ref={wrap}>
      <button ref={btn} type="button" className="dd-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={panelId} aria-current={active ? "page" : undefined} onClick={() => setOpen((v) => !v)} onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
        {label}<i className="dd-caret" aria-hidden="true" />
      </button>
      <div id={panelId} role="menu" className={`dd-panel ${align} ${panelClassName}`} hidden={!open}>
        {groups.map((g, gi) => (
          <div className="dd-group" key={gi} role="group" aria-label={g.heading || undefined}>
            {g.heading && <div className="dd-heading" aria-hidden="true">{g.heading}</div>}
            {g.items.map((it) => it.external
              ? <a key={it.href} href={it.href} role="menuitem" target="_blank" rel="noopener" onClick={() => close(false)}>{it.label}{it.note && <small>{it.note}</small>}</a>
              : <Link key={it.href} href={it.href} role="menuitem" aria-current={pathname && (pathname === it.href || (it.href !== "/" && !it.href.includes("#") && pathname.startsWith(it.href))) ? "page" : undefined} onClick={() => close(false)}>{it.label}{it.note && <small>{it.note}</small>}</Link>)}
          </div>
        ))}
      </div>
    </div>
  );
}
