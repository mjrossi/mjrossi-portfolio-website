// The theme carve-out — the third and smallest piece of client JS on the site.
//
// Loaded synchronously from <head> in Base.astro, so `data-theme` is on <html>
// before the first paint and a reader who chose Dark never sees a cream flash.
// Everything here degrades to nothing: no script, no storage, or an unknown
// stored value all leave <html> without `data-theme`, which is Auto — the
// stylesheet's prefers-color-scheme block decides.
//
// Trusted Types are required site-wide (`require-trusted-types-for 'script'`),
// so this touches no HTML sinks: attributes and properties only.
(() => {
  const KEY = 'theme';
  const root = document.documentElement;

  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch {
      return 'auto';
    }
  };

  const apply = (choice) => {
    if (choice === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  };

  apply(read());

  const sync = (choice) => {
    for (const b of document.querySelectorAll('[data-theme-choice]')) {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    const choice = read();
    // Turnstile renders implicitly from its data attributes, after this runs.
    // `auto` follows the OS, which is wrong only when the reader overrode it.
    if (choice !== 'auto') {
      for (const el of document.querySelectorAll('.cf-turnstile[data-theme="auto"]')) {
        el.setAttribute('data-theme', choice);
      }
    }
    sync(choice);
    for (const group of document.querySelectorAll('.theme-toggle')) group.hidden = false;

    document.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-theme-choice]') : null;
      if (!b) return;
      const next = b.dataset.themeChoice;
      try {
        if (next === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch {
        // Storage refused (private mode, blocked site data): the choice still
        // applies to this page, it just won't follow the reader to the next.
      }
      apply(next);
      sync(next);
    });
  });
})();
