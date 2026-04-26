// ── Gutenberg OPDS Popup ──────────────────────────────────────────────────────
// Implements:
//   • Navigation stack (breadcrumb-style, back button)
//   • Feed fetching via Service Worker message bridge
//   • Lazy-loading book cover images (IntersectionObserver)
//   • Bookmarks (chrome.storage.local)
//   • Full-text search via OPDS search endpoint
//   • Book detail panel (slides in over list)
//   • Full text reader — "Read in Popup" fetches plain text via SW → shows inline
//   • Glass overlay — "Read on Page" fetches plain text via SW → sends to
//     the active tab's content script, which displays it in the liquid glass
//     overlay already injected on the page
//   • Settings panel (⚙) — overlay font size, persisted + live preview

import { parseFeed } from './opds-parser.js';

const ROOT_FEED   = 'https://www.gutenberg.org/ebooks/search.opds/';
const SEARCH_BASE = 'https://www.gutenberg.org/ebooks/search.opds/?query=';

const OVERLAY_FONT_MIN     = 9;
const OVERLAY_FONT_MAX     = 48;
const OVERLAY_FONT_DEFAULT = 28;

const CHUNK_WORDS_MIN     = 50;
const CHUNK_WORDS_MAX     = 600;
const CHUNK_WORDS_STEP    = 25;
const CHUNK_WORDS_DEFAULT = 150;

const BLUR_MIN     = 0;
const BLUR_MAX     = 20;
const BLUR_DEFAULT = 20;

// Randomizer — interval between fade-ins, controlled by frequency slider
const RAND_FREQ_MIN     = 1;
const RAND_FREQ_MAX     = 50;
const RAND_FREQ_DEFAULT = 6;
const RAND_WINDOW_MS    = 3 * 60 * 60 * 1000; // 3 hours
const RAND_ON_DURATION  = 5 * 60 * 1000;       // 5 minutes overlay ON (timer bar duration)
const RAND_FADE_MS      = 1500;                 // fade transition duration

// ── State ─────────────────────────────────────────────────────────────────────
const navStack       = [];
let   bookmarks      = {};
let   showingBkmk    = false;
let   readerFontSize = 13; // px — popup reader only
let   overlayFontSize = OVERLAY_FONT_DEFAULT; // px — overlay on page
let   chunkWords      = CHUNK_WORDS_DEFAULT;  // words per chunk
let   overlayBlur     = BLUR_DEFAULT;         // blur intensity 0–20
let   overlayEnabled  = false;                // on/off toggle — default OFF
let   randFreq        = RAND_FREQ_DEFAULT;    // times per 3-hour window
let   randActive      = false;                // is the randomizer running?
const lazyObs        = setupLazyObserver();

// ── Element refs ──────────────────────────────────────────────────────────────
const feedTitle      = document.getElementById('feed-title');
const btnBack        = document.getElementById('btn-back');
const btnBookmarks   = document.getElementById('btn-bookmarks');
const btnOverlayToggle = document.getElementById('btn-overlay-toggle');
const searchInput    = document.getElementById('search-input');
const btnSearch      = document.getElementById('btn-search');
const navList        = document.getElementById('nav-list');
const bookList       = document.getElementById('book-list');
const bookmarksView  = document.getElementById('bookmarks-view');
const detailPanel    = document.getElementById('detail-panel');
const detailContent  = document.getElementById('detail-content');
const btnCloseDetail = document.getElementById('btn-close-detail');

// Reader
const readerPanel    = document.getElementById('reader-panel');
const readerTitle    = document.getElementById('reader-title');
const readerLoading  = document.getElementById('reader-loading');
const readerError    = document.getElementById('reader-error');
const readerBody     = document.getElementById('reader-body');
const btnCloseReader = document.getElementById('btn-close-reader');
const btnFontUp      = document.getElementById('btn-font-up');
const btnFontDown    = document.getElementById('btn-font-down');

// Settings
const btnSettings       = document.getElementById('btn-settings');
const settingsPanel     = document.getElementById('settings-panel');
const settingsFontSlider = document.getElementById('settings-font-slider');
const settingsFontValue  = document.getElementById('settings-font-value');
const settingsFontUp     = document.getElementById('settings-font-up');
const settingsFontDown   = document.getElementById('settings-font-down');
const settingsChunkSlider = document.getElementById('settings-chunk-slider');
const settingsChunkValue  = document.getElementById('settings-chunk-value');
const settingsChunkUp     = document.getElementById('settings-chunk-up');
const settingsChunkDown   = document.getElementById('settings-chunk-down');
const settingsBlurSlider  = document.getElementById('settings-blur-slider');
const settingsBlurValue   = document.getElementById('settings-blur-value');
const settingsBlurUp      = document.getElementById('settings-blur-up');
const settingsBlurDown    = document.getElementById('settings-blur-down');

