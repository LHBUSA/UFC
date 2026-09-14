/* The route skeleton shown while a page streams.
 *
 * It used to be app/loading.tsx. A root loading boundary wraps every route, so
 * every response started streaming (HTTP 200) before any page could decide it
 * did not exist: notFound() then rendered "not found" with a 200 and a noindex,
 * and permanentRedirect() became a client-side meta refresh. The skeleton now
 * lives below each entity's existence gate ([slug]/layout.tsx) and in static
 * sections that cannot 404. */
export function PageSkeleton() {
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
