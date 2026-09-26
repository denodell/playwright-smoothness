// A virtualized list: only rows near the viewport exist in the DOM.
//   ?cost=      wall-clock ms of work to build each row (default 0)
//   ?overscan=  extra rows rendered beyond the viewport (default 2)
//   ?rows=      number of rows (default 5000)
//   ?axis=      'y' (default) or 'x' for a horizontal list
//   ?skeleton=  if set, each new row shows a grey skeleton first and its content this many ms later
//   ?bg=        list background color (default white)
const ROW = 80;
const rows = param('rows', 5000);
const costPerRow = param('cost', 0);
const query = new URLSearchParams(location.search);
const overscan = param('overscan', 2);
const horizontal = query.get('axis') === 'x';
const skeletonMs = query.has('skeleton') ? param('skeleton', 0) : -1;

const list = document.getElementById('list');
const spacer = document.getElementById('spacer');
if (query.get('bg')) list.style.background = query.get('bg');
if (horizontal) {
  list.classList.add('horizontal');
  spacer.style.width = rows * ROW + 'px';
  spacer.style.height = '100%';
} else {
  spacer.style.height = rows * ROW + 'px';
}
const rendered = new Map();

function fillRow(row, i) {
  row.classList.remove('skeleton');
  row.innerHTML = `<div class="poster" style="background:hsl(${(i * 37) % 360} 70% 45%)"></div><div>Title ${i}</div>`;
}

function buildRow(i) {
  if (costPerRow) busyWait(costPerRow);
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'listitem');
  if (horizontal) row.style.left = i * ROW + 'px';
  else row.style.top = i * ROW + 'px';
  if (skeletonMs >= 0) {
    row.classList.add('skeleton');
    setTimeout(function fillSkeletonRow() {
      if (row.isConnected) fillRow(row, i);
    }, skeletonMs);
  } else {
    fillRow(row, i);
  }
  return row;
}

function renderVisibleRows() {
  const offset = horizontal ? list.scrollLeft : list.scrollTop;
  const size = horizontal ? list.clientWidth : list.clientHeight;
  const first = Math.max(0, Math.floor(offset / ROW) - overscan);
  const last = Math.min(rows - 1, Math.ceil((offset + size) / ROW) + overscan);
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
