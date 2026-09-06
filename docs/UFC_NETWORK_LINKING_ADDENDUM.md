# PropBetEdge UFC — Network Linking Addendum

This addendum applies to `ufc-fight-dna-v1` and subsequent UFC product work.

## Goal

Make UFC feel unmistakably part of the PropBetEdge sports network while improving cross-product discovery and sensible crawl paths between:

- `https://propbetedge.ai`
- `https://mlb.propbetedge.ai`
- `https://nfl.propbetedge.ai`
- `https://ufc.propbetedge.ai`

These are sibling products under one brand. Cross-link them intentionally; do not scatter repetitive links throughout every paragraph.

## 1. Header / brand link

The canonical PropBetEdge wordmark or network mark should link to `https://propbetedge.ai`.

Near the UFC product tag, add a subtle network affordance on desktop such as:

`PBE Network · MLB · NFL · UFC`

or a compact `Sports` / `Network` menu.

Requirements:

- UFC remains visually selected/current
- MLB links to `https://mlb.propbetedge.ai`
- NFL links to `https://nfl.propbetedge.ai`
- PropBetEdge links to `https://propbetedge.ai`
- do not crowd the primary UFC navigation
- mobile may move the network links into the menu instead of forcing another top row

## 2. Footer

Keep the existing `The PropBetEdge Sports Network` treatment and ensure every destination is correct.

Footer destinations:

- PropBetEdge — `https://propbetedge.ai`
- MLB Intelligence — `https://mlb.propbetedge.ai`
- NFL Intelligence — `https://nfl.propbetedge.ai`
- UFC Intelligence — current site
- PropSports API — existing API network destination

Use descriptive anchor text, not naked domains only.

## 3. Contextual article links

Add a small `More from PropBetEdge` or `Across the network` module at the end of article pages / related-content rail.

Do not hardcode irrelevant sibling stories into UFC prose.

Initial static network links are acceptable:

- `PropBetEdge — Sports betting intelligence`
- `NFL Intelligence — Football data, markets and models`
- `MLB Intelligence — Baseball data, markets and analysis`

Later, if a shared network feed/API exists, this module may show one current relevant sibling story per sport.

## 4. About / editorial pages

The About and editorial-policy pages should clearly state that UFC is part of the PropBetEdge sports network and link to the sibling products.

This is a natural place for stronger descriptive cross-links because the context is brand/product architecture rather than a fight article.

## 5. Homepage network rail

Near the lower homepage / before footer, include a premium network rail or cards:

- MLB
- NFL
- UFC (current)

Each card should feel like a sibling product, not an advertisement.

Example:

`MLB — Baseball Intelligence`
`NFL — Football Intelligence`
`UFC — Fight Intelligence`

Keep UFC marked as `YOU ARE HERE` / current.

## 6. Structured data / metadata

Do not change UFC canonicals to sibling domains.

Keep each page canonical to `ufc.propbetedge.ai`.

Where appropriate in Organization/WebSite/AboutPage structured data, represent the parent PropBetEdge brand and sibling product URLs without falsely claiming that unrelated content is the same page.

Do not misuse `sameAs` for sibling product pages; use appropriate organization/product relationships instead.

## 7. Link behavior

For first-party PropBetEdge network domains:

- normal followed links
- no `nofollow`
- same-tab navigation by default
- clear visible anchor text
- preserve accessibility/focus states

Do not open every sibling product in a new tab just because the hostname differs.

## 8. Avoid over-linking

Do not:

- add sibling links repeatedly inside every article paragraph
- force MLB/NFL references into UFC copy where they are not contextually relevant
- create hidden SEO link blocks
- duplicate the same network rail in multiple adjacent sections

The goal is a coherent sports network, not link stuffing.

## Acceptance

Before merge verify:

- PropBetEdge logo/parent link resolves correctly
- MLB resolves to `https://mlb.propbetedge.ai`
- NFL resolves to `https://nfl.propbetedge.ai`
- UFC current-state styling works
- footer links are correct
- mobile menu exposes the network cleanly
- article network module is present but unobtrusive
- canonical URLs remain UFC URLs
- no duplicate/broken sibling links

## Product bar

A user should understand within seconds that UFC is one specialized intelligence product inside a larger PropBetEdge sports network, and moving between UFC, NFL, MLB and the main PropBetEdge property should feel intentional and first-party.
