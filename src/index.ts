// @forgeax/chat — public entry for the independent chat app.
//
// The chat surface is the Forge conversation UI (message stream, composer,
// agent capsule, rewind controls). Chat owns its conversation/event store and
// pure message helpers. The embedding product supplies shell/session registry,
// host UI services, and cross-surface bridges through the runtime contract.
//
// IDE composes Chat as a panel contribution and configures the runtime before
// session subscriptions start. The reusable shell never imports this package.
export { ChatPanel } from "./components/ChatPanel/ChatPanel";
