// =====================================================================
// InstaGen — Frontend controller (vanilla ES module)
// =====================================================================
// Responsibilities:
//   1. Render the "today" date in the header
//   2. Check localStorage for a cached carousel for today's calendar day
//      and short-circuit the backend call when one exists (saves API credits)
//   3. POST /api/generate-content on demand
//   4. Drive the loading UI: spinner, ticker micro-copy rotation, fake
//      progress bar (so the 60-90s wait feels alive)
//   5. Render the slide grid (year badge, image, title, description,
//      per-slide download button)
//   6. Handle errors gracefully and surface them in the error banner
// =====================================================================

const API_ENDPOINT = '/api/generate-content';
const CACHE_KEY = 'instagen:daily:v1';

// Micro-copy shown while the backend works. Rotates every ~4s to keep
// the user engaged during the long generation window.
const TICKER_MESSAGES = [
  'Researching history...',
  'Curating the day...',
  'Composing narratives...',
  'Synthesizing images...',
  'Painting the past...',
  'Adding film grain...',
  'Finalizing carousel...',
];

// ---------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------
const els = {
  todayDate: document.getElementById('today-date'),
  generateBtn: document.getElementById('generate-btn'),
  generateBtnLabel: document.getElementById('generate-btn__label'),
  loading: document.getElementById('loading'),
  ticker: document.getElementById('ticker'),
  progressFill: document.getElementById('progress-fill'),
  error: document.getElementById('error'),
  results: document.getElementById('results'),
  resultsMeta: document.getElementById('results-meta'),
  slideGrid: document.getElementById('slide-grid'),
};

// ---------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------

/** YYYY-MM-DD in the user's local timezone. */
function getTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "January 7" style label, matching the backend's fullDate format. */
function getPrettyToday() {
  return new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------
// Cache layer (localStorage)
// ---------------------------------------------------------------------

/**
 * Returns the cached payload for today, or null. The cache is keyed by
 * the calendar day — entries from previous days are intentionally
 * ignored so the user always sees fresh content once a new day starts.
 */
function loadFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.dateKey !== getTodayKey()) return null;
    if (!Array.isArray(parsed?.slides) || parsed.slides.length === 0) return null;
    return parsed;
  } catch (err) {
    console.warn('[cache] failed to read:', err);
    return null;
  }
}

/** Persists the payload under today's key, with a timestamp. */
function saveToCache(payload) {
  try {
    const record = {
      ...payload,
      dateKey: getTodayKey(),
      cachedAt: new Date().toISOString(),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(record));
  } catch (err) {
    console.warn('[cache] failed to write:', err);
  }
}

// ---------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------

/**
 * Triggers the generation pipeline. Throws on network or server error.
 */
async function requestGeneration() {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  // Try to parse JSON either way — the backend always returns JSON for errors.
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }

  if (!Array.isArray(data?.slides) || data.slides.length === 0) {
    throw new Error('Server returned an empty carousel.');
  }

  return data;
}

// ---------------------------------------------------------------------
// UI state machines
// ---------------------------------------------------------------------

/** Show the spinner, disable the button, start the ticker + progress bar. */
function enterLoadingState() {
  els.error.hidden = true;
  els.results.hidden = true;
  els.loading.hidden = false;
  els.generateBtn.disabled = true;
  els.generateBtnLabel.textContent = 'Generating...';

  // Smooth-scroll the spinner into view on small screens.
  els.loading.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Ticker — cycles through micro-copy every 4s.
  let idx = 0;
  els.ticker.textContent = TICKER_MESSAGES[idx];
  const tickerTimer = setInterval(() => {
    idx = (idx + 1) % TICKER_MESSAGES.length;
    els.ticker.style.opacity = '0';
    setTimeout(() => {
      els.ticker.textContent = TICKER_MESSAGES[idx];
      els.ticker.style.opacity = '1';
    }, 200);
  }, 4000);

  // Progress bar — animated, asymptotic toward 95% (resets to 100 on success).
  // Total animation ~90s, mirroring typical backend latency.
  let progress = 0;
  els.progressFill.style.width = '0%';
  const progressTimer = setInterval(() => {
    // Asymptotic growth — fast at first, slow as it approaches 95.
    const remaining = 95 - progress;
    progress += remaining * 0.04 + 0.3;
    if (progress > 95) progress = 95;
    els.progressFill.style.width = `${progress.toFixed(1)}%`;
  }, 500);

  // Return a teardown fn so we can stop timers cleanly.
  return () => {
    clearInterval(tickerTimer);
    clearInterval(progressTimer);
    els.progressFill.style.width = '100%';
  };
}

