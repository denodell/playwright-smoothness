function busyWait(ms) { const end = performance.now() + ms; while (performance.now() < end) {} }
const feed = document.getElementById('feed');
for (let i = 0; i < 200; i++) { const d = document.createElement('div'); d.textContent = 'Item ' + i; feed.appendChild(d); }
document.getElementById('buy').addEventListener('click', function onBuy() { busyWait(80); });
document.getElementById('search').addEventListener('keydown', function onSearchKey() { busyWait(60); });
document.getElementById('vanish').addEventListener('click', function onVanish(e) { busyWait(70); e.currentTarget.remove(); });
feed.addEventListener('scroll', function onFeedScroll() { busyWait(70); });
// Background work unrelated to any interaction.
addEventListener('load', () => setTimeout(function backgroundJob() { busyWait(90); }, 300));
