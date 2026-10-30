// Sets the theme class before first paint so the page never flashes the wrong colours.
(function () {
  try {
    var m = localStorage.getItem('sales_tracker_theme');
    var dark = m === 'dark' || (m !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {}
})();

// The density (uplift 5.3) the same way: comfortable unless 'compact' is stored. index.css applies compact at md and up only.
// A storage event from another tab re-applies it here, so every open tab follows the Settings toggle, not only the one with Settings open.
(function () {
  function apply() {
    var compact = false;
    try { compact = localStorage.getItem('sales_tracker_density') === 'compact'; } catch (e) {}
    document.documentElement.setAttribute('data-density', compact ? 'compact' : 'comfortable');
  }
  apply();
  try {
    window.addEventListener('storage', function (e) { if (e.key === null || e.key === 'sales_tracker_density') apply(); });
  } catch (e) {}
})();
