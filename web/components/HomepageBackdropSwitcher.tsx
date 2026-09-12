"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "pbe:ufc:homepage-backdrop:v2";

const BACKDROPS = [
  { id: "fight-night", label: "Fight night", src: "/media/home-bg-fight-night.webp" },
  { id: "walkout", label: "Walkout", src: "/media/home-bg-walkout.webp" },
  { id: "lights", label: "Under lights", src: "/media/home-bg-under-lights.webp" },
  { id: "cage", label: "Cage", src: "/media/home-bg-cage.webp" },
] as const;

type BackdropId = (typeof BACKDROPS)[number]["id"];

export function HomepageBackdropSwitcher() {
  const pathname = usePathname();
  const [hero, setHero] = useState<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<BackdropId>("fight-night");

  const active = useMemo(
    () => BACKDROPS.find((item) => item.id === activeId) ?? BACKDROPS[0],
    [activeId],
  );

  useEffect(() => {
    if (pathname !== "/") {
      setHero(null);
      return;
    }

    /* WAIT for the mount point rather than querying for it once.
     *
     * This component lives in the ROOT LAYOUT, which hydrates before the page
     * body has finished streaming in. A single querySelector on mount therefore
     * raced the page: sometimes the hero was already in the DOM and the picker
     * appeared, sometimes it was not and the control silently never rendered at
     * all. (Measured: `pathname` was "/" and `.hero` was still absent when this
     * effect ran.) Observing until the slot exists makes it deterministic.
     *
     * The target is a dedicated empty slot rather than `.hero` itself, because
     * `.hero` is a React-rendered node, and portalling foreign children into a
     * node React re-renders is its own source of disappearing UI.
     *
     * The hero also ships with `home-scene-enabled` and its stage already in
     * the server HTML now, so the arena is in the first paint rather than
     * appearing a beat after hydration. Setting the class here is a no-op on
     * the homepage; it stays so a page that somehow lacks it still lights up. */
    let observer: MutationObserver | null = null;

    const attach = () => {
      const slot = document.querySelector<HTMLElement>("[data-home-scene-picker-slot]")
        ?? document.querySelector<HTMLElement>(".hero");
      if (!slot) return false;
      document.querySelector<HTMLElement>(".hero")?.classList.add("home-scene-enabled");
      setHero(slot);
      return true;
    };

    /* Belt and braces, because a MutationObserver alone did not make this
     * deterministic in testing (it still missed roughly one load in three).
     * The observer catches the slot arriving as a DOM mutation; the bounded
     * poll catches the cases where the node is already present but React has
     * not finished committing the subtree the observer is watching. Both stop
     * the moment the picker attaches, and both are torn down on cleanup, so
     * the cost when it attaches immediately is zero. */
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      observer?.disconnect();
      observer = null;
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const poll = () => {
      if (attach() || tries > 20) { stop(); return; }
      tries += 1;
      timer = setTimeout(poll, 100);
    };

    if (!attach()) {
      observer = new MutationObserver(() => { if (attach()) stop(); });
      observer.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(poll, 60);
    }

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && BACKDROPS.some((item) => item.id === stored)) {
        setActiveId(stored as BackdropId);
      }
    } catch {
      // Storage is optional; the default image remains deterministic.
    }

    for (const item of BACKDROPS) {
      const img = new Image();
      img.decoding = "async";
      img.src = item.src;
    }

    return () => {
      stop();
      /* Leave `home-scene-enabled` in place: it is server-rendered now, so
       * stripping it on unmount would darken the hero rather than restore it. */
    };
  }, [pathname]);

  /* Paint the chosen scene onto the stage the SERVER rendered. Rendering our
   * own stage here would put a second full-bleed layer over the first — two
   * images, two composites, and a flash on every change. */
  useEffect(() => {
    if (!hero) return;
    const stage = document.querySelector<HTMLElement>("[data-home-scene-stage]");
    if (stage) stage.style.backgroundImage = `url("${active.src}")`;
  }, [hero, active.src]);

  const choose = (id: BackdropId) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private browsing/storage restrictions should not break the control.
    }
  };

  if (!hero || pathname !== "/") return null;

  return createPortal(
    <>
      <div className="home-scene-picker" role="group" aria-label="Choose homepage fight-night background">
        <span className="home-scene-label">Scene</span>
        <div className="home-scene-options">
          {BACKDROPS.map((item) => {
            const selected = item.id === active.id;
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
                <span className="home-scene-thumb" aria-hidden="true" style={{ backgroundImage: `url("${item.src}")` }} />
                <span className="home-scene-name">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>,
    hero,
  );
}
