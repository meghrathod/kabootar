import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import bundledEntryPlugin from "vite-plugin-bundled-entry";

export default defineConfig({
  plugins: [
    solidPlugin(),
    bundledEntryPlugin({
      id: "sw-bundled-entry",
      outFile: "/sw.js",
      entryPoint: "./src/sw.ts",
    }),
  ],
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
  },
});
