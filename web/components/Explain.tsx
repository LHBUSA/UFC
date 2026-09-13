"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

/* Accessible metric explainer.
 *
 * A real popover, not a title attribute: hover opens on pointer devices, tap
 * toggles on touch, Enter/Space toggle from the keyboard, Escape closes and
 * returns focus, clicking outside closes. The trigger carries aria-expanded
 * and aria-controls; the panel is a labelled dialog region. Nothing inside
 * grades a value — it explains the definition and shows the sample behind
 * the number.
 *
 * The panel renders in a portal on document.body with fixed positioning
 * measured from the trigger, so no card, accordion or transformed ancestor can
 * clip it, and it is kept inside all four viewport edges. Below the mobile
 * breakpoint it becomes a bottom sheet. Keyboard order is preserved by hand:
 * Tab from the open trigger moves into the panel, and leaving the panel either
 * way returns to the trigger. */

export type ExplainProps = {
  /* Heading of the popover, e.g. the metric's full name. */
  title: string;
  /* Plain-English definition. */
  body: string;
  unit?: string;
  caution?: string;
  formula?: string;
  rows?: Array<[string, string]>;
  learnHref?: string;
  learnLabel?: string;
  /* Visually-hidden accessible name for the trigger. */
  label?: string;
  size?: "sm" | "md";
};

const SHEET_MAX = 680; // px: at or below this viewport width the panel is a bottom sheet
const GAP = 8;         // px between trigger and panel
const EDGE = 12;       // px minimum distance from every viewport edge
const TIERS = new Set(["high", "medium", "low", "insufficient"]);

type Place = { top: number; left: number; width: number; maxHeight: number; side: "below" | "above" } | null;

function useIsoLayoutEffect(fn: () => void | (() => void), deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  (typeof window === "undefined" ? useEffect : useLayoutEffect)(fn, deps);
}

