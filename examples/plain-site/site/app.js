// ?slow=N makes opening the filters panel block the main thread for N ms: the example's
// stand-in for a regression.
const slow = Number(new URLSearchParams(location.search).get('slow') || 0);

const list = document.getElementById('articles');
for (let i = 0; i < 1500; i++) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="thumb" style="background:hsl(${(i * 47) % 360} 60% 55%)"></span>Article ${i + 1}`;
  list.appendChild(li);
}

document.getElementById('filters').addEventListener('click', function toggleFilters(event) {
  const panel = document.getElementById('panel');
  const start = performance.now();
  while (performance.now() - start < slow) {
    // simulated expensive work
  }
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});
