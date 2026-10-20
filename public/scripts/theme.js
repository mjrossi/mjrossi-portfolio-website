// The theme switch. Loaded synchronously from <head> so `data-theme` is set
// before first paint, with no flash. No script, no storage or an unknown value
// all mean Auto (the stylesheet's prefers-color-scheme decides). Attributes and
// properties only, under Trusted Types.

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
  // The CSS reveal hook: `:root[data-js] .theme-toggle[hidden]` shows the
  // switch from the first paint, so revealing it never shifts the layout.
  root.setAttribute('data-js', '');

  const sync = (choice) => {
    for (const b of document.querySelectorAll('[data-theme-choice]')) {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
    }
  };

  // Another tab changed it, or the page came back from the bfcache.
  const refresh = () => {
    const choice = read();
    apply(choice);
    sync(choice);
  };
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) refresh();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) refresh();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const choice = read();
    // Turnstile renders after this; `auto` is wrong only if the reader overrode it.
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
        // Storage refused: the choice applies to this page only.
      }
      apply(next);
      sync(next);
    });
  });
})();
