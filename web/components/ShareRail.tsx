"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

const DETAIL = /^\/(fighters|fights|events|news)\/.+/;

export function ShareRail() {
  const path = usePathname() || "/";
  const [copied, setCopied] = useState(false);
  if (!DETAIL.test(path)) return null;

  async function share() {
    const url = `https://ufc.propbetedge.ai${path}`;
    const title = document.title.replace(/\s+[—|-]\s+PropBetEdge UFC.*$/i, "");
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch { /* browser blocked both share and clipboard */ }
    }
  }

  return (
    <button type="button" className={`share-rail${copied ? " copied" : ""}`} onClick={share} aria-label={copied ? "Link copied" : "Share this page"} title={copied ? "Link copied" : "Share"}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 12.5v5.25A2.25 2.25 0 0 0 7.25 20h9.5A2.25 2.25 0 0 0 19 17.75V12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <span>{copied ? "Copied" : "Share"}</span>
    </button>
  );
}
