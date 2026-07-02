// Standalone chat dev server — self-contained build config OWNED by this package
// (not imported from interface). Defaults to :18931; override FORGEAX_CHAT_PORT.
//
// NOTE (submodule path): alias targets currently point at the studio-monorepo
// sibling packages (`../interface`, `../types`, …). When this package becomes a
// self-contained submodule that vendors interface (the editor pattern), flip
// INTERFACE_DIR / SIB to the vendored locations (e.g. `./packages/interface`).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const sib = (p: string) => resolve(PACKAGE_DIR, '..', p);
const INTERFACE_DIR = sib('interface');

// Hydrate process.env from the repo-root .env (FORGEAX_SERVER_URL, ports, …).
const ROOT_ENV = resolve(PACKAGE_DIR, '../../.env');
if (existsSync(ROOT_ENV)) {
  for (const line of readFileSync(ROOT_ENV, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SERVER = process.env.FORGEAX_SERVER_URL ?? 'http://127.0.0.1:18900';
const SERVER_WS = SERVER.replace(/^http/, 'ws');

const HTTPS_ENABLED = process.env.FORGEAX_INTERFACE_HTTPS === '1';
const ROOT_TLS = resolve(PACKAGE_DIR, '../../.tls');
const tlsCertPath = existsSync(resolve(ROOT_TLS, 'cert.pem')) ? resolve(ROOT_TLS, 'cert.pem') : resolve(PACKAGE_DIR, '.tls/cert.pem');
const tlsKeyPath = existsSync(resolve(ROOT_TLS, 'key.pem')) ? resolve(ROOT_TLS, 'key.pem') : resolve(PACKAGE_DIR, '.tls/key.pem');
const useCustomCert = HTTPS_ENABLED && existsSync(tlsCertPath) && existsSync(tlsKeyPath);
const httpsServerOption = useCustomCert ? { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) } : undefined;

export default defineConfig({
  plugins: [
    react(),
    ...(HTTPS_ENABLED && !useCustomCert ? [basicSsl()] : []),
  ],
  resolve: {
    // dockview declares react as a peer dep; bun's isolated node_modules can
    // resolve a SECOND react copy → "Invalid hook call". Force a single one.
    dedupe: ['react', 'react-dom'],
    alias: {
      // Trailing-slash (subpath) aliases MUST precede their bare-name twins
      // (Vite first-prefix-match; see studio/vite.config.ts rationale).
      '@forgeax/interface/': `${resolve(INTERFACE_DIR, 'src')}/`,
      '@forgeax/interface': resolve(INTERFACE_DIR, 'src/index.ts'),
      '@/': `${resolve(INTERFACE_DIR, 'src')}/`,
      '@forgeax/design/preset': resolve(INTERFACE_DIR, 'packages/design/preset.ts'),
      '@forgeax/design/theme': resolve(INTERFACE_DIR, 'packages/design/theme.ts'),
      '@forgeax/design/tokens.css': resolve(INTERFACE_DIR, 'packages/design/tokens.css'),
      '@forgeax/design': resolve(INTERFACE_DIR, 'packages/design/index.ts'),
      '@forgeax/types': sib('types/src/index.ts'),
      '@forgeax/host-sdk': sib('host-sdk/src/index.ts'),
    },
  },
  optimizeDeps: { exclude: ['@forgeax/engine-runtime'] },
  server: {
    port: Number(process.env.FORGEAX_CHAT_PORT ?? 18931),
    host: '0.0.0.0',
    strictPort: true,
    open: false,
    ...(httpsServerOption !== undefined ? { https: httpsServerOption } : {}),
    watch: { usePolling: false, ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'] },
    fs: { allow: ['..', '../..'] },
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER_WS, ws: true, changeOrigin: true },
    },
  },
});
