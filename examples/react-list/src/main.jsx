import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

// ?slowRows=1 makes each row expensive to render: the example's stand-in for a regression.
const slowRows = new URLSearchParams(location.search).has('slowRows');
const ROW = 72;
const COUNT = 10_000;
const HEIGHT = 480;

function expensiveFormat(i) {
  const end = performance.now() + (slowRows ? 12 : 0);
  while (performance.now() < end) {
    // simulated expensive formatting
  }
  return `Product ${i + 1}`;
}

function Row({ index }) {
  return (
    <li className="row" style={{ top: index * ROW }}>
      <span className="thumb" style={{ background: `hsl(${(index * 47) % 360} 60% 55%)` }} />
      {expensiveFormat(index)}
    </li>
  );
}

// A windowed list: only rows in view (plus two) are rendered.
function Catalogue() {
  const [top, setTop] = useState(0);
  const first = Math.max(0, Math.floor(top / ROW) - 2);
  const last = Math.min(COUNT - 1, Math.ceil((top + HEIGHT) / ROW) + 2);
  const rows = [];
  for (let i = first; i <= last; i++) rows.push(<Row key={i} index={i} />);
  return (
    <ul
      className="catalogue"
      role="list"
      aria-label="Catalogue"
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: COUNT * ROW, position: 'relative' }}>{rows}</div>
    </ul>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready ? <Catalogue /> : null;
}

createRoot(document.getElementById('root')).render(<App />);
