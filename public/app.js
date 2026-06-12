// =====================================================================
// InstaGen — Frontend controller (vanilla ES module)
// =====================================================================
// Responsibilities:
//   1. Read the active niche from the global store (set on / by hub.js)
//      and render the niche badge at the top of the page
//   2. Render the "today" date in the header
//   3. Check localStorage for a cached carousel for (today, active niche)
//      and short-circuit the backend call when one exists (saves API credits)
//   4. POST /api/generate-content with { niche } on demand
//   5. Drive the loading UI: spinner, ticker micro-copy rotation, fake
//      progress bar (so the 60-90s wait feels alive)
//   6. Render the slide grid (year badge, image, title, description,
//      per-slide download button)
//   7. Handle errors gracefully and surface them in the error banner
// =====================================================================

import {
  getActiveNiche,
  subscribeActiveNiche,
  getNiche,
} from './state.js';
import { apiUrl } from './api-base.js';

// API base defaults to same-origin ("/api/..."). Override via
// window.INSTAGEN_API_BASE or <meta name="instagen-api-base"> for
// split-architecture deploys (see public/api-base.js).
const API_ENDPOINT = apiUrl('/api/generate-content');
const VIDEO_API_ENDPOINT = apiUrl('/api/generate-daily-videos');

// Cache is keyed by (niche, date) so picking a different niche on the
// hub doesn't show another niche's cached carousel. The legacy single-key
// 'instagen:daily:v1' is still read on first load for back-compat with
// payloads generated before niches existed — those are treated as the
// 'history' niche and re-cached under the new key on the next save.
const CACHE_KEY_PREFIX = 'instagen:daily:v2:';

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

// Micro-copy shown while the video generation backend is working.
// The first message is the one spelled out in the spec — it stays on
// screen for the first interval, then the rest rotate every ~4s.
const VIDEO_TICKER_MESSAGES = [
  "Analyzing Day's Events & Generating Videos...",
  'Storyboarding scenes...',
  'Rendering footage...',
  'Stitching clips together...',
  'Adding motion blur...',
  'Polishing the final cut...',
];

// ---------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------
const els = {
  nicheBadge: document.getElementById('niche-badge'),
  nicheBadgeLabel: document.getElementById('niche-badge__label'),
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
  videos: document.getElementById('videos'),
  generateVideosBtn: document.getElementById('generate-videos-btn'),
  generateVideosBtnLabel: document.getElementById('generate-videos-btn__label'),
  videosLoading: document.getElementById('videos-loading'),
  videosTicker: document.getElementById('videos-ticker'),
  videosProgressFill: document.getElementById('videos-progress-fill'),
  videosError: document.getElementById('videos-error'),
  videosMeta: document.getElementById('videos-meta'),
  videoGrid: document.getElementById('video-grid'),
};

// ---------------------------------------------------------------------
// Active niche — the live value is held in module scope and updated by
// the store subscription below. The badge, cache key, and API payload
// all read from this single variable so they stay in lockstep.
// ---------------------------------------------------------------------
let activeNiche = getActiveNiche();

