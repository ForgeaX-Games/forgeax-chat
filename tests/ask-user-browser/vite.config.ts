// Run from Chat: bunx vite --config tests/ask-user-browser/vite.config.ts
// Set FORGEAX_INTERFACE_DIR when Interface is not a sibling checkout.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL(".", import.meta.url));
const interfaceDir =
  process.env.FORGEAX_INTERFACE_DIR || resolve(root, "../../../interface");
export default defineConfig({
  root,
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: { "@forgeax/interface/": resolve(interfaceDir, "src") + "/" },
  },
  esbuild: { jsx: "automatic" },
  server: {
    host: "127.0.0.1",
    port: 19351,
    strictPort: true,
    fs: { allow: [resolve(root, "../.."), interfaceDir] },
  },
});
