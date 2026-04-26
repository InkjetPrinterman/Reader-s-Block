// ── Gutenberg OPDS Service Worker ────────────────────────────────────────────
//
// RANDOMIZER RESILIENCE ARCHITECTURE
// ─────────────────────────────────────────────────────────────────────────────
// MV3 service workers are killed by the browser after ~30 s of inactivity and
// can be revived at any time.  A plain setInterval is therefore not sufficient
// on its own — it will silently stop firing the moment the SW is suspended.
//
// Solution: dual-layer keep-alive
//
//   LAYER 1 — chrome.alarms ("keepalive" alarm, every 20 s)
//     Alarms survive SW suspension.  The alarm handler re-creates the
//     setInterval if it was lost, and re-populates activeTabs from storage
//     if the in-memory Set was cleared.  This guarantees the tick resumes
//     within ≤20 s of any SW wake-up.
//
//   LAYER 2 — setInterval (1 s) for second-accurate tick
//     Drives per-second RAND_TICK broadcasts to the popup and the per-second
//     phase-expiry check.  Re-created by the alarm handler if missing.
//
// activeTabs is also mirrored to storage (key "activeTabs") so it survives
// SW termination without waiting for the next RAND_START message.
//
// HEARTBEAT
//   Each tick also sends RAND_HEARTBEAT to every active content script.
//   The content script uses this to verify the SW is alive and to re-anchor
//   the overlay's opacity/display if something reset them unexpectedly.
//   If the content script sees no heartbeat for HEARTBEAT_GRACE_MS it queries
//   state itself and self-heals.
//
// SW → content-script messages
//   SET_OVERLAY_FADE  { enabled, fadeDuration, onDuration }
//   START_RAND_TIMER  { onDuration }
//   STOP_RAND_TIMER
//   RAND_HEARTBEAT    { phase, remaining, overlayEnabled }
//
// SW → popup messages
//   RAND_TICK         { tabId, phase, remaining }
//
// popup → SW messages
//   RAND_START        { tabId, phase, phaseEnds, randFreq, overlayEnabled }
//   RAND_STOP         { tabId }
//
// content → SW messages
//   RAND_QUERY_STATE  → reply { randActive, randPhase, remaining, overlayEnabled }
//   SET_BADGE, FETCH_*, etc.

const ROOT_FEED    = 'https://www.gutenberg.org/ebooks/search.opds/';
const CACHE_TTL_MS = 30 * 60 * 1000;
const TEXT_TTL_MS  = 60 * 60 * 1000;

const RAND_WINDOW_MS    = 3 * 60 * 60 * 1000; // 3 h
const RAND_ON_DURATION  = 5 * 60 * 1000;       // 5 min ON
const RAND_FADE_MS      = 1500;
const KEEPALIVE_PERIOD  = 20;                   // alarm period in seconds
const KEEPALIVE_NAME    = 'rand_keepalive';

// ── In-memory tick state (rebuilt on every SW wake) ──────────────────────────
// activeTabs: Set of tabIds that have randActive=true.
// Rebuilt from storage on activate and on every keepalive alarm.
let activeTabs     = new Set();
let tickIntervalId = null;

// ── Install / activate ────────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', async (e) => {
  e.waitUntil((async () => {
    await clients.claim();
    await rebuildActiveTabs();
    ensureKeepaliveAlarm();
    ensureTickRunning();
    updateBadge(false);
  })());
});

// ── Keepalive alarm ───────────────────────────────────────────────────────────
// Fires every KEEPALIVE_PERIOD seconds, waking the SW and re-anchoring the
// setInterval if it was lost due to suspension.

function ensureKeepaliveAlarm() {
  chrome.alarms.get(KEEPALIVE_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(KEEPALIVE_NAME, {
        delayInMinutes: KEEPALIVE_PERIOD / 60,
        periodInMinutes: KEEPALIVE_PERIOD / 60,
      });
    }
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_NAME) return;
  // Re-anchor: rebuild in-memory state from storage if SW was suspended.
  await rebuildActiveTabs();
  ensureTickRunning();
});

// ── activeTabs persistence ────────────────────────────────────────────────────
// Mirror activeTabs Set to storage so it survives SW termination.

async function persistActiveTabs() {
  await chrome.storage.local.set({ activeTabs: [...activeTabs] });
}

