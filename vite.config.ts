// Standalone chat dev server — self-contained build config OWNED by this package
// (not imported from interface). Defaults to :18931; override FORGEAX_CHAT_PORT.
//
// Dependencies resolve through this package's published package.json contract;
// the standalone app does not reach into sibling source checkouts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import checker from "vite-plugin-checker";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

// Hydrate process.env from the repo-root .env (FORGEAX_SERVER_URL, ports, …).
const ROOT_ENV = resolve(PACKAGE_DIR, "../../.env");
if (existsSync(ROOT_ENV)) {
	for (const line of readFileSync(ROOT_ENV, "utf-8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
		if (m && !(m[1] in process.env))
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
}

const SERVER = process.env.FORGEAX_SERVER_URL ?? "http://127.0.0.1:18900";
const SERVER_WS = SERVER.replace(/^http/, "ws");

const HTTPS_ENABLED = process.env.FORGEAX_INTERFACE_HTTPS === "1";
const ROOT_TLS = resolve(PACKAGE_DIR, "../../.tls");
const tlsCertPath = existsSync(resolve(ROOT_TLS, "cert.pem"))
	? resolve(ROOT_TLS, "cert.pem")
	: resolve(PACKAGE_DIR, ".tls/cert.pem");
const tlsKeyPath = existsSync(resolve(ROOT_TLS, "key.pem"))
	? resolve(ROOT_TLS, "key.pem")
	: resolve(PACKAGE_DIR, ".tls/key.pem");
const useCustomCert =
	HTTPS_ENABLED && existsSync(tlsCertPath) && existsSync(tlsKeyPath);
const httpsServerOption = useCustomCert
	? { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }
	: undefined;

export default defineConfig({
	plugins: [
		react(),
		checker({
			typescript: true,
			biome: {
				command: "check",
				flags: "--config-path=biome.json --diagnostic-level=error",
				dev: { logLevel: ["error"] },
			},
			overlay: { initialIsOpen: "error" },
			terminal: true,
		}),
		...(HTTPS_ENABLED && !useCustomCert ? [basicSsl()] : []),
	],
	resolve: {
		// dockview declares react as a peer dep; bun's isolated node_modules can
		// resolve a SECOND react copy → "Invalid hook call". Force a single one.
		dedupe: ["react", "react-dom"],
	},
	optimizeDeps: { exclude: ["@forgeax/engine-runtime"] },
	server: {
		port: Number(process.env.FORGEAX_CHAT_PORT ?? 18931),
		host: "0.0.0.0",
		strictPort: true,
		open: false,
		...(httpsServerOption !== undefined ? { https: httpsServerOption } : {}),
		watch: {
			usePolling: false,
			ignored: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
		},
		fs: { allow: ["..", "../.."] },
		proxy: {
			"/api": { target: SERVER, changeOrigin: true },
			"/ws": { target: SERVER_WS, ws: true, changeOrigin: true },
		},
	},
});