/** Re-enable the button, hide the spinner. */
function exitLoadingState() {
  els.loading.hidden = true;
  els.generateBtn.disabled = false;
  els.generateBtnLabel.textContent = "Generate Today's Content";
}

/** Show an error message in the banner; restore the button. */
function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
  els.error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

/** Formats a timestamp for the "generated X ago" meta line. */
function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Renders one slide card. Returns the root element so we can attach
 * per-image load handlers for the fade-in transition.
 */
function renderSlide(slide, index) {
  const card = document.createElement('article');
  card.className = 'slide';
  card.style.animationDelay = `${index * 40}ms`;

  // Image with lazy fade-in once decoded
  const imgWrap = document.createElement('div');
  imgWrap.className = 'slide-image-wrap';

  const img = document.createElement('img');
  img.className = 'slide-image';
  img.alt = slide.title || 'Historical image';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = slide.imageUrl;
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.classList.add('loaded')); // still fade in

  const year = document.createElement('span');
  year.className = 'slide-year';
  year.textContent = slide.year || '—';

  imgWrap.append(img, year);

  // Body
  const body = document.createElement('div');
  body.className = 'slide-body';

  const title = document.createElement('h3');
  title.className = 'slide-title';
  title.textContent = slide.title || 'Untitled event';

  const desc = document.createElement('p');
  desc.className = 'slide-description';
  desc.textContent = slide.description || '';

  // One-tap "Copy description" affordance. The description is rendered
  // as plain text (not truncated, fully selectable on its own); this
  // button is just a shortcut so the user doesn't have to triple-click
  // + ⌘C every time.
  const copyDescBtn = document.createElement('button');
  copyDescBtn.className = 'copy-text-btn';
  copyDescBtn.type = 'button';
  copyDescBtn.textContent = 'Copy description';
  copyDescBtn.setAttribute('aria-label', 'Copy description to clipboard');
  copyDescBtn.addEventListener('click', () =>
    copyToClipboard(copyDescBtn, slide.description || '')
  );

  // Action row
  const actions = document.createElement('div');
  actions.className = 'slide-actions';

  const dl = document.createElement('button');
  dl.className = 'download-btn';
  dl.type = 'button';
  dl.innerHTML = `
    <svg class="download-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span>Download</span>
  `;
  dl.addEventListener('click', () => downloadImage(slide, index));

  actions.append(dl);

  body.append(title, desc, copyDescBtn, actions);
  card.append(imgWrap, body);
  return card;
}

/**
 * Copies an arbitrary string to the clipboard and flashes a "Copied"
 * hint on the triggering button. Falls back to a hidden <textarea> +
 * execCommand('copy') on browsers/environments where the async
 * Clipboard API is unavailable (e.g. insecure contexts, very old
 * mobile browsers).
 */
async function copyToClipboard(button, text) {
  if (!text) return;

  const flashCopied = () => {
    const original = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove('copied');
    }, 1500);
  };

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      flashCopied();
      return;
    }
  } catch {
    /* fall through to legacy path */
  }

  // Legacy fallback: stage a temporary textarea, select, exec copy.
  let staging;
  try {
    staging = document.createElement('textarea');
    staging.value = text;
    staging.setAttribute('readonly', '');
    staging.style.position = 'fixed';
    staging.style.opacity = '0';
    staging.style.pointerEvents = 'none';
    document.body.appendChild(staging);
    staging.select();
    const ok = document.execCommand('copy');
    if (ok) flashCopied();
  } catch (err) {
    console.warn('[copy] failed:', err);
  } finally {
    if (staging) staging.remove();
  }
}