export function Explain({ title, body, unit, caution, formula, rows, learnHref, learnLabel = "Learn more →", label, size = "sm" }: ExplainProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [place, setPlace] = useState<Place>(null);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const viaKeyboard = useRef(false);
  /* Clicking a panel that hover opened pins it, so mouse-leave no longer closes it. */
  const pinned = useRef(false);

  useEffect(() => setMounted(true), []);

  const close = useCallback((refocus = false) => { pinned.current = false; setOpen(false); setPlace(null); if (refocus) btn.current?.focus(); }, []);

  /* Measure from the trigger and keep the whole panel on screen. */
  const position = useCallback(() => {
    const b = btn.current, p = pop.current;
    if (!b || !p) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    if (vw <= SHEET_MAX) { setSheet(true); setPlace(null); return; }
    setSheet(false);
    const r = b.getBoundingClientRect();
    const width = Math.min(Math.max(360, vw * 0.32), 440, vw - EDGE * 2);
    let left = r.left;
    if (left + width > vw - EDGE) left = vw - EDGE - width;
    if (left < EDGE) left = EDGE;
    const natural = p.scrollHeight;
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const side: "below" | "above" = natural <= below || below >= above ? "below" : "above";
    const maxHeight = Math.max(160, side === "below" ? below : above);
    const height = Math.min(natural, maxHeight);
    const top = side === "below" ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - height);
    setPlace({ top, left, width, maxHeight, side });
  }, []);

  useIsoLayoutEffect(() => { if (open) position(); }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || pop.current?.contains(t) || (t as Element).classList?.contains("xp-scrim")) return;
      close(false);
    };
    const onMove = () => position();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close, position]);

  /* Opened from the keyboard: move focus into the dialog so its links are reachable. */
  useEffect(() => {
    if (open && viaKeyboard.current && (place || sheet)) { pop.current?.focus(); viaKeyboard.current = false; }
  }, [open, place, sheet]);

  const hover = () => typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches;
  const hoverIn = () => { if (!hover()) return; if (hoverTimer.current) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setOpen(true), 120); };
  const hoverOut = () => { if (!hover() || pinned.current) return; if (hoverTimer.current) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => close(false), 180); };
  const holdOpen = () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && !open) viaKeyboard.current = true;
    if (e.key === "Tab" && !e.shiftKey && open && pop.current) { e.preventDefault(); pop.current.focus(); }
  };
  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !pop.current) return;
    const focusables = [...pop.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === pop.current || active === first)) { e.preventDefault(); btn.current?.focus(); }
    else if (!e.shiftKey && (active === last || (!last && active === pop.current))) { e.preventDefault(); close(true); }
  };

  const conf = (v: string) => {
    const t = v.trim().toLowerCase();
    return TIERS.has(t) ? <span className={`conf ${t}`}>{t}</span> : v;
  };

  const style: React.CSSProperties | undefined = sheet
    ? undefined
    : place
      ? { top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }
      : { top: 0, left: -9999, width: typeof window === "undefined" ? 440 : Math.min(Math.max(360, document.documentElement.clientWidth * 0.32), 440, document.documentElement.clientWidth - EDGE * 2), visibility: "hidden" };

  const panel = (
    <div
      ref={pop}
      id={`${id}-pop`}
      role="dialog"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      className={`xp-pop${sheet ? " sheet" : ""}${place?.side === "above" ? " above" : ""}`}
      hidden={!open}
      style={open ? style : undefined}
      onMouseEnter={holdOpen}
      onMouseLeave={hoverOut}
      onKeyDown={onPanelKey}
    >
      <div className="xp-head">
        <b id={`${id}-title`}>{title}</b>
        <button type="button" className="xp-close" aria-label="Close explainer" onClick={() => close(true)}><span aria-hidden="true">×</span></button>
      </div>
      <p className="xp-p">{body}</p>
      {unit && <p className="xp-p xp-unit">{unit}</p>}
      {rows && rows.length > 0 && (
        <dl className="xp-rows">
          {rows.map(([k, v]) => (
            <div className="xp-row" key={k}>
              <dt className="xp-dt">{TIERS.has(k.trim().toLowerCase()) ? conf(k) : k}</dt>
              <dd className="xp-dd">{/^confidence$/i.test(k) ? conf(v) : v}</dd>
            </div>
          ))}
        </dl>
      )}
      {caution && <p className="xp-caution">{caution}</p>}
      {formula && (
        <div className="xp-formula">
          <span className="xp-label">Formula</span>
          <code>{formula}</code>
        </div>
      )}
      <div className="xp-links">
        {learnHref && <Link href={learnHref} onClick={() => close(false)}>{learnLabel}</Link>}
        <Link href="/learn/fight-dna#confidence" onClick={() => close(false)}>What does confidence mean?</Link>
      </div>
    </div>
  );

  return (
    <span className={`xp${open ? " open" : ""}`} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      <button
        ref={btn}
        type="button"
        className={`xp-btn ${size}`}
        aria-label={label || `Explain: ${title}`}
        aria-expanded={open}
        aria-controls={`${id}-pop`}
        aria-haspopup="dialog"
        onClick={() => {
          if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
          if (open && !pinned.current && hover()) { pinned.current = true; return; }
          if (open) close(false); else { pinned.current = hover(); setOpen(true); }
        }}
        onKeyDown={onTriggerKey}
      >
        <span aria-hidden="true">i</span>
      </button>
      {mounted && createPortal(<>{open && sheet ? <div className="xp-scrim" aria-hidden="true" onClick={() => close(true)} /> : null}{panel}</>, document.body)}
    </span>
  );
}

/* EXPLAIN STATS — optional learn mode. Adds data-explain="on" to the Fight
 * DNA section so a plain-English line renders under every technical metric.
 * Values are untouched; expert metadata stays visible. The preference is
 * remembered per browser. */
const KEY = "pbe.dna.explain";

export function ExplainToggle({ target = "fight-dna" }: { target?: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let saved = false;
    try { saved = window.localStorage.getItem(KEY) === "1"; } catch {}
    setOn(saved);
    document.getElementById(target)?.setAttribute("data-explain", saved ? "on" : "off");
  }, [target]);
  const toggle = () => {
    const next = !on;
    setOn(next);
    document.getElementById(target)?.setAttribute("data-explain", next ? "on" : "off");
    try { window.localStorage.setItem(KEY, next ? "1" : "0"); } catch {}
  };
  return (
    <button type="button" className={`dna-explain-toggle${on ? " on" : ""}`} aria-pressed={on} onClick={toggle}>
      <i aria-hidden="true" /><span>Explain stats</span>
    </button>
  );
}

/* Expand/collapse for secondary metric detail with a remembered preference. */
export function DeeperDetail({ id, summary, children, defaultOpen = false }: { id: string; summary: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const storageKey = `pbe.dna.open.${id}`;
  useEffect(() => { try { const v = window.localStorage.getItem(storageKey); if (v === "1") setOpen(true); else if (v === "0") setOpen(false); } catch {} }, [storageKey]);
  return (
    <details className="dna-more" open={open} onToggle={(e) => { const v = (e.currentTarget as HTMLDetailsElement).open; setOpen(v); try { window.localStorage.setItem(storageKey, v ? "1" : "0"); } catch {} }}>
      <summary><span>{summary}</span><i aria-hidden="true" /></summary>
      <div className="dna-more-body">{children}</div>
    </details>
  );
}
