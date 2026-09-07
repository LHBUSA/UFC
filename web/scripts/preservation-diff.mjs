#!/usr/bin/env node
/* Preservation diff: compare the working tree / HEAD against the exact
 * starting SHA of a task and list what disappeared or changed.
 *
 *   node scripts/preservation-diff.mjs <start-sha> [--strict]
 *
 * Reports: deleted files, removed routes, removed NAV items, removed homepage
 * sections, changed/deleted public image + background assets. With --strict
 * the process exits 1 when any route, NAV item, homepage section or public
 * asset was removed. Run from web/ or the repo root. */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const [sha, ...flags] = process.argv.slice(2);
if (!sha) { console.error("usage: preservation-diff.mjs <start-sha> [--strict]"); process.exit(2); }
const strict = flags.includes("--strict");
const git = (cmd) => execSync(`git ${cmd}`, { cwd: WEB, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const prefix = git("rev-parse --show-prefix").replace(/\/$/, ""); // e.g. "web"
const at = (ref, path) => { try { return git(`show ${ref}:${prefix ? prefix + "/" : ""}${path}`); } catch { return null; } };
const routesOf = (ref) => git(`ls-tree -r --name-only ${ref} -- app`).split("\n").filter((f) => /\/page\.tsx$/.test(f)).map((f) => "/" + f.replace(/^app\//, "").replace(/\/?page\.tsx$/, "")).map((r) => (r === "/" || r === "" ? "/" : r.replace(/\/$/, ""))).sort();
const navOf = (src) => { if (!src) return []; const b = src.slice(src.indexOf("export const NAV"), src.indexOf("] as const", src.indexOf("export const NAV"))); return [...b.matchAll(/href:\s*"([^"]+)"[^}]*label:\s*"([^"]+)"/g)].map((m) => `${m[2]} (${m[1]})`); };
const sectionsOf = (src) => (src ? [...new Set([...src.matchAll(/<([A-Z][A-Za-z]+)[\s/>]/g)].map((m) => m[1]))].sort() : []);

const head = "HEAD";
const deleted = git(`diff --name-only --diff-filter=D ${sha} ${head}`).split("\n").filter(Boolean);
const changedAssets = git(`diff --name-status ${sha} ${head} -- public`).split("\n").filter(Boolean).filter((l) => /\.(webp|png|jpg|jpeg|svg|webmanifest)$/i.test(l));
const routesBefore = routesOf(sha), routesAfter = routesOf(head);
const removedRoutes = routesBefore.filter((r) => !routesAfter.includes(r));
const addedRoutes = routesAfter.filter((r) => !routesBefore.includes(r));
const navBefore = navOf(at(sha, "lib/site.ts")), navAfter = navOf(at(head, "lib/site.ts"));
const removedNav = navBefore.filter((n) => !navAfter.includes(n));
const secBefore = sectionsOf(at(sha, "app/page.tsx")), secAfter = sectionsOf(at(head, "app/page.tsx"));
const removedSections = secBefore.filter((s) => !secAfter.includes(s));
const dirty = git("status --porcelain").split("\n").filter(Boolean).length;

const list = (title, items) => console.log(`\n${title}${items.length ? "" : " — none"}${items.length ? "\n" + items.map((i) => `  - ${i}`).join("\n") : ""}`);
console.log(`Preservation diff ${sha.slice(0, 10)} → ${git("rev-parse --short HEAD")}${dirty ? ` (+${dirty} uncommitted changes not included)` : ""}`);
list("Deleted files", deleted);
list("Removed routes", removedRoutes);
list("Added routes", addedRoutes);
list("Removed NAV items", removedNav);
list("Removed homepage sections/components", removedSections);
list("Changed or deleted public image/background assets", changedAssets.map((l) => l.replace(/^([A-Z])\t/, "$1  ")));
const bad = removedRoutes.length + removedNav.length + removedSections.length + changedAssets.filter((l) => l.startsWith("D")).length;
if (bad) { console.log(`\n✖ ${bad} preservation regression(s) — new work may improve the site, not recreate an older one.`); if (strict) process.exit(1); }
else console.log("\n✔ nothing removed since the starting SHA.");
