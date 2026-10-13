/**
 * The `sync` of a `StateStore` whose file goes with the test. The disk serves one flush at a
 * time for the whole machine, so the test processes queued on it: the suite took 64 s with the
 * real flush and 16 s without (2026-10-14, macOS, ten cores, Node 26.5.1). The tests of the
 * store itself (`test/core/state.test.ts`) keep the real one.
 */
export const NO_SYNC = (): void => undefined;
