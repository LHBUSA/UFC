// PropBetEdge's own X identity is @PROPBETEDGE network-wide. Every page-level
// `twitter` block replaces the layout's (Next merges metadata shallowly), so each
// one must carry `site` itself or that page ships without twitter:site.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE } from "./site.ts";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STALE = [/x\.com\/MLBHRALERTSPBE/i, /@MLBHRALERTSPBE/i, /x\.com\/propbetedgeai/i, /@propbetedgeai/i, /x\.com\/propbetedge["'/]/, /["']@propbetedge["']/, /twitter\.com\/intent/i, /x\.com\/intent\/tweet/i];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(tsx?|m?js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(full);
  }
  return out;
}

test("canonical X identity", () => {
  assert.equal(SITE.twitter, "@PROPBETEDGE");
  assert.equal(SITE.xUrl, "https://x.com/PROPBETEDGE");
});

test("no stale PropBetEdge X identity or legacy share intent in web source", () => {
  for (const file of [...walk(path.join(WEB, "app")), ...walk(path.join(WEB, "lib")), ...walk(path.join(WEB, "components"))]) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of STALE) assert.doesNotMatch(text, re, `${path.relative(WEB, file)} contains ${re}`);
  }
});

test("every page-level twitter metadata block sets site", () => {
  const offenders: string[] = [];
  for (const file of walk(path.join(WEB, "app")).filter((f) => f.endsWith(".tsx"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/twitter:\s*\{([^}]*)\}/g)) {
      if (!/\bsite:\s*SITE\.twitter\b/.test(m[1])) offenders.push(path.relative(WEB, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("every page-level openGraph block has a share image unless its segment renders one", () => {
  const hasSegmentCard = (file: string) => {
    for (let d = path.dirname(file); path.relative(path.join(WEB, "app"), d) !== ""; d = path.dirname(d)) {
      if (fs.readdirSync(d).some((n) => n.startsWith("opengraph-image."))) return true;
    }
    return false;
  };
  const offenders: string[] = [];
  for (const file of walk(path.join(WEB, "app")).filter((f) => f.endsWith("page.tsx") && !hasSegmentCard(f))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/openGraph:\s*\{/g)) {
      let depth = 0, end = m.index! + m[0].length - 1;
      for (let i = end; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) { end = i; break; }
      }
      if (!/\bimages\b/.test(text.slice(m.index!, end))) offenders.push(path.relative(WEB, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("Organization sameAs uses the canonical profile once", () => {
  const layout = fs.readFileSync(path.join(WEB, "app/layout.tsx"), "utf8");
  assert.equal((layout.match(/sameAs: \[SITE\.xUrl\]/g) || []).length, 1);
});

test("footer: exactly one PropBetEdge X link, new tab, safe rel, accessible name", () => {
  const shell = fs.readFileSync(path.join(WEB, "components/Shell.tsx"), "utf8");
  const footer = shell.slice(shell.indexOf("<footer"), shell.indexOf("</footer>"));
  const anchors = [...footer.matchAll(/<a [^>]*href=\{SITE\.xUrl\}[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
  assert.equal(anchors.length, 1);
  assert.match(anchors[0], /target="_blank" rel="noopener noreferrer"/);
  assert.match(anchors[0], /aria-label=\{`Follow PropBetEdge on X \(\$\{SITE\.twitter\}\)`\}/);
});
