import { ImageResponse } from "next/og";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function svg() {
  const bars = [260,340,300,470,420,610,535,760,690,840].map((h, i) => `<rect x="${220 + i * 105}" y="${820 - h / 2}" width="48" height="${h / 2}" fill="#e9e5d8" opacity="${.35 + i * .055}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2250" height="925" viewBox="0 0 2250 925">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1d57e"/><stop offset=".5" stop-color="#b78325"/><stop offset="1" stop-color="#e9c55f"/></linearGradient></defs>
  <text x="150" y="190" fill="#f3efe4" font-family="Arial Black,Arial" font-weight="900" font-size="150" letter-spacing="8">TRUST THE</text>
  <text x="150" y="365" fill="url(#g)" font-family="Arial Black,Arial" font-weight="900" font-size="210" letter-spacing="10">DATA</text>
  ${bars}
  <polyline points="245,690 360,625 485,660 600,575 730,600 855,485 980,430 1095,300" fill="none" stroke="#d6aa39" stroke-width="25" stroke-linecap="round" stroke-linejoin="round"/>
  <polygon points="1095,300 1050,345 1135,350" fill="#d6aa39"/>
  <g transform="translate(1320 110)">
    <circle cx="340" cy="220" r="105" fill="#d6aa39" opacity=".18"/>
    <path d="M350 170 C275 220 260 325 290 435 L240 720 H470 L430 430 C465 300 430 215 350 170 Z" fill="#e5dfd0" opacity=".78"/>
    <path d="M410 270 L515 70 L575 105 L475 335" fill="none" stroke="#e5dfd0" stroke-width="80" stroke-linecap="round"/>
    <circle cx="555" cy="75" r="60" fill="#d6aa39"/>
  </g>
  <text x="1330" y="730" fill="#f3efe4" font-family="Arial" font-weight="900" font-size="78" letter-spacing="5">LESS OPINIONS.</text>
  <text x="1330" y="820" fill="#f3efe4" font-family="Arial" font-weight="900" font-size="78" letter-spacing="5">MORE WINNING.</text>
  <text x="2050" y="875" text-anchor="end" fill="url(#g)" font-family="Arial" font-weight="900" font-size="58" letter-spacing="5">PROPBETEDGE</text>
  </svg>`;
}

export function GET() {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg())}`;
  return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><img src={src} width={2250} height={925} alt="" /></div>, { width: 2250, height: 925, headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
}
