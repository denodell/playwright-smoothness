// ?ms= wall-clock work in the requestAnimationFrame callback (default 200).
const rafMs = param('ms', 200);

window.runHeavyFrame = function runHeavyFrame() {
  requestAnimationFrame(function heavyFrame() {
    busyWait(rafMs);
  });
};
