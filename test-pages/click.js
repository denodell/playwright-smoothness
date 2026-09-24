// ?ms= wall-clock work per click (default 150). ?iter= adds iteration-based work that
// CPU throttling slows down.
const clickMs = param('ms', 150);
const clickIter = param('iter', 0);
const status = document.getElementById('status');

document.getElementById('heavy').addEventListener('click', function onHeavyClick() {
  busyWait(clickMs);
  if (clickIter) doWork(clickIter);
  status.textContent = 'heavy clicked';
});

// The click lands on the nested span; reporting should name the button.
document.getElementById('nested').addEventListener('click', function onNestedClick() {
  busyWait(clickMs);
  if (clickIter) doWork(clickIter);
  status.textContent = 'nested clicked';
});

// Removes itself, so Event Timing's target is null by the time it's read.
document.getElementById('vanish').addEventListener('click', function onVanishClick(event) {
  busyWait(clickMs);
  if (clickIter) doWork(clickIter);
  event.currentTarget.remove();
  status.textContent = 'dismissed';
});
