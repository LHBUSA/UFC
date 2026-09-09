import { ImageResponse } from "next/og";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const GOLD = "#d5ad45";
const LIGHT = "#f2eee4";
const BG = "#0b0a08";

function Hoodie() {
  return <div style={{ width: 610, height: 760, display: "flex", position: "relative", alignItems: "center", justifyContent: "center", flexDirection: "column", background: "#090909", borderRadius: 70, border: "3px solid #28251f", boxShadow: "0 0 80px rgba(213,173,69,.22)" }}>
    <div style={{ position: "absolute", top: -90, width: 360, height: 210, borderRadius: "50% 50% 30% 30%", border: "50px solid #090909", borderBottomWidth: 70 }} />
    <div style={{ fontSize: 72, fontWeight: 900, color: LIGHT, letterSpacing: 4, marginTop: 10 }}>TALE OF THE TAPE</div>
    <div style={{ width: 480, height: 6, background: GOLD, margin: "20px 0 30px" }} />
    {['STRIKING','GRAPPLING','CARDIO','DEFENSE','INTANGIBLES'].map((x,i)=><div key={x} style={{ width: 470, display: "flex", justifyContent: "space-between", fontSize: 30, color: LIGHT, margin: 9 }}><span>{x}</span><span style={{ color: GOLD }}>{'▮'.repeat((i%3)+2)}<span style={{color:'#777'}}>{'▮'.repeat(4-((i%3)+2))}</span></span></div>)}
    <div style={{ marginTop: 35, fontSize: 29, color: LIGHT, letterSpacing: 3 }}>DIFFERENT FIGHTERS. SAME DATA.</div>
    <div style={{ marginTop: 24, fontSize: 32, color: GOLD, fontWeight: 900, letterSpacing: 3 }}>PROPBETEDGE</div>
  </div>;
}

function Hat() {
  return <div style={{ display: "flex", position: "relative", width: 650, height: 470, background: "#080808", borderRadius: "330px 330px 80px 80px", border: "3px solid #29251e", alignItems: "center", flexDirection: "column", justifyContent: "center", boxShadow: "0 0 80px rgba(213,173,69,.24)" }}>
    <div style={{ position: "absolute", bottom: -70, width: 530, height: 145, borderRadius: "0 0 70% 70%", background: "#080808", border: "3px solid #29251e" }} />
    <div style={{ fontSize: 90, color: GOLD }}>♛</div>
    <div style={{ fontSize: 62, color: GOLD, fontWeight: 900, letterSpacing: 4 }}>PROPBETEDGE</div>
    <div style={{ fontSize: 25, color: GOLD, marginTop: 16, letterSpacing: 8 }}>COMMAND THE NUMBERS</div>
  </div>;
}

function Mug() {
  return <div style={{ display: "flex", position: "relative", width: 500, height: 650, background: "#050505", borderRadius: 45, border: "4px solid #27231d", flexDirection: "column", justifyContent: "center", padding: 55, boxShadow: "0 0 80px rgba(213,173,69,.24)" }}>
    <div style={{ position: "absolute", right: -175, top: 150, width: 230, height: 310, borderRadius: 120, border: "55px solid #050505" }} />
    <div style={{ fontSize: 68, color: LIGHT, fontWeight: 900 }}>TRUST THE</div>
    <div style={{ fontSize: 110, color: GOLD, fontWeight: 900, lineHeight: 1 }}>DATA</div>
    <div style={{ height: 180, display: "flex", alignItems: "end", gap: 12, marginTop: 24 }}>{[70,95,80,125,110,160,145,180].map((h,i)=><div key={i} style={{ width: 24, height: h, background: i>4?GOLD:'#ddd', opacity:.8 }} />)}</div>
    <div style={{ fontSize: 30, color: LIGHT, marginTop: 28, fontWeight: 800 }}>LESS OPINIONS.<br/>MORE WINNING.</div>
    <div style={{ fontSize: 29, color: GOLD, marginTop: 28, fontWeight: 900 }}>PROPBETEDGE</div>
  </div>;
}

export function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  return params.then(({ slug }) => {
    const product = slug === "tale-of-the-tape-hoodie" ? <Hoodie /> : slug === "propbetedge-hat" ? <Hat /> : slug === "trust-the-data-mug" ? <Mug /> : null;
    if (!product) return new Response("not found", { status: 404 });
    return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: `radial-gradient(circle at 50% 40%, #463114 0%, ${BG} 58%, #050505 100%)` }}>{product}</div>, { width: 720, height: 900, headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
  });
}
