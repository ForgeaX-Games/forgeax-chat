/** Phase one stays visible for text-only turns. Presenting a real artifact is
 * the phase boundary that folds the whole execution trace. */
export function defaultProcessOpen(
  live: boolean,
  hasArtifact: boolean,
  failed = false,
): boolean {
  // Failure details remain available on demand, but a terminal error/abort is
  // denser and more useful as a collapsed summary. Live work is the only state
  // that always opens automatically.
  return live || (!failed && !hasArtifact);
}