async function rebuildActiveTabs() {
  const data = await chrome.storage.local.get('activeTabs');
  const stored = Array.isArray(data.activeTabs) ? data.activeTabs : [];
  // Validate each tabId is still a live tab before re-adding.
  activeTabs = new Set();
  for (const tabId of stored) {
    try {
      await chrome.tabs.get(tabId); // throws if tab doesn't exist
      const s = await loadTabState(tabId);
      if (s.randActive) activeTabs.add(tabId);
    } catch (_) {
      // Tab is gone — clean up its storage entry.
      await chrome.storage.local.remove(tabStateKey(tabId));
    }
  }
  await persistActiveTabs();
}

// ── setInterval tick ──────────────────────────────────────────────────────────

function ensureTickRunning() {
  if (activeTabs.size === 0) { stopTick(); return; }
  if (tickIntervalId !== null) return; // already running
  tickIntervalId = setInterval(onTick, 1000);
}

function stopTick() {
  if (tickIntervalId === null) return;
  clearInterval(tickIntervalId);
  tickIntervalId = null;
}

async function onTick() {
  if (activeTabs.size === 0) { stopTick(); return; }
  const now = Date.now();

  for (const tabId of [...activeTabs]) {
    const s = await loadTabState(tabId);
    if (!s.randActive) {
      activeTabs.delete(tabId);
      await persistActiveTabs();
      continue;
    }

    const remaining = s.randPhaseEnds - now;

    // ── Send RAND_TICK to popup (display only) ───────────────────────────
    chrome.runtime.sendMessage({
      type     : 'RAND_TICK',
      tabId,
      phase    : s.randPhase,
      remaining: Math.max(0, remaining),
    }).catch(() => {}); // popup closed — silently ignore

    // ── Send RAND_HEARTBEAT to content script ────────────────────────────
    // Content script uses this to re-anchor opacity/display if needed and
    // to detect SW silence.
    chrome.tabs.sendMessage(tabId, {
      type          : 'RAND_HEARTBEAT',
      phase         : s.randPhase,
      remaining     : Math.max(0, remaining),
      overlayEnabled: s.overlayEnabled,
    }).catch(() => {});

    // ── Phase expiry ─────────────────────────────────────────────────────
    if (remaining <= 0) {
      await advancePhase(tabId, s);
    }
  }
}

// ── Phase advancement ─────────────────────────────────────────────────────────
//
// RACE CONDITION FIX — storage-gated fade-in
//
// The prefetch task (popup.js → prefetchRandomBook / background.js →
// The prefetch task (prefetchBookForTab) runs on an unpredictable network
// exceed the phase IN duration. If advancePhase reads the storage key and
// finds it empty, blindly firing the fade produces a blank overlay.
//
// Resolution: when the key is missing, we register a one-shot
// chrome.storage.onChanged listener targeted at that exact key. The fade
// command is withheld until the listener fires, confirming the write is
// complete. The listener immediately unregisters itself to prevent leaks.
//
// A per-tab guard set (tabsPendingFadeIn) prevents the tick loop from calling
// advancePhase a second time for a tab that is already waiting.

const tabsPendingFadeIn = new Set();

