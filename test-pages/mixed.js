const feed = document.getElementById('feed');
for (let i = 0; i < 200; i++) {
  const d = document.createElement('div');
  d.textContent = 'Item ' + i;
  feed.appendChild(d);
}

document.getElementById('buy').addEventListener('click', function onBuy() {
  busyWait(80);
});
document.getElementById('search').addEventListener('keydown', function onSearchKey() {
  busyWait(60);
});
document.getElementById('vanish').addEventListener('click', function onVanish(event) {
  busyWait(70);
  event.currentTarget.remove();
});
feed.addEventListener('scroll', function onFeedScroll() {
  busyWait(70);
});

// ?bgevery=N repeats background work every N ms forever, for testing the settle timeout.
const bgEvery = param('bgevery', 0);
if (bgEvery) {
  setInterval(function repeatingBackgroundJob() {
    busyWait(70);
  }, bgEvery);
}

// Background work unrelated to any interaction, 300ms after load.
addEventListener('load', () =>
  setTimeout(
    function backgroundJob() {
      busyWait(90);
    },
    param('bgdelay', 300),
  ),
);
