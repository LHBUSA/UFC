import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./modules.css";
import "./media-fixes.css";
import "./product-polish.css";
import "./editorial-discovery.css";
import "./heritage.css";
import "./expansion.css";
import "./fightweek.css";
import "./fightdna.css";
import "./depth.css";
import "./judges.css";
import "./roundanalysis.css";
import "./market.css";
import "./tuf.css";
import "./store.css";
import "./store-commerce.css";
import "./model.css";
import "./fighter-dna-polish.css";
import { Header, Footer } from "@/components/Shell";
import { CartProvider } from "@/components/store/CartProvider";
import { LiveWire } from "@/components/LiveWire";
import { ShareRail } from "@/components/ShareRail";
import { JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["700", "800", "900"], style: ["normal", "italic"], variable: "--font-playfair", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-mono", display: "swap" });

const TITLE = "PropBetEdge UFC — Fight DNA, Cards, Fighters & Betting Intelligence";
const DESCRIPTION = "UFC fight intelligence from PropBetEdge: upcoming cards, fighter profiles, Fight DNA, round-level striking and grappling data, official rankings, results and bettor-focused newsroom analysis.";
const OG = `${SITE.url}/opengraph-image`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: TITLE, template: `%s — ${SITE.name}` },
  description: DESCRIPTION,
  applicationName: SITE.name,
  keywords: ["UFC", "MMA", "UFC Fight DNA", "UFC analytics", "UFC fight card", "UFC results", "UFC rankings", "UFC fighters", "tale of the tape", "UFC betting analysis", "PropBetEdge"],
  authors: [{ name: SITE.desk, url: `${SITE.url}/about` }],
  creator: "PropBetEdge",
  publisher: SITE.publisher,
  category: "sports",
  alternates: { canonical: "/", types: { "application/rss+xml": [{ url: `${SITE.url}/feed.xml`, title: `${SITE.name} — News` }] } },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon1.png", sizes: "32x32", type: "image/png" },
      { url: "/icon2.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
    shortcut: ["/icon.svg"],
  },
  manifest: "/site.webmanifest",
  appleWebApp: { capable: true, title: SITE.shortName, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    url: SITE.url,
    locale: "en_US",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: OG, width: 1200, height: 630, alt: "PropBetEdge UFC — Fight Intelligence" }],
  },
  twitter: { card: "summary_large_image", site: SITE.twitter, creator: SITE.twitter, title: TITLE, description: DESCRIPTION, images: [OG] },
};

export const viewport: Viewport = { themeColor: "#0d0b08", colorScheme: "dark", width: "device-width", initialScale: 1, viewportFit: "cover" };

const ORG = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE.parent}/#org`,
      name: "PropBetEdge",
      legalName: SITE.publisher,
      url: SITE.parent,
      logo: { "@type": "ImageObject", url: SITE.logo.full600, width: 1075, height: 600 },
      sameAs: ["https://x.com/propbetedge"],
      contactPoint: { "@type": "ContactPoint", contactType: "editorial and customer support", email: SITE.contact },
    },
    {
      "@type": "NewsMediaOrganization",
      "@id": `${SITE.url}/#desk`,
      name: SITE.desk,
      url: SITE.url,
      parentOrganization: { "@id": `${SITE.parent}/#org` },
      logo: { "@type": "ImageObject", url: `${SITE.url}${SITE.brand.logoWide}`, width: 600, height: 160 },
      ethicsPolicy: `${SITE.url}/about`,
      correctionsPolicy: `${SITE.url}/about#corrections`,
    },
    {
      "@type": "WebSite",
      "@id": `${SITE.url}/#site`,
      url: SITE.url,
      name: SITE.name,
      alternateName: "PropBetEdge UFC Fight Intelligence",
      description: DESCRIPTION,
      publisher: { "@id": `${SITE.parent}/#org` },
      creator: { "@id": `${SITE.url}/#desk` },
      inLanguage: "en-US",
      isPartOf: { "@type": "WebSite", "@id": `${SITE.parent}/#site`, name: "PropBetEdge", url: SITE.parent },
      potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${SITE.url}/fighters?q={search_term_string}` }, "query-input": "required name=search_term_string" },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} ${mono.variable}`}>
      <body style={{ ["--pbe-font-ui" as string]: "var(--font-inter), Inter, sans-serif", ["--pbe-font-display" as string]: "var(--font-playfair), Georgia, serif", ["--pbe-font-data" as string]: "var(--font-mono), Menlo, monospace" } as React.CSSProperties}>
        <a className="skip" href="#main">Skip to content</a>
        <JsonLd data={ORG} />
        {/* The cart is a client context and wraps everything, because the
            header's cart count and the product pages both read it. It holds
            slugs and quantities only; prices are resolved server-side at
            checkout. */}
        <CartProvider>
          <Header />
          <LiveWire />
          <ShareRail />
          <main id="main">{children}</main>
          <Footer />
        </CartProvider>
      </body>
    </html>
  );
}