function getCacheKey() {
  // Falls back to 'history' when no niche has been picked (e.g. someone
  // deep-linked straight to /generator). getNiche() also returns the
  // history record in that case, so the API call still gets a valid id.
  const niche = getNiche(activeNiche).id;
  return `${CACHE_KEY_PREFIX}${niche}:${getTodayKey()}`;
}

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
 * Returns the cached payload for the active niche + today, or null.
 * The cache is keyed by (niche, calendar day) — entries from previous
 * days are intentionally ignored so the user always sees fresh content
 * once a new day starts, and entries for a different niche are not
 * returned (so switching from True Crime to History on the hub gives
 * a fresh History carousel, not yesterday's True Crime one).
 */
function loadFromCache() {
  const cacheKey = getCacheKey();
  try {
    const raw = localStorage.getItem(cacheKey);
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

/** Persists the payload under the active niche + today's key, with a timestamp. */
function saveToCache(payload) {
  try {
    const record = {
      ...payload,
      dateKey: getTodayKey(),
      niche: getNiche(activeNiche).id,
      cachedAt: new Date().toISOString(),
    };
    localStorage.setItem(getCacheKey(), JSON.stringify(record));
  } catch (err) {
    console.warn('[cache] failed to write:', err);
  }
}

// ---------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------

/**
 * Triggers the generation pipeline. Throws on network or server error.
 * The active niche is forwarded to the backend so each engine
 * ("True Crime", "History", ...) actually generates content scoped
 * to that niche instead of generic events.
 */
async function requestGeneration() {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      niche: getNiche(activeNiche).id,
    }),
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

/**
 * Submit a video generation request to the backend. Two response
 * shapes are supported:
 *
 *   - SYNC (HTTP 200):  { videos: [...] }                  — backend
 *     bundled the videos itself (ffmpeg, external webhook, or
 *     manifest stub). The frontend renders immediately.
 *
 *   - ASYNC (HTTP 202): { status: 'processing', tasks: [...],
 *                          statusUrl: '/api/video-status?ids=...' }
 *     — the backend accepted the work and MiniMax is rendering
 *     asynchronously. Frontend polls statusUrl until each task
 *     resolves, then renders the completed videos. The status
 *     field is normalized by the handler to 'processing' on
 *     submit and 'completed'/'failed' on the per-task callback.
 *
 * Returns a tagged union: { kind: 'sync', videos, generatedAt }
 * or { kind: 'async', tasks, statusUrl, generatedAt }.
 */
async function submitVideoGeneration() {
  const response = await fetch(VIDEO_API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      niche: getNiche(activeNiche).id,
    }),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }

  // Async path: BUNDLE_PROVIDER=minimax_video or minimax_i2v.
  // The handler returns 202 with task IDs and a statusUrl the
  // frontend polls.
  if (response.status === 202 && data?.statusUrl && Array.isArray(data?.tasks)) {
    return {
      kind: 'async',
      tasks: data.tasks,
      statusUrl: data.statusUrl,
      generatedAt: data.generatedAt || new Date().toISOString(),
    };
  }

  // Sync path: backend returned real video URLs in the body.
  const videos = Array.isArray(data) ? data : data?.videos;
  if (!Array.isArray(videos) || videos.length === 0) {
    throw new Error('Server returned no videos.');
  }
  const playable = videos.filter((v) => v && (v.url || v.videoUrl || v.src));
  if (playable.length === 0) {
    throw new Error('Server returned videos without playable URLs.');
  }
  return {
    kind: 'sync',
    generatedAt: data?.generatedAt || new Date().toISOString(),
    videos: playable.map((v) => ({
      url: v.url || v.videoUrl || v.src,
      title: v.title || '',
      year: v.year || '',
    })),
  };
}

/**
 * Poll the backend's /api/video-status endpoint until every task
 * has settled (success or failed) or the timeout elapses.
 *
 * @param {string}   statusUrl
 *        e.g. "/api/video-status?ids=t1,t2,t3"
 * @param {Array}    tasks
 *        [{ taskId, title, year }] — preserved so the rendered
 *        video card carries the script's title/year even when
 *        the callback doesn't echo them back.
 * @param {Function} onUpdate
 *        Called after each poll with the latest `videos` array
 *        (only completed entries, in the original task order).
 *        Lets the UI render partial results as they arrive.
 * @param {object}   [opts]
 * @param {number}   [opts.pollMs=5000]        Cadence between polls.
 * @param {number}   [opts.timeoutMs=360000]   6 minutes hard cap.
 * @returns {Promise<{videos: Array, status: 'completed'|'partial'|'timeout'}>}
 */
