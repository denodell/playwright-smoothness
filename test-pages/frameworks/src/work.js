// Wall-clock busy wait, so the framework pages block for an exact duration.
export function busyWait(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}
