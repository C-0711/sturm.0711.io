/* STURM theme toggle — light/dark per Neo design system.
 *
 * Resolution order on boot:
 *   1. localStorage('sturm-theme')  → 'light' | 'dark'
 *   2. matchMedia('(prefers-color-scheme: dark)') if no stored pref
 *   3. fallback 'light'
 *
 * To wire a button: add `data-theme-toggle` to any element. Click flips.
 * Optional: an inner `<span data-theme-label>` gets text "Light"/"Dark".
 */

(function () {
  const KEY = 'sturm-theme';
  const root = document.documentElement;

  function current() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function apply(mode) {
    if (mode === 'dark') {
      root.setAttribute('data-theme', 'dark');
      root.classList.add('dark');
    } else {
      root.setAttribute('data-theme', 'light');
      root.classList.remove('dark');
    }
    document.querySelectorAll('[data-theme-label]').forEach((el) => {
      el.textContent = mode === 'dark' ? 'Dark' : 'Light';
    });
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      // Replace the icon glyph if Lucide isn't loaded yet — text fallback.
      el.textContent = mode === 'dark' ? '☀' : '☾';
    });
  }

  function detect() {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    } catch { /* private mode */ }
    // Default to dark/night. Light is opt-in via the ☾ toggle.
    return 'dark';
  }

  function toggle() {
    const next = current() === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  }

  // Init synchronously so we don't flash the wrong palette.
  apply(detect());

  // Wire up any [data-theme-toggle] elements after DOM is ready.
  function wire() {
    document.querySelectorAll('[data-theme-toggle]').forEach((el) => {
      if (el.__sturmThemeWired) return;
      el.__sturmThemeWired = true;
      el.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // Expose for ad-hoc calls / debugging.
  window.sturmTheme = { current, apply, toggle };
})();
