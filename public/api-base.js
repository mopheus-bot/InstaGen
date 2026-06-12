// =====================================================================
// InstaGen — Frontend API base resolver
// =====================================================================
// Resolves the base URL the browser should prepend to /api/* fetch()
// calls. Default is "" (same-origin), which is the co-located deploy
// where Express serves both the static frontend and the JSON API.
//
// For a split architecture (frontend hosted on a different domain
// from the backend, e.g. a static page on Cloudflare Pages talking
// to an API on Railway), the operator can set the override in EITHER
// of two places, in this precedence order:
//
//   1. window.INSTAGEN_API_BASE   set by an inline <script> before
//                                 this module loads (highest
//                                 precedence — useful for env-
//                                 specific builds)
//   2. <meta name="instagen-api-base"
//              content="https://api.instagen.app">
//                                 a static override in the page
//                                 head (good for a one-off
//                                 staging deploy)
//
// The value MUST be either empty (same-origin) or an absolute URL
// ending in "/". A trailing slash is added automatically if missing
// so the caller can always do `apiBase('/foo')` and get a clean URL.
// =====================================================================

function normalize(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  // Absolute URL: require scheme + host. Anything else is rejected
  // so a typo (e.g. "instagen.app" with no scheme) doesn't silently
  // resolve to a relative path.
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    let base = u.origin;
    // Preserve any path prefix (e.g. "https://host/api") so the
    // caller can keep using "/foo" style relative paths.
    if (u.pathname && u.pathname !== '/') {
      base += u.pathname.replace(/\/+$/, '');
    }
    return base + '/';
  } catch {
    return '';
  }
}

function readMeta() {
  const el = document.querySelector('meta[name="instagen-api-base"]');
  return el ? el.getAttribute('content') : null;
}

const API_BASE = normalize(
  // Highest precedence first: an explicit window global wins over
  // a <meta> tag, so a deploy script can override without editing
  // the HTML.
  (typeof window !== 'undefined' && window.INSTAGEN_API_BASE) ||
  readMeta() ||
  ''
);

/**
 * Build a full URL for an API path. Empty base = same-origin, so
 * the returned string is the path itself ("/api/foo") and fetch()
 * resolves it against the current origin.
 *
 * @param {string} path  e.g. "/api/generate-content"
 * @returns {string}     absolute URL or original path
 */
export function apiUrl(path) {
  if (typeof path !== 'string') path = String(path || '');
  if (API_BASE.length === 0) {
    // Ensure leading slash for same-origin paths.
    return path.startsWith('/') ? path : `/${path}`;
  }
  // Strip a leading slash from `path` so we don't end up with
  // "https://host//api/foo".
  return API_BASE + path.replace(/^\/+/, '');
}

/** Exposed for debugging — most callers should use apiUrl(). */
export const apiBase = API_BASE;
