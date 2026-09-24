// Heavy work while the page loads (a classic script, no user interaction involved).
(function () { const end = performance.now() + 120; while (performance.now() < end) {} })();
