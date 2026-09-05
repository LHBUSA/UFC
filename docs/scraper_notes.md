# UFC Stats scraper notes

Living document. Every deviation from the kickoff brief that was found against
the live site goes here, with the date it was observed.

## 2026-09-05 — ufcstats.com is no longer static HTML

The brief says: "Static HTML, no JS, no auth." That was true for years. It is
not true as of 2026-09-05.

Every request to `ufcstats.com` (both `http://` and `www.`) from a plain HTTP
client (`requests`, `curl`, any User-Agent) returns HTTP 200 with a ~3 KB
interstitial instead of the page:

```
<title>Loading…</title><meta name="robots" content="noindex">
<p>Checking your browser…</p>
<noscript>This site requires JavaScript.</noscript>
```

The page carries an inline JavaScript proof-of-work: a pure-JS SHA-256
implementation, a server-issued `nonce`, and a loop that finds an integer `n`
such that `sha256(nonce + ':' + n)` starts with two hex zeros (difficulty 2,
~256 hashes, sub-millisecond). It then POSTs `nonce` and `n` to `/__c` and
reloads. The reload presumably succeeds because `/__c` sets a cookie; the
cookie name, lifetime and scope have NOT been observed (I did not solve the
challenge — see "Decision needed").

Response headers on the interstitial:

```
Server: nginx/1.10.1
Cache-Control: no-store, no-cache, must-revalidate
```

`/robots.txt` returns 404. No terms-of-use page was fetched.

`https://` on the bare host does not connect (curl exit 000); `http://` and
`http://www.` both serve the interstitial.

### What this breaks

* The brief's "1 req/sec with a real User-Agent" plan does not work as written.
  No selector in the brief could be verified against the live site.
* The Cloudflare Worker cannot run the challenge script as a browser would.
  Any fetch strategy has to be decided before `ufc-stats-ingest` can do
  anything.

### Decision needed (Justin)

Options, in order of least to most infrastructure:

1. **Solve the challenge in the fetch layer.** Compute the same SHA-256 PoW
   in Python / WebCrypto, POST to `/__c`, keep the cookie in a session, reuse
   it for every request. This is exactly what a browser does; the gate is a
   "runs JS" check, not a CAPTCHA and not a login. Cheapest and simplest, but
   it is knowingly working through an anti-automation gate the site operator
   put up. That is a business/legal call, not an engineering one, so it is
   not implemented until you say so.
2. **Cloudflare Browser Rendering** from the Worker (a real headless Chromium
   passes the challenge natively) plus Playwright locally for the backfill.
   Heavier, costs money per session, same legal posture as option 1.
3. **Change the primary source.** Sherdog / Tapology / ESPN / Wikipedia carry
   results and cards; none carries UFC Stats' per-round striking/grappling
   detail. The Phase 4 model would lose round-level stats.
4. **Licensed data.** Fight data vendors exist; out of scope to evaluate here.

### What was verified anyway

Nothing on the live site. The Internet Archive holds captures of all page
types (completed list 2026-02-16, upcoming list 2026-08-01, fighter list
2026-02-19). Wayback rate-limited (HTTP 429) every fetch attempt during this
session, so structure verification is pending. The archived copies are the
right thing to verify parsers against first; they cost UFC Stats nothing.

## Selector hypothesis (from the brief, unverified)

Kept here so the verification pass has something concrete to diff against.

| Page | Expectation |
|---|---|
| `/statistics/events/completed?page=all` | table rows: name link `/event-details/{16hex}`, date, location |
| `/statistics/events/upcoming` | same shape |
| `/statistics/fighters?char=a&page=all` | first, last, nickname, height, weight, reach, stance, W, L, D, belt |
| `/event-details/{id}` | rows in card order, main event first; W/L, two fighter links, KD, STR, TD, SUB, weight class, method (2 lines), round, time; row link `/fight-details/{id}` |
| `/fight-details/{id}` | header names/links + W/L; weight-class line; Method / Round / Time / Time format / Referee / Details; Totals table + per-round; Sig. strikes table + per-round; two `<p>` per cell |
| `/fighter-details/{id}` | name, nickname, `Record: W-L-D (n NC)`; Height/Weight/Reach/Stance/DOB; SLpM … Sub. Avg.; fight history table |