// Randomizer
const btnRandomizer       = document.getElementById('btn-randomizer');
const randCountdownEl     = document.getElementById('rand-countdown');
const settingsRandSlider  = document.getElementById('settings-rand-slider');
const settingsRandValue   = document.getElementById('settings-rand-value');
const settingsRandUp      = document.getElementById('settings-rand-up');
const settingsRandDown    = document.getElementById('settings-rand-down');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  bookmarks       = await loadBookmarks();
  overlayFontSize = await loadOverlayFontSize();
  chunkWords      = await loadChunkWords();
  overlayBlur     = await loadOverlayBlur();
  randFreq        = await loadRandFreq();

  // Resolve the active tab and load its per-tab state.
  const tabId = await getActiveTabId();
  if (tabId) await switchToTab(tabId);

  syncSettingsUI();
  await navigateTo(ROOT_FEED, 'eBooks');
})();

// Re-scope the popup whenever the user switches tabs while it's open.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await switchToTab(tabId);
});

// ── Settings panel ────────────────────────────────────────────────────────────

async function loadOverlayFontSize() {
  const data = await chrome.storage.local.get('overlayFontSize');
  const val  = data.overlayFontSize;
  return (typeof val === 'number' && val >= OVERLAY_FONT_MIN && val <= OVERLAY_FONT_MAX)
    ? val
    : OVERLAY_FONT_DEFAULT;
}

function saveOverlayFontSize() {
  chrome.storage.local.set({ overlayFontSize });
}

async function loadChunkWords() {
  const data = await chrome.storage.local.get('chunkWords');
  const val  = data.chunkWords;
  return (typeof val === 'number' && val >= CHUNK_WORDS_MIN && val <= CHUNK_WORDS_MAX)
    ? val
    : CHUNK_WORDS_DEFAULT;
}

function saveChunkWords() {
  chrome.storage.local.set({ chunkWords });
}

async function loadOverlayBlur() {
  const data = await chrome.storage.local.get('overlayBlur');
  const val  = data.overlayBlur;
  return (typeof val === 'number' && val >= BLUR_MIN && val <= BLUR_MAX) ? val : BLUR_DEFAULT;
}

function saveOverlayBlur() {
  chrome.storage.local.set({ overlayBlur });
}

// ── Randomizer persistence ────────────────────────────────────────────────────
async function loadRandFreq() {
  const data = await chrome.storage.local.get('randFreq');
  const val  = data.randFreq;
  return (typeof val === 'number' && val >= RAND_FREQ_MIN && val <= RAND_FREQ_MAX)
    ? val : RAND_FREQ_DEFAULT;
}

function saveRandFreq() {
  chrome.storage.local.set({ randFreq });
}

// ── Per-tab state ─────────────────────────────────────────────────────────────
// overlayEnabled, randActive, randPhase, and randPhaseEnds are stored per tab
// under the key  tabState__{tabId}  in chrome.storage.local.
// randPhaseEnds is an epoch-ms timestamp so the popup can resume a countdown
// accurately even after being closed and reopened.
//
// Global settings (font size, blur, chunk words, rand frequency) remain global.

let activeTabId = null;  // tab the popup is currently scoped to

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function tabStateKey(tabId) {
  return `tabState__${tabId}`;
}

// Load state for a given tab. Returns defaults if nothing stored.
// `fresh` is true when there is no stored entry — used by switchToTab to
// trigger auto-arm and book prefetch on first-ever load for this tab.
async function loadTabState(tabId) {
  const key  = tabStateKey(tabId);
  const data = await chrome.storage.local.get(key);
  const s    = data[key] || {};
  const fresh = !data[key];
  return {
    overlayEnabled: s.overlayEnabled === true,
    randActive    : fresh ? true : (s.randActive === true),
    randPhase     : s.randPhase === 'on' ? 'on' : 'in',
    randPhaseEnds : typeof s.randPhaseEnds === 'number' ? s.randPhaseEnds : 0,
    fresh,
  };
}

// Persist current in-memory state back to storage for activeTabId.
function saveTabState() {
  if (!activeTabId) return;
  const key = tabStateKey(activeTabId);
  chrome.storage.local.set({
    [key]: { overlayEnabled, randActive, randPhase, randPhaseEnds, randFreq },
  });
}

// Switch the popup to reflect a different tab — reload state and resume display.
async function switchToTab(tabId) {
  clearCountdown();
  activeTabId = tabId;

  const s = await loadTabState(tabId);
  overlayEnabled = s.overlayEnabled;
  randActive     = s.randActive;
  randPhase      = s.randPhase;
  randPhaseEnds  = s.randPhaseEnds;

  syncToggleBtn();
  syncRandBtn();

  if (randActive) {
    const remaining = randPhaseEnds - Date.now();
    if (remaining > 0) {
      renderCountdown(randPhase, remaining);
    } else {
      // Phase expired while popup was closed — re-arm from now.
      if (randPhase === 'in') {
        randPhase     = 'on';
        randPhaseEnds = Date.now() + RAND_ON_DURATION;
      } else {
        randPhase     = 'in';
        randPhaseEnds = Date.now() + randIntervalMs();
      }
      saveTabState();
      renderCountdown(randPhase, randPhaseEnds - Date.now());
      armBackground(randPhase, randPhaseEnds);
    }
  }

  // First-ever tab: arm phase IN immediately and kick off silent book prefetch.
  if (s.fresh) {
    randPhase     = 'in';
    randPhaseEnds = Date.now() + randIntervalMs();
    saveTabState();
    renderCountdown(randPhase, randPhaseEnds - Date.now());
    armBackground(randPhase, randPhaseEnds);
    // Fire-and-forget — never blocks the UI
    prefetchRandomBook(tabId);
  }
}