async function advancePhase(tabId, s) {
  const intervalMs  = RAND_WINDOW_MS / Math.max(s.randFreq, 1);
  const prefetchKey = `prefetchedBook__${tabId}`;

  if (s.randPhase === 'in') {
    // Guard: do nothing if we are already waiting for this tab's prefetch.
    if (tabsPendingFadeIn.has(tabId)) return;

    // Transition state immediately so the tick loop reflects phase 'on'.
    const phaseEnds = Date.now() + RAND_ON_DURATION;
    await saveTabState(tabId, {
      overlayEnabled: true,
      randPhase     : 'on',
      randPhaseEnds : phaseEnds,
    });

    const prefetchData = await chrome.storage.local.get(prefetchKey);
    const book         = prefetchData[prefetchKey];

    if (book?.html) {
      // Book is already in storage — dispatch immediately, no waiting.
      await dispatchFadeIn(tabId, book);
    } else {
      // Book is not ready yet — hold the fade until storage is written.
      tabsPendingFadeIn.add(tabId);

      const listener = (changes, area) => {
        if (area !== 'local') return;
        if (!changes[prefetchKey]) return;
        const arrived = changes[prefetchKey].newValue;
        if (!arrived?.html) return;

        // Unregister immediately — one-shot.
        chrome.storage.onChanged.removeListener(listener);
        tabsPendingFadeIn.delete(tabId);

        // Verify the randomizer is still active before firing.
        loadTabState(tabId).then(fresh => {
          if (!fresh.randActive) return;
          dispatchFadeIn(tabId, arrived);
        }).catch(() => {});
      };

      chrome.storage.onChanged.addListener(listener);

      // Safety timeout: if the prefetch never completes (network failure,
      // all books lack HTML editions, etc.), release the gate after
      // PREFETCH_TIMEOUT_MS and fade in with whatever content exists in
      // lastDisplayMsg on the content script side (may be empty, but avoids
      // the overlay being permanently suppressed for this cycle).
      const PREFETCH_TIMEOUT_MS = 30000;
      setTimeout(() => {
        if (!tabsPendingFadeIn.has(tabId)) return; // already resolved
        chrome.storage.onChanged.removeListener(listener);
        tabsPendingFadeIn.delete(tabId);
        // Fire fade without book content — overlay shows but may be blank.
        loadTabState(tabId).then(fresh => {
          if (!fresh.randActive) return;
          fadeTab(tabId, true);
          updateBadge(true);
          chrome.tabs.sendMessage(tabId, {
            type      : 'START_RAND_TIMER',
            onDuration: RAND_ON_DURATION,
          }).catch(() => {});
        }).catch(() => {});
      }, PREFETCH_TIMEOUT_MS);
    }

  } else {
    // ON phase ended → fade overlay OFF, enter waiting phase.
    const phaseEnds = Date.now() + intervalMs;
    await saveTabState(tabId, {
      overlayEnabled: false,
      randPhase     : 'in',
      randPhaseEnds : phaseEnds,
    });
    await fadeTab(tabId, false);
    updateBadge(false);

    // Kick off a fresh prefetch for the next cycle. The onChanged listener
    // in the next advancePhase call will pick it up when it arrives.
    prefetchBookForTab(tabId);
  }
}

// dispatchFadeInWithSettings — send DISPLAY_IN_OVERLAY + SET_OVERLAY_FADE
// using explicitly supplied (or storage-read) user settings.
async function dispatchFadeInWithSettings(tabId, book, settings = {}) {
  // Load global settings from storage if caller didn't supply them.
  const stored = await chrome.storage.local.get(['overlayFontSize', 'chunkWords', 'overlayBlur']);
  const fontSize   = settings.fontSize   ?? stored.overlayFontSize ?? 28;
  const chunkWords = settings.chunkWords ?? stored.chunkWords      ?? 150;
  const overlayBlur= settings.overlayBlur ?? stored.overlayBlur   ?? 20;

  try {
    await chrome.tabs.sendMessage(tabId, {
      type       : 'DISPLAY_IN_OVERLAY',
      title      : `${book.title} — ${book.author}`,
      html       : book.html,
      bookId     : String(book.bookId),
      transparent: false,
      fontSize,
      chunkWords,
      overlayBlur,
    });
  } catch (_) {}

  await fadeTab(tabId, true);
  updateBadge(true);
  chrome.tabs.sendMessage(tabId, {
    type      : 'START_RAND_TIMER',
    onDuration: RAND_ON_DURATION,
  }).catch(() => {});
}

// Dispatch DISPLAY_IN_OVERLAY then SET_OVERLAY_FADE to the content script.
// Called both when book is immediately available and when the onChanged
// listener fires after a delayed write.
async function dispatchFadeIn(tabId, book) {
  await dispatchFadeInWithSettings(tabId, book);
}

// ── Book prefetch — ordered by popup feed list ────────────────────────────────
// The popup writes `feedBookList` to storage after every renderFeed call —
// an array of { bookId, title, author } in exactly the order they appear on
// screen.  The SW reads this list and walks it with a per-tab cursor so each
// fade-in cycle advances to the next book in popup order, wrapping when the
// list is exhausted.  No shuffling.  No regex XML parsing in the SW.
// If feedBookList is not yet written (popup never opened), fall back to a
// small hardcoded list of well-known Gutenberg IDs with HTML editions.

const FALLBACK_BOOK_IDS = [
  '1342',  // Pride and Prejudice
  '11',    // Alice's Adventures in Wonderland
  '84',    // Frankenstein
  '1661',  // The Adventures of Sherlock Holmes
  '98',    // A Tale of Two Cities
  '2701',  // Moby Dick
  '74',    // Adventures of Huckleberry Finn
  '1952',  // The Yellow Wallpaper
  '345',   // Dracula
  '1400',  // Great Expectations
];

