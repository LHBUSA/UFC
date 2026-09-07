import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { SITE } from "@/lib/site";

/* /store/policies — what actually happens after an order.
 *
 * Written now, before anything can be bought, because print-on-demand
 * genuinely behaves differently from a warehouse and the differences are the
 * things people are annoyed by later: production time is not shipping time,
 * and a garment printed to order is not returnable simply for being unwanted.
 * Saying so in advance is cheaper than saying it in a support reply. */
export const revalidate = 3600;

const TITLE = "Store policies | PropBetEdge UFC";
const DESCRIPTION = "Shipping, production times, returns and print policies for the PropBetEdge UFC store.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/store/policies" },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: `${SITE.url}/store/policies` },
};

export default function StorePolicies() {
  return (
    <>
      <PageHead
        eyebrow="Store"
        title="Policies"
        lede="How a print-on-demand order works, and where it differs from a shop that holds stock."
        crumbs={[{ name: "Home", href: "/" }, { name: "Store", href: "/store" }, { name: "Policies" }]}
      />

      <section className="wrap st-prose">
        <h2>Nothing is made until you order it</h2>
        <p>
          There is no warehouse. Each piece is printed for the order that paid for it, which is why the collection can
          be small and specific rather than whatever a bulk run made cheap.
        </p>

        <h2>Production time is separate from shipping time</h2>
        <p>
          Production typically takes a few business days before anything is handed to a carrier. The delivery estimate
          shown at checkout is the carrier&rsquo;s, and it starts when production finishes, not when you pay. We show both
          numbers separately rather than adding them into one optimistic figure.
        </p>

        <h2>Returns</h2>
        <p>
          A misprint, a damaged item, or the wrong item is ours to fix: tell us within 30 days of delivery and we
          replace it or refund it, with no return shipment required for most defects. Because each item is made to
          order, we cannot accept a return simply because a size was wrong &mdash; check the size guide before ordering.
          If something arrives faulty, email{" "}
          <a href={`mailto:${SITE.contact}`}>{SITE.contact}</a> with your order number and a photograph.
        </p>

        <h2>What is printed</h2>
        <p>
          Every design is our own. Nothing sold here uses the UFC name as a mark on a product, the octagon trademark,
          or any rights-holder&rsquo;s trade dress, and no fighter&rsquo;s name or likeness appears on any item. This site
          reports on the sport; it is not affiliated with, endorsed by, or licensed by any promotion.
        </p>

        <h2>Payment</h2>
        <p>
          Card details are handled by our payment processor and never reach our servers. We store an order record and
          the address the parcel must go to, and nothing else.
        </p>

        <p className="st-fine">
          Questions before the store opens? <Link href="/about">About this desk</Link>.
        </p>
      </section>
    </>
  );
}
