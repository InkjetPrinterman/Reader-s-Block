(() => {
  // ── 2. Build host + Shadow DOM ────────────────────────────────────────────
  const host   = document.createElement('div');
  host.id      = 'liquid-glass-extension-root';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }

      /* ── Wrapper — borderless blur host ── */
      .lg-wrapper {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);

        width: max-content;
        height: max-content;
        min-width: 220px;
        /* min-height is set dynamically in applyConstraints() */
        box-sizing: border-box;

        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 28px 36px 22px;

        /* Fully transparent — text only, no background or blur */
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        background: transparent;

        z-index: 2147483647;
        pointer-events: auto;
        cursor: default;
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
        user-select: none;
        transition: max-width 0.2s ease, max-height 0.2s ease;
      }

      /* ── Content layer ── */
      .lg-content {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-height: 0;
      }

      /* ── Book title bar ── */
      .lg-book-title {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.10em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.55);
        text-align: center;
        flex-shrink: 0;
        display: none;
      }

      /* ── Text scroll container ── */
      /* flex: 1 + min-height: 0 lets it fill exactly the space the wrapper   */
      /* allocates after chrome (title, hint). overflow: hidden clips it to    */
      /* that boundary so the mask gradient coordinates always match the        */
      /* visible region regardless of zoom level or wrapper pixel dimensions.  */
      .lg-text-scroll {
        position: relative;
        flex: 1;
        width: 100%;
        min-height: 0;
        overflow: hidden;
        -webkit-mask-image: none;
        mask-image: none;
        transition: -webkit-mask-image 0.25s ease, mask-image 0.25s ease;
      }

      /* ── Text element ── */
      /* width: 100% anchors text width to lg-text-scroll, which is anchored  */
      /* to the wrapper, which is 93.33% vpW — so text width scales with viewport */
      /* at any zoom level. height / overflow are set by JS (applyConstraints) */
      /* so the element scrolls within the scroll container.                   */
      .lg-text {
        font-size: 18px;
        line-height: 1.45;
        font-weight: 500;
        color: rgba(255,255,255,0.92);
        letter-spacing: 0.01em;
        text-align: center;

        outline: none;
        border: none;
        min-width: 0;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        word-break: break-word;
        white-space: pre-wrap;
        cursor: text;
        user-select: text;

        border-bottom: 1px solid rgba(255,255,255,0.15);
        padding-bottom: 2px;
        transition: border-color 0.2s;

        overflow-y: auto;
        overflow-x: hidden;
      }

      .lg-text.book-mode {
        font-size: 13px;
        font-weight: 400;
        text-align: left;
        letter-spacing: 0;
        font-family: 'Georgia', 'Times New Roman', serif;
        border-bottom-style: none;
        color: rgba(255,255,255,0.88);
      }

      /* html-mode: injected book HTML renders as normal flow content.        */
      /* white-space must be 'normal' so the browser collapses whitespace      */
      /* between tags as expected; pre-wrap would print every newline/space.   */
      /* Images are display:block with a max-width cap so they never overflow  */
      /* the overlay width and scale proportionally to the container.          */
      .lg-text.html-mode {
        white-space: normal;
      }
      .lg-text.html-mode img {
        display: block;
        max-width: 100%;
        height: auto;
        margin: 0.75em auto;
        border-radius: 3px;
      }

      .lg-text:focus         { border-bottom-color: rgba(255,255,255,0.35); }
      .lg-text:empty::before {
        content: attr(data-placeholder);
        color: rgba(255,255,255,0.35);
        font-weight: 400;
        font-style: italic;
        pointer-events: none;
      }

      .lg-text::-webkit-scrollbar        { width: 3px; }
      .lg-text::-webkit-scrollbar-track  { background: transparent; }
      .lg-text::-webkit-scrollbar-thumb  {
        background: rgba(255,255,255,0.20);
        border-radius: 3px;
      }

      /* ── Hint ── */
      .lg-hint {
        font-size: 10px;
        font-weight: 500;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.40);
        flex-shrink: 0;
      }

      /* ── Dismiss button ── */
      .lg-close {
        position: absolute;
        top: 10px;
        right: 12px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: transparent;
        border: none;
        color: rgba(255,255,255,0.55);
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s;
        z-index: 3;
        pointer-events: auto;
        user-select: none;
      }
      .lg-close:hover {
        background: transparent;
        color: rgba(255,255,255,0.9);
      }

      /* ── Bookmark toggle ── */
      /* Sits immediately left of the close button. Uses an inline SVG bookmark */
      /* shape: outline-only when off, filled when on.                           */
      .lg-bookmark {
        position: absolute;
        top: 10px;
        right: 36px;          /* close is at right:12, 20px wide → 12+20+4 gap */
        width: 16px;
        height: 20px;
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 0;
        z-index: 3;
        pointer-events: auto;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.55;
        transition: opacity 0.15s;
      }
      .lg-bookmark:hover { opacity: 0.9; }
      .lg-bookmark.active { opacity: 1; }

      /* The SVG path fill/stroke is toggled by JS via .active class */
      .lg-bookmark svg .bm-shape {
        stroke: rgba(255,255,255,0.9);
        stroke-width: 1.5;
        fill: none;
        transition: fill 0.18s, stroke 0.18s;
      }
      .lg-bookmark.active svg .bm-shape {
        fill: rgba(255,255,255,0.9);
        stroke: rgba(255,255,255,0.9);
      }

      /* ── Randomizer countdown bar ── */
      /* 3px strip flush at the bottom of the wrapper. Shrinks left→right via   */
      /* scaleX transform so the filled portion always starts from the left      */
      /* edge. When the transition ends (bar = zero) we fire RAND_TIMER_EXPIRED  */
      /* back to the popup, which triggers the fade-out.                         */
      .lg-timer-bar {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 3px;
        width: 100%;
        border-radius: 0;
        background: linear-gradient(
          to right,
          rgba(255,255,255,0.90) 0%,
          rgba(160,220,255,0.75) 50%,
          rgba(255,255,255,0.40) 100%
        );
        transform-origin: left center;
        transform: scaleX(1);
        transition: transform linear;   /* duration set dynamically by JS */
        opacity: 0;
        pointer-events: none;
      }
      .lg-timer-bar.visible {
        opacity: 1;
      }
    </style>

    <div class="lg-wrapper" id="lg-wrapper">
      <button class="lg-bookmark" id="lg-bookmark-btn" title="Bookmark this book">
        <svg width="12" height="16" viewBox="0 0 12 16" xmlns="http://www.w3.org/2000/svg">
          <path class="bm-shape" d="M1 1 h10 v14 l-5 -3.5 -5 3.5 Z" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
      </button>
      <button class="lg-close" id="lg-close-btn" title="Dismiss">✕</button>

      <div class="lg-content">
        <div class="lg-book-title" id="lg-book-title"></div>
        <div class="lg-text-scroll" id="lg-text-scroll">
          <div
            class="lg-text"
            id="lg-text"
            contenteditable="true"
            spellcheck="false"
            data-placeholder="Type something…"
          >Sample Overlay Text</div>
        </div>
        <span class="lg-hint" id="lg-hint"></span>
      </div>

      <!-- Randomizer countdown bar — always last child so it overlays the bottom edge -->
      <div class="lg-timer-bar" id="lg-timer-bar"></div>
    </div>
  `;

  document.body.appendChild(host);

  // Overlay is hidden by default until the user enables it via the popup toggle.
  // This state is kept in sync with chrome.storage 'overlayEnabled'.
  host.style.display = 'none';

  // ── 3. Element refs ───────────────────────────────────────────────────────
  const wrapper    = shadow.getElementById('lg-wrapper');
  const scrollWrap = shadow.getElementById('lg-text-scroll');
  const textEl     = shadow.getElementById('lg-text');
  const bookTitle  = shadow.getElementById('lg-book-title');
  const hintEl     = shadow.getElementById('lg-hint');
  const timerBar    = shadow.getElementById('lg-timer-bar');
  const bookmarkBtn = shadow.getElementById('lg-bookmark-btn');

  // ── 4. Constants ──────────────────────────────────────────────────────────
  // ── 5. Chrome height measurement ─────────────────────────────────────────
  let chromeHeight = 0;

  function measureChromeHeight() {
    // Chrome height = wrapper interior minus the flex scroll container.
    // Both values come from getBoundingClientRect which is zoom-adjusted,
    // so this is always correct at any zoom level. No need to collapse
    // textEl — the wrapper has a fixed JS-set height, scrollWrap has flex:1,
    // so their difference is exactly the chrome (close btn, title, hint).
    const wRect = wrapper.getBoundingClientRect();
    const sRect = scrollWrap.getBoundingClientRect();
    chromeHeight = Math.round(wRect.height - sRect.height);
  }

  // ── 6. Fade mask logic ────────────────────────────────────────────────────
  // FADE_FRACTION: the fade band height is this fixed proportion of the
  // overlay box height (lockedH = 80% of viewport).  At any zoom level
  // lockedH scales with the viewport in CSS px, so the band scales too —
  // no font measurement, no line-height lookup, no hardcoded pixel constant.
  //
  // The distance between the bottom edge of the top band and the top edge
  // of the bottom band is always containerH − 2 × fadepx, an invariant
  // derived purely from the box proportion, not from content.
  const FADE_FRACTION = 0.08; // 8% of overlay box height per fade band

  function updateFadeMask() {
    const scrollTop = textEl.scrollTop;
    const scrollBot = textEl.scrollHeight - textEl.clientHeight - scrollTop;
    const hasTop    = scrollTop > 1;
    const hasBot    = scrollBot > 1;

    if (!hasTop && !hasBot) {
      scrollWrap.style.webkitMaskImage = 'none';
      scrollWrap.style.maskImage       = 'none';
      return;
    }

    // containerH is the visible height of the scroll container — the element
    // the mask is painted on. Since .lg-text-scroll has flex:1 + overflow:hidden
    // it is always exactly the wrapper interior height, which equals lockedH
    // minus chrome. We read clientHeight directly so the value is always
    // accurate at any zoom level without needing lockedH at all.
    const containerH = scrollWrap.clientHeight;
    const fadepx     = Math.round(containerH * FADE_FRACTION);
    const botStart   = containerH - fadepx;

    const topGrad = hasTop
      ? `linear-gradient(to bottom, transparent 0px, black ${fadepx}px, black 100%)`
      : 'linear-gradient(black, black)';

    const botGrad = hasBot
      ? `linear-gradient(to bottom, black 0%, black ${botStart}px, transparent ${containerH}px)`
      : 'linear-gradient(black, black)';

    const maskValue = `${topGrad}, ${botGrad}`;
    scrollWrap.style.webkitMaskImage     = maskValue;
    scrollWrap.style.maskImage           = maskValue;
    scrollWrap.style.webkitMaskComposite = 'source-in, destination-in';
    scrollWrap.style.maskComposite       = 'intersect';
  }

  // ── 7. Constraint application ─────────────────────────────────────────────
  let scrollEngaged = false;

  // lockedW / lockedH — the wrapper's fixed pixel dimensions.
  // Set once by the first applyConstraints() call (93.33% vpW × 80% vpH),
  // then frozen. Reset to null only on window resize so the overlay
  // re-proportions correctly if the viewport changes.
  let lockedW = null;
  let lockedH = null;

  // applyLockedConstraints — used by font-resize and chunk-resize paths.
  // Wrapper dimensions are already fixed; this only re-caps textEl's
  // maxHeight in case chromeHeight changed (e.g. title bar toggled).
  function applyLockedConstraints() {
    if (lockedW === null) { applyConstraints(); return; }
    // Wrapper dimensions are frozen. textEl fills its container via CSS
    // (height:100%, overflow-y:auto on .lg-text), so nothing to set here —
    // just ensure the scroll listener is wired and refresh the fade mask.
    if (!scrollEngaged) {
      scrollEngaged = true;
      textEl.addEventListener('scroll', updateFadeMask);
    }
    updateFadeMask();
  }

  function applyConstraints() {
    // Wrapper is always 93.33% of viewport width × 80% of viewport height.
    // (Original 70% × 60% increased by 1/3: ×4/3 each axis.)
    // window.innerWidth/innerHeight are CSS pixels, already zoom-adjusted.
    const boxW = Math.round(window.innerWidth  * 0.9333);
    const boxH = Math.round(window.innerHeight * 0.80);

    wrapper.style.width     = boxW + 'px';
    wrapper.style.maxWidth  = boxW + 'px';
    wrapper.style.height    = boxH + 'px';
    wrapper.style.maxHeight = boxH + 'px';
    wrapper.style.minHeight = '';

    // textEl fills .lg-text-scroll via CSS (height:100%, overflow-y:auto),
    // and .lg-text-scroll fills the wrapper interior via flex:1 + min-height:0.
    // No JS height assignment needed — CSS propagates the wrapper dimensions
    // all the way down to the scrollable text element automatically.

    if (!scrollEngaged) {
      scrollEngaged = true;
      textEl.addEventListener('scroll', updateFadeMask);
    }
    updateFadeMask();

    lockedW = boxW;
    lockedH = boxH;
  }

  // ── 8. Bootstrap ──────────────────────────────────────────────────────────
  requestAnimationFrame(() => {
    measureChromeHeight();
    applyConstraints();
  });

  textEl.addEventListener('input', applyConstraints);

  window.addEventListener('resize', () => {
    measureChromeHeight();
    applyConstraints();
  });

  // ── 9. Dismiss ────────────────────────────────────────────────────────────
  let userDismissed = false;
  shadow.getElementById('lg-close-btn').addEventListener('click', () => {
    userDismissed = true;
    stopTimerBar();
    host.remove();
  });

  // ── 10. Overlay bookmark toggle ───────────────────────────────────────────
  // When active: the current book is preserved for all subsequent fade-ins.
  // The SW reads 'overlayBookmarked' storage key in prefetchBookForTab —
  // if true, it skips the cursor advance and re-fetches the same book.
  // State is stored in chrome.storage.local so it persists across sessions.
  // The current bookId is stored as 'overlayBookmarkedId' so the SW knows
  // which book to repeat.

  let bookmarkActive = false;
  let bookmarkBookId = null; // bookId of the currently displayed book

  function syncBookmarkBtn() {
    if (bookmarkActive) {
      bookmarkBtn.classList.add('active');
      bookmarkBtn.title = 'Bookmarked — repeating this book';
    } else {
      bookmarkBtn.classList.remove('active');
      bookmarkBtn.title = 'Bookmark this book';
    }
  }

  // Load persisted bookmark state on init.
  chrome.storage.local.get(['overlayBookmarked', 'overlayBookmarkedId'], (data) => {
    bookmarkActive = data.overlayBookmarked === true;
    bookmarkBookId = data.overlayBookmarkedId || null;
    syncBookmarkBtn();
  });

  bookmarkBtn.addEventListener('click', () => {
    bookmarkActive = !bookmarkActive;
    const patch = { overlayBookmarked: bookmarkActive };
    if (bookmarkActive && bookmarkBookId) {
      patch.overlayBookmarkedId = bookmarkBookId;
    } else if (!bookmarkActive) {
      patch.overlayBookmarkedId = null;
    }
    chrome.storage.local.set(patch);
    syncBookmarkBtn();
  });

  // Called by DISPLAY_IN_OVERLAY handler to update bookmarkBookId when a
  // new book is loaded into the overlay. Does not change active state.
  function setCurrentBookId(id) {
    bookmarkBookId = id ? String(id) : null;
    // If bookmark is active, keep the stored ID in sync.
    if (bookmarkActive && bookmarkBookId) {
      chrome.storage.local.set({ overlayBookmarkedId: bookmarkBookId });
    }
  }

  // ── 10. Select-all on first focus ─────────────────────────────────────────
  let firstFocus = true;
  textEl.addEventListener('focus', () => {
    if (!firstFocus) return;
    firstFocus = false;
    setTimeout(() => {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }, 0);
  });

  // ── 11. Escape blurs (non-transparent mode only) ──────────────────────────
  textEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') textEl.blur();
  });

  // ── 12. Message listener — receive book text from popup ───────────────────
  //
  // Two message types handled:
  //
  //   DISPLAY_IN_OVERLAY  — initial render; carries full book text + fontSize.
  //   UPDATE_OVERLAY_FONT — real-time resize from the settings slider;
  //     updates font size on the live overlay without re-rendering content.

  // Mutable ref to the wrapper — written on DISPLAY_IN_OVERLAY so that
  // UPDATE_OVERLAY_BLUR can update backdrop-filter and background in real time.
  let activeWrapper = null;

  // applyBlurToWrapper — maps blur level (0–20) to CSS properties.
  //   blur px   = level × 1.5   (20 → 30px)
  //   scrim alpha = level / 20 × 0.55  (20 → rgba(0,0,0,0.55))
  // At level 0 both are zero — fully transparent, matching the current default.
  function applyBlurToWrapper(el, level) {
    const blurPx = (level * 1.5).toFixed(1);
    const alpha  = ((level / 20) * 0.55).toFixed(3);
    el.style.backdropFilter         = `blur(${blurPx}px)`;
    el.style.webkitBackdropFilter   = `blur(${blurPx}px)`;
    el.style.background             = `rgba(0,0,0,${alpha})`;
  }

  // Mutable ref to the book text element — written on DISPLAY_IN_OVERLAY,
  // read by UPDATE_OVERLAY_FONT. null = no book overlay currently visible.
  let activeBookTextEl = null;

  // Mutable ref to the currently-active keyboard capture handler for
  // transparent-mode typing.  Kept at IIFE scope so that a second
  // DISPLAY_IN_OVERLAY message can tear down the previous book's handler
  // before installing the new one — preventing stale handlers from
  // consuming keystrokes via stopImmediatePropagation.
  let currentOverlayKeyHandler = null;

  // ── Last DISPLAY_IN_OVERLAY message cache ─────────────────────────────────
  // Stored so that SET_OVERLAY_ENABLED:true can replay the last book onto the
  // page immediately, without the user needing to refresh or re-select the book.
  let lastDisplayMsg = null;

  // ── Randomizer countdown bar helpers ─────────────────────────────────────
  // The bar uses a single CSS scaleX transition (transform-origin: left) so it
  // shrinks from full-width to nothing over exactly onDuration ms — perfectly
  // smooth, zero rAF overhead.
  //
  // When the transition ends (bar = zero width) we send RAND_TIMER_EXPIRED to
  // the popup, which is responsible for triggering the fade-out and scheduling
  // the next fade-in.  The bar itself never drives the fade — it only reports.
  //
  //   startTimerBar(durationMs)  — show bar at full width, start countdown
  //   stopTimerBar()             — hide instantly, cancel expiry listener

  let timerBarRafId      = null;
  let timerBarExpirySent = false;

  // ── SW-silence watchdog ───────────────────────────────────────────────────
  // Tracks the last time a RAND_HEARTBEAT arrived from the SW.
  // If more than HEARTBEAT_GRACE_MS passes with no beat, we assume the SW
  // was suspended and query its state to self-heal the overlay.
  const HEARTBEAT_GRACE_MS = 25000; // 25 s — SW keepalive fires every 20 s
  let lastHeartbeatAt = 0;

  setInterval(() => {
    if (lastHeartbeatAt === 0) return; // heartbeats never started — nothing to guard
    if (Date.now() - lastHeartbeatAt < HEARTBEAT_GRACE_MS) return; // still live
    // SW appears silent — query current state and reconcile.
    lastHeartbeatAt = Date.now(); // reset so we don't spam queries
    chrome.runtime.sendMessage({ type: 'RAND_QUERY_STATE' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      if (!resp.randActive) return;
      // SW is alive again. Re-anchor the overlay state.
      if (resp.overlayEnabled) {
        if (!userDismissed && !document.getElementById('liquid-glass-extension-root')) {
          document.body.appendChild(host);
        }
        host.style.display  = '';
        host.style.opacity  = '1';
        host.style.transition = '';
        if (resp.randPhase === 'on' && resp.remaining > 0) {
          const barVisible = timerBar.classList.contains('visible');
          if (!barVisible) startTimerBar(resp.remaining);
        }
      }
    });
  }, 10000); // check every 10 s

  function onTimerBarTransitionEnd() {
    timerBar.removeEventListener('transitionend', onTimerBarTransitionEnd);
    if (!timerBarExpirySent) {
      timerBarExpirySent = true;
      chrome.runtime.sendMessage({ type: 'RAND_TIMER_EXPIRED' }).catch(() => {});
    }
  }

  function startTimerBar(durationMs) {
    stopTimerBar();
    timerBarExpirySent = false;

    // Snap back to full width with no transition, then in the next two frames
    // engage the linear transition and drive to scaleX(0).
    timerBar.style.transition = 'none';
    timerBar.style.transform  = 'scaleX(1)';
    timerBar.classList.add('visible');

    timerBarRafId = requestAnimationFrame(() => {
      timerBarRafId = requestAnimationFrame(() => {
        timerBar.addEventListener('transitionend', onTimerBarTransitionEnd, { once: true });
        timerBar.style.transition = `transform ${durationMs}ms linear`;
        timerBar.style.transform  = 'scaleX(0)';
        timerBarRafId = null;
      });
    });
  }

  function stopTimerBar() {
    timerBar.removeEventListener('transitionend', onTimerBarTransitionEnd);
    if (timerBarRafId !== null) {
      cancelAnimationFrame(timerBarRafId);
      timerBarRafId = null;
    }
    timerBar.style.transition = 'none';
    timerBar.style.transform  = 'scaleX(1)';
    timerBar.classList.remove('visible');
    timerBarExpirySent = false;
  }

  // handleMessage — the single internal entry point for all incoming messages.
  // Registered as the chrome.runtime listener AND called directly for replays.
  function handleMessage(msg) {
    // ── Live font resize ──────────────────────────────────────────────────
    if (msg.type === 'UPDATE_OVERLAY_FONT') {
      if (!activeBookTextEl) return;
      const size = (typeof msg.fontSize === 'number' && msg.fontSize > 0)
        ? msg.fontSize : 13;
      activeBookTextEl.style.fontSize = size + 'px';
      // Only re-cap textEl's scroll height within the already-locked wrapper —
      // do NOT call measureChromeHeight() or applyConstraints() here, as that
      // would remeasure content and resize the outer wrapper.
      applyLockedConstraints();
      return;
    }

    if (msg.type === 'UPDATE_OVERLAY_BLUR') {
      if (!activeWrapper) return;
      const level = (typeof msg.overlayBlur === 'number')
        ? Math.max(0, Math.min(20, msg.overlayBlur)) : 0;
      applyBlurToWrapper(activeWrapper, level);
      return;
    }

    if (msg.type === 'STOP_RAND_TIMER') {
      stopTimerBar();
      return;
    }

    // START_RAND_TIMER — sent when randomizer activates while overlay is already ON
    if (msg.type === 'START_RAND_TIMER') {
      const dur = (typeof msg.onDuration === 'number' && msg.onDuration > 0)
        ? msg.onDuration : 300000;
      startTimerBar(dur);
      return;
    }

    // ── RAND_HEARTBEAT — SW ticks every second while randomizer is active ─────
    //
    // Two jobs:
    //
    //   1. DOM ANCHOR — If the host element was removed from the document
    //      (SPA navigation, aggressive page script, etc.) or its visibility
    //      was reset to hidden/opacity-0 by the host page, re-attach it and
    //      restore the correct visual state.
    //
    //   2. TIMER BAR SYNC — If the overlay is in phase 'on' but the timer bar
    //      is not running (e.g. the page was backgrounded when START_RAND_TIMER
    //      arrived and the CSS transition never started), restart the bar with
    //      the correct remaining time so it stays in sync with the SW clock.
    //
    // We record `lastHeartbeatAt` on every beat.  A separate setInterval
    // (HEARTBEAT_GRACE_MS) checks for SW silence and queries state to self-heal
    // if the SW was suspended and beats stopped arriving.
    if (msg.type === 'RAND_HEARTBEAT') {
      lastHeartbeatAt = Date.now();

      if (msg.overlayEnabled) {
        // ── DOM anchor ────────────────────────────────────────────────────
        // Re-attach if host was removed from the page — but never if the
        // user explicitly dismissed it via the close button.
        if (!userDismissed && !document.getElementById('liquid-glass-extension-root')) {
          document.body.appendChild(host);
        }
        // Restore opacity/display if something reset them.
        if (host.style.display === 'none' || host.style.display === '') {
          host.style.display  = '';
          host.style.opacity  = '1';
          host.style.transition = '';
        }
        if (host.style.opacity !== '1') {
          // Caught mid-transition or wrongly zeroed — snap back to visible.
          host.style.transition = 'none';
          host.style.opacity    = '1';
        }

        // ── Timer bar sync ────────────────────────────────────────────────
        if (msg.phase === 'on' && typeof msg.remaining === 'number' && msg.remaining > 0) {
          const barVisible = timerBar.classList.contains('visible');
          const barMoving  = timerBar.style.transform !== 'scaleX(1)' &&
                             timerBar.style.transform !== '';
          if (!barVisible || !barMoving) {
            // Bar is absent or stalled — restart it with remaining time.
            startTimerBar(msg.remaining);
          }
        }
      }
      return;
    }

    if (msg.type === 'UPDATE_CHUNK_WORDS') {
      // Only meaningful while a book is displayed in transparent mode.
      // `initChunks` and related variables are only in scope inside the
      // transparent-mode branch, so we use a closure ref stored below.
      if (typeof activeRechunk === 'function') {
        const wc = (typeof msg.chunkWords === 'number' && msg.chunkWords >= 50)
          ? msg.chunkWords : 150;
        activeRechunk(wc);
      }
      return;
    }

    if (msg.type === 'SET_OVERLAY_ENABLED') {
      if (!msg.enabled) {
        // Turning overlay off — hide immediately, stop any timer bar
        stopTimerBar();
        host.style.display = 'none';
      } else {
        // Turning overlay on — show, then immediately query the SW for current
        // rand state so the timer bar reconciles without waiting for the next tick.
        if (lastDisplayMsg) {
          host.style.display = '';
          Promise.resolve().then(() => handleMessage(lastDisplayMsg));
        } else {
          host.style.display = '';
        }
        // Async state query — does not block the display
        chrome.runtime.sendMessage({ type: 'RAND_QUERY_STATE' }, (resp) => {
          if (chrome.runtime.lastError || !resp) return;
          if (!resp.randActive) return;
          if (resp.randPhase === 'on' && resp.remaining > 0) {
            // Overlay is in the ON phase — start the bar at current remaining time
            startTimerBar(resp.remaining);
          }
          // If phase is 'in' (waiting to fade in), no bar shown — the fade-in
          // will come from the SW tick via SET_OVERLAY_FADE when the time comes.
        });
      }
      return;
    }

    // ── Smooth fade on/off — driven by the SW randomizer ─────────────────────
    if (msg.type === 'SET_OVERLAY_FADE') {
      const dur = (typeof msg.fadeDuration === 'number' && msg.fadeDuration > 0)
        ? msg.fadeDuration : 1500;
      // onDuration: the full ON-phase duration sent by the SW (used for the bar
      // only when this is the start of a fresh ON phase).
      const onDuration = (typeof msg.onDuration === 'number' && msg.onDuration > 0)
        ? msg.onDuration : 300000;

      if (msg.enabled) {
        // SW commanded a fresh fade-in — treat as a new overlay session.
        // DISPLAY_IN_OVERLAY is always sent by the SW before this message
        // (via dispatchFadeIn), so lastDisplayMsg is already populated.
        userDismissed = false;

        if (lastDisplayMsg) {
          host.style.opacity    = '0';
          host.style.transition = `opacity ${dur}ms ease`;
          host.style.display    = '';
          Promise.resolve().then(() => handleMessage(lastDisplayMsg));
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              host.style.opacity = '1';
              startTimerBar(onDuration);
            });
          });
        } else {
          // Fallback: no book content yet — show overlay anyway.
          host.style.transition = `opacity ${dur}ms ease`;
          host.style.opacity    = '0';
          host.style.display    = '';
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              host.style.opacity = '1';
              startTimerBar(onDuration);
            });
          });
        }
      } else {
        // Fade out, then hide — stop the bar first
        stopTimerBar();
        host.style.transition = `opacity ${dur}ms ease`;
        host.style.opacity    = '0';
        host.addEventListener('transitionend', () => {
          host.style.display    = 'none';
          host.style.transition = '';
        }, { once: true });
        setTimeout(() => {
          if (host.style.opacity === '0') {
            host.style.display    = 'none';
            host.style.transition = '';
          }
        }, dur + 200);
      }
      return;
    }

    if (msg.type !== 'DISPLAY_IN_OVERLAY') return;

    // Cache for replay when the toggle is turned back on.
    lastDisplayMsg = msg;

    // Track which book is currently displayed for the bookmark toggle.
    setCurrentBookId(msg.bookId || null);

    // If the overlay toggle is currently OFF, store for later but don't show.
    // The SET_OVERLAY_ENABLED handler will replay this message when turned on.
    if (host.style.display === 'none') return;

    // If overlay was hidden by the toggle, show it again for the new book
    host.style.display = '';

    bookTitle.textContent   = msg.title || '';
    bookTitle.style.display = msg.title ? 'block' : 'none';

    textEl.classList.add('book-mode');
    textEl.setAttribute('contenteditable', 'false');
    hintEl.textContent   = '';
    hintEl.style.display = 'none';

    // Apply the font size sent from the settings panel before any layout
    // measurement so the overlay renders at the correct size from the first frame.
    const bookFontSize = (typeof msg.fontSize === 'number' && msg.fontSize > 0)
      ? msg.fontSize : 13;
    textEl.style.fontSize = bookFontSize + 'px';

    // Keep refs so live-update messages can reach the wrapper and text element.
    activeBookTextEl = textEl;
    activeWrapper    = wrapper;

    // Apply initial blur level from settings (0 = fully transparent).
    const initBlur = (typeof msg.overlayBlur === 'number')
      ? Math.max(0, Math.min(20, msg.overlayBlur)) : 0;
    applyBlurToWrapper(wrapper, initBlur);

    // Expose a rechunk callback so UPDATE_CHUNK_WORDS can trigger re-init.
    // This is assigned inside the transparent branch (below) once initChunks
    // is in scope; for opaque mode it stays null (chunking not used).
    let activeRechunk = null;

    if (msg.transparent) {
      // ── Transparent reveal mode ───────────────────────────────────────────
      //
      // Rules enforced here:
      //
      //   SINGLE CURSOR HIGHLIGHT
      //     `cursorSpan` is the single variable that owns the highlighted span.
      //     clearCursorHighlight() is the ONE place that strips outline styles
      //     and nulls the reference. setCursor() always calls it first. No
      //     other code path touches outline styles on character spans.
      //     Consequence: at most one span is ever outlined at a time.
      //
      //   CASE SENSITIVITY
      //     Matching uses `pressed === ch` where `pressed` is taken directly
      //     from e.key (which the browser already resolves for Shift state).
      //     'T' and 't' are different strings, so they never cross-match.
      //
      //   SPECIAL CHARACTER SENSITIVITY
      //     e.key for printable characters is exactly the produced glyph:
      //     Shift+1 → '!', Shift+' → '"', etc. Since we compare pressed === ch
      //     with no transformation, '"', '!', '>', ':', and all other specials
      //     require their own exact key press.
      //
      //   NEWLINES AS SPACES
      //     '\n' chars are stored as isNewline=true entries in chars[]. A real
      //     text node is inserted into the DOM so visual line breaks render
      //     correctly. The user presses Space (not Enter) to advance past them.

      textEl.style.opacity = '1';

      // ── Pre-process ───────────────────────────────────────────────────
      // Use the raw book text without collapsing newlines so that transparent
      // mode preserves the same original line spacing and paragraph formatting
      // as the opaque "Read on Page" mode.  The chunker and buildChunk already
      // handle \n correctly: each \n becomes an isNewline entry in chars[]
      // rendered as a DOM text node, and the user presses Space to advance past it.
      const normalised = msg.text;

      // ── Chunking & virtual window ──────────────────────────────────────
      //
      // The full normalised text is split into fixed word-count chunks once,
      // up front.  Only a sliding window of chunks is ever in the DOM at once:
      //
      //   [ ... placeholder ... | BUFFER | VISIBLE | BUFFER | ... placeholder ... ]
      //
      // BUFFER_CHUNKS chunks are kept rendered above and below the visible
      // viewport at all times.  Chunks outside that window are replaced by
      // lightweight <div> height-spacers so scrollHeight stays accurate and
      // scrollTop never jumps.
      //
      // chars[] stability guarantee:
      //   chars[] is the single source of truth for the typing mechanic.
      //   It is populated once per chunk when that chunk is first built and
      //   never modified again.  Evicting a chunk removes its DOM nodes but
      //   leaves chars[] entries and their .el references untouched — those
      //   elements simply become detached.  The typing mechanic only ever
      //   interacts with the chunk containing `cursor`, which is always kept
      //   in the DOM (it sits inside the visible viewport by definition).

      // chunkWords — controlled by the popup settings panel.
      // msg.chunkWords is the persisted value; falls back to 150.
      let chunkWords    = (typeof msg.chunkWords === 'number' && msg.chunkWords >= 50)
        ? msg.chunkWords : 150;
      const BUFFER_CHUNKS = 2;   // rendered chunks to keep above & below visible

      // ── Mutable split state — rebuilt by initChunks() ──────────────────
      // Declared with let so initChunks() can replace them in place.
      let chunkStrings = [];
      let TOTAL_CHUNKS = 0;
      let chunkMeta    = [];

      // chars[] — the single source of truth for the typing mechanic.
      // Entries are never removed; .el refs are nulled when a chunk is evicted
      // and re-populated when it is rendered again.
      const chars = [];

      // ── splitNormalised — produce chunk strings from normalised text ───
      // Splits the text into word-count-bounded chunks while preserving ALL
      // whitespace (spaces and newlines) so that paragraph breaks and line
      // spacing are identical to the opaque "Read on Page" mode.
      //
      // All whitespace (including \n\n paragraph breaks) between chunks is
      // included at the START of the next chunk's string, so buildChunk stores
      // it faithfully in chars[].  The inter-chunk separator space that buildChunk
      // previously injected has been removed to avoid inserting a spurious space
      // at chunk boundaries that may fall inside a paragraph break.
      function splitNormalised(wordCount) {
        const result = [];
        let pos = 0;
        while (pos < normalised.length) {
          let wc = 0;
          let i  = pos;
          while (i < normalised.length && wc < wordCount) {
            // Skip whitespace to find the start of the next word.
            while (i < normalised.length && (normalised[i] === ' ' || normalised[i] === '\n')) i++;
            if (i >= normalised.length) break;
            // Advance through the word.
            while (i < normalised.length && normalised[i] !== ' ' && normalised[i] !== '\n') i++;
            wc++;
          }
          // `i` now points just past the last word character (or end-of-string).
          // Slice up to `i`; do NOT advance pos past any trailing whitespace —
          // those newlines/spaces belong to the next chunk so paragraph breaks
          // are never swallowed at a chunk boundary.
          result.push(normalised.slice(pos, i));
          pos = i;
        }
        return result;
      }

      // ── buildChunk — create chars[] entries for chunk i ───────────────
      // Does not touch the DOM.  Safe to call multiple times (no-op if built).
      // NOTE: No inter-chunk separator space is injected here.  All whitespace
      // (including paragraph-break newlines) between chunks is preserved at the
      // start of each chunk string by splitNormalised, so it arrives here as
      // ordinary characters and is stored faithfully in chars[].
      function buildChunk(i) {
        if (chunkMeta[i].built) return;
        const meta  = chunkMeta[i];
        meta.charStart = chars.length;

        for (const ch of chunkStrings[i]) {
          if (ch === '\n') {
            chars.push({ el: null, ch: '\n', isNewline: true, chunkIdx: i });
          } else {
            chars.push({ el: null, ch, isNewline: false, chunkIdx: i });
          }
        }

        meta.charEnd = chars.length;
        meta.built   = true;
      }

      // ── renderChunk — build DOM nodes for chunk i and insert them ─────
      // Replaces the placeholder if one exists; otherwise appends.
      // Precondition: buildChunk(i) has been called.
      function renderChunk(i) {
        if (chunkMeta[i].rendered) return;
        const meta = chunkMeta[i];
        buildChunk(i); // ensure chars[] entries exist

        const container = document.createElement('span');
        container.dataset.chunk = i;
        const frag = document.createDocumentFragment();

        for (let j = meta.charStart; j < meta.charEnd; j++) {
          const entry = chars[j];
          if (entry.isNewline) {
            const tn = document.createTextNode('\n');
            frag.appendChild(tn);
            entry.el = null; // newlines have no span
          } else if (entry.ch === ' ') {
            const sp = document.createElement('span');
            sp.dataset.idx = j;
            sp.textContent = ' ';
            entry.el = sp;
            frag.appendChild(sp);
          } else {
            const sp = document.createElement('span');
            sp.dataset.idx = j;
            sp.textContent = entry.ch;
            // Preserve reveal state — if already typed, show at full opacity.
            sp.style.opacity = entry.revealed ? '1' : '0.5';
            entry.el = sp;
            frag.appendChild(sp);
          }
        }

        container.appendChild(frag);

        if (meta.placeholder) {
          // Swap placeholder out for the real container, preserving scroll position.
          const savedTop = textEl.scrollTop;
          textEl.replaceChild(container, meta.placeholder);
          textEl.scrollTop = savedTop;
          meta.placeholder = null;
        } else {
          // No placeholder — find the right position to insert.
          // Insert before the placeholder/container of chunk i+1 if it exists,
          // otherwise append.
          let insertBefore = null;
          for (let k = i + 1; k < TOTAL_CHUNKS; k++) {
            if (chunkMeta[k].placeholder) { insertBefore = chunkMeta[k].placeholder; break; }
            if (chunkMeta[k].container)   { insertBefore = chunkMeta[k].container;   break; }
          }
          if (insertBefore) {
            textEl.insertBefore(container, insertBefore);
          } else {
            textEl.appendChild(container);
          }
        }

        meta.container = container;
        meta.rendered  = true;
      }

      // ── evictChunk — remove DOM nodes for chunk i, replace with spacer ─
      // chars[] entries are preserved; only .el refs become detached.
      function evictChunk(i) {
        if (!chunkMeta[i].rendered) return;
        const meta = chunkMeta[i];

        // Measure the real pixel height before removal.
        const h = meta.container.getBoundingClientRect().height;

        const placeholder = document.createElement('div');
        placeholder.dataset.chunkPlaceholder = i;
        placeholder.style.cssText = `height:${h}px;flex-shrink:0;`;

        // Nullify el refs so typing mechanic reads no stale DOM nodes.
        for (let j = meta.charStart; j < meta.charEnd; j++) {
          chars[j].el = null;
        }

        const savedTop = textEl.scrollTop;
        textEl.replaceChild(placeholder, meta.container);
        textEl.scrollTop = savedTop;

        meta.container   = null;
        meta.placeholder = placeholder;
        meta.rendered    = false;
      }

      // ── chunkIndexForCharIdx ──────────────────────────────────────────
      // Returns which chunk owns the given chars[] index.
      // Because chunks are built in order and charEnd is set when built,
      // we can binary-search once enough chunks are built, or linear scan.
      function chunkIndexForCharIdx(charIdx) {
        // Ensure all chunks up to the one containing charIdx are built
        // so their charStart/charEnd are populated.
        for (let k = 0; k < TOTAL_CHUNKS; k++) {
          if (!chunkMeta[k].built) buildChunk(k);
          if (chunkMeta[k].charEnd > charIdx) return k;
        }
        return TOTAL_CHUNKS - 1;
      }

      // ── windowUpdate — main virtual-window maintenance ────────────────
      // Called on every scroll event (and once at init).
      // 1. Determines which chunk the scroll viewport intersects.
      // 2. Ensures BUFFER_CHUNKS on each side are rendered.
      // 3. Evicts chunks outside the render window.
      // 4. Loads the next unbuilt chunk if the trailing buffer edge needs it.

      function windowUpdate() {
        // Step 1 — find the "anchor" chunk: the first chunk whose container
        // (or placeholder) has its bottom edge below the current scrollTop.
        const scrollTop = textEl.scrollTop;
        let anchorChunk = 0;
        let cumH = 0;
        for (let k = 0; k < TOTAL_CHUNKS; k++) {
          const meta = chunkMeta[k];
          let h = 0;
          if (meta.rendered && meta.container) {
            h = meta.container.getBoundingClientRect().height;
          } else if (meta.placeholder) {
            h = parseFloat(meta.placeholder.style.height) || 0;
          }
          cumH += h;
          if (cumH >= scrollTop) { anchorChunk = k; break; }
          if (k === TOTAL_CHUNKS - 1) anchorChunk = k;
        }

        // Step 2 — desired render window.
        const windowStart = Math.max(0, anchorChunk - BUFFER_CHUNKS);
        const windowEnd   = Math.min(TOTAL_CHUNKS - 1, anchorChunk + BUFFER_CHUNKS + 1);

        // Step 3 — build + render chunks inside the window.
        for (let k = windowStart; k <= windowEnd; k++) {
          if (!chunkMeta[k].built) buildChunk(k);
          if (!chunkMeta[k].rendered) renderChunk(k);
        }

        // Step 4 — evict chunks outside the window.
        for (let k = 0; k < TOTAL_CHUNKS; k++) {
          if (k < windowStart || k > windowEnd) {
            if (chunkMeta[k].rendered) evictChunk(k);
          }
        }

        // Step 5 — ensure trailing buffer chunk is built (no-op if initChunks
        // already built all chunks eagerly, which is the normal path).
        const trailChunk = windowEnd + 1;
        if (trailChunk < TOTAL_CHUNKS && !chunkMeta[trailChunk].built) {
          buildChunk(trailChunk);
        }
      }

      // ── initChunks — (re-)initialise the entire virtual window ──────────
      //
      // Called once at startup, and again whenever UPDATE_CHUNK_WORDS fires.
      // On re-init: the cursor position is preserved by finding the equivalent
      // character in the new split (chars[] is rebuilt from scratch so the
      // index mapping changes). `revealed` state is preserved via the
      // `revealedSet` snapshot taken before the reset.
      //
      // Between the old and new split, cursor continuity is best-effort:
      // we snap to the start of the nearest chunk that contains the same
      // character offset in the normalised string.
      let nextUnbuiltChunk = 0;

      function initChunks(wordCount, preserveCursor) {
        // Snapshot revealed state before wiping chars[].
        const revealedSet = new Set();
        for (let j = 0; j < chars.length; j++) {
          if (chars[j].revealed) revealedSet.add(j);
        }
        // Record the normalised-text offset of the current cursor (if any)
        // so we can re-snap after the split.
        let cursorNormOffset = 0;
        if (preserveCursor && cursor < chars.length) {
          // Walk chars[] up to cursor summing character contributions.
          // chars[] entries map 1:1 to normalised characters (newlines and
          // non-newline alike), so the offset is simply `cursor`.
          cursorNormOffset = cursor;
        }

        // Wipe DOM.
        textEl.innerHTML = '';

        // Rebuild split.
        chunkStrings = splitNormalised(wordCount);
        TOTAL_CHUNKS = chunkStrings.length;
        chunkMeta    = Array.from({ length: TOTAL_CHUNKS }, () => ({
          built: false, charStart: 0, charEnd: 0,
          rendered: false, container: null, placeholder: null,
        }));

        // Wipe and rebuild chars[].
        chars.length = 0;
        for (let k = 0; k < TOTAL_CHUNKS; k++) buildChunk(k);

        // Restore revealed flags.
        // The chars[] length may differ after re-split (different chunk count
        // means the whitespace distribution between chunks changes), but the
        // raw character sequence is the same — re-apply revealed flags by
        // direct index mapping.  revealed is sparse (user has only typed a
        // fraction of the book), so mapping old index → new index directly is
        // safe: the character at each index is the same character from the
        // original text regardless of where chunk boundaries fall.
        for (const oldIdx of revealedSet) {
          if (oldIdx < chars.length) chars[oldIdx].revealed = true;
        }

        // Re-snap cursor to the same logical offset, clamped to valid range.
        if (preserveCursor) {
          cursor = Math.min(cursorNormOffset, chars.length - 1);
          // Advance past any already-revealed chars (setCursor will do this
          // too, but doing it here keeps the cursor from jumping back).
        }

        nextUnbuiltChunk = TOTAL_CHUNKS; // all already built above

        // Render chunk 0 immediately so there is visible text.
        renderChunk(0);

        // Insert height-spacer placeholders for all remaining chunks in rAF
        // batches so the initial paint is not blocked.
        (function buildAllPlaceholders() {
          const BATCH = 20;
          let k = 1;
          function batch() {
            const end = Math.min(k + BATCH, TOTAL_CHUNKS);
            for (; k < end; k++) {
              if (!chunkMeta[k].rendered && !chunkMeta[k].placeholder) {
                const est = document.createElement('div');
                est.dataset.chunkPlaceholder = k;
                const estLines = Math.ceil(chunkStrings[k].split(' ').length / 8);
                const fontPx   = parseFloat(textEl.style.fontSize) || 28;
                const lineH    = fontPx * 1.75;
                est.style.cssText = `height:${estLines * lineH}px;flex-shrink:0;`;
                textEl.appendChild(est);
                chunkMeta[k].placeholder = est;
              }
            }
            if (k < TOTAL_CHUNKS) requestAnimationFrame(batch);
            else requestAnimationFrame(windowUpdate); // settle the window after all placeholders
          }
          requestAnimationFrame(batch);
        })();

        requestAnimationFrame(windowUpdate);
      }

      // ── Scroll listener ───────────────────────────────────────────────
      textEl.addEventListener('scroll', windowUpdate, { passive: true });

      // ── Kick off initial chunking ─────────────────────────────────────
      initChunks(chunkWords, false);

      // Expose rechunk so the outer UPDATE_CHUNK_WORDS handler can trigger it.
      activeRechunk = (newWordCount) => {
        chunkWords = newWordCount;
        clearCursorHighlight();
        initChunks(chunkWords, true);
        // After re-init, re-seat the cursor on a rendered span.
        // Use the locked path so chunk-size changes never resize the wrapper.
        requestAnimationFrame(() => {
          setCursor(cursor);
          applyLockedConstraints();
          updateFadeMask();
        });
      };

      // ── Cursor state ──────────────────────────────────────────────────────

      let cursor     = 0;    // index of the next character awaiting input
      let cursorSpan = null; // THE single span that currently has an outline

      // Tracks which newline indices have been passed with Space.
      const revealedNewlines = new Set();

      // clearCursorHighlight — sole authority for removing the outline.
      // After this returns: cursorSpan === null, no span has an outline.
      function clearCursorHighlight() {
        if (cursorSpan) {
          cursorSpan.style.outline      = '';
          cursorSpan.style.borderRadius = '';
          cursorSpan = null;
        }
      }

      // setCursor — moves the logical cursor to idx, skipping already-done
      // positions, then applies the outline to the new position (if it has
      // a visible span). Enforces single-highlight by calling
      // clearCursorHighlight() unconditionally before setting anything.
      function setCursor(idx) {
        clearCursorHighlight(); // ← always first; removes old highlight

        // Skip past completed positions.
        // Use entry.revealed (set when a character is typed) rather than
        // reading .el.style.opacity, because .el may be null when that chunk
        // has been evicted from the DOM by the virtual window.
        while (idx < chars.length) {
          const e = chars[idx];
          // Passed newline → skip
          if (e.isNewline && revealedNewlines.has(idx)) { idx++; continue; }
          // Revealed visible character → skip (use the persistent flag, not DOM state)
          if (!e.isNewline && e.ch !== ' ' && e.revealed) { idx++; continue; }
          break; // un-passed newline, space, or unrevealed character — stop
        }

        cursor = idx;

        // Ensure the chunk that owns `cursor` is rendered so .el refs are live.
        if (cursor < chars.length) {
          const cursorChunkIdx = chunkIndexForCharIdx(cursor);
          if (!chunkMeta[cursorChunkIdx].rendered) {
            renderChunk(cursorChunkIdx);
          }
        }

        // Apply highlight to the new position — only if it has a real span
        // (newlines have no span, so they get no highlight; cursorSpan stays
        // null, meaning zero outlines in the DOM for that position).
        if (cursor < chars.length) {
          const e = chars[cursor];
          if (!e.isNewline && e.el) {
            cursorSpan = e.el;                                    // ← sole assignment
            cursorSpan.style.outline      = '1px solid rgba(255,255,255,0.7)';
            cursorSpan.style.borderRadius = '1px';

            // Sub-2px rule: if the glyph's rendered pixel width is less than
            // 2px the character is effectively invisible and the user has no
            // meaningful target to type toward. Auto-reveal it and keep
            // advancing until the cursor lands on a glyph wide enough to see.
            // getBoundingClientRect() is called only here — once per setCursor
            // call — so the layout cost is bounded and non-cumulative.
            while (cursor < chars.length) {
              const cur = chars[cursor];
              if (cur.isNewline || !cur.el) break;  // newline — normal handling
              const w = cur.el.getBoundingClientRect().width;
              if (w >= 2) break;                    // visible — stop here
              // Too narrow: silently reveal and advance.
              cur.el.style.opacity      = '1';
              cur.el.style.outline      = '';
              cur.el.style.borderRadius = '';
              cur.revealed = true; // persist across evict/re-render cycles
              if (cursorSpan === cur.el) cursorSpan = null;
              cursor++;
              // Apply highlight to the next candidate if it has a span.
              if (cursor < chars.length && !chars[cursor].isNewline && chars[cursor].el) {
                cursorSpan = chars[cursor].el;
                cursorSpan.style.outline      = '1px solid rgba(255,255,255,0.7)';
                cursorSpan.style.borderRadius = '1px';
              } else {
                cursorSpan = null;
              }
            }
          }
        }

        // Auto-scroll: keep the cursor span vertically centred in textEl.
        // spanRect.top is relative to the viewport; textElRect.top is too.
        // The span's position relative to textEl's visible area is therefore
        // spanRect.top - textElRect.top. We want that to equal half of
        // textEl's client height, so we adjust scrollTop by the difference.
        if (cursorSpan) {
          const spanRect   = cursorSpan.getBoundingClientRect();
          const textRect   = textEl.getBoundingClientRect();
          const spanMid    = spanRect.top + spanRect.height / 2;
          const targetMid  = textRect.top + textEl.clientHeight / 2;
          textEl.scrollTop += spanMid - targetMid;
        }
      }

      setCursor(0);

      // ── Click to reposition cursor ────────────────────────────────────────
      textEl.addEventListener('click', (ev) => {
        if (ev.target && ev.target.dataset && ev.target.dataset.idx !== undefined) {
          setCursor(parseInt(ev.target.dataset.idx, 10));
        }
      });

      // ── Keyboard lock — document capture phase ────────────────────────────
      //
      // useCapture=true puts this listener ahead of every other handler on
      // the page (including other capture listeners at lower nodes).
      // stopImmediatePropagation + preventDefault fully consume the event:
      // no browser default action, no site hotkey, nothing downstream fires.

      // normalizeForMatch — maps typographic Unicode characters to their
      // closest typeable ASCII equivalent for the purpose of key matching.
      // The source text is displayed as-is; only the comparison uses this.
      function normalizeForMatch(ch) {
        switch (ch) {
          // Quotation marks
          case '\u201C': case '\u201D': return '"'; // “” → "
          case '\u2018': case '\u2019': return "'"; // ‘’ → '
          case '\u00AB': case '\u00BB': return '"'; // «» → "
          case '\u2039': case '\u203A': return "'"; // ‹› → '
          // Dashes
          case '\u2014': return '-'; // em dash — → -
          case '\u2013': return '-'; // en dash – → -
          case '\u2012': return '-'; // figure dash ‒ → -
          // Ellipsis
          case '\u2026': return '.'; // … → .
          // Non-breaking and other spaces
          case '\u00A0': case '\u202F': case '\u2009': return ' ';
          // Accented / ligature letters that have a common ASCII base
          default: {
            // NFD decomposes accented characters into base + combining mark;
            // we take just the base letter so e.g. é → e, ü → u.
            const nfd = ch.normalize('NFD');
            if (nfd.length > 1) return nfd[0];
            return ch; // already plain ASCII or unmapped — compare as-is
          }
        }
      }

      // ── Double-Enter failsafe state ───────────────────────────────────────
      // Tracks whether the immediately preceding keydown was an Enter press.
      // Two consecutive Enter presses fill in the currently highlighted glyph
      // and advance the cursor — a failsafe for users who cannot type the
      // required special character (e.g. smart quotes, em-dashes, accented
      // letters) using any available keyboard key.
      // The flag is cleared by any non-Enter key so partial sequences do not
      // accumulate across unrelated keystrokes.
      let lastWasEnter = false;

      function overlayKeyHandler(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();

        // Escape: release lock, remove overlay.
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', overlayKeyHandler, true);
          if (currentOverlayKeyHandler === overlayKeyHandler) currentOverlayKeyHandler = null;
          host.remove();
          return;
        }

        if (cursor >= chars.length) return;

        // ── Double-Enter failsafe ─────────────────────────────────────────
        // First Enter: arm the failsafe (no visible action).
        // Second Enter (consecutive): force-reveal the highlighted glyph and
        // advance, regardless of what the character is.  This lets users pass
        // any character they cannot physically type (rare Unicode, etc.).
        if (e.key === 'Enter') {
          if (lastWasEnter) {
            // Second Enter — fill in the current position unconditionally.
            lastWasEnter = false;
            const entry = chars[cursor];
            if (entry.isNewline) {
              // Newline position: count it as revealed via Space-equivalent.
              revealedNewlines.add(cursor);
              setCursor(cursor + 1);
            } else if (entry.el) {
              const { el, ch } = entry;
              if (ch !== ' ') {
                el.style.opacity      = '1';
                el.style.outline      = '';
                el.style.borderRadius = '';
                entry.revealed = true;
                cursorSpan = null;
              }
              setCursor(cursor + 1);
            }
          } else {
            // First Enter — arm; wait for a second Enter.
            lastWasEnter = true;
          }
          return;
        }

        // Any non-Enter key disarms the failsafe.
        lastWasEnter = false;

        // ── Tab: skip up to 5 consecutive spaces ─────────────────────────
        //
        // Tab may only traverse space characters (' '). It stops as soon as
        // the next position is a newline, an unrevealed glyph, or end-of-text.
        // If the cursor is not currently sitting on a space, Tab is a no-op —
        // it never skips over glyphs that still need to be typed.
        //
        // Spaces traversed by Tab are marked `revealed` so that setCursor's
        // completed-position skip logic never re-lands on them, and so that
        // a subsequent rechunk/re-render restores the correct visual state.
        if (e.key === 'Tab') {
          const TAB_SPACE_LIMIT = 5;
          // Guard: only act if the cursor is on a plain space right now.
          if (cursor < chars.length && !chars[cursor].isNewline && chars[cursor].ch === ' ') {
            let skipped = 0;
            let idx = cursor;
            while (idx < chars.length && skipped < TAB_SPACE_LIMIT) {
              const entry = chars[idx];
              // Stop at anything that isn't a plain space.
              if (entry.isNewline || entry.ch !== ' ') break;
              // Mark the space as passed so rechunk/re-render preserves state.
              entry.revealed = true;
              skipped++;
              idx++;
            }
            // Move the cursor to the first non-space (or limit) position.
            // setCursor's internal skip-loop will honour the newly-revealed
            // spaces and land on the next character awaiting input.
            setCursor(idx);
          }
          // If not on a space: Tab is silently consumed (no-op).
          return;
        }

        // Resolve what the user typed.
        //
        // e.key is already the final character produced by the key combination
        // (the browser applies Shift, AltGr, etc. before we see it):
        //   Shift+t       → 'T'
        //   Shift+1       → '!'
        //   Shift+;       → ':'
        //   Shift+<       → '>'
        //   Shift+"       → '"'  (on US layout)
        //
        // We only accept single-character e.key values plus Space.
        // Multi-character values (e.g. 'Backspace', 'ArrowUp', 'F1') are
        // non-printable and are silently ignored.
        const pressed =
          e.key === 'Spacebar' ? ' '    : // old browser alias
          e.key === ' '        ? ' '    :
          e.key.length === 1   ? e.key  : // exact printable char, case intact
          null;                           // non-printable — ignore

        if (pressed === null) return;

        const entry = chars[cursor];

        // ── Newline position: only Space advances ─────────────────────────
        if (entry.isNewline) {
          if (pressed === ' ') {
            revealedNewlines.add(cursor);
            setCursor(cursor + 1); // clearCursorHighlight called inside
          }
          // Any other key at a newline: silently blocked.
          return;
        }

        // ── Visible character or space position ───────────────────────────
        //
        // Matching rules:
        //   • Case-sensitive: 'T' only matches 'T'
        //   • Special-char-sensitive: '!' only matches '!'
        //   • Typographic → ASCII normalization (normalizeForMatch):
        //     Book text often contains Unicode typographic characters
        //     (smart quotes, em-dashes, ellipses…) that have no direct
        //     keyboard key. We map the stored char to its closest typeable
        //     ASCII equivalent so the user can still press something real.
        //     The displayed character is never changed — only the comparison
        //     target is normalized.
        const { el, ch } = entry;
        if (!el) return;

        if (pressed === normalizeForMatch(ch)) {
          if (ch !== ' ') {
            // Reveal the character — bring to full opacity and mark the
            // persistent flag so the opacity is restored if this chunk is
            // evicted and later re-rendered by the virtual window.
            el.style.opacity      = '1';
            el.style.outline      = '';
            el.style.borderRadius = '';
            entry.revealed = true; // survives evict/re-render
            cursorSpan = null; // release before setCursor runs clearCursorHighlight
          }
          setCursor(cursor + 1);
        }
        // Wrong key: swallowed by preventDefault above, no visible effect.
      }

      // ── Keyboard capture listener ───────────────────────────────────────
      // Only one overlayKeyHandler must be active at a time.  A second
      // DISPLAY_IN_OVERLAY message (user selects a new book) must remove the
      // previous handler before registering the new one.  Without this, the
      // old handler fires first in the capture phase, calls
      // stopImmediatePropagation + preventDefault, and swallows every keystroke
      // before the new handler sees it — making typing broken on book 2+.
      if (currentOverlayKeyHandler) {
        document.removeEventListener('keydown', currentOverlayKeyHandler, true);
        currentOverlayKeyHandler = null;
      }
      document.addEventListener('keydown', overlayKeyHandler, true);
      currentOverlayKeyHandler = overlayKeyHandler;

      // Also remove the capture listener if the user clicks the close button.
      shadow.getElementById('lg-close-btn').addEventListener('click', () => {
        document.removeEventListener('keydown', overlayKeyHandler, true);
        if (currentOverlayKeyHandler === overlayKeyHandler) currentOverlayKeyHandler = null;
      }, { once: true });

      // Give wrapper a tabindex for focus; routing handled by capture listener.
      wrapper.setAttribute('tabindex', '0');
      wrapper.focus();

    } else if (msg.html) {
      // ── HTML-with-images mode ─────────────────────────────────────────────
      //
      // The service worker fetches the pg{id}-images.html file, which contains
      // the full book as structured HTML with relative image src paths like
      // "../images/…" or "images/…".  We must rewrite every relative URL to
      // absolute before injecting so images actually load from gutenberg.org.
      //
      // Sanitisation strategy: parse into a detached document, strip every
      // element that can execute code or load unrelated resources (script,
      // style, link, iframe, form, meta, object, embed), then rewrite all
      // src/href/srcset attributes that are not already absolute to be
      // absolute against the canonical pg{id}-images.html base URL.
      // The result is serialised back to an HTML string and set as innerHTML
      // on textEl — which lives inside a shadow DOM, so the injected markup
      // is isolated from the host page's styles and scripts.

      const bookId  = String(msg.bookId || '');
      const baseUrl = bookId
        ? `https://www.gutenberg.org/cache/epub/${bookId}/`
        : 'https://www.gutenberg.org/';

      // Parse into a detached document for safe manipulation.
      const parser  = new DOMParser();
      const doc     = parser.parseFromString(msg.html, 'text/html');

      // Strip executable / resource-loading elements.
      const stripTags = ['script','style','link','iframe','frame','frameset',
                         'form','input','button','select','textarea',
                         'meta','object','embed','applet','base'];
      stripTags.forEach(tag => {
        doc.querySelectorAll(tag).forEach(el => el.remove());
      });

      // Rewrite relative URLs in src, href, srcset, data-src to absolute.
      function toAbsolute(attr) {
        if (!attr) return attr;
        attr = attr.trim();
        // Already absolute or a data URI — leave untouched.
        if (/^(https?:|data:|#)/i.test(attr)) return attr;
        // Protocol-relative
        if (attr.startsWith('//')) return 'https:' + attr;
        // Absolute path on gutenberg.org
        if (attr.startsWith('/')) return 'https://www.gutenberg.org' + attr;
        // Relative path — resolve against baseUrl
        return baseUrl + attr.replace(/^\.\.\//, '');
      }

      doc.querySelectorAll('[src]').forEach(el => {
        el.setAttribute('src', toAbsolute(el.getAttribute('src')));
      });
      doc.querySelectorAll('[href]').forEach(el => {
        // Keep anchor hrags as plain anchors; rewrite only non-fragment hrefs.
        const h = el.getAttribute('href');
        if (h && !h.startsWith('#')) el.setAttribute('href', toAbsolute(h));
      });
      doc.querySelectorAll('[srcset]').forEach(el => {
        const rewritten = el.getAttribute('srcset')
          .split(',')
          .map(part => {
            const [u, ...rest] = part.trim().split(/\s+/);
            return [toAbsolute(u), ...rest].join(' ');
          })
          .join(', ');
        el.setAttribute('srcset', rewritten);
      });
      doc.querySelectorAll('[data-src]').forEach(el => {
        el.setAttribute('data-src', toAbsolute(el.getAttribute('data-src')));
      });

      // Extract just the <body> content — we don't want <head> cruft.
      const bodyHtml = doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;

      textEl.classList.add('html-mode');
      textEl.innerHTML     = bodyHtml;
      textEl.style.opacity = '1';

    } else {
      // ── Normal (opaque) mode ──────────────────────────────────────────────
      textEl.textContent = msg.text;
      textEl.style.opacity = '1';
    }

    textEl.scrollTop = 0;

    requestAnimationFrame(() => {
      // If wrapper dimensions were already locked by a previous book selection,
      // keep them — only reflow the text inside the fixed box.
      // If no lock exists yet (first-ever display), run the free path to
      // measure and establish the initial dimensions, then lock them.
      if (lockedW !== null) {
        applyLockedConstraints();
      } else {
        measureChromeHeight();
        applyConstraints(); // will snapshot lockedW/lockedH at the end
      }
    });
  } // end handleMessage

  chrome.runtime.onMessage.addListener((msg) => { handleMessage(msg); });
})();