async function getFeedEntries() {
  const data = await chrome.storage.local.get('feedBookList');
  if (Array.isArray(data.feedBookList) && data.feedBookList.length > 0) {
    return data.feedBookList; // popup-ordered list
  }
  // Fallback: return the hardcoded list as minimal entry objects.
  return FALLBACK_BOOK_IDS.map(id => ({ bookId: id, title: `Book #${id}`, author: 'Project Gutenberg' }));
}

async function prefetchBookForTab(tabId) {
  const prefetchKey = `prefetchedBook__${tabId}`;
  const cursorKey   = `bookIndex__${tabId}`;

  try {
    await chrome.storage.local.remove(prefetchKey);

    // ── Bookmark check ────────────────────────────────────────────────────────
    // If the user bookmarked a book in the overlay, repeat it every cycle
    // without advancing the cursor.
    const bmData = await chrome.storage.local.get(['overlayBookmarked', 'overlayBookmarkedId']);
    if (bmData.overlayBookmarked === true && bmData.overlayBookmarkedId) {
      const bookId = String(bmData.overlayBookmarkedId);
      try {
        const html = await fetchBookHtml(bookId);
        if (html) {
          // Re-use whatever title/author we have in the existing prefetch or
          // fall back to a generic label — the title is already in lastDisplayMsg
          // on the content script side so visual display is unaffected.
          const existingData = await chrome.storage.local.get(prefetchKey);
          const prev = existingData[prefetchKey];
          await chrome.storage.local.set({
            [prefetchKey]: {
              bookId,
              title : prev?.title  || `Book #${bookId}`,
              author: prev?.author || 'Project Gutenberg',
              html,
              ts    : Date.now(),
            },
          });
          return; // done — cursor not advanced
        }
      } catch (_) {
        // HTML fetch failed for bookmarked book — fall through to normal cursor
      }
    }

    // ── Normal ordered cursor ─────────────────────────────────────────────────
    const entries = await getFeedEntries();
    if (entries.length === 0) return;

    const cursorData = await chrome.storage.local.get(cursorKey);
    let   startIndex = typeof cursorData[cursorKey] === 'number' ? cursorData[cursorKey] : 0;
    startIndex = startIndex % entries.length;

    for (let i = 0; i < entries.length; i++) {
      const idx   = (startIndex + i) % entries.length;
      const entry = entries[idx];
      try {
        const html = await fetchBookHtml(entry.bookId);
        if (!html) continue;

        await chrome.storage.local.set({ [cursorKey]: (idx + 1) % entries.length });
        await chrome.storage.local.set({
          [prefetchKey]: {
            bookId: entry.bookId,
            title : entry.title,
            author: entry.author,
            html,
            ts    : Date.now(),
          },
        });
        return;
      } catch (_) {
        await chrome.storage.local.set({ [cursorKey]: (idx + 1) % entries.length });
        continue;
      }
    }
  } catch (_) {
    // Network failure — the 30 s safety timeout in advancePhase handles this.
  }
}

// ── Fade helper ───────────────────────────────────────────────────────────────

async function fadeTab(tabId, enabled) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type        : 'SET_OVERLAY_FADE',
      enabled,
      fadeDuration: RAND_FADE_MS,
      onDuration  : RAND_ON_DURATION,
    });
  } catch (_) {}
}


// ── Per-tab state ─────────────────────────────────────────────────────────────

function tabStateKey(tabId) { return `tabState__${tabId}`; }

async function loadTabState(tabId) {
  const key  = tabStateKey(tabId);
  const data = await chrome.storage.local.get(key);
  const s    = data[key] || {};
  return {
    overlayEnabled: s.overlayEnabled === true,
    randActive    : s.randActive     === true,
    randPhase     : s.randPhase === 'on' ? 'on' : 'in',
    randPhaseEnds : typeof s.randPhaseEnds === 'number' ? s.randPhaseEnds : 0,
    randFreq      : typeof s.randFreq === 'number' ? s.randFreq : 6,
  };
}