async function pollVideoStatus(statusUrl, tasks, onUpdate, opts = {}) {
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 5000;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 6 * 60 * 1000;
  const start = Date.now();

  // Resolve statusUrl against the API base. statusUrl is a
  // server-relative path like "/api/video-status?ids=..." so we
  // just hand it to apiUrl() which prefixes the configured base
  // (or returns it as-is for the co-located default).
  const pollUrl = apiUrl(statusUrl);

  while (true) {
    if (Date.now() - start > timeoutMs) {
      return { videos: [], status: 'timeout' };
    }

    let data;
    try {
      const r = await fetch(pollUrl);
      if (!r.ok) throw new Error(`status ${r.status}`);
      data = await r.json();
    } catch {
      // Transient network blip — try again on the next tick.
      await sleep(pollMs);
      continue;
    }

    const completed = [];
    let stillRunning = 0;
    for (const t of tasks) {
      const r = data?.tasks?.[t.taskId];
      if (!r || r.status === 'processing' || r.status === 'unknown') {
        stillRunning++;
        continue;
      }
      // Terminal states:
      //   'success' / 'completed' — render if we have a URL.
      //   'failed'                — skip silently (the meta line
      //                             on the grid already shows the
      //                             total count, so the user sees
      //                             fewer videos).
      if ((r.status === 'success' || r.status === 'completed') && r.url) {
        completed.push({ url: r.url, title: t.title || '', year: t.year || '' });
      }
    }

    if (typeof onUpdate === 'function') onUpdate(completed);

    if (stillRunning === 0) {
      return {
        videos: completed,
        status: completed.length === tasks.length ? 'completed' : 'partial',
      };
    }
    await sleep(pollMs);
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
// Video UI state machines
// ---------------------------------------------------------------------

/**
 * Show the video spinner, disable the video button, start the ticker
 * and the asymptotic progress bar. Mirrors enterLoadingState() but
 * with its own set of micro-copy and a longer tail (video jobs can
 * take 3–6 minutes).
 */
function enterVideoLoadingState() {
  els.videosError.hidden = true;
  // Keep the previously rendered grid visible until the new payload
  // arrives — it gets cleared/replaced on success.
  els.videosLoading.hidden = false;
  els.generateVideosBtn.disabled = true;
  els.generateVideosBtnLabel.textContent = 'Generating Videos...';

  // Smooth-scroll the spinner into view on small screens.
  els.videosLoading.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Ticker — cycles through micro-copy every 4s. The first message
  // is the spec-mandated copy and stays for the full first interval.
  let idx = 0;
  els.videosTicker.textContent = VIDEO_TICKER_MESSAGES[idx];
  const tickerTimer = setInterval(() => {
    idx = (idx + 1) % VIDEO_TICKER_MESSAGES.length;
    els.videosTicker.style.opacity = '0';
    setTimeout(() => {
      els.videosTicker.textContent = VIDEO_TICKER_MESSAGES[idx];
      els.videosTicker.style.opacity = '1';
    }, 200);
  }, 4000);

  // Progress bar — asymptotic toward 95% (resets to 100 on success).
  // Total animation ~5min, mirroring typical video backend latency.
  let progress = 0;
  els.videosProgressFill.style.width = '0%';
  const progressTimer = setInterval(() => {
    const remaining = 95 - progress;
    progress += remaining * 0.025 + 0.2;
    if (progress > 95) progress = 95;
    els.videosProgressFill.style.width = `${progress.toFixed(1)}%`;
  }, 500);

  return () => {
    clearInterval(tickerTimer);
    clearInterval(progressTimer);
    els.videosProgressFill.style.width = '100%';
  };
}

/** Hide the video spinner; restore the video button. */
function exitVideoLoadingState() {
  els.videosLoading.hidden = true;
  els.generateVideosBtn.disabled = false;
  els.generateVideosBtnLabel.textContent = 'Regenerate Videos';
}

/** Show a video-specific error in the banner; restore the button. */
function showVideoError(message) {
  els.videosError.textContent = message;
  els.videosError.hidden = false;
  els.videosError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  // The videos section is a logical follow-up to the carousel — show
  // it now that the daily events are on screen. The video button is
  // its own CTA; the grid renders below it on click.
  els.videos.hidden = false;

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
// Video rendering
// ---------------------------------------------------------------------

/**
 * Renders one video card. Mirrors the slide card visually — same
 * dark surface, same 9/16 media well, same year pill — so the two
 * sections feel like part of the same system.
 */
function renderVideoCard(video, index) {
  const card = document.createElement('article');
  card.className = 'video-card';
  card.style.animationDelay = `${index * 40}ms`;

  const wrap = document.createElement('div');
  wrap.className = 'video-wrap';

  // Native <video controls> — no custom player. `preload="metadata"`
  // is light enough that 3 videos don't hammer the CDN on render.
  const v = document.createElement('video');
  v.controls = true;
  v.preload = 'metadata';
  v.playsInline = true;
  v.src = video.url;
  v.setAttribute('aria-label', video.title || `Generated video ${index + 1}`);

  const year = document.createElement('span');
  year.className = 'video-year';
  year.textContent = video.year || `Clip ${index + 1}`;

  wrap.append(v, year);

  // Body
  const body = document.createElement('div');
  body.className = 'video-body';

  const title = document.createElement('h3');
  title.className = 'video-title';
  title.textContent = video.title || `Video ${index + 1}`;

  // Action row
  const actions = document.createElement('div');
  actions.className = 'video-actions';

  const dl = document.createElement('a');
  dl.className = 'download-btn';
  dl.href = video.url;
  dl.setAttribute('download', '');
  dl.setAttribute('target', '_blank');
  dl.setAttribute('rel', 'noopener noreferrer');
  dl.innerHTML = `
    <svg class="download-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span>Download</span>
  `;

  actions.append(dl);

  body.append(title, actions);
  card.append(wrap, body);
  return card;
}

/**
 * Mounts the videos array into the grid and updates the meta line.
 * Accepts either a bare array or `{ videos: [...], generatedAt }`.
 */
function renderVideos(payload) {
  const videos = Array.isArray(payload) ? payload : payload?.videos || [];
  els.videoGrid.innerHTML = '';
  videos.forEach((video, i) => {
    els.videoGrid.appendChild(renderVideoCard(video, i));
  });

  const count = videos.length;
  const when = timeAgo(payload?.generatedAt);
  els.videosMeta.textContent = when
    ? `${count} videos · ${when}`
    : `${count} videos`;
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

/**
 * Orchestrates a full video-generate → render cycle. Independent of
 * the image flow — runs in parallel conceptually but is gated behind
 * the videos section becoming visible (which only happens after the
 * carousel is on screen).
 *
 * Two backend paths are supported:
 *   - SYNC: the backend bundled the videos itself (ffmpeg, external
 *     webhook, manifest stub). We render immediately and exit.
 *   - ASYNC: the backend accepted the work and MiniMax is rendering
 *     in the background. We keep the loading state up, poll
 *     /api/video-status every 5s, and re-render after every poll
 *     so the user sees videos appear one-by-one as they complete.
 */
async function handleGenerateVideosClick() {
  const stopLoading = enterVideoLoadingState();

  try {
    const result = await submitVideoGeneration();

    if (result.kind === 'sync') {
      renderVideos({ videos: result.videos, generatedAt: result.generatedAt });
      return;
    }

    // Async path: poll for completion. Re-render the grid after
    // every poll so partial results show up immediately. The meta
    // line ("X videos") updates with the count.
    const final = await pollVideoStatus(
      result.statusUrl,
      result.tasks,
      (videos) => renderVideos({ videos, generatedAt: result.generatedAt })
    );

    if (final.videos.length === 0) {
      if (final.status === 'timeout') {
        throw new Error(
          'Video generation timed out after 6 minutes. The tasks may still complete in the background — try again in a moment.'
        );
      }
      // partial / completed-but-empty means every task failed.
      throw new Error('No videos completed. Please try again.');
    }
  } catch (err) {
    console.error('[generate-videos] error:', err);
    showVideoError(
      err?.message ||
        'Something went wrong while generating videos. Check your connection and try again.'
    );
  } finally {
    stopLoading();
    exitVideoLoadingState();
  }
}

// ---------------------------------------------------------------------
// Niche badge — surfaces the active engine at the top of the dashboard.
// The badge is also tied to the store subscription so if the user
// opens /generator, switches the niche on / in another tab, the badge
// (and cached grid) refreshes live without a page reload.
// ---------------------------------------------------------------------
function renderNicheBadge(nicheId) {
  if (!els.nicheBadge || !els.nicheBadgeLabel) return;
  const niche = getNiche(nicheId);
  els.nicheBadgeLabel.textContent = niche.label;
  // Tint the badge with the niche's gradient so the visual identity
  // carries over from the hub card the user just clicked.
  els.nicheBadge.style.setProperty('--niche-gradient', niche.gradient);
  els.nicheBadge.hidden = false;
}

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------
function init() {
  // Show today's date in the header
  els.todayDate.textContent = getPrettyToday();

  // Render the active niche badge (also re-renders on cross-tab changes).
  renderNicheBadge(activeNiche);
  subscribeActiveNiche((id) => {
    activeNiche = id;
    renderNicheBadge(id);
    // If a payload is already on screen for the OLD niche, clear it
    // so the user doesn't see a stale carousel under the new badge.
    // They'll re-trigger generation (or hit the cache) explicitly.
    if (!els.results.hidden) {
      els.results.hidden = true;
      els.videos.hidden = true;
      els.generateBtn.hidden = false;
    }
  });

  // Wire up the primary action
  els.generateBtn.addEventListener('click', handleGenerateClick);
  // Wire up the secondary "Generate Videos" action
  els.generateVideosBtn.addEventListener('click', handleGenerateVideosClick);

  // Instant-load from cache if we already have today's carousel for
  // the active niche. (Different niche → different cache key → cache
  // miss → user clicks Generate.)
  const cached = loadFromCache();
  if (cached) {
    console.info('[cache] rendering cached carousel for', cached.dateKey, '·', getNiche(activeNiche).id);
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
