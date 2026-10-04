// UFC footer directory: every destination is pinned to the semantic group
// (the heading it sits under), not to an accidental column position.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../components/Shell.tsx", import.meta.url), "utf8");
const footer = shell.slice(shell.indexOf("export function Footer()"));
const dir = footer.slice(footer.indexOf('className="ftr-dir"'), footer.indexOf("<PreferredSource"));

/** group key -> { heading, hrefs (source expressions, in order) } */
function parseGroups() {
  const out: Record<string, { heading: string; hrefs: string[]; body: string }> = {};
  const re = /<div className="col" data-ufc-footer-group="([a-z-]+)">([\s\S]*?)<\/div>/g;
  for (const m of dir.matchAll(re)) {
    const body = m[2];
    const heading = (body.match(/<h4>([\s\S]*?)<\/h4>/) || [])[1] ?? "";
    const hrefs = [...body.matchAll(/href=(\{`[^`]*`\}|\{[^}]*\}|"[^"]*")/g)].map((h) => h[1].slice(1, -1));
    out[m[1]] = { heading, hrefs, body };
  }
  return out;
}
const groups = parseGroups();

const EXPECTED: Record<string, { heading: string; hrefs: string[] }> = {
  "fight-intelligence": { heading: "Fight Intelligence", hrefs: ["/events", "/contender-series", "/fighters", "/rankings", "/referees", "/history", "/hall-of-fame"] },
  editorial: { heading: "Editorial", hrefs: ["/news", "/#notable-voices", "/about", "/methodology", "/feed.xml", "`mailto:${SITE.contact}`"] },
  developers: { heading: "Developers", hrefs: ["SITE.ufcApi", "SITE.ufcApiDocs"] },
  "official-ufc": { heading: "Official UFC", hrefs: ["UFC_OFFICIAL.home", "UFC_OFFICIAL.athletes", "UFC_OFFICIAL.rankings", "UFC_OFFICIAL.hallOfFame", "UFC_OFFICIAL.fightPass", "UFC_OFFICIAL.store"] },
  propbetedge: { heading: "PropBetEdge", hrefs: ["ALL_ACCESS_URL", "ALL_ACCESS_URL", "NETWORK.news.href", "NETWORK.learn.href", "NETWORK.store.href"] },
  account: { heading: "Account", hrefs: ["/account", "/pro", "SITE.billingPortal", "https://propbetedge.ai/support"] },
  community: { heading: "Community", hrefs: ["NETWORK.discord", "SITE.xUrl"] },
  "company-legal": { heading: "Company &amp; Legal", hrefs: ["https://propbetedge.ai/about", "https://propbetedge.ai/terms", "https://propbetedge.ai/legal"] },
};

test("footer directory: exactly the eight semantic groups, UFC areas first, then the network groups", () => {
  assert.deepEqual(Object.keys(groups), Object.keys(EXPECTED));
});

for (const [key, exp] of Object.entries(EXPECTED)) {
  test(`footer group ${key}: heading "${exp.heading}" owns exactly its destinations`, () => {
    const g = groups[key];
    assert.ok(g, key);
    assert.equal(g.heading, exp.heading);
    assert.deepEqual(g.hrefs, exp.hrefs);
  });
}

test("no destination is placed in two directory groups (except All Access + What's included, same URL by design)", () => {
  const all = Object.values(groups).flatMap((g) => g.hrefs).filter((h) => h !== "ALL_ACCESS_URL");
  assert.equal(new Set(all).size, all.length);
});

test("trust/legal group carries no billing, social or commerce links", () => {
  const body = groups["company-legal"].body;
  for (const bad of ["billingPortal", "discord", "xUrl", "store", "ALL_ACCESS_URL"]) assert.ok(!body.includes(bad), bad);
});

test("billing and social links never sit in the PropBetEdge group or the Preferred Source band", () => {
  const pbe = groups.propbetedge.body;
  for (const bad of ["billingPortal", "discord", "xUrl", "propbetedge.ai/support", "propbetedge.ai/terms"]) assert.ok(!pbe.includes(bad), bad);
  const band = footer.slice(footer.indexOf("<PreferredSource"), footer.indexOf('className="net"'));
  for (const bad of ["billingPortal", "discord", "xUrl"]) assert.ok(!band.includes(bad), bad);
});

test("Preferred Source band renders once, after the directory and before the sports rail", () => {
  assert.equal(footer.split('<PreferredSource surface="footer" />').length - 1, 1);
  const iDir = footer.indexOf('className="ftr-dir"');
  const iBand = footer.indexOf('<PreferredSource surface="footer" />');
  const iNet = footer.indexOf('className="net"');
  assert.ok(iDir > 0 && iDir < iBand && iBand < iNet);
});

test("no invented destinations: no LinkedIn, and Privacy only from the propbetedge.ai origin", () => {
  assert.ok(!/linkedin/i.test(footer));
  for (const m of footer.matchAll(/privacy/gi)) assert.ok(footer.slice(m.index! - 30, m.index!).includes("propbetedge.ai/"), "privacy link must be https://propbetedge.ai/privacy");
});
