import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./visual-v2.css";
import { Header, Footer } from "@/components/Shell";
import { JsonLd } from "@/components/ui";
import { SITE } from "@/lib/site";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["700", "800", "900"], style: ["normal", "italic"], variable: "--font-playfair", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: `${SITE.name} — ${SITE.tagline}`, template: `%s — ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: ["UFC", "MMA", "UFC odds", "UFC picks", "UFC fight card", "UFC rankings", "fighter stats", "PropBetEdge"],
  authors: [{ name: SITE.publisher, url: SITE.parent }],
  creator: SITE.publisher,
  publisher: SITE.publisher,
  alternates: { canonical: "/", types: { "application/rss+xml": `${SITE.url}/feed.xml` } },
  robots: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
  icons: {
    icon: [{ url: SITE.logo.mark80, sizes: "80x80", type: "image/png" }, { url: SITE.logo.mark160, sizes: "160x160", type: "image/png" }],
    apple: [{ url: SITE.logo.mark240, sizes: "240x240", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  appleWebApp: { capable: true, title: SITE.shortName, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  openGraph: {
    type: "website", siteName: "PropBetEdge", url: SITE.url, locale: "en_US",
    title: `${SITE.name} — ${SITE.tagline}`, description: SITE.description,
  },
  twitter: { card: "summary_large_image", site: SITE.twitter, title: `${SITE.name} — ${SITE.tagline}`, description: SITE.description },
};

export const viewport: Viewport = { themeColor: "#14110d", colorScheme: "dark", width: "device-width", initialScale: 1, viewportFit: "cover" };

const ORG = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": `${SITE.parent}/#org`, name: "PropBetEdge", url: SITE.parent, logo: SITE.logo.full600, sameAs: ["https://x.com/propbetedge"] },
    { "@type": "WebSite", "@id": `${SITE.url}/#site`, url: SITE.url, name: SITE.name, publisher: { "@id": `${SITE.parent}/#org` }, inLanguage: "en-US",
      potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${SITE.url}/fighters?q={search_term_string}` }, "query-input": "required name=search_term_string" } },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} ${mono.variable}`}>
      <body style={{ ["--pbe-font-ui" as string]: "var(--font-inter), Inter, sans-serif", ["--pbe-font-display" as string]: "var(--font-playfair), Georgia, serif", ["--pbe-font-data" as string]: "var(--font-mono), Menlo, monospace" } as React.CSSProperties}>
        <a className="skip" href="#main">Skip to content</a>
        <JsonLd data={ORG} />
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
