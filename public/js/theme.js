// Runs before first paint (blocking, tiny) so a saved theme choice never flashes the wrong colours.
(function () {
  try {
    var t = localStorage.getItem('tra5x-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage unavailable: fall back to the OS setting */
  }
})();
