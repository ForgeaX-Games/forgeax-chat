/// <reference types="vite/client" />

// Asset module shims keep Chat's standalone TypeScript program self-sufficient;
// the IDE product can inject its own branded assets through the runtime contract.
declare module "*.png" {
	const src: string;
	export default src;
}
declare module "*.jpg" {
	const src: string;
	export default src;
}
declare module "*.svg" {
	const src: string;
	export default src;
}
declare module "*.css";
