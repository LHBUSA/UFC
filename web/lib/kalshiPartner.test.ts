// Kalshi PERPETUALS partner offer (kalshi-partner/2): vendored client, fixed
// same-origin rewrites, one footer mount, and no offer terms in this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const CANONICAL = "D:/Workers/propbetedge-workers/workers/propsports-markets/client/kalshi-partner.js";

test("vendored kalshi-partner.js is byte-identical to the canonical client (skipped when absent)", (t) => {
  const vendored = join(WEB, "public", "kalshi-partner.js");
  assert.ok(existsSync(vendored), "web/public/kalshi-partner.js missing");
  assert.match(read("public/kalshi-partner.js"), /export const PARTNER_CONTRACT = 'kalshi-partner\/2'/);
  if (!existsSync(CANONICAL)) { t.skip("canonical client not on this machine"); return; }
  assert.equal(sha(vendored), sha(CANONICAL));
});

test("rewrites: exactly the two fixed /go/kalshi-perps paths to the network router", () => {
  const cfg = read("next.config.ts");
  const go = [...cfg.matchAll(/\{\s*source:\s*"(\/go\/[^"]*)",\s*destination:\s*"([^"]*)"\s*\}/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(go, [
    ["/go/kalshi-perps", "https://propsports-markets.sales-fd3.workers.dev/go/kalshi-perps"],
    ["/go/kalshi-perps/config", "https://propsports-markets.sales-fd3.workers.dev/v1/partner/kalshi"],
  ]);
  for (const [src, dst] of go) assert.ok(!/[:*()]/.test(src) && !/[:*()]/.test(dst.replace("https://", "")), "fixed paths only");
});

test("mount: one offer, in the footer, after the network directory, with the sport_footer context", () => {
  const shell = read("components/Shell.tsx");
  const footer = shell.slice(shell.indexOf("export function Footer()"));
  assert.equal((shell.match(/<KalshiPartnerOffer \/>/g) || []).length, 1);
  assert.ok(footer.indexOf("<KalshiPartnerOffer />") > footer.indexOf('className="net-sec"'));
  assert.ok(footer.indexOf("<KalshiPartnerOffer />") < footer.indexOf('className="disclaimer"'));
  const comp = read("components/KalshiPartnerOffer.tsx");
  assert.match(comp, /placement: "sport_footer", product: "ufc", sport: "ufc" \}, \{ variant: "footer" \}/);
  assert.match(comp, /loadPartnerConfig\(CONFIG\)/);
  assert.match(comp, /const CONFIG = "\/go\/kalshi-perps\/config"/);
});

test("no offer terms or referral id in this repo's own offer code (all copy lives in the vendored client)", () => {
  const cfg = read("next.config.ts");
  const own = [read("components/KalshiPartnerOffer.tsx"), cfg.slice(cfg.indexOf("async rewrites()"), cfg.indexOf("async redirects()"))];
  for (const text of own) {
    assert.ok(!/\$\d|\d+\s*%|\d+\s*(month|year)s?|kalshi\.com\/p\/|referra[l]=|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text), "offer terms or referral id hardcoded");
  }
});
