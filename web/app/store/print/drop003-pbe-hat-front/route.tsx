import { ImageResponse } from "next/og";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function svg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1650" height="600" viewBox="0 0 1650 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1d57e"/><stop offset=".5" stop-color="#b78325"/><stop offset="1" stop-color="#e9c55f"/></linearGradient></defs>
  <g fill="none" stroke="url(#g)" stroke-width="26" stroke-linejoin="round">
    <path d="M640 155 L715 240 L825 115 L935 240 L1010 155 L980 300 H670 Z"/>
    <path d="M685 330 H965" stroke-width="18"/>
  </g>
  <text x="825" y="445" text-anchor="middle" fill="url(#g)" font-family="Arial Black,Arial" font-weight="900" font-size="135" letter-spacing="6">PROPBETEDGE</text>
  <text x="825" y="535" text-anchor="middle" fill="#d5ad45" font-family="Arial" font-weight="700" font-size="48" letter-spacing="12">COMMAND THE NUMBERS</text>
  </svg>`;
}

export function GET() {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg())}`;
  return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><img src={src} width={1650} height={600} alt="" /></div>, { width: 1650, height: 600, headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
}
