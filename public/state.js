// =====================================================================
// InstaGen — Global niche store (vanilla, framework-agnostic)
// =====================================================================
// Why a hand-rolled store? This project is plain ES modules served
// as static assets — no React, no Redux, no Pinia. The "global state" the spec
// asks for is just one key (`active_niche`) shared between two pages
// (the hub at /, the generator at /generator). The contract below is
// deliberately shaped like a small store API (get / set / subscribe)
// so swapping in React Context, Zustand, or Pinia later is a one-file
// change rather than a refactor of the call sites.
//
// Persistence: localStorage under the key `instagen:active_niche`.
// Cross-tab sync: the browser fires a `storage` event in OTHER tabs
// when localStorage changes, so opening /generator in a second tab
// after picking a niche on / picks up the new value automatically.
// =====================================================================

const STORAGE_KEY = 'instagen:active_niche';

/**
 * Canonical niche registry. This is the single source of truth — both
 * the hub (to render the cards) and the generator (to label the badge
 * and pass the niche to the API) import from here. Adding a niche?
 * Add a row here and you're done.
 *
 *   id        — stable string, sent to the API as `niche`
 *   label     — exact title shown on the hub card
 *   tag       — short eyebrow text on the card
 *   gradient  — CSS background for the card's gradient overlay
 *   icon      — inline SVG path data (24x24 viewBox) for the card icon
 */
export const NICHES = [
  {
    id: 'true-crime',
    label: 'On This Day in True Crime',
    tag: 'Forensic · Real cases',
    gradient: 'linear-gradient(135deg, #6b0f1a 0%, #2a0608 100%)',
    icon: 'M12 2a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4Zm-7 9a7 7 0 0 0 14 0M12 19v3',
  },
  {
    id: 'conspiracy',
    label: 'On This Day in Conspiracy Theories',
    tag: 'Hidden patterns',
    gradient: 'linear-gradient(135deg, #0d4f3c 0%, #03150f 100%)',
    icon: 'M12 5c-7 0-10 7-10 12 0 0 3 5 10 5s10-5 10-5c0-5-3-12-10-12Zm0 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
  },
  {
    id: 'history',
    label: 'On This Day in History',
    tag: 'The original engine',
    gradient: 'linear-gradient(135deg, #8a6a1a 0%, #2b1f08 100%)',
    icon: 'M4 4h16v4H4zM4 12h16v4H4zM4 20h16',
  },
  {
    id: 'womens-history',
    label: "On This Day in Women's History",
    tag: 'Pioneers · Voices',
    gradient: 'linear-gradient(135deg, #8a3a8f 0%, #2a0f2c 100%)',
    icon: 'M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm-4 9h8l-1 8h-6Z',
  },
  {
    id: 'vintage-tech',
    label: 'On This Day in Vintage Tech',
    tag: 'Bits · Boards',
    gradient: 'linear-gradient(135deg, #1a6e7a 0%, #06212a 100%)',
    icon: 'M9 2h6v2h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2v2H9v-2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2Zm0 6v2h6V8Z',
  },
  {
    id: 'ancient-civ',
    label: 'On This Day in Ancient Civilizations',
    tag: 'Empires · Ruins',
    gradient: 'linear-gradient(135deg, #b06a1f 0%, #2b1505 100%)',
    icon: 'M3 10 12 3l9 7v2H3zM5 13h2v7H5zM10 13h2v7h-2zM15 13h2v7h-2z',
  },
  {
    id: 'philosophy',
    label: 'On This Day in Philosophy',
    tag: 'Ideas · Thinkers',
    gradient: 'linear-gradient(135deg, #4a3a8a 0%, #110a26 100%)',
    icon: 'M12 2a7 7 0 0 0-4 12.7V18a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-3.3A7 7 0 0 0 12 2Zm-2 20h4',
  },
];

/** Look up a niche record by id. Falls back to the original 'history' engine. */
export function getNiche(id) {
  return NICHES.find((n) => n.id === id) || NICHES.find((n) => n.id === 'history');
}

// ---------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------

/** Returns the currently active niche id, or null if nothing's picked. */
export function getActiveNiche() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Persists the niche id. Pass null to clear. */
export function setActiveNiche(id) {
  try {
    if (id == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode, quota, etc — non-fatal, the in-memory listeners still fire */
  }
  // Notify in-page subscribers. The browser's `storage` event only
  // fires across tabs, so we fire our own micro-event for the same-tab case.
  notify(id);
}

// In-page subscribers (same-tab). We use a simple EventTarget rather
// than pulling in a library — `addEventListener('change', ...)` is
// idiomatic and zero-dependency.
const bus = new EventTarget();

function notify(id) {
  bus.dispatchEvent(new CustomEvent('change', { detail: { id } }));
}

/**
 * Subscribe to niche changes. The callback fires immediately with the
 * current value (so the badge can render on first paint without a
 * separate read), and again on every change — both in-tab and across
 * tabs (the latter via the browser's native `storage` event).
 *
 * Returns an unsubscribe function.
 */
export function subscribeActiveNiche(callback) {
  // Initial fire with the current value.
  queueMicrotask(() => callback(getActiveNiche()));

  const onInTab = (e) => callback(e.detail?.id ?? null);
  const onCrossTab = (e) => {
    if (e.key !== STORAGE_KEY) return;
    callback(e.newValue || null);
  };

  bus.addEventListener('change', onInTab);
  window.addEventListener('storage', onCrossTab);

  return () => {
    bus.removeEventListener('change', onInTab);
    window.removeEventListener('storage', onCrossTab);
  };
}
