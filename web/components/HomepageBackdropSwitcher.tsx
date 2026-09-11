"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "pbe:ufc:homepage-background:v3";

const BACKDROPS = [
  {
    id: "arena",
    label: "Arena",
    src: "/media/ufc-cage-bg-1600.webp",
    position: "center 32%",
  },
  {
    id: "fence",
    label: "Fence",
    src: "/media/ufc-fence-1400.webp",
    position: "center 42%",
  },
] as const;

type BackdropId = (typeof BACKDROPS)[number]["id"];

export function HomepageBackdropSwitcher() {
  const pathname = usePathname();
  const [activeId, setActiveId] = useState<BackdropId>("arena");

  useEffect(() => {
    if (pathname !== "/") return;

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && BACKDROPS.some((item) => item.id === stored)) {
        setActiveId(stored as BackdropId);
      }
    } catch {
      // The default arena background is already rendered by CSS.
    }

    for (const item of BACKDROPS) {
      const img = new Image();
      img.decoding = "async";
      img.src = item.src;
    }
  }, [pathname]);

  useEffect(() => {
    if (pathname !== "/") return;

    const active = BACKDROPS.find((item) => item.id === activeId) ?? BACKDROPS[0];
    const body = document.body;

    body.classList.add("home-background-active");
    body.style.setProperty("--home-background-image", `url("${active.src}")`);
    body.style.setProperty("--home-background-position", active.position);

    return () => {
      body.classList.remove("home-background-active");
      body.style.removeProperty("--home-background-image");
      body.style.removeProperty("--home-background-position");
    };
  }, [activeId, pathname]);

  if (pathname !== "/") return null;

  const choose = (id: BackdropId) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Storage is optional; switching still works for the current visit.
    }
  };

  return (
    <div className="home-scene-control-slot" aria-label="Homepage background controls">
      <div className="home-scene-picker" role="group" aria-label="Choose homepage background">
        <span className="home-scene-label">Background</span>
        <div className="home-scene-options">
          {BACKDROPS.map((item) => {
            const selected = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                className={`home-scene-option${selected ? " active" : ""}`}
                aria-label={`Use ${item.label} homepage background`}
                aria-pressed={selected}
                title={item.label}
                onClick={() => choose(item.id)}
              >
                <span
                  className="home-scene-thumb"
                  aria-hidden="true"
                  style={{ backgroundImage: `url("${item.src}")`, backgroundPosition: item.position }}
                />
                <span className="home-scene-name">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
