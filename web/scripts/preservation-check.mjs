#!/usr/bin/env node
/* Preservation guard for the UFC product surface.
 *
 * Rule: every task is additive. This script fails the build when a required
 * route, NAV item, homepage module, feature library or public visual asset
 * that exists in the recorded baseline disappears.
 *
 *   node scripts/preservation-check.mjs                 # static check vs baseline (runs as `prebuild`)
 *   node scripts/preservation-check.mjs --write-baseline # refresh scripts/preservation-baseline.json (deliberate, reviewed)
 *   BASE=https://host node scripts/preservation-check.mjs --http   # additionally assert required routes return 200 and nav has DWCS
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "preservation-baseline.json");
const args = new Set(process.argv.slice(2));

/* Routes that must always exist (page.tsx under app/). */
export const REQUIRED_ROUTES = ["/", "/events", "/events/[slug]", "/contender-series", "/fighters", "/fighters/[slug]", "/fights/[slug]", "/rankings", "/referees", "/referees/[slug]", "/history", "/hall-of-fame", "/news", "/news/[slug]", "/voices/[key]", "/pro", "/fight-week", "/pregame/[slug]", "/learn/fight-dna", "/hall-of-fame/[slug]"];
/* NAV must contain these hrefs (label may vary). */
export const REQUIRED_NAV = ["/", "/fight-week", "/events", "/contender-series", "/fighters", "/rankings", "/history", "/news", "/pro"];
/* Homepage modules that must stay mounted in app/page.tsx. */
export const REQUIRED_HOME_MODULES = ["PregameDesk", "FightDnaShowcase", "ContenderStrip", "ChampionsShowcase", "NewsStoryCard", "Voices", "VideoRail", "CardSegments", "MatchupCard", "EventCard", "OfficialDestinations"];
/* Feature libraries and components that must exist. */
export const REQUIRED_FEATURES = ["lib/dna.ts", "lib/contender.ts", "lib/archive.ts", "lib/pregame.ts", "lib/fightweek.ts", "lib/referees.ts", "lib/voices.ts", "lib/heritage.ts", "lib/faces.ts", "lib/wire.ts", "components/dna.tsx", "components/PregameDesk.tsx", "components/PregameDesk.module.css", "components/DeskArt.tsx", "components/FightWeek.tsx", "app/fightweek.css", "lib/dnaGlossary.ts", "lib/videoPolicy.ts", "lib/hof.ts", "components/MobileNav.tsx", "components/VideoRailClient.tsx", "components/Menu.tsx", "app/depth.css", "components/Explain.tsx", "components/DnaPipeline.tsx", "components/FightDnaShowcase.tsx", "app/fightdna.css", "components/OfficialVideo.tsx", "components/VideoRail.tsx", "components/ChampionshipBelt.tsx", "components/Brand.tsx", "components/LiveWire.tsx", "components/NewsStoryCard.tsx", "components/VoiceImage.tsx", "app/icon.svg", "app/apple-icon.tsx", "app/opengraph-image.tsx", "public/site.webmanifest"];
/* Public visual assets that must not vanish (backgrounds, brand, voices). */
export const REQUIRED_ASSETS = ["public/media/ufc-cage-bg-1600.webp", "public/media/ufc-cage-bg-960.webp", "public/media/ufc-fence-1400.webp", "public/brand/mark.svg", "public/brand/logo.svg", "public/brand/logo-wide.svg", "public/media/voices/joe-rogan-660.webp", "public/media/voices/daniel-cormier-660.webp", "public/media/voices/dana-white-660.webp", "public/media/voices/dana-white-900.webp"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) { const p = join(dir, name); const s = statSync(p); if (s.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
const rel = (p) => relative(ROOT, p).split(sep).join("/");

export function inventory() {
  const appDir = join(ROOT, "app");
  const routes = walk(appDir).filter((p) => /[\\/]page\.tsx$/.test(p)).map((p) => "/" + rel(p).replace(/^app\//, "").replace(/\/?page\.tsx$/, "")).map((r) => (r === "/" ? "/" : r.replace(/\/$/, ""))).map((r) => (r === "" ? "/" : r)).sort();
  const site = readFileSync(join(ROOT, "lib", "site.ts"), "utf8");
  const navBlock = site.slice(site.indexOf("export const NAV"), site.indexOf("] as const", site.indexOf("export const NAV")));
  const nav = [...navBlock.matchAll(/href:\s*"([^"]+)"[^}]*label:\s*"([^"]+)"/g)].map((m) => ({ href: m[1], label: m[2] }));
  const home = readFileSync(join(ROOT, "app", "page.tsx"), "utf8");
  const homeModules = REQUIRED_HOME_MODULES.concat(["Octagon", "SectionHead", "ProPlans", "JsonLd"]).filter((c) => new RegExp(`<${c}[\\s/>]`).test(home)).sort();
  const publicDir = join(ROOT, "public");
  const assets = Object.fromEntries(walk(publicDir).filter((p) => /\.(webp|png|jpg|jpeg|svg|webmanifest)$/i.test(p)).map((p) => [rel(p), createHash("sha1").update(readFileSync(p)).digest("hex").slice(0, 12)]));
  const features = [...REQUIRED_FEATURES].filter((f) => existsSync(join(ROOT, f))).sort();
  return { routes, nav, homeModules, assets, features };
}

function fail(msgs) { console.error("\n✖ PRESERVATION CHECK FAILED\n" + msgs.map((m) => `  - ${m}`).join("\n") + "\n"); process.exit(1); }

const inv = inventory();
const problems = [];
for (const r of REQUIRED_ROUTES) if (!inv.routes.includes(r)) problems.push(`required route missing: ${r}`);
for (const h of REQUIRED_NAV) if (!inv.nav.some((n) => n.href === h)) problems.push(`required NAV item missing: ${h}`);
if (!inv.nav.some((n) => n.href === "/contender-series" || /contender|dwcs/i.test(n.label))) problems.push("primary navigation must contain Contender Series / DWCS");
for (const m of REQUIRED_HOME_MODULES) if (!inv.homeModules.includes(m)) problems.push(`homepage module no longer mounted: <${m}>`);
for (const f of REQUIRED_FEATURES) if (!inv.features.includes(f)) problems.push(`feature file missing: ${f}`);
for (const a of REQUIRED_ASSETS) if (!inv.assets[a]) problems.push(`public asset missing: ${a}`);

if (args.has("--write-baseline")) {
  writeFileSync(BASELINE, JSON.stringify({ generated_at: new Date().toISOString(), ...inv }, null, 2) + "\n");
  console.log(`baseline written: ${rel(BASELINE)} (${inv.routes.length} routes, ${inv.nav.length} nav items, ${Object.keys(inv.assets).length} assets)`);
}
if (existsSync(BASELINE)) {
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  for (const r of base.routes) if (!inv.routes.includes(r)) problems.push(`route removed since baseline: ${r}`);
  for (const n of base.nav) if (!inv.nav.some((x) => x.href === n.href)) problems.push(`NAV item removed since baseline: ${n.label} (${n.href})`);
  for (const m of base.homeModules) if (!inv.homeModules.includes(m)) problems.push(`homepage section removed since baseline: <${m}>`);
  for (const f of base.features) if (!inv.features.includes(f)) problems.push(`feature removed since baseline: ${f}`);
  for (const a of Object.keys(base.assets)) if (!inv.assets[a]) problems.push(`public asset deleted since baseline: ${a}`);
  const changed = Object.keys(base.assets).filter((a) => inv.assets[a] && inv.assets[a] !== base.assets[a]);
  if (changed.length) console.warn(`⚠ public assets changed since baseline (review intentionally):\n${changed.map((a) => `  - ${a}`).join("\n")}`);
}
if (problems.length) fail(problems);

if (args.has("--http")) {
  const base = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
  const http = [];
  const httpRoutes = ["/", "/fight-week", "/learn/fight-dna", "/events", "/contender-series", "/fighters", "/rankings", "/referees", "/history", "/hall-of-fame", "/news", "/pro"];
  for (const r of httpRoutes) {
    const res = await fetch(base + r, { redirect: "manual" }).catch(() => null);
    if (!res || res.status !== 200) http.push(`${r} -> ${res ? res.status : "unreachable"}`);
    if (r === "/" && res && res.status === 200) { const html = await res.text(); if (!/href="\/contender-series"/.test(html)) http.push("homepage HTML: primary nav has no Contender Series / DWCS link"); }
  }
  if (http.length) fail(http.map((h) => `http: ${h}`));
  console.log(`✔ http: ${httpRoutes.length} required routes return 200 on ${base}; nav contains Contender Series / DWCS`);
}
console.log(`✔ preservation check passed (${inv.routes.length} routes, nav: ${inv.nav.map((n) => n.label).join(" · ")}, home modules: ${inv.homeModules.length}, assets: ${Object.keys(inv.assets).length})`);