async function saveTabState(tabId, patch) {
  const key  = tabStateKey(tabId);
  const data = await chrome.storage.local.get(key);
  const s    = data[key] || {};
  await chrome.storage.local.set({ [key]: { ...s, ...patch } });
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'FETCH_FEED') {
    cachedFetch(msg.url)
      .then(xml  => sendResponse({ ok: true, xml }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_TEXT') {
    fetchBookText(msg.bookId, msg.acquisitionLinks || [])
      .then(text => sendResponse({ ok: true, text }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_HTML') {
    fetchBookHtml(msg.bookId)
      .then(html => sendResponse({ ok: true, html }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SET_BADGE') {
    updateBadge(msg.enabled);
    return false;
  }

  // ── RAND_START ────────────────────────────────────────────────────────────
  if (msg.type === 'RAND_START') {
    const { tabId, phase, phaseEnds, randFreq, overlayEnabled } = msg;
    saveTabState(tabId, {
      randActive: true, randPhase: phase,
      randPhaseEnds: phaseEnds, randFreq, overlayEnabled,
    }).then(async () => {
      activeTabs.add(tabId);
      await persistActiveTabs();
      ensureKeepaliveAlarm();
      ensureTickRunning();
      // On first arm (phase IN), immediately begin prefetching so the book
      // is ready — or at least in-flight — before the countdown expires.
      if (phase === 'in') {
        prefetchBookForTab(tabId);
      }
    });
    return false;
  }

// ── FORCE_DISPATCH — popup requests an immediate overlay show ─────────────
// Sent when the user flips the overlay toggle ON and the content script
// reports it has no cached lastDisplayMsg to replay.  We dispatch the
// prefetched book if one is ready, or trigger a fresh prefetch and wait
// for it via the storage-onChanged gate (same path as advancePhase).
if (msg.type === 'FORCE_DISPATCH') {
  const { tabId, fontSize, chunkWords, overlayBlur } = msg;
  if (!tabId) return false;

  (async () => {
    const prefetchKey  = `prefetchedBook__${tabId}`;
    const prefetchData = await chrome.storage.local.get(prefetchKey);
    const book         = prefetchData[prefetchKey];

    if (book?.html) {
      // Book ready — dispatch immediately with user settings.
      await dispatchFadeInWithSettings(tabId, book, { fontSize, chunkWords, overlayBlur });
    } else {
      // Nothing cached yet — prefetch then dispatch via onChanged gate.
      tabsPendingFadeIn.add(tabId);
      const listener = (changes, area) => {
        if (area !== 'local' || !changes[prefetchKey]) return;
        const arrived = changes[prefetchKey].newValue;
        if (!arrived?.html) return;
        chrome.storage.onChanged.removeListener(listener);
        tabsPendingFadeIn.delete(tabId);
        dispatchFadeInWithSettings(tabId, arrived, { fontSize, chunkWords, overlayBlur }).catch(() => {});
      };
      chrome.storage.onChanged.addListener(listener);
      // Safety timeout — 30 s, same as advancePhase gate.
      setTimeout(() => {
        if (!tabsPendingFadeIn.has(tabId)) return;
        chrome.storage.onChanged.removeListener(listener);
        tabsPendingFadeIn.delete(tabId);
        // Show overlay even with no content so the toggle feels responsive.
        fadeTab(tabId, true);
        updateBadge(true);
      }, 30000);
      prefetchBookForTab(tabId);
    }
  })();
  return false;
}

  if (msg.type === 'PREFETCH_BOOK') {
    const { tabId } = msg;
    if (tabId) prefetchBookForTab(tabId);
    return false;
  }

  // ── RAND_STOP ─────────────────────────────────────────────────────────────
  if (msg.type === 'RAND_STOP') {
    const { tabId } = msg;
    activeTabs.delete(tabId);
    tabsPendingFadeIn.delete(tabId); // release any waiting gate
    persistActiveTabs();
    saveTabState(tabId, { randActive: false });
    if (activeTabs.size === 0) stopTick();
    return false;
  }

  // ── RAND_QUERY_STATE — content script asks for current phase/remaining ────
  // Used by the content script heartbeat to self-heal if the overlay state
  // drifted while the SW was suspended.
  if (msg.type === 'RAND_QUERY_STATE') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse(null); return false; }
    loadTabState(tabId).then(s => {
      const remaining = s.randPhaseEnds - Date.now();
      sendResponse({
        randActive    : s.randActive,
        randPhase     : s.randPhase,
        remaining     : Math.max(0, remaining),
        overlayEnabled: s.overlayEnabled,
      });
    });
    return true; // async response
  }

  // Legacy — no-op
  if (msg.type === 'RAND_TIMER_EXPIRED') return false;

  return false;
});

// ── Badge ─────────────────────────────────────────────────────────────────────

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#1a6b3c' : '#888888' });
  chrome.action.setTitle({ title: `Reader's Block — Overlay ${enabled ? 'ON' : 'OFF'}` });
}

// ── Book text fetching ────────────────────────────────────────────────────────

async function fetchBookText(bookId, acquisitionLinks) {
  const cacheKey = 'booktext__' + bookId;
  const stored   = await chrome.storage.local.get(cacheKey);
  const entry    = stored[cacheKey];
  if (entry && (Date.now() - entry.ts) < TEXT_TTL_MS) return entry.text;

  const id = String(bookId);
  if (!/^\d+$/.test(id)) throw new Error(`Invalid book ID "${id}".`);

  const candidates = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    `https://www.gutenberg.org/files/${id}/${id}.txt`,
  ];
  for (const url of candidates) {
    const text = await tryFetchText(url);
    if (text) { await chrome.storage.local.set({ [cacheKey]: { text, ts: Date.now() } }); return text; }
  }
  throw new Error(`Could not retrieve plain text for book #${id}.`);
}

