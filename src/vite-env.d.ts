/// <reference types="vite/client" />

// Asset module shims — chat imports image/style assets from @forgeax/interface
// (e.g. agent-icon.png) which tsconfig `paths` resolves to the real file in
// interface/src/assets. Declaring the wildcards here makes chat's STANDALONE
// `tsc` self-sufficient (it does not depend on vite/client being resolvable
// in this package's program). studio's build types these via vite/client.
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
declare module '*.css';
