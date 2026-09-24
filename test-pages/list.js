// A virtualized list: only rows near the viewport exist in the DOM.
//   ?cost=      work to build each row (default 0)
//   ?costmode=  'wall' (cost is ms, default) or 'iter' (cost is thousands of iterations)
//   ?overscan=  extra rows rendered beyond the viewport (default 2)
const ROWS = 5000;
const ROW_H = 80;
const costPerRow = param('cost', 0);
const costMode = new URLSearchParams(location.search).get('costmode') || 'wall';
const overscan = param('overscan', 2);

const list = document.getElementById('list');
const spacer = document.getElementById('spacer');
spacer.style.height = ROWS * ROW_H + 'px';
const rendered = new Map();

function buildRow(i) {
  if (costPerRow) {
    if (costMode === 'iter') doWork(costPerRow * 1000);
    else busyWait(costPerRow);
  }
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'listitem');
  row.style.top = i * ROW_H + 'px';
  row.innerHTML = `<div class="poster" style="background:hsl(${(i * 37) % 360} 70% 45%)"></div><div>Title ${i}</div>`;
  return row;
}

function renderVisibleRows() {
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - overscan);
  const last = Math.min(ROWS - 1, Math.ceil((list.scrollTop + list.clientHeight) / ROW_H) + overscan);
  for (const [i, el] of rendered) {
    if (i < first || i > last) {
      el.remove();
      rendered.delete(i);
    }
  }
  for (let i = first; i <= last; i++) {
    if (!rendered.has(i)) {
      const row = buildRow(i);
      spacer.appendChild(row);
      rendered.set(i, row);
    }
  }
}

list.addEventListener(
  'scroll',
  function onListScroll() {
    renderVisibleRows();
  },
  { passive: true },
);
renderVisibleRows();
