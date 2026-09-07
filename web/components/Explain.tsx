"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

/* Accessible metric explainer.
 *
 * A real popover, not a title attribute: hover opens on pointer devices, tap
 * toggles on touch, Enter/Space toggle from the keyboard, Escape closes and
 * returns focus, clicking outside closes. The trigger carries aria-expanded
 * and aria-controls; the panel is a labelled dialog region. Nothing inside
 * grades a value — it explains the definition and shows the sample behind
 * the number. */

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

export function Explain({ title, body, unit, caution, formula, rows, learnHref, learnLabel = "Learn more →", label, size = "sm" }: ExplainProps) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<number | null>(null);

  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) close(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    /* Keep the panel inside the viewport: flip to right-aligned when it would overflow. */
    const r = btn.current?.getBoundingClientRect();
    if (r) setFlip(r.left + 340 > window.innerWidth);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open, close]);

  const hoverIn = () => { if (window.matchMedia?.("(hover: hover)").matches) { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setOpen(true), 120); } };
  const hoverOut = () => { if (window.matchMedia?.("(hover: hover)").matches) { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setOpen(false), 180); } };

  return (
    <span className={`xp${open ? " open" : ""}`} ref={wrap} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      <button
        ref={btn}
        type="button"
        className={`xp-btn ${size}`}
        aria-label={label || `Explain: ${title}`}
        aria-expanded={open}
        aria-controls={`${id}-pop`}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">i</span>
      </button>
      {/* Phrasing content only (spans), so the popover is valid inside <p>, <th> and <span> hosts and hydrates cleanly. */}
      <span id={`${id}-pop`} role="dialog" aria-labelledby={`${id}-title`} className={`xp-pop${flip ? " flip" : ""}`} hidden={!open}>
        <b id={`${id}-title`}>{title}</b>
        <span className="xp-p">{body}</span>
        {unit && <span className="xp-p xp-unit">{unit}</span>}
        {caution && <span className="xp-p xp-caution">{caution}</span>}
        {rows && rows.length > 0 && <span className="xp-rows">{rows.map(([k, v]) => <span className="xp-row" key={k}><span className="xp-dt">{k}</span><span className="xp-dd">{v}</span></span>)}</span>}
        {formula && <code className="xp-formula">{formula}</code>}
        <span className="xp-links">
          {learnHref && <Link href={learnHref} onClick={() => close(false)}>{learnLabel}</Link>}
          <Link href="/learn/fight-dna#confidence" onClick={() => close(false)}>What does confidence mean?</Link>
        </span>
      </span>
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
