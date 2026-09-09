import { ImageResponse } from "next/og";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const GOLD = "#d2ae4a";
const PALE = "#e8d8a5";

function artSvg(): string {
  const cage = Array.from({ length: 13 }, (_, i) => {
    const x = 340 + i * 95;
    return `<path d="M${x} 480 L${x + 430} 910 M${x} 910 L${x + 430} 480" fill="none" stroke="${GOLD}" stroke-width="9" opacity=".28"/>`;
  }).join("");

  const rungs = Array.from({ length: 13 }, (_, i) => {
    const y = 420 + i * 112;
    const phase = i % 4;
    const left = phase === 0 ? 705 : phase === 1 ? 645 : phase === 2 ? 705 : 765;
    const right = 1800 - left;
    return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALE}" stroke-width="18" stroke-linecap="round" opacity=".88"/>`;
  }).join("");

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1800" height="2400" viewBox="0 0 1800 2400">
    <defs>
      <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f4e5b0"/>
        <stop offset=".25" stop-color="#b48b2f"/>
        <stop offset=".52" stop-color="#f5d779"/>
        <stop offset=".78" stop-color="#8f6822"/>
        <stop offset="1" stop-color="#e7cc74"/>
      </linearGradient>
      <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="4"/>
      </filter>
    </defs>

    <g transform="translate(0 20)">
      <path d="M900 170 L1415 445 L1540 1040 L1340 1720 L900 2155 L460 1720 L260 1040 L385 445 Z"
            fill="none" stroke="url(#metal)" stroke-width="34" stroke-linejoin="round"/>
      <path d="M900 220 L1370 475 L1482 1045 L1295 1685 L900 2070 L505 1685 L318 1045 L430 475 Z"
            fill="none" stroke="${GOLD}" stroke-width="8" opacity=".55"/>

      <g clip-path="url(#clip)">${cage}</g>

      <g opacity=".97">
        <path d="M735 270 C1110 470 1110 720 735 920 C360 1120 360 1370 735 1570 C1110 1770 1110 2010 735 2180"
              fill="none" stroke="url(#metal)" stroke-width="54" stroke-linecap="round"/>
        <path d="M1065 270 C690 470 690 720 1065 920 C1440 1120 1440 1370 1065 1570 C690 1770 690 2010 1065 2180"
              fill="none" stroke="url(#metal)" stroke-width="54" stroke-linecap="round"/>
        ${rungs}
      </g>

      <rect x="365" y="930" width="1070" height="505" rx="32" fill="#0f0e0c" opacity=".94" stroke="${GOLD}" stroke-width="11"/>
      <text x="900" y="1175" text-anchor="middle" font-family="Georgia, Times New Roman, serif" font-weight="900"
            font-size="204" letter-spacing="10" fill="url(#metal)" stroke="#5b4216" stroke-width="4">FIGHT DNA</text>
      <line x1="550" y1="1252" x2="1250" y2="1252" stroke="${GOLD}" stroke-width="8"/>
      <text x="900" y="1345" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700"
            font-size="72" letter-spacing="5" fill="${PALE}">PropBetEdge</text>
    </g>
  </svg>`;
}

export function GET() {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artSvg())}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "transparent",
        }}
      >
        <img src={src} width={1800} height={2400} alt="" />
      </div>
    ),
    {
      width: 1800,
      height: 2400,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
