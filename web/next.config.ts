import type { NextConfig } from "next"

// Production builds are a static export (web/out) served by the Fastify server.
// `next dev` cannot use export-incompatible features, so the /api and /media proxy exists only in dev.
const isExport = !!process.env.NEXT_EXPORT

const nextConfig: NextConfig = {
  output: isExport ? "export" : undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@duet/shared"],
  ...(isExport
    ? {}
    : {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: "http://localhost:3100/api/:path*" },
            // Auth-gated media (plan 02-04, Pitfall 17): same cookie, served by the Fastify server.
            { source: "/media/:path*", destination: "http://localhost:3100/media/:path*" },
          ]
        },
      }),
}

export default nextConfig