/** Mounts the slide array into the grid. */
function renderSlides(payload) {
  els.slideGrid.innerHTML = '';
  payload.slides.forEach((slide, i) => {
    els.slideGrid.appendChild(renderSlide(slide, i));
  });

  // Meta line: "8 slides · just now" (or "8 slides · 2h ago" if cached)
  const slideCount = payload.slides.length;
  const when = timeAgo(payload.generatedAt || payload.cachedAt);
  const cached = payload.cachedAt && !payload.generatedAt;
  els.resultsMeta.textContent = cached
    ? `${slideCount} slides · cached ${when}`
    : `${slideCount} slides · ${when}`;

  els.results.hidden = false;

  // The "Generate" button is redundant once the carousel is on screen
  // (results are cached for the day, so re-running would just produce
  // the same images). Hide it as soon as every slide image has fired
  // its load/error event — that's the "after images are loaded" gate.
  scheduleGenerateButtonHiding();
}

/**
 * Waits for every slide image to load (or error out) and then hides
 * the primary generate button. Handles the case where some images
 * are already in the browser cache (img.complete is true) before the
 * `load` event can fire, otherwise the button would never get hidden.
 */
function scheduleGenerateButtonHiding() {
  const imgs = els.slideGrid.querySelectorAll('.slide-image');
  if (imgs.length === 0) {
    els.generateBtn.hidden = true;
    return;
  }

  let remaining = imgs.length;
  const onSettled = () => {
    remaining -= 1;
    if (remaining === 0) {
      els.generateBtn.hidden = true;
    }
  };

  imgs.forEach((img) => {
    if (img.complete && img.naturalWidth > 0) {
      // Already loaded (e.g. browser cache hit) — settle on next tick.
      onSettled();
      return;
    }
    img.addEventListener('load', onSettled, { once: true });
    img.addEventListener('error', onSettled, { once: true });
  });
}

// ---------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------

/**
 * Downloads an image to the user's device.
 *
 * On desktop browsers this triggers a normal file download.
 * On iOS Safari we open the image in a new tab so the user can
 * long-press → "Add to Photos" (the most reliable mobile path).
 */
async function downloadImage(slide, index) {
  const safeName = `${(slide.year || 'event').toString().replace(/[^0-9]/g, '')}_${slugify(
    slide.title || `event-${index + 1}`
  )}.jpg`;

  try {
    // Best path: fetch → blob → object URL → <a download>.
    // Works on desktop and modern Android browsers.
    const response = await fetch(slide.imageUrl, { mode: 'cors' });
    if (response.ok) {
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      triggerDownload(blobUrl, safeName);
      // Revoke after a tick so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      return;
    }
  } catch {
    /* fall through to direct-anchor path */
  }

  // Fallback: open the URL in a new tab. Mobile users can long-press
  // to save; desktop users get a normal download via Content-Disposition
  // if the host set one, or a right-click → Save As otherwise.
  triggerDownload(slide.imageUrl, safeName, /* newTab = */ true);
}

function triggerDownload(href, filename, newTab = false) {
  const a = document.createElement('a');
  a.href = href;
  if (!newTab) a.download = filename;
  else a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'event';
}

// ---------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------

/** Orchestrates a full generate → render cycle. */
async function handleGenerateClick() {
  const stopLoading = enterLoadingState();

  try {
    const payload = await requestGeneration();
    saveToCache(payload);
    renderSlides(payload);
  } catch (err) {
    console.error('[generate] error:', err);
    showError(
      err?.message ||
        'Something went wrong while generating. Check your connection and try again.'
    );
  } finally {
    stopLoading();
    exitLoadingState();
  }
}

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------
function init() {
  // Show today's date in the header
  els.todayDate.textContent = getPrettyToday();

  // Wire up the primary action
  els.generateBtn.addEventListener('click', handleGenerateClick);

  // Instant-load from cache if we already have today's carousel
  const cached = loadFromCache();
  if (cached) {
    console.info('[cache] rendering cached carousel for', cached.dateKey);
    renderSlides(cached);
  }
}

// Fire init once the DOM is parsed (this script is <script type="module">
// so it's deferred by default, but we still wait for DOMContentLoaded
// to be explicit about timing).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