// ── Overlay enabled (now per-tab) ─────────────────────────────────────────────
async function loadOverlayEnabled() {
  // Reads from tab state; returns false if tab unknown.
  if (!activeTabId) return false;
  const s = await loadTabState(activeTabId);
  return s.overlayEnabled;
}

function saveOverlayEnabled() {
  saveTabState();
  // Badge is now per-tab.
  if (activeTabId) {
    chrome.runtime.sendMessage({
      type  : 'SET_BADGE',
      tabId : activeTabId,
      enabled: overlayEnabled,
    }).catch(() => {});
  }
}

// ── Randomizer active (now per-tab) ───────────────────────────────────────────
function saveRandActive() {
  saveTabState();
}

function syncToggleBtn() {
  if (overlayEnabled) {
    btnOverlayToggle.classList.add('on');
    btnOverlayToggle.classList.remove('off');
    btnOverlayToggle.title = 'Overlay: On';
    btnOverlayToggle.innerHTML = '&#9646;&#9646;';
  } else {
    btnOverlayToggle.classList.add('off');
    btnOverlayToggle.classList.remove('on');
    btnOverlayToggle.title = 'Overlay: Off';
    btnOverlayToggle.innerHTML = '&#9647;&#9647;';
  }
  chrome.runtime.sendMessage({
    type   : 'SET_BADGE',
    tabId  : activeTabId,
    enabled: overlayEnabled,
  }).catch(() => {});
}

btnOverlayToggle.addEventListener('click', async () => {
  overlayEnabled = !overlayEnabled;
  saveOverlayEnabled();
  syncToggleBtn();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    if (overlayEnabled) {
      // ── Deterministic ON rule ─────────────────────────────────────────────
      // When the overlay is switched ON we must immediately show content —
      // either by replaying the most-recent selection stored on the content
      // script, or, if no selection has ever been made this session, by
      // triggering a fresh prefetch-and-dispatch via the service worker.
      //
      // Step 1: tell the content script the overlay is now enabled so it
      //         can replay lastDisplayMsg if it has one.
      // Step 2: query the SW for current rand state so we can also arm the
      //         timer bar if the randomizer happens to be in its ON phase.
      // Step 3: if the content script has no lastDisplayMsg yet, ask the SW
      //         to force-dispatch the prefetched book immediately (or prefetch
      //         one if none is cached yet).
      const contentReply = await chrome.tabs.sendMessage(tab.id, {
        type             : 'SET_OVERLAY_ENABLED',
        enabled          : true,
        fontSize         : overlayFontSize,
        chunkWords       : chunkWords,
        overlayBlur      : overlayBlur,
      }).catch(() => null);

      // contentReply is { hadContent: bool } — truthy only if content.js
      // already had a lastDisplayMsg to replay. If not, trigger a dispatch.
      if (!contentReply?.hadContent) {
        // Ask the SW to immediately dispatch the prefetched book (or fetch one).
        chrome.runtime.sendMessage({
          type         : 'FORCE_DISPATCH',
          tabId        : tab.id,
          fontSize     : overlayFontSize,
          chunkWords   : chunkWords,
          overlayBlur  : overlayBlur,
        }).catch(() => {});
      }
    } else {
      // Turning overlay OFF — straightforward hide message.
      await chrome.tabs.sendMessage(tab.id, {
        type   : 'SET_OVERLAY_ENABLED',
        enabled: false,
      }).catch(() => {});
    }
  } catch (_) {}
});

// Sync slider, label, and button disabled states for all settings controls.
function syncSettingsUI() {
  // Font size
  settingsFontSlider.value       = overlayFontSize;
  settingsFontValue.textContent  = overlayFontSize + 'px';
  settingsFontDown.disabled      = overlayFontSize <= OVERLAY_FONT_MIN;
  settingsFontUp.disabled        = overlayFontSize >= OVERLAY_FONT_MAX;
  updateSliderTrack();
  // Chunk size
  settingsChunkSlider.value      = chunkWords;
  settingsChunkValue.textContent = chunkWords + ' words';
  settingsChunkDown.disabled     = chunkWords <= CHUNK_WORDS_MIN;
  settingsChunkUp.disabled       = chunkWords >= CHUNK_WORDS_MAX;
  updateChunkSliderTrack();
  // Blur
  settingsBlurSlider.value      = overlayBlur;
  settingsBlurValue.textContent = overlayBlur;
  settingsBlurDown.disabled     = overlayBlur <= BLUR_MIN;
  settingsBlurUp.disabled       = overlayBlur >= BLUR_MAX;
  updateBlurSliderTrack();
  // Randomizer frequency
  settingsRandSlider.value      = randFreq;
  settingsRandValue.textContent = randFreq + '×/3h';
  settingsRandDown.disabled     = randFreq <= RAND_FREQ_MIN;
  settingsRandUp.disabled       = randFreq >= RAND_FREQ_MAX;
  updateRandSliderTrack();
}

