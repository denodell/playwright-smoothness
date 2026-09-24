// requestAnimationFrame sampler, used ONLY by the detection suite to show why rAF
// sampling is the wrong metric (section 3 of the brief). The library never uses it.
//
// mode 'timestamp' records the rAF callback's timestamp argument.
// mode 'now' records performance.now() inside the callback.
window.startFrameSampler = function startFrameSampler(mode) {
  const times = [];
  window.__frameSampler = { times, id: 0 };
  const tick = function frameSamplerTick(t) {
    times.push(mode === 'now' ? performance.now() : t);
    window.__frameSampler.id = requestAnimationFrame(tick);
  };
  window.__frameSampler.id = requestAnimationFrame(tick);
};

window.stopFrameSampler = function stopFrameSampler() {
  cancelAnimationFrame(window.__frameSampler.id);
  const t = window.__frameSampler.times;
  const gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  return gaps;
};
