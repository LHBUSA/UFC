export default function Loading() {
  return (
    <div className="wrap page" aria-busy="true" aria-live="polite">
      <div className="skel" style={{ width: 160, height: 12, marginBottom: 16 }} />
      <div className="skel" style={{ width: "55%", height: 44, marginBottom: 12 }} />
      <div className="skel" style={{ width: "40%", height: 18, marginBottom: 32 }} />
      <div className="grid-3">
        <div className="skel" style={{ height: 220 }} />
        <div className="skel" style={{ height: 220 }} />
        <div className="skel" style={{ height: 220 }} />
      </div>
      <div className="stack mt-5">
        <div className="skel" style={{ height: 72 }} />
        <div className="skel" style={{ height: 72 }} />
        <div className="skel" style={{ height: 72 }} />
      </div>
    </div>
  );
}