// Paint the filled portion of the range track using a gradient on the element.
function updateSliderTrack() {
  const pct = ((overlayFontSize - OVERLAY_FONT_MIN) / (OVERLAY_FONT_MAX - OVERLAY_FONT_MIN)) * 100;
  // Use the CSS accent variable value; fall back to a green that matches light mode.
  const filled   = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1a6b3c';
  const unfilled = getComputedStyle(document.documentElement).getPropertyValue('--border').trim()  || 'rgba(0,0,0,0.10)';
  settingsFontSlider.style.background =
    `linear-gradient(to right, ${filled} 0%, ${filled} ${pct}%, ${unfilled} ${pct}%, ${unfilled} 100%)`;
}

// Paint the filled portion of the chunk-size range track.
function updateChunkSliderTrack() {
  const pct = ((chunkWords - CHUNK_WORDS_MIN) / (CHUNK_WORDS_MAX - CHUNK_WORDS_MIN)) * 100;
  const filled   = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1a6b3c';
  const unfilled = getComputedStyle(document.documentElement).getPropertyValue('--border').trim()  || 'rgba(0,0,0,0.10)';
  settingsChunkSlider.style.background =
    `linear-gradient(to right, ${filled} 0%, ${filled} ${pct}%, ${unfilled} ${pct}%, ${unfilled} 100%)`;
}

// Paint the filled portion of the blur range track.
function updateBlurSliderTrack() {
  const pct      = ((overlayBlur - BLUR_MIN) / (BLUR_MAX - BLUR_MIN)) * 100;
  const filled   = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1a6b3c';
  const unfilled = getComputedStyle(document.documentElement).getPropertyValue('--border').trim()  || 'rgba(0,0,0,0.10)';
  settingsBlurSlider.style.background =
    `linear-gradient(to right, ${filled} 0%, ${filled} ${pct}%, ${unfilled} ${pct}%, ${unfilled} 100%)`;
}

// Paint the filled portion of the randomizer frequency range track.
function updateRandSliderTrack() {
  const pct      = ((randFreq - RAND_FREQ_MIN) / (RAND_FREQ_MAX - RAND_FREQ_MIN)) * 100;
  const filled   = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1a6b3c';
  const unfilled = getComputedStyle(document.documentElement).getPropertyValue('--border').trim()  || 'rgba(0,0,0,0.10)';
  settingsRandSlider.style.background =
    `linear-gradient(to right, ${filled} 0%, ${filled} ${pct}%, ${unfilled} ${pct}%, ${unfilled} 100%)`;
}

// Apply the new font size to any overlay currently showing in the active tab,
// then persist and sync the UI — called on every slider/button interaction.
async function applyOverlayFontSize(newSize) {
  overlayFontSize = Math.max(OVERLAY_FONT_MIN, Math.min(OVERLAY_FONT_MAX, newSize));
  syncSettingsUI();
  saveOverlayFontSize();
  await sendFontUpdateToActiveTab();
}

// Apply a new chunk word count: persist, sync UI, and notify the active tab
// so the overlay re-chunks in place without needing to reload the book.
async function applyChunkWords(newCount) {
  chunkWords = Math.max(CHUNK_WORDS_MIN, Math.min(CHUNK_WORDS_MAX,
    Math.round(newCount / CHUNK_WORDS_STEP) * CHUNK_WORDS_STEP));
  syncSettingsUI();
  saveChunkWords();
  await sendChunkUpdateToActiveTab();
}

async function sendChunkUpdateToActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, {
      type      : 'UPDATE_CHUNK_WORDS',
      chunkWords: chunkWords,
    });
  } catch (_) {
    // Tab may not have a content script — silently ignore.
  }
}

// Apply a new blur level: persist, sync UI, notify active tab.
async function applyOverlayBlur(newVal) {
  overlayBlur = Math.max(BLUR_MIN, Math.min(BLUR_MAX, Math.round(newVal)));
  syncSettingsUI();
  saveOverlayBlur();
  await sendBlurUpdateToActiveTab();
}

async function sendBlurUpdateToActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, {
      type       : 'UPDATE_OVERLAY_BLUR',
      overlayBlur: overlayBlur,
    });
  } catch (_) {}
}

// Message the active tab's content script so it can update the overlay
// font size in real time without the user needing to reload the book.
async function sendFontUpdateToActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, {
      type    : 'UPDATE_OVERLAY_FONT',
      fontSize: overlayFontSize,
    });
  } catch (_) {
    // Tab may not have a content script (e.g. chrome:// pages) — silently ignore.
  }
}

