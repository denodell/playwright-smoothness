// React: one root listener per event type (delegation), dispatching to the app's handlers.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { busyWait } from './work.js';

function App() {
  const [count, setCount] = useState(0);
  const [query, setQuery] = useState('');
  function onCheckout() {
    busyWait(150);
    setCount((c) => c + 1);
  }
  function onSearchKey() {
    busyWait(60);
  }
  return (
    <main>
      <button id="checkout" onClick={onCheckout}>
        <span className="label">Checkout</span>
      </button>
      <input
        id="search"
        aria-label="Search"
        value={query}
        onKeyDown={onSearchKey}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p id="count">{count}</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
