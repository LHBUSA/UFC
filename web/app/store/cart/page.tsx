import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { CartView } from "@/components/store/CartView";

/* /store/cart — the only page between choosing a piece and paying for it. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Bag & Checkout | PropBetEdge UFC Store" },
  description: "Review your PropBetEdge order and continue to secure checkout.",
  robots: { index: false, follow: false },
};

export default async function CartPage({ searchParams }: { searchParams: Promise<{ cancelled?: string }> }) {
  const { cancelled } = await searchParams;
  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="PropBetEdge Store"
            title="Bag & checkout"
            lede="Review your items, then continue to Stripe for shipping, tax and secure payment."
            crumbs={[{ name: "Store", href: "/store" }, { name: "Bag & checkout" }]}
          />
        </div>
      </div>
      <section className="wrap st-section">
        <CartView cancelled={cancelled === "1"} />
      </section>
    </>
  );
}
