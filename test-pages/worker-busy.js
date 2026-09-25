// Busy in bursts, forever.
function workerSpin() {
  const end = performance.now() + 40;
  while (performance.now() < end) {
    // spin
  }
  setTimeout(workerSpin, 5);
}
self.onmessage = function workerStart() {
  workerSpin();
};
