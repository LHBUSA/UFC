import { getWire } from "@/lib/wire";
import { LiveWireRail } from "./LiveWireClient";
import { SITE } from "@/lib/site";

/* Server shell for the global wire: renders real items before hydration and
 * hands the client rail the API base to poll. Renders nothing at all when
 * there is no attributed item to show — never a placeholder headline. */
export async function LiveWire() {
  const wire = await getWire(20);
  if (!wire.items.length) return null;
  return <LiveWireRail initial={wire} api={`${SITE.api}/v1/ufc/wire?limit=20`} />;
}
