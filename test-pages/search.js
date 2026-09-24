// ?ms= wall-clock work per keydown (default 60).
const keyMs = param('ms', 60);
const results = document.getElementById('results');

document.getElementById('search').addEventListener('keydown', function onSearchKeydown() {
  busyWait(keyMs);
});

document.getElementById('search').addEventListener('input', function onSearchInput(event) {
  results.textContent = '';
  const li = document.createElement('li');
  li.textContent = 'Results for ' + event.target.value;
  results.appendChild(li);
});
