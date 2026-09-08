// @forgeax/chat — public entry for the independent chat app.
//
// The chat surface is the Forge conversation UI (message stream, composer,
// agent capsule, rewind controls). Its STATE — sessions / messages / agents /
// composer-insert — lives in @forgeax/interface's shared session store and the
// composer-bridge; this package owns only the presentation over that state.
//
// The IDE product assembly composes chat into the shell by injecting `renderChat` through
// the interface `PanelRenderers` seam (see packages/studio/src/panels/
// editorRenderers.tsx). The shared interface base never imports this package;
// the lint:agnostic gate forbids that reverse dependency.
export { ChatPanel } from './components/ChatPanel/ChatPanel';
