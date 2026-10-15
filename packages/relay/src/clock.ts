/**
 * The relay's only source of time, so tests can move it forward. Production
 * code reads `now()`; only tests call `setClockOffsetForTests`.
 */
let offsetMs = 0;

export function now(): number {
  return Date.now() + offsetMs;
}

export function setClockOffsetForTests(ms: number): void {
  offsetMs = ms;
}
