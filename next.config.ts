import type { NextConfig } from "next";

/**
 * Content-Security-Policy.
 *
 * `'unsafe-inline'` for styles is required by the inline `style={{...}}` props
 * used throughout the dashboard; `'unsafe-eval'` is NOT granted in production.
 * Development adds it: React's dev build calls eval() to rebuild call stacks,
 * and without it every dev page logs a CSP error (the "1 Issue" badge). `connect-src`
 * includes the Pusher endpoints the realtime client opens and the Nominatim
 * endpoint the pickup map geocodes against — anything not listed cannot be
 * reached from a page, which is what makes the policy worth having.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  // images.unsplash.com: the 11 seeded demo listings use Unsplash photos, and
  // without it the admin listing pages drew them as broken images (20 Oct 2026).
  // Images only; the phone app is not subject to this header.
  "img-src 'self' data: blob: https://res.cloudinary.com https://lh3.googleusercontent.com https://images.unsplash.com https://*.tile.openstreetmap.org https://unpkg.com",
  "media-src 'self' blob: https://res.cloudinary.com",
  "font-src 'self' data:",
  "connect-src 'self' https://res.cloudinary.com https://*.pusher.com wss://*.pusher.com https://nominatim.openstreetmap.org",
  "worker-src 'self' blob:",
  // HTTPS DEPLOYMENTS ONLY (3 Oct 2026, widened 11 Oct). Served over plain
  // http, a phone opening a page at http://<this machine's LAN address>:3000
  // obeys this directive by asking for the stylesheet and every image over
  // https, which nothing answers: the page arrives unstyled with broken
  // images. Browsers exempt localhost, so it only ever showed on a phone --
  // which is where the app's Settings rows open /policy/*.
  //
  // Keyed on NEXTAUTH_URL, not NODE_ENV: `next start` on a laptop is also
  // NODE_ENV=production and also plain http, and the old NODE_ENV test broke
  // those pages there. A real deployment sets NEXTAUTH_URL to its https origin.
  // Read at BUILD time (headers() is baked into the build), so rebuild after
  // changing it.
  // VERCEL is set on every Vercel build, which is always https.
  ...(process.env.NEXTAUTH_URL?.startsWith("https://") || process.env.VERCEL ? ["upgrade-insecure-requests"] : []),
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  // Only meaningful over HTTPS; browsers ignore it on plain http://localhost.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=(self), payment=()" },
];

/**
 * Hosts that may load the DEV server's /_next scripts, besides localhost.
 *
 * Next 16 answers 403 for /_next/* requested from any other origin, and a page
 * whose scripts are refused never hydrates. That is exactly what a phone sees
 * at http://<this laptop's LAN IP>:3000: the page renders and every onClick on
 * it is dead (17 Oct 2026, "Confirm my email" did nothing on a real phone).
 * Private ranges only, matched segment by segment by Next. Dev only: Next does
 * not consult this in production.
 */
const LAN_DEV_ORIGINS = [
  "127.0.0.1",
  "10.*.*.*",
  "192.168.*.*",
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*.*`),
];

const nextConfig: NextConfig = {
  allowedDevOrigins: LAN_DEV_ORIGINS,

  async redirects() {
    return [{ source: "/admin/anomalies", destination: "/admin/review-queue", permanent: true }];
  },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
      },
    ],
  },

  experimental: {
    // Route Handlers have no default body cap, so `await req.formData()` would
    // buffer an arbitrarily large upload into memory before the route's own
    // 10 MB check could run. 12 MB leaves headroom for multipart overhead on a
    // legitimate 10 MB file while still bounding the allocation.
    serverActions: { bodySizeLimit: "12mb" },
  },

  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
