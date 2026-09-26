// A worker that is always busy, next to a slow click handler on the main thread. The CPU
// profile must attribute the click's frames to the main thread only.
// ?ms= wall-clock work per click (default 150).
const worker = new Worker('/worker-busy.js');
worker.postMessage('start');
document.getElementById('heavy').addEventListener('click', function onHeavyClick() {
  busyWait(param('ms', 150));
});
