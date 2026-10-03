/* ALGO vs MARKET (shared module, canonical client ad6187a). Server components:
 * the HTML is the vendored algoVsMarketCard / algoVsMarketEvent output (escaped
 * strings), read on the server so it is in the first paint. PUBLIC: it shows
 * exactly what the API returns — a pending UFC call is LOCKED with selections
 * null until graded. Nothing renders until a qualifying comparison exists. */
import { ufcAvmEventHtml, ufcAvmRecordHtml, type AvmAlgo, type AvmComparison } from "@/lib/kalshi";

export function AlgoVsMarketRecord({ payload }: { payload: { algos?: AvmAlgo[] } | null }) {
  const html = ufcAvmRecordHtml(payload);
  if (!html) return null;
  return <div className="ufc-kx ufc-avm mt-5" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function AlgoVsMarketFight({ payload, a, b }: { payload: { comparisons?: AvmComparison[] } | null; a: string; b: string }) {
  const html = ufcAvmEventHtml(payload, { a, b });
  if (!html) return null;
  return <div className="ufc-kx ufc-kx--top ufc-avm" dangerouslySetInnerHTML={{ __html: html }} />;
}
