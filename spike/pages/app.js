// Work measured in loop iterations, not wall-clock time, so CPU throttling slows it down.
function doWork(iterations) {
  let x = 0;
  for (let i = 0; i < iterations; i++) x += Math.sqrt(i) * Math.sin(i);
  return x;
}
// Wall-clock busy wait, for the controlled checks where the duration must be exact.
function busyWait(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
}
window.busyWaitInRaf = (ms) => requestAnimationFrame(function heavyFrame() { busyWait(ms); });

const params = new URLSearchParams(location.search);
const scrollWork = Number(params.get('work') || 0);
const scrollWait = Number(params.get('wait') || 0);
const clickWait = Number(params.get('clickwait') || 0);

const list = document.getElementById('list');
for (let i = 0; i < 600; i++) {
  const li = document.createElement('li');
  li.textContent = 'Article ' + i;
  list.appendChild(li);
}
document.getElementById('heavy').addEventListener('click', function onHeavyClick() { busyWait(clickWait || 150); });
window.addEventListener('scroll', function onScroll() { if (scrollWork) doWork(scrollWork); if (scrollWait) busyWait(scrollWait); });

// Layout-heavy frame: change every row's height and force layout after each change.
window.layoutThrashInRaf = () => requestAnimationFrame(function layoutFrame() {
  const rows = document.querySelectorAll('li');
  rows.forEach((li, i) => { li.style.height = (38 + (i % 5)) + 'px'; void li.offsetHeight; });
});

// Record the time of every animation frame, to see frames LoAF's 50ms threshold misses.
window.startFrameSampler = () => {
  window.__rafTimes = [];
  const tick = (t) => { window.__rafTimes.push(window.__useNow ? performance.now() : t); window.__rafId = requestAnimationFrame(tick); };
  window.__rafId = requestAnimationFrame(tick);
};
window.stopFrameSampler = () => {
  cancelAnimationFrame(window.__rafId);
  const t = window.__rafTimes, gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  return gaps;
};