async function tryFetchText(url) {
  if (!url) return null;
  try {
    const res  = await fetch(url, { headers: { Accept: 'text/plain, */*' } });
    if (!res.ok) return null;
    const buf  = await res.arrayBuffer();
    const text = stripBom(new TextDecoder('utf-8').decode(buf));
    if (!text || text.length < 500) return null;
    const head = text.trimStart().slice(0, 100).toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) return null;
    return stripGutenbergFooter(stripGutenbergHeader(text)).replace(/_/g, '');
  } catch (_) { return null; }
}

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

function stripGutenbergHeader(text) {
  const m = /\*{2,}\s*START\s+OF\s+(?:THE\s+)?PROJECT\s+GUTENBERG\s+EBOOK[^\n]*/i.exec(text);
  return m ? text.slice(m.index + m[0].length).trimStart() : text;
}

function stripGutenbergFooter(text) {
  const m = /\*{2,}\s*END\s+OF\s+(?:THE\s+)?PROJECT\s+GUTENBERG\s+EBOOK[^\n]*\*{2,}/i.exec(text);
  return m ? text.slice(0, m.index).trimEnd() : text;
}

// ── Book HTML fetching ────────────────────────────────────────────────────────

const HTML_TTL_MS = 60 * 60 * 1000;

async function fetchBookHtml(bookId) {
  const id       = String(bookId);
  const cacheKey = 'bookhtml__' + id;
  if (!/^\d+$/.test(id)) throw new Error(`Invalid book ID "${id}".`);
  const stored = await chrome.storage.local.get(cacheKey);
  const entry  = stored[cacheKey];
  if (entry && (Date.now() - entry.ts) < HTML_TTL_MS) return entry.html;
  const url = `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.html`;
  const res = await fetch(url, { headers: { Accept: 'text/html, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for book #${id}`);
  const html = await res.text();
  if (!html || html.length < 200) throw new Error(`Empty HTML for book #${id}`);
  const stripped = stripGutenbergHtml(html);
  await chrome.storage.local.set({ [cacheKey]: { html: stripped, ts: Date.now() } });
  return stripped;
}

function stripGutenbergHtml(raw) {
  const sRe = /\*{2,}\s*START\s+OF\s+(?:THE\s+)?PROJECT\s+GUTENBERG\s+EBOOK[^<\r\n]*(?:<\/[^>]+>)?/i;
  const eRe = /(?:<[^/][^>]*>)?\s*\*{2,}\s*END\s+OF\s+(?:THE\s+)?PROJECT\s+GUTENBERG\s+EBOOK[^<\r\n]*\*{2,}/i;
  let r = raw;
  const sm = sRe.exec(r); if (sm) r = r.slice(sm.index + sm[0].length).replace(/^\s+/, '');
  const em = eRe.exec(r); if (em) r = r.slice(0, em.index).trimEnd();
  return r;
}

// ── OPDS feed caching ─────────────────────────────────────────────────────────

async function cachedFetch(url) {
  const key    = 'feed__' + url;
  const stored = await chrome.storage.local.get(key);
  const entry  = stored[key];
  if (entry && (Date.now() - entry.ts) < CACHE_TTL_MS) return entry.xml;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const xml = await res.text();
  await chrome.storage.local.set({ [key]: { xml, ts: Date.now() } });
  return xml;
}
