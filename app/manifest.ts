import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Cipher Budget",
    short_name: "Cipher Budget",
    description: "A private, encrypted biweekly budget planner",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#1a1718",
    theme_color: "#1a1718",
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}
