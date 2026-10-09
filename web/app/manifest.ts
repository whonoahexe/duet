import type { MetadataRoute } from "next"

// Emitted as out/manifest.webmanifest by the static export.
// id and start_url define the installed app's identity: changing them later makes browsers
// treat it as a different app. Colors are the preset's dark --background (D-10).
export const dynamic = "force-static"

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "duet",
    short_name: "duet",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#090b0c",
    theme_color: "#090b0c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
