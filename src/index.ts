// @forgeax/chat — public entry for the chat L2 app.
//
// The chat surface is the Forge conversation UI (message stream, composer,
// agent capsule, rewind controls). Its STATE — sessions / messages / agents /
// composer-insert — lives in @forgeax/interface's L1 session store and the
// composer-bridge; this package owns only the presentation over that state.
//
// studio (L3) composes chat into the shell by injecting `renderChat` through
// the interface `PanelRenderers` seam (see packages/studio/src/panels/
// editorRenderers.tsx). interface (L1) never imports this package — that
// reverse edge is forbidden by the `interface-no-l2-apps` dependency-cruiser
// rule and the lint:agnostic gate.
export { ChatPanel } from './components/ChatPanel/ChatPanel';
