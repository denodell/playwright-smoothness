const rafMs = param('ms', 200);

window.runHeavyFrame = function runHeavyFrame() {
  requestAnimationFrame(function heavyFrame() {
    busyWait(rafMs);
  });
};