// Chunk size controls.
settingsChunkSlider.addEventListener('input', () => {
  applyChunkWords(parseInt(settingsChunkSlider.value, 10));
});
settingsChunkUp.addEventListener('click', () => {
  applyChunkWords(chunkWords + CHUNK_WORDS_STEP);
});
settingsChunkDown.addEventListener('click', () => {
  applyChunkWords(chunkWords - CHUNK_WORDS_STEP);
});

// Blur controls.
settingsBlurSlider.addEventListener('input', () => {
  applyOverlayBlur(parseInt(settingsBlurSlider.value, 10));
});
settingsBlurUp.addEventListener('click', () => { applyOverlayBlur(overlayBlur + 1); });
settingsBlurDown.addEventListener('click', () => { applyOverlayBlur(overlayBlur - 1); });

// Randomizer frequency controls.
async function applyRandFreq(newVal) {
  randFreq = Math.max(RAND_FREQ_MIN, Math.min(RAND_FREQ_MAX, Math.round(newVal)));
  syncSettingsUI();
  saveRandFreq();
}

settingsRandSlider.addEventListener('input', () => {
  applyRandFreq(parseInt(settingsRandSlider.value, 10));
});
settingsRandUp.addEventListener('click', () => { applyRandFreq(randFreq + 1); });
settingsRandDown.addEventListener('click', () => { applyRandFreq(randFreq - 1); });

// ── Randomizer core ───────────────────────────────────────────────────────────
//
// The popup is a DISPLAY RENDERER ONLY.  All countdown logic lives in the
// background service worker (background.js), which ticks every second and
// fires SET_OVERLAY_FADE directly to the tab's content script when a phase
// expires.  The SW also broadcasts RAND_TICK each second so the popup can
// update its countdown display while it happens to be open.
//
// Popup responsibilities:
//   • Send RAND_START to SW when the user enables the randomizer
//   • Send RAND_STOP  to SW when the user disables it
//   • Listen for RAND_TICK from the SW and update the countdown label
//   • Reconstruct the current countdown from tab state when popup opens

// randPhase / randPhaseEnds are loaded from tab state in switchToTab().
let randPhase     = 'in';
let randPhaseEnds = 0;

function syncRandBtn() {
  if (randActive) {
    btnRandomizer.classList.add('on');
    btnRandomizer.classList.remove('off');
    btnRandomizer.title = 'Randomizer: On';
  } else {
    btnRandomizer.classList.add('off');
    btnRandomizer.classList.remove('on');
    btnRandomizer.title = 'Randomizer: Off';
  }
}

function randIntervalMs() { return RAND_WINDOW_MS / randFreq; }

// Format ms as "M:SS".
function fmtCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Render the countdown label from a remaining-ms value and phase string.
function renderCountdown(phase, remaining) {
  if (!randCountdownEl) return;
  if (!randActive || remaining == null) {
    randCountdownEl.textContent = '';
    randCountdownEl.hidden = true;
    return;
  }
  const label = phase === 'in' ? 'on in ' : 'off in ';
  randCountdownEl.textContent = label + fmtCountdown(remaining);
  randCountdownEl.hidden = false;
}

// Hide the countdown display.
function clearCountdown() {
  if (randCountdownEl) { randCountdownEl.textContent = ''; randCountdownEl.hidden = true; }
}

// Tell the SW to arm the randomizer for the active tab.
function armBackground(phase, phaseEnds) {
  if (!activeTabId) return;
  chrome.runtime.sendMessage({
    type          : 'RAND_START',
    tabId         : activeTabId,
    phase,
    phaseEnds,
    randFreq,
    overlayEnabled,
  }).catch(() => {});
}

btnRandomizer.addEventListener('click', async () => {
  randActive = !randActive;
  saveRandActive();
  syncRandBtn();

  if (randActive) {
    // Decide which phase to start in:
    //   Overlay OFF → Phase IN  (count down to next fade-in)
    //   Overlay ON  → Phase ON  (count down to fade-out)
    if (overlayEnabled) {
      randPhase     = 'on';
      randPhaseEnds = Date.now() + RAND_ON_DURATION;
      // Start the visual timer bar on the content script immediately
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
          type      : 'START_RAND_TIMER',
          onDuration: RAND_ON_DURATION,
        }).catch(() => {});
      }
    } else {
      randPhase     = 'in';
      randPhaseEnds = Date.now() + randIntervalMs();
    }
    saveTabState();
    renderCountdown(randPhase, randPhaseEnds - Date.now());
    armBackground(randPhase, randPhaseEnds);
  } else {
    randPhase     = 'in';
    randPhaseEnds = 0;
    clearCountdown();
    saveTabState();
    if (activeTabId) {
      chrome.runtime.sendMessage({ type: 'RAND_STOP', tabId: activeTabId }).catch(() => {});
      chrome.tabs.sendMessage(activeTabId, { type: 'STOP_RAND_TIMER' }).catch(() => {});
    }
  }
});

// ── RAND_TICK listener — SW pushes a tick every second ───────────────────────
// Only update display if the tick is for the tab we're currently showing.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'RAND_TICK') return;
  if (msg.tabId !== activeTabId) return;
  if (!randActive) return;
  // Update local phase mirror so switchToTab recovers correctly on re-open.
  randPhase     = msg.phase;
  randPhaseEnds = Date.now() + msg.remaining;
  renderCountdown(msg.phase, msg.remaining);
});
btnSettings.addEventListener('click', () => {
  const opening = settingsPanel.hidden;
  settingsPanel.hidden = !opening;
  btnSettings.classList.toggle('active', opening);
});

// Slider — fires on every drag step for real-time preview.
settingsFontSlider.addEventListener('input', () => {
  applyOverlayFontSize(parseInt(settingsFontSlider.value, 10));
});

// Step buttons — ±1px per click.
settingsFontUp.addEventListener('click', () => {
  applyOverlayFontSize(overlayFontSize + 1);
});
settingsFontDown.addEventListener('click', () => {
  applyOverlayFontSize(overlayFontSize - 1);
});

// ── Random book prefetch ──────────────────────────────────────────────────────
// Delegates to the SW, which is the sole authority for fetching and storing
// the prefetched book. The popup sends PREFETCH_BOOK and returns immediately —
// the SW writes to storage and the advancePhase onChanged listener picks it up.
async function prefetchRandomBook(tabId) {
  chrome.runtime.sendMessage({ type: 'PREFETCH_BOOK', tabId }).catch(() => {});
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigateTo(url, title) {
  showingBkmk = false;
  try {
    const xml  = await fetchFeed(url);
    const feed = parseFeed(xml);

    if (navStack.length > 0 || url !== ROOT_FEED) {
      const top = navStack[navStack.length - 1];
      if (!top || top.url !== url) navStack.push({ url, title: title || feed.title });
    } else {
      navStack.push({ url, title: feed.title });
    }

    renderFeed(feed, title || feed.title);
    updateBackButton();
    chrome.storage.local.set({ lastFeed: { url, title: title || feed.title } });
  } catch (err) {
    console.error('OPDS fetch failed:', err);
  }
}

function goBack() {
  navStack.pop();
  const prev = navStack[navStack.length - 1];
  if (!prev) return;
  navStack.pop();
  navigateTo(prev.url, prev.title);
}

function updateBackButton() {
  btnBack.hidden = navStack.length <= 1;
}

// ── Feed rendering ────────────────────────────────────────────────────────────
function renderFeed(feed, title) {
  feedTitle.textContent = title || feed.title;

  navList.hidden = feed.navLinks.length === 0;
  navList.innerHTML = '';
  for (const nav of feed.navLinks) {
    navList.appendChild(buildNavItem(nav));
  }

  bookList.hidden = feed.entries.length === 0;
  bookList.innerHTML = '';
  for (const book of feed.entries) {
    bookList.appendChild(buildBookCard(book));
  }

  bookmarksView.hidden = true;

  // Persist the ordered book list to storage so the SW's prefetch cursor
  // walks books in exactly the same order as the popup displays them.
  // Only write when there are real book entries (not nav-only pages).
  if (feed.entries.length > 0) {
    const ordered = feed.entries
      .filter(b => b.id)
      .map(b => ({ bookId: String(b.id), title: b.title || '', author: b.author || '' }));
    chrome.storage.local.set({ feedBookList: ordered });
  }
}

// ── Nav item ──────────────────────────────────────────────────────────────────
function buildNavItem(nav) {
  const el = document.createElement('div');
  el.className = 'nav-item';
  el.innerHTML = `
    <div class="nav-icon">📚</div>
    <div class="nav-text">
      <strong>${esc(nav.title)}</strong>
      <span>${esc(nav.summary)}</span>
    </div>
    <span class="nav-chevron">›</span>`;
  el.addEventListener('click', () => {
    if (nav.href) navigateTo(nav.href, nav.title);
  });
  return el;
}

// ── Book card ─────────────────────────────────────────────────────────────────
function buildBookCard(book) {
  const isBookmarked = !!bookmarks[book.id];

  const el = document.createElement('div');
  el.className = 'book-card';
  el.dataset.bookId = book.id;

  const coverHtml = book.coverUrl
    ? `<img class="book-cover" data-src="${esc(book.coverUrl)}" alt="" loading="lazy" />`
    : `<div class="book-cover-placeholder">📖</div>`;

  const tagsHtml = book.subjects.slice(0, 3)
    .map(s => `<span class="tag">${esc(s)}</span>`)
    .join('');

  el.innerHTML = `
    ${coverHtml}
    <div class="book-meta">
      <div class="book-title">${esc(book.title)}</div>
      <div class="book-author">${esc(book.author)}</div>
      <div class="book-summary">${esc(book.summary)}</div>
      <div class="book-tags">${tagsHtml}</div>
    </div>
    <button class="bookmark-btn ${isBookmarked ? 'active' : ''}" title="${isBookmarked ? 'Remove bookmark' : 'Bookmark'}">★</button>`;

  const img = el.querySelector('img[data-src]');
  if (img) lazyObs.observe(img);

  el.addEventListener('click', (e) => {
    if (e.target.closest('.bookmark-btn')) return;
    showDetail(book);
  });

  el.querySelector('.bookmark-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookmark(book, el);
  });

  return el;
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function showDetail(book) {
  const coverHtml = book.coverUrl
    ? `<img class="detail-cover" src="${esc(book.coverUrl)}" alt="" />`
    : '';

  const dlLinks = book.acquisitionLinks
    .map((l, i) => `<a class="dl-btn ${i > 0 ? 'secondary' : ''}" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`)
    .join('');

  const subjectTags = book.subjects
    .map(s => `<span class="tag">${esc(s)}</span>`)
    .join('');

  detailContent.innerHTML = `
    ${coverHtml}
    <h2>${esc(book.title)}</h2>
    <div class="detail-author">${esc(book.author)}</div>
    <div class="detail-summary">${esc(book.summary) || '<em>No summary available.</em>'}</div>
    <div class="detail-subjects">${subjectTags}</div>
    <div class="download-links">
      <button class="read-txt-btn" id="btn-get-txt">📄 Read in Popup</button>
      <button class="read-txt-btn overlay-btn" id="btn-send-overlay">✦ Read on Page</button>
      <button class="read-txt-btn transparent-btn" id="btn-send-overlay-transparent">👁 Read as You Type</button>
      <button class="read-txt-btn overlay-btn" id="btn-send-overlay-html">🖼 Read with Images</button>
      ${dlLinks || ''}
    </div>
    <div class="view-online">
      <a href="${esc(book.gutenbergUrl)}" target="_blank" rel="noopener">View on Project Gutenberg ↗</a>
    </div>`;

  detailPanel.hidden = false;
  detailPanel.removeAttribute('hidden');

  document.getElementById('btn-get-txt').addEventListener('click', () => {
    openReader(book);
  });

  document.getElementById('btn-send-overlay').addEventListener('click', () => {
    sendToOverlay(book, false);
  });

  document.getElementById('btn-send-overlay-transparent').addEventListener('click', () => {
    sendToOverlay(book, true);
  });

  document.getElementById('btn-send-overlay-html').addEventListener('click', () => {
    sendToOverlayHtml(book);
  });
}

btnCloseDetail.addEventListener('click', () => {
  detailPanel.hidden = true;
});

// ── Send to overlay ───────────────────────────────────────────────────────────
// Fetches the book text (same path as the popup reader) then messages the
// active tab's content script, which writes it into the glass overlay.
async function sendToOverlay(book, transparent = false) {
  const btnId = transparent ? 'btn-send-overlay-transparent' : 'btn-send-overlay';
  const btn   = document.getElementById(btnId);
  if (!btn) return;

  btn.disabled    = true;
  btn.textContent = '⏳ Fetching…';
  btn.dataset.originalText = transparent ? '👁 Read as You Type' : '✦ Read on Page';

  try {
    const response = await chrome.runtime.sendMessage({
      type            : 'FETCH_TEXT',
      bookId          : book.id,
      acquisitionLinks: book.acquisitionLinks,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'No response from background worker.');
    }

    // Get the active tab and forward the text to the content script.
    // Include the current overlayFontSize so the overlay renders at the
    // user's preferred size from the very first paint.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Could not find the active tab.');

    // ── Deterministic selection rule ──────────────────────────────────────
    // Making a manual selection always forces the overlay ON, regardless of
    // the current toggle state.  Update both in-memory state and storage so
    // the toggle button and badge stay in sync, then send the content.
    if (!overlayEnabled) {
      overlayEnabled = true;
      saveOverlayEnabled();
      syncToggleBtn();
    }

    await chrome.tabs.sendMessage(tab.id, {
      type       : 'DISPLAY_IN_OVERLAY',
      title      : `${book.title} — ${book.author}`,
      text       : response.text,
      transparent: transparent,
      fontSize   : overlayFontSize,
      chunkWords : chunkWords,
      overlayBlur: overlayBlur,
    });

    // Close the popup — the user's focus should move to the page
    window.close();

  } catch (err) {
    if (btn) {
      btn.disabled    = false;
      btn.textContent = btn.dataset.originalText || '✦ Read on Page';
      btn.title       = `Error: ${err.message}`;
    }
  }
}

// ── Send HTML (with images) to overlay ───────────────────────────────────────
// Fetches the illustrated pg{id}-images.html edition via the service worker,
// then forwards the raw HTML to the content script as DISPLAY_IN_OVERLAY with
// msg.html set. The content script sanitises and injects it into the shadow
// DOM's textEl so images and formatting render natively in the overlay.
async function sendToOverlayHtml(book) {
  const btn = document.getElementById('btn-send-overlay-html');
  if (!btn) return;

  btn.disabled    = true;
  btn.textContent = '⏳ Fetching…';

  try {
    const response = await chrome.runtime.sendMessage({
      type  : 'FETCH_HTML',
      bookId: book.id,
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'No response from background worker.');
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Could not find the active tab.');

    // ── Deterministic selection rule ──────────────────────────────────────
    // Making a manual selection always forces the overlay ON.
    if (!overlayEnabled) {
      overlayEnabled = true;
      saveOverlayEnabled();
      syncToggleBtn();
    }

    await chrome.tabs.sendMessage(tab.id, {
      type       : 'DISPLAY_IN_OVERLAY',
      title      : `${book.title} — ${book.author}`,
      html       : response.html,
      bookId     : book.id,
      transparent: false,
      fontSize   : overlayFontSize,
      chunkWords : chunkWords,
      overlayBlur: overlayBlur,
    });

    window.close();

  } catch (err) {
    if (btn) {
      btn.disabled    = false;
      btn.textContent = '🖼 Read with Images';
      btn.title       = `Error: ${err.message}`;
    }
  }
}

// ── Reader panel ──────────────────────────────────────────────────────────────
async function openReader(book) {
  detailPanel.hidden = true;
  readerPanel.hidden = false;
  readerPanel.removeAttribute('hidden');

  readerTitle.textContent = `${book.title} — ${book.author}`;
  readerBody.textContent  = '';
  readerError.hidden      = true;
  readerLoading.hidden    = false;

  try {
    const response = await chrome.runtime.sendMessage({
      type            : 'FETCH_TEXT',
      bookId          : book.id,
      acquisitionLinks: book.acquisitionLinks,
    });

    readerLoading.hidden = true;

    if (!response || !response.ok) {
      throw new Error(response?.error || 'No response from background worker.');
    }

    readerBody.textContent = response.text;
    readerBody.scrollTop   = 0;

  } catch (err) {
    readerLoading.hidden = true;
    readerError.hidden   = false;
    readerError.textContent = `⚠️ Could not load text:\n${err.message}`;
  }
}

btnCloseReader.addEventListener('click', () => {
  readerPanel.hidden = true;
});

btnFontUp.addEventListener('click', () => {
  readerFontSize = Math.min(readerFontSize + 1, 22);
  document.documentElement.style.setProperty('--reader-font-size', readerFontSize + 'px');
});
btnFontDown.addEventListener('click', () => {
  readerFontSize = Math.max(readerFontSize - 1, 9);
  document.documentElement.style.setProperty('--reader-font-size', readerFontSize + 'px');
});

// ── Bookmarks ─────────────────────────────────────────────────────────────────
async function loadBookmarks() {
  const data = await chrome.storage.local.get('bookmarks');
  return data.bookmarks || {};
}

async function saveBookmarks() {
  await chrome.storage.local.set({ bookmarks });
}

function toggleBookmark(book, cardEl) {
  const btn = cardEl.querySelector('.bookmark-btn');
  if (bookmarks[book.id]) {
    delete bookmarks[book.id];
    btn.classList.remove('active');
    btn.title = 'Bookmark';
  } else {
    bookmarks[book.id] = book;
    btn.classList.add('active');
    btn.title = 'Remove bookmark';
  }
  saveBookmarks();
}

btnBookmarks.addEventListener('click', () => {
  if (showingBkmk) {
    const top = navStack[navStack.length - 1];
    if (top) { navStack.pop(); navigateTo(top.url, top.title); }
    return;
  }
  showingBkmk = true;
  showBookmarksView();
});

function showBookmarksView() {
  navList.hidden   = true;
  bookList.hidden  = true;
  feedTitle.textContent = 'Bookmarks';
  bookmarksView.hidden  = false;
  bookmarksView.innerHTML = '';

  const bkList = Object.values(bookmarks);
  if (bkList.length === 0) {
    bookmarksView.innerHTML = `<div class="empty-bookmarks">No bookmarks yet.<br>Tap ★ on any book to save it.</div>`;
    return;
  }
  for (const book of bkList) {
    bookmarksView.appendChild(buildBookCard(book));
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;
  const url = SEARCH_BASE + encodeURIComponent(query);
  navStack.length = 0;
  navigateTo(url, `Search: ${query}`);
}

btnSearch.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

// ── Back button ───────────────────────────────────────────────────────────────
btnBack.addEventListener('click', goBack);

// ── Lazy loading ──────────────────────────────────────────────────────────────
function setupLazyObserver() {
  return new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
        lazyObs.unobserve(img);
      }
    }
  }, { rootMargin: '80px' });
}

// ── Feed fetching via SW ──────────────────────────────────────────────────────
async function fetchFeed(url) {
  const response = await chrome.runtime.sendMessage({ type: 'FETCH_FEED', url });
  if (!response) throw new Error('No response from background worker. Try reloading the extension.');
  if (!response.ok) throw new Error(response.error || 'Fetch failed');
  return response.xml;
}

// ── HTML escaping ─────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
