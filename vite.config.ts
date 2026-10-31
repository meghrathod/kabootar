import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// In production one Cloudflare Worker serves the app, API and websockets on
// one origin. In development Vite proxies /api and /ws to `wrangler dev`.
const server = process.env.KABOOTAR_SERVER ?? "http://localhost:8787";

const icon = (size: number) => ({
  src: `/assets/rounded/Icon-${size}.png`,
  sizes: `${size}x${size}`,
  type: "image/png",
  purpose: "any",
});

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      manifestFilename: "manifest.webmanifest",
      injectManifest: {
        globPatterns: [
          "**/*.{js,css,html,svg,webmanifest}",
          "**/*-latin-wght-*.woff2",
          "assets/rounded/Icon-{192,512}.png",
          "assets/logo-mark.png",
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: true, type: "module" },
      manifest: {
        id: "/",
        name: "Kabootar: Fast & Secure File Sharing",
        short_name: "Kabootar",
        description:
          "Share files of any size straight between devices. Peer-to-peer, end-to-end encrypted, no uploads.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        orientation: "any",
        background_color: "#060818",
        theme_color: "#060818",
        categories: ["productivity", "utilities"],
        icons: [
          ...[72, 96, 120, 128, 144, 152, 180, 192, 384, 512].map(icon),
          {
            src: "/icons/maskable-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        shortcuts: [
          {
            name: "Send files",
            short_name: "Send",
            url: "/?action=send",
            icons: [{ src: "/assets/share.png", sizes: "512x512" }],
          },
          {
            name: "Receive files",
            short_name: "Receive",
            url: "/receive",
            icons: [{ src: "/assets/discover.png", sizes: "512x512" }],
          },
        ],
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [{ name: "files", accept: ["*/*"] }],
          },
        },
        launch_handler: { client_mode: ["navigate-existing", "auto"] },
      },
    }),
  ],
  build: {
    target: "es2022",
    assetsDir: "static",
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: "es" },
  server: {
    port: 3000,
    proxy: {
      "/api": server,
      "/healthz": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
