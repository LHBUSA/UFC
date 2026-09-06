import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./media-fixes.css";
import { Header, Footer } from "@/components/Shell";
import { LiveWire } from "@/components/LiveWire";
import { JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["700", "800", "900"], style: ["normal", "italic"], variable: "--font-playfair", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-mono", display: "swap" });

const TITLE = `${SITE.name} — UFC Cards, Fighters, Rankings & News`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: TITLE, template: `%s — ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: ["UFC", "MMA", "UFC fight card", "UFC results", "UFC rankings", "UFC fighters", "tale of the tape", "UFC news", "PropBetEdge"],
  authors: [{ name: SITE.publisher, url: SITE.parent }],
  creator: SITE.publisher,
  publisher: SITE.publisher,
  category: "sports",
  alternates: { canonical: "/", types: { "application/rss+xml": [{ url: `${SITE.url}/feed.xml`, title: `${SITE.name} — News` }] } },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
    shortcut: ["/icon.svg"],
  },
  manifest: "/site.webmanifest",
  appleWebApp: { capable: true, title: SITE.shortName, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  openGraph: { type: "website", siteName: SITE.name, url: SITE.url, locale: "en_US", title: TITLE, description: SITE.description },
  twitter: { card: "summary_large_image", site: SITE.twitter, creator: SITE.twitter, title: TITLE, description: SITE.description },
};

export const viewport: Viewport = { themeColor: "#14110d", colorScheme: "dark", width: "device-width", initialScale: 1, viewportFit: "cover" };

const ORG = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization", "@id": `${SITE.parent}/#org`, name: "PropBetEdge", legalName: SITE.publisher, url: SITE.parent,
      logo: { "@type": "ImageObject", url: SITE.logo.full600, width: 1075, height: 600 },
      sameAs: ["https://x.com/propbetedge", SITE.network.nfl, SITE.network.mlb, SITE.url],
      contactPoint: { "@type": "ContactPoint", contactType: "editorial", email: SITE.contact },
    },
    {
      "@type": "NewsMediaOrganization", "@id": `${SITE.url}/#desk`, name: SITE.desk, url: SITE.url, parentOrganization: { "@id": `${SITE.parent}/#org` },
      logo: { "@type": "ImageObject", url: `${SITE.url}${SITE.brand.logoWide}`, width: 600, height: 160 },
      ethicsPolicy: `${SITE.url}/about`, correctionsPolicy: `${SITE.url}/about#corrections`,
    },
    {
      "@type": "WebSite", "@id": `${SITE.url}/#site`, url: SITE.url, name: SITE.name, description: SITE.description, publisher: { "@id": `${SITE.parent}/#org` }, inLanguage: "en-US",
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
        <Header />
        <LiveWire />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
