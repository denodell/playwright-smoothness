// A virtualized list: only rows near the viewport exist in the DOM.
const ROWS = 5000, ROW_H = 80;
const params = new URLSearchParams(location.search);
const costPerRow = Number(params.get('cost') || 0);   // ms of work to build each row
const overscan = Number(params.get('overscan') || 2);  // extra rows rendered beyond the viewport
const list = document.getElementById('list'), spacer = document.getElementById('spacer');
spacer.style.height = ROWS * ROW_H + 'px';
const rendered = new Map();
function busyWait(ms) { const end = performance.now() + ms; while (performance.now() < end) {} }
function buildRow(i) {
  if (costPerRow) busyWait(costPerRow);
  const row = document.createElement('div');
  row.className = 'row'; row.style.top = i * ROW_H + 'px';
  row.innerHTML = `<div class="poster" style="background:hsl(${(i * 37) % 360} 70% 45%)"></div><div>Title ${i}</div>`;
  return row;
}
function render() {
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - overscan);
  const last = Math.min(ROWS - 1, Math.ceil((list.scrollTop + list.clientHeight) / ROW_H) + overscan);
  for (const [i, el] of rendered) if (i < first || i > last) { el.remove(); rendered.delete(i); }
  for (let i = first; i <= last; i++) if (!rendered.has(i)) { const r = buildRow(i); spacer.appendChild(r); rendered.set(i, r); }
}
list.addEventListener('scroll', function renderVisibleRows() { render(); }, { passive: true });
render();
