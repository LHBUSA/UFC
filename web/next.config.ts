import type { NextConfig } from "next";

const supabaseHost = (() => {
  try { return new URL(process.env.SUPABASE_URL || "https://tkmlnhmylqnttmnsnief.supabase.co").hostname; } catch { return "tkmlnhmylqnttmnsnief.supabase.co"; }
})();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "propbetedge.ai" },
      { protocol: "https", hostname: "a.espncdn.com", pathname: "/i/headshots/mma/players/full/**" },
      { protocol: "https", hostname: supabaseHost, pathname: "/storage/v1/object/public/**" },
    ],
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
      { source: "/brand/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/feed.xml", headers: [{ key: "Cache-Control", value: "public, s-maxage=600, stale-while-revalidate=3600" }] },
    ];
  },
  async redirects() {
    return [
      { source: "/rss", destination: "/feed.xml", permanent: true },
      { source: "/rss.xml", destination: "/feed.xml", permanent: true },
      // /picks is the phrase people type; /model is the page. A config
      // redirect rather than a second route, so there is one canonical URL and
      // the alias never competes with it in search.
      { source: "/picks", destination: "/model", permanent: true },
    ];
  },
};

export default nextConfig;