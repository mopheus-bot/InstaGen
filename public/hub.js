// =====================================================================
// InstaGen — Theme Hub controller
// =====================================================================
// Renders the niche grid, wires each card click to:
//   1. setActiveNiche(id)   — write to the global store
//   2. play a leave animation
//   3. navigate to /generator (the dashboard reads the niche on mount)
//
// No build step, no framework — keeps the project on its existing
// vanilla-JS + Vercel static hosting setup.
// =====================================================================

import { NICHES, setActiveNiche } from './state.js';

const grid = document.getElementById('niche-grid');

/**
 * Builds a single niche card. The gradient is set via a CSS custom
 * property so the per-niche palette lives in the data, not in CSS.
 */
function renderCard(niche) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'niche-card';
  btn.dataset.nicheId = niche.id;
  btn.setAttribute('aria-label', `Open ${niche.label}`);
  btn.style.setProperty('--niche-gradient', niche.gradient);

  btn.innerHTML = `
    <span class="niche-card__inner">
      <span class="niche-card__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="${niche.icon}"></path>
        </svg>
      </span>
      <span class="niche-card__tag">${niche.tag}</span>
      <h2 class="niche-card__title">${niche.label}</h2>
      <span class="niche-card__cta" aria-hidden="true">
        Open engine
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14M13 5l7 7-7 7"></path>
        </svg>
      </span>
    </span>
  `;

  btn.addEventListener('click', () => handleSelect(niche, btn));
  return btn;
}

/**
 * Click handler: save the niche, animate the card, navigate.
 * Order matters — set the niche FIRST so /generator's read on mount
 * sees it even if the user lands there before the animation finishes
 * (e.g. via bfcache restoring the next page).
 */
function handleSelect(niche, cardEl) {
  setActiveNiche(niche.id);

  // Animate the chosen card, fade the rest, then navigate.
  cardEl.classList.add('is-leaving');
  grid.querySelectorAll('.niche-card').forEach((c) => {
    if (c !== cardEl) c.style.transition = 'opacity 200ms ease';
    if (c !== cardEl) c.style.opacity = '0.25';
  });

  // Wait for the leave animation to play out, then route.
  // 360ms matches the CSS keyframe duration.
  setTimeout(() => {
    window.location.href = '/generator';
  }, 360);
}

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------
function init() {
  NICHES.forEach((niche) => grid.appendChild(renderCard(niche)));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
