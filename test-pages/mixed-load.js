// Blocks the main thread while the page loads: a classic script, no interaction.
(function loadTimeWork() {
  busyWait(param('loadms', 120));
})();
