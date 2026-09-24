// Two ways to keep the main thread busy.
//
// busyWait(ms) spins on the wall clock. The duration is exact, but CPU throttling
// does not slow it down, so it can't be used to test throttling.
//
// doWork(iterations) does a fixed amount of arithmetic. CPU throttling slows it down,
// so use it wherever a test depends on Emulation.setCPUThrottlingRate.
function busyWait(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

function doWork(iterations) {
  let x = 0;
  for (let i = 0; i < iterations; i++) x += Math.sqrt(i) * Math.sin(i);
  return x;
}

// Reads a numeric query parameter, falling back to a default.
function param(name, fallback) {
  const value = new URLSearchParams(location.search).get(name);
  return value === null ? fallback : Number(value);
}

window.busyWait = busyWait;
window.doWork = doWork;
window.param = param;
