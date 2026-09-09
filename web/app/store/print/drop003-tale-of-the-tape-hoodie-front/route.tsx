import { ImageResponse } from "next/og";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const GOLD = "#d5ad45";
const PALE = "#f1ead7";

function svg() {
  const labels = ["STRIKING", "GRAPPLING", "CARDIO", "DEFENSE", "INTANGIBLES"];
  const rows = labels.map((label, i) => {
    const y = 700 + i * 170;
    const bars = Array.from({ length: 4 }, (_, b) => `<rect x="${1035 + b * 70}" y="${y - 43}" width="48" height="48" rx="4" fill="${b <= (i % 3) + 1 ? GOLD : PALE}" opacity="${b <= (i % 3) + 1 ? 1 : .75}"/>`).join("");
    return `<text x="900" y="${y}" text-anchor="middle" fill="${PALE}" font-family="Arial" font-weight="700" font-size="72" letter-spacing="8">${label}</text>${bars}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1800" viewBox="0 0 1800 1800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f3dd91"/><stop offset=".45" stop-color="#b98624"/><stop offset="1" stop-color="#f3d36f"/></linearGradient></defs>
  <path d="M190 230 H1610 L1690 310 V1490 L1610 1570 H190 L110 1490 V310Z" fill="none" stroke="url(#g)" stroke-width="28"/>
  <path d="M240 275 H1560" stroke="${GOLD}" stroke-width="7" opacity=".6"/>
  <text x="900" y="505" text-anchor="middle" fill="${PALE}" font-family="Arial Black,Arial" font-weight="900" font-size="190" letter-spacing="8">TALE OF THE TAPE</text>
  <line x1="370" y1="560" x2="1430" y2="560" stroke="${GOLD}" stroke-width="12"/>
  ${rows}
  <text x="900" y="1600" text-anchor="middle" fill="${PALE}" font-family="Arial" font-weight="800" font-size="78" letter-spacing="7">DIFFERENT FIGHTERS. SAME DATA.</text>
  <text x="900" y="1700" text-anchor="middle" fill="url(#g)" font-family="Arial" font-weight="900" font-size="70" letter-spacing="7">PROPBETEDGE</text>
  </svg>`;
}

export function GET() {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg())}`;
  return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><img src={src} width={1800} height={1800} alt="" /></div>, { width: 1800, height: 1800, headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
}
