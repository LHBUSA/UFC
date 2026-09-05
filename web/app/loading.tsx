export default function Loading() {
  return (
    <div className="wrap" style={{ padding: "48px 24px" }} aria-busy="true" aria-live="polite">
      <div className="skel" style={{ width: 160, height: 12, marginBottom: 16 }} />
      <div className="skel" style={{ width: "60%", height: 40, marginBottom: 12 }} />
      <div className="skel" style={{ width: "40%", height: 18, marginBottom: 32 }} />
      <div className="grid-3">
        <div className="skel" style={{ height: 140 }} />
        <div className="skel" style={{ height: 140 }} />
        <div className="skel" style={{ height: 140 }} />
      </div>
    </div>
  );
}
