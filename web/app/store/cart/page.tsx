import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { CartView } from "@/components/store/CartView";

/* /store/cart — the only page between choosing a piece and paying for it.
 *
 * Kept to one screen on purpose. This shop sells three things; a multi-step
 * cart would be ceremony around a decision the customer already made. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Cart | PropBetEdge UFC Store" },
  description: "Your PropBetEdge store cart.",
  robots: { index: false, follow: false },
};

export default async function CartPage({ searchParams }: { searchParams: Promise<{ cancelled?: string }> }) {
  const { cancelled } = await searchParams;
  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="Store"
            title="Your cart"
            lede="Printed on demand. Nothing is made until the order is paid for."
            crumbs={[{ name: "Store", href: "/store" }, { name: "Cart" }]}
          />
        </div>
      </div>
      <section className="wrap st-section">
        <CartView cancelled={cancelled === "1"} />
      </section>
    </>
  );
}
