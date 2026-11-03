/**
 * ThemeManager — Light / Dark dual-theme controller.
 * Persists to localStorage['tgbot_ui_theme'] and sets data-theme on <html>.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'tgbot_ui_theme';
  const VALID = ['dark', 'light', 'system'];

  function resolve(theme) {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return theme === 'light' ? 'light' : 'dark';
  }

  function getStored() {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(v) ? v : 'dark';
  }

  function apply(theme) {
    const resolved = resolve(theme);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = theme;
  }

  function init() {
    apply(getStored());

    // React to system preference changes when in "system" mode
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (getStored() === 'system') apply('system');
    });
  }

  function set(theme) {
    if (!VALID.includes(theme)) theme = 'dark';
    localStorage.setItem(STORAGE_KEY, theme);
    apply(theme);
  }

  function toggle() {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    set(current === 'dark' ? 'light' : 'dark');
  }

  // Expose globally for app.js and settings.js
  window.ThemeManager = { init, set, toggle, getStored, resolve };
})();
