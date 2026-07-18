// Standalone chat app entry — OWNS its own boot, mirroring
// packages/editor/standalone/main.tsx. interface is consumed purely as a parts
// library (store + L1 init side-effects + ErrorBoundary/BrandProvider); the IDE
// product shell (<App>: TopBar / DockShell / SurfaceKeepAliveLayer / overlays)
// is studio's (L3) concern and is NOT rendered here.
//
// Why only <ChatPanel/> (no DockShell/surfaces): an app dev server proxies only
// /api·/ws, so mounting DockShell's surface iframes would SPA-fall back to this
// app's own index.html and nest infinitely. We mount just the chat surface
// full-viewport over the booted L1 store + chat session stream.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@forgeax/interface/styles/global.css';
import { applyTheme } from '@forgeax/design/theme';
import { initI18n } from '@forgeax/interface/i18n';
import { initAegis } from '@forgeax/interface/lib/aegis';
import { BrandProvider } from '@forgeax/interface/brand';
import { ErrorBoundary } from '@forgeax/interface/components/ErrorBoundary';
import { bootStageEntry } from '@forgeax/interface/boot/driver';
import { bootBroadcast } from '@forgeax/interface/boot/broadcast';
import { subscribeNarrativeCopilot } from '@forgeax/interface/lib/narrative-copilot';
import { subscribeFileActivityStream } from '@forgeax/interface/lib/file-activity-stream';
import { subscribePermissionStream } from '@forgeax/interface/lib/permission-stream';
import { subscribePerceptionStream } from '@forgeax/interface/lib/perception-stream';
import { syncBrowserPrefsFromServer, startBrowserPrefsSync } from '@forgeax/interface/lib/browser-prefs-sync';
import { useShellStore } from '@forgeax/interface/store';
import { installHealthBridge } from '@forgeax/interface/components/StatusBar/healthBridge';
import { subscribeSessionStream, subscribeDaemonTick } from './session-store';
import { ChatPanel } from './components/ChatPanel/ChatPanel';

// The single surface child fills the full-viewport flex shell.
const SHELL_CSS = `
.forgeax-standalone-shell { position: fixed; inset: 0; display: flex; overflow: hidden; background: var(--color-background, #0e1216); }
.forgeax-standalone-shell > * { flex: 1 1 auto; min-width: 0; min-height: 0; }
`;

function boot(): void {
  // Dark-only today; index.html already dual-marks data-theme + .dark for no-flash.
  applyTheme('dark');
  initI18n();
  initAegis();

  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('#root missing');

  void syncBrowserPrefsFromServer().finally(() => {
    initI18n();
    startBrowserPrefsSync();
  });
  bootStageEntry();

  // Order matters: chat's session-event handler (subscribeSessionStream) MUST
  // attach BEFORE initSessions → connectForgeaXWs, or the first WS frames have
  // no listener.
  installHealthBridge();
  bootBroadcast();          // 唯一公共广播 socket + telemetry/workspace-changed 接线
  subscribeDaemonTick();    // daemon-tick-* 帧接到该广播流（chat 域）
  subscribeNarrativeCopilot();
  subscribeFileActivityStream();
  subscribePermissionStream();
  subscribePerceptionStream();
  subscribeSessionStream();
  void useShellStore.getState().initSessions();

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>)['__dev'] = useShellStore;
  }
  (window as unknown as { __forgeaxBoot?: { done?: () => void } }).__forgeaxBoot?.done?.();

  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary scope="chat-standalone">
        <BrandProvider>
          <style>{SHELL_CSS}</style>
          <div className="forgeax-standalone-shell studio-shell studio-shell--preview-skin">
            <ChatPanel />
          </div>
        </BrandProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

boot();
