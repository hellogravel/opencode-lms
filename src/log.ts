// Info-level logging, gated behind the OPENCODE_LMS_LOG env var. Default is
// SILENT: opencode does not isolate plugin stdout from its TUI, so a bare
// console.log here scrolls/corrupts a running board. Set OPENCODE_LMS_LOG=1 to
// surface these (e.g. in the Docker serve container, where diagnostics reads
// container logs). Warnings/errors deliberately stay on console.warn/error —
// they're rare and worth seeing even in a TUI.
export const log = (...args: unknown[]): void => {
  if (process.env.OPENCODE_LMS_LOG) console.log(...args);
};
