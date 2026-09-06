/* Shared helpers for server-rendered images (OG cards, icons). Fonts are
 * fetched from Google Fonts at render time and cached by the platform. */
const FONT_CACHE = new Map<string, Promise<ArrayBuffer>>();

async function googleFont(family: string, weight: number, text?: string): Promise<ArrayBuffer> {
  const key = `${family}:${weight}:${text || ""}`;
  if (!FONT_CACHE.has(key)) {
    FONT_CACHE.set(key, (async () => {
      /* No User-Agent on purpose: Google Fonts then serves TrueType, the
       * only format satori parses (a browser UA gets woff2, which throws
       * "Unsupported OpenType signature wOF2"). */
      const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}${text ? `&text=${encodeURIComponent(text)}` : ""}`, {
        headers: { "User-Agent": "" },
        cache: "force-cache",
      }).then((r) => r.text());
      const m = css.match(/url\((https:[^)]+\.(?:ttf|otf))\)/);
      if (!m) throw new Error(`font ${family} not found`);
      return fetch(m[1], { cache: "force-cache" }).then((r) => r.arrayBuffer());
    })());
  }
  return FONT_CACHE.get(key)!;
}

export async function ogFonts() {
  const [display, ui, mono] = await Promise.all([
    googleFont("Playfair Display", 800).catch(() => null),
    googleFont("Inter", 600).catch(() => null),
    googleFont("JetBrains Mono", 600).catch(() => null),
  ]);
  const fonts: Array<{ name: string; data: ArrayBuffer; weight: 400 | 600 | 800; style: "normal" }> = [];
  if (display) fonts.push({ name: "Playfair", data: display, weight: 800, style: "normal" });
  if (ui) fonts.push({ name: "Inter", data: ui, weight: 600, style: "normal" });
  if (mono) fonts.push({ name: "Mono", data: mono, weight: 600, style: "normal" });
  return fonts;
}

export const OG_SIZE = { width: 1200, height: 630 };
