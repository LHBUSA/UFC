"use client";

import { useState } from "react";
import { Mark, OCTAGON } from "@/components/Brand";

/* Portrait for a Notable Voices card. If the self-hosted derivative fails to
 * load for any reason the card degrades to the branded treatment (fighter
 * mark, name, role, faint cage) instead of a broken image. */
export function VoiceImage({ src, width, height, focal, alt, name, label }: {
  src: string | null; width?: number; height?: number; focal?: string; alt: string; name: string; label: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="voice-fallback" role="img" aria-label={name}>
        <svg className="cage" viewBox="0 0 64 64" aria-hidden="true"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <Mark size={72} />
        <b>{name}</b>
        <span>{label}</span>
      </div>
    );
  }
  return (
    <img
      src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async"
      style={{ objectPosition: focal || "50% 30%" }}
      onError={() => setFailed(true)}
    />
  );
}
