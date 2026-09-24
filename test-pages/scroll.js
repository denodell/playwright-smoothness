// ?wait= wall-clock ms per scroll event; ?work= iterations per scroll event.
const scrollWait = param('wait', 0);
const scrollWork = param('work', 0);

const list = document.getElementById('list');
for (let i = 0; i < 600; i++) {
  const li = document.createElement('li');
  li.textContent = 'Article ' + i;
  list.appendChild(li);
}

window.addEventListener('scroll', function onWindowScroll() {
  if (scrollWait) busyWait(scrollWait);
  if (scrollWork) doWork(scrollWork);
});

document.getElementById('heavy').addEventListener('click', function onHeavyClick() {
  busyWait(param('clickms', 150));
});
