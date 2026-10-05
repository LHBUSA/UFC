"use client";

import { useState } from "react";
import { Mark, OCTAGON } from "@/components/Brand";

/* Featured-fighter portrait for the homepage Fight DNA demo. If the stored
 * derivative fails to load for any reason the panel degrades to the branded
 * octagon treatment, never a broken-image icon. */
export function FightDnaPortrait({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="fdna-portrait-fallback" aria-hidden="true">
        <svg className="cage" viewBox="0 0 64 64"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <Mark size={96} />
      </div>
    );
  }
  return <img src={src} alt={alt} width={800} height={1000} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}
