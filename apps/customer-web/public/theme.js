/**
 * The light/dark toggle, shared by every merchant surface.
 *
 * Lifted out of app.js because the dashboard, Business Setup and the admin
 * console all need it and three copies of a preference store is how two of them
 * end up disagreeing about which key holds the choice.
 *
 * This only wires the *button*. Applying the theme has to happen before first
 * paint or a shop that chose dark sees a white flash on the way in, and a
 * deferred script lands far too late for that — so each page keeps a tiny
 * inline script in its <head> that sets data-theme, and this takes over
 * afterwards.
 *
 * Customer-facing pages deliberately do not load either. The landing page and
 * the print flow are designed light, a customer scanning a QR poster has
 * expressed no preference to this product, and the shop owner's choice of
 * theme is not something their customers should inherit.
 */
(function (global) {
  'use strict';

  const ThemeToggle = {
    KEY: 'printok.theme',

    stored() {
      try { return localStorage.getItem(this.KEY); } catch { return null; }
    },

    /** What is actually on screen, whether chosen here or inherited from the OS. */
    current() {
      const chosen = document.documentElement.getAttribute('data-theme');
      if (chosen === 'dark' || chosen === 'light') return chosen;
      return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    },

    apply(theme, { persist = true } = {}) {
      document.documentElement.setAttribute('data-theme', theme);
      if (persist) {
        try { localStorage.setItem(this.KEY, theme); } catch { /* private browsing */ }
      }
      this.render(theme);
    },

    render(theme) {
      const btn = document.getElementById('btnThemeToggle');
      const icon = document.getElementById('themeToggleIcon');
      const label = document.getElementById('themeToggleLabel');
      const dark = theme === 'dark';

      // The button offers the theme you would switch *to*.
      if (icon) icon.textContent = dark ? '☀️' : '🌙';
      if (label) label.textContent = dark ? 'Light' : 'Dark';
      if (btn) {
        btn.setAttribute('aria-pressed', String(dark));
        btn.setAttribute('title', dark ? 'Switch to light' : 'Switch to dark');
      }

      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#121210' : '#0d0d0d');
    },

    init() {
      this.render(this.current());

      const btn = document.getElementById('btnThemeToggle');
      if (btn) {
        btn.addEventListener('click', () => {
          this.apply(this.current() === 'dark' ? 'light' : 'dark');
        });
      }

      // Follow the OS while the shop has expressed no preference of its own.
      // Not persisted: that would turn an OS change into a standing choice and
      // stop the page following the OS from then on.
      if (global.matchMedia) {
        const os = global.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e) => {
          if (!this.stored()) this.apply(e.matches ? 'dark' : 'light', { persist: false });
        };
        if (os.addEventListener) os.addEventListener('change', onChange);
        else if (os.addListener) os.addListener(onChange);
      }
    },
  };

  global.PrintOkTheme = ThemeToggle;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ThemeToggle.init());
  } else {
    ThemeToggle.init();
  }
})(window);
