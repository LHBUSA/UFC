/* UFC Stats HTML parsers (Worker side). NOT YET WRITTEN.
 *
 * Same contract as scripts/backfill/parsers.py. Held until the live page
 * structure is verified (docs/scraper_notes.md). Every parser throws
 * SchemaAssertionError on anything unexpected and never returns partial rows.
 *
 * Workers have no DOM. The plan is HTMLRewriter-free, regex/tokeniser based
 * parsing over the small, regular ufcstats.com markup, validated against the
 * same fixture HTML the Python parsers use, so both sides are proven on
 * identical inputs.
 */

const PENDING = 'parsers pending live structure verification — see docs/scraper_notes.md';

export function parseEventList(html, sourceUrl) { throw new Error(`not_implemented: ${PENDING}`); }
export function parseFighterList(html, sourceUrl) { throw new Error(`not_implemented: ${PENDING}`); }
export function parseEventPage(html, sourceUrl) { throw new Error(`not_implemented: ${PENDING}`); }
export function parseFightPage(html, sourceUrl) { throw new Error(`not_implemented: ${PENDING}`); }
export function parseFighterPage(html, sourceUrl) { throw new Error(`not_implemented: ${PENDING}`); }
