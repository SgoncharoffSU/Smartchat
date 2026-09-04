(function () {
  var scriptTag = document.currentScript;
  var botToken = scriptTag.getAttribute('data-bot-token');
  if (!botToken) {
    console.error('[Smartchat] widget.js: data-bot-token attribute is required on the <script> tag');
    return;
  }
  var baseUrl = scriptTag.getAttribute('data-base-url') || new URL(scriptTag.src, location.href).origin;

  // Owner-configurable in the cabinet's "Обучение бота" section (see
  // cabinet.service.ts's getEmbedSnippet) — baked into the snippet as plain
  // data attributes, same as every other data-* setting this loader reads.
  // A real client site only picks up a change once it re-copies the snippet.
  var DEFAULT_WIDGET_COLOR = '#4f46e5';
  var widgetColorAttr = scriptTag.getAttribute('data-color');
  var widgetColor = widgetColorAttr && /^#[0-9a-fA-F]{6}$/.test(widgetColorAttr) ? widgetColorAttr : DEFAULT_WIDGET_COLOR;
  function hexToRgb(hex) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 79, g: 70, b: 229 };
  }
  var widgetRgb = hexToRgb(widgetColor);
  // Which screen corner the launcher/chat window/teaser all anchor to.
  var widgetSide = scriptTag.getAttribute('data-position') === 'bottom-left' ? 'left' : 'right';

  var sessionKey = 'smartchat_session_' + botToken;
  var sessionId = localStorage.getItem(sessionKey);
  // Must be read before we possibly create a fresh sessionId below — this is
  // the only reliable client-side signal that "this browser has been here
  // before" (see the returning-visitor nudge further down).
  var isReturningVisitor = !!sessionId;
  if (!sessionId) {
    sessionId = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    localStorage.setItem(sessionKey, sessionId);
  }

  var launcher = document.createElement('button');
  var launcherIconUrl = scriptTag.getAttribute('data-launcher-icon');
  if (launcherIconUrl) {
    var launcherImg = document.createElement('img');
    launcherImg.src = launcherIconUrl;
    launcherImg.alt = '';
    Object.assign(launcherImg.style, { width: '28px', height: '28px', objectFit: 'contain' });
    launcher.appendChild(launcherImg);
  } else {
    // Built-in "AI chat" mark (bubble + curved sparkle) instead of a generic
    // emoji — swap in a real brand logo later via data-launcher-icon="<image url>".
    // The sparkle uses curved (concave) sides on purpose: a straight-edged
    // 4-point star at this size reads as a plus/medical-cross; the curve is
    // what makes it read as "spark" instead.
    launcher.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="white"/>' +
      '<path d="M12 6c.5 3.8 2.2 5.5 6 6-3.8.5-5.5 2.2-6 6-.5-3.8-2.2-5.5-6-6 3.8-.5 5.5-2.2 6-6z" fill="' + widgetColor + '"/>' +
      '</svg>';
  }
  // Lets embedding pages (currently just the cabinet's own test widget, which
  // sits above a page-level "Сбросить тестовый чат" link) nudge the launcher,
  // teaser and floating chat window up so that link has room and isn't hugging
  // the viewport edge. Real client sites don't set this and get the default 0.
  var offsetBottom = Number(scriptTag.getAttribute('data-offset-bottom')) || 0;

  // Always-on "notice me" motion — a continuous, gentle pulse plus a grow-on-
  // hover — instead of only pulsing while the teaser bubble happens to be up.
  // Inline styles can't express :hover or @keyframes, so this is the one bit
  // of real CSS the loader injects into the host page.
  var style = document.createElement('style');
  var glowRgb = widgetRgb.r + ',' + widgetRgb.g + ',' + widgetRgb.b;
  style.textContent =
    '@keyframes smartchat-launcher-pulse {' +
    '0%,100%{box-shadow:0 4px 14px rgba(0,0,0,.25),0 0 0 0 rgba(' + glowRgb + ',.55)}' +
    '50%{box-shadow:0 4px 14px rgba(0,0,0,.25),0 0 0 10px rgba(' + glowRgb + ',0)}' +
    '}' +
    '.smartchat-launcher{animation:smartchat-launcher-pulse 2.6s ease-in-out infinite;transition:transform .18s ease;}' +
    '.smartchat-launcher:hover{transform:scale(1.08);}';
  document.head.appendChild(style);

  launcher.setAttribute('aria-label', 'Open Smartchat');
  launcher.className = 'smartchat-launcher';
  var launcherStyle = {
    position: 'fixed',
    bottom: (20 + offsetBottom) + 'px',
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    border: 'none',
    background: widgetColor,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    zIndex: 2147483000,
  };
  launcherStyle[widgetSide] = '20px';
  Object.assign(launcher.style, launcherStyle);

  var autoOpen = scriptTag.getAttribute('data-auto-open') === 'true';
  // Plain attribute check — safe now that chat.js no longer has ANY admin-
  // only UI gated behind this flag (the training/testing switch and the
  // coach bar were removed from that shared file entirely, not just hidden
  // better). This flag's only remaining job is telling the backend to
  // exclude the dialog from real analytics (see isPreview on
  // SendMessageDto) — used by test-chat.html's public prospect-demo link,
  // which still legitimately wants that exclusion. The cabinet's own
  // training/testing panes don't use this loader at all anymore; they embed
  // chat-ui/index.html directly with their own fixed, explicit URL params.
  var previewMode = scriptTag.getAttribute('data-preview') === 'true';
  // Only ever set by the cabinet's OWN "Тестирование" pane (test-widget-
  // preview.html) — never by test-chat.html (the public prospect-facing demo
  // link), which sets data-preview alone. Just a UI hint forwarded to chat.js
  // to show the "mark as bad" control; actual ownership is still verified
  // server-side on submit (see WidgetController#addCorrection), same as
  // trainingMode already is.
  var ownerTestingMode = previewMode && scriptTag.getAttribute('data-owner-testing') === 'true';

  // Opt-in only (currently just the landing page's own hero section) — every
  // other embed never sets this attribute, so the whole heroTarget branch
  // below is dead code for them and the widget behaves exactly as before.
  // Lets the SAME iframe that's normally a floating popup start out docked
  // inline inside a page element instead, already open, showing the bot's
  // real cold-open turn (self-intro + one question — see chat.js's
  // COLD_OPEN_INSTRUCTIONS) without the visitor lifting a finger. Once that
  // element scrolls out of view, it "collapses" into the normal floating
  // widget position — see dockToHero/collapseHeroChat below.
  var heroTargetSelector = scriptTag.getAttribute('data-hero-target');
  var heroTarget = heroTargetSelector ? document.querySelector(heroTargetSelector) : null;
  var heroDocked = false;
  // True from hero-init all the way through the end of collapseHeroChat's
  // animation, and again for the whole of expandHeroChat's — broader than
  // heroDocked (which flips to false the INSTANT collapse starts, well
  // before the animation finishes). Without this, a window.resize firing
  // mid-collapse (mobile browsers commonly fire one when the address bar
  // hides/shows during the very scroll gesture that triggers the collapse)
  // hits applyIframeLayout's un-guarded mobile branch, which unconditionally
  // sets borderRadius:'0' + a fullscreen box — stomping the in-flight
  // animation into a square-cornered mess. Only false during the genuine
  // idle window once collapse has fully hands off to being a normal
  // floating widget (see the end of collapseHeroChat, and the start of
  // expandHeroChat re-locking it).
  var heroLayoutLocked = Boolean(heroTarget);

  var iframe = document.createElement('iframe');
  var chatUiUrl =
    baseUrl +
    '/chat-ui/index.html?token=' +
    encodeURIComponent(botToken) +
    '&session=' +
    encodeURIComponent(sessionId) +
    '&api=' +
    encodeURIComponent(baseUrl) +
    '&mode=' +
    (window.innerWidth <= 480 ? 'fullscreen' : 'floating') +
    '&color=' +
    encodeURIComponent(widgetColor) +
    (previewMode ? '&preview=1' : '') +
    (ownerTestingMode ? '&ownerPreview=1' : '') +
    // See chat.js — the iframe's document/script load early (this same
    // src, fired the moment the outside teaser becomes visible instead of
    // waiting for a real click), but its own real isInit/reveal call stays
    // gated on an explicit "start" postMessage from openChat() below. That
    // keeps the fetch + JS parse/compile off the critical path when the
    // visitor actually opens, without paying for a wasted completion call
    // on every visitor who merely saw the teaser and never opened.
    '&autostart=0';
  // Loaded lazily (see ensureIframeLoaded) rather than immediately: the chat-ui
  // page calls isInit itself on load, and starting that eagerly for every page
  // view — even ones that never touch the chat — would race with the teaser's
  // own isInit call and waste a YandexGPT call per visit.
  iframe.title = 'Smartchat';
  Object.assign(iframe.style, {
    position: 'fixed',
    border: 'none',
    // A border-radius alone doesn't clip an <iframe>'s own rendered content
    // (unlike a plain div) — without this, the box's corners round off but
    // the chat page drawn inside it still has square corners poking past
    // the rounding. Applies to every embed, not just hero-docked ones.
    overflow: 'hidden',
    boxShadow: '0 10px 40px rgba(0,0,0,.25)',
    display: 'none',
    zIndex: 2147483000,
  });

  var MOBILE_BREAKPOINT = 480;
  // Real embeds never set this — it exists for the cabinet's own "Обучение
  // бота" preview, whose container width is meant to match the reference
  // prototype's own 510px (owner's explicit request) rather than being kept
  // under MOBILE_BREAKPOINT just to trick this same check. Forces the exact
  // full-screen "the box IS the chat" behavior on ANY container width,
  // instead of coupling that behavior to an incidental narrow width.
  var forceFullScreen = scriptTag.getAttribute('data-force-fullscreen') === 'true';
  function isMobile() {
    return forceFullScreen || window.innerWidth <= MOBILE_BREAKPOINT;
  }

  // On phones, a small floating box is cramped once the on-screen keyboard
  // opens — use the full screen instead, like most chat widgets do on mobile.
  // No-op while heroDocked: the hero branch owns the iframe's position until
  // it collapses (see collapseHeroChat), so this would otherwise fight it —
  // e.g. a resize event mid-hero-session snapping the iframe to the floating
  // corner behind the visitor's back.
  function applyIframeLayout() {
    if (heroDocked || heroLayoutLocked) return;
    if (isMobile()) {
      Object.assign(iframe.style, {
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        width: '100%',
        height: '100%',
        maxWidth: '100%',
        maxHeight: '100%',
        borderRadius: '0',
      });
    } else {
      var desktopStyle = {
        top: 'auto',
        bottom: (90 + offsetBottom) + 'px',
        width: '380px',
        height: '560px',
        maxWidth: 'calc(100vw - 40px)',
        maxHeight: 'calc(100vh - 120px)',
        borderRadius: '16px',
      };
      desktopStyle[widgetSide] = '20px';
      desktopStyle[widgetSide === 'right' ? 'left' : 'right'] = 'auto';
      Object.assign(iframe.style, desktopStyle);
    }
  }
  applyIframeLayout();
  window.addEventListener('resize', applyIframeLayout);

  var mobileCloseBtn = document.createElement('button');
  mobileCloseBtn.textContent = '✕';
  mobileCloseBtn.setAttribute('aria-label', 'Close Smartchat');
  Object.assign(mobileCloseBtn.style, {
    position: 'fixed',
    top: '10px',
    right: '10px',
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(0,0,0,.55)',
    color: '#fff',
    fontSize: '16px',
    lineHeight: '36px',
    textAlign: 'center',
    cursor: 'pointer',
    display: 'none',
    zIndex: 2147483001,
  });

  var iframeLoaded = false;
  function ensureIframeLoaded() {
    if (!iframeLoaded) {
      iframeLoaded = true;
      iframe.src = chatUiUrl;
    }
  }

  // Coordinates the deferred "start" handshake with chat.js's own autostart=0
  // branch (see there). iframeReady flips once the preloaded iframe's script
  // has actually run and registered its listener; startRequested covers the
  // case where the visitor opens before that's happened yet (e.g. clicked
  // within the first instant, before the teaser/preload ever fired) — the
  // "start" message just gets sent the moment iframe-ready arrives instead.
  var iframeReady = false;
  var startRequested = false;
  // Set only inside the heroTarget branch below (see there) — stays null
  // everywhere else, so these messages are simply ignored for the normal
  // floating widget, desktop, and cabinet test panes.
  var heroKeyboardFocusHandler = null;
  var heroKeyboardBlurHandler = null;
  window.addEventListener('message', function (e) {
    if (e.source !== iframe.contentWindow || !e.data) return;
    if (e.data.type === 'smartchat:ready') {
      iframeReady = true;
      if (startRequested) iframe.contentWindow.postMessage({ type: 'smartchat:start' }, '*');
    } else if (e.data.type === 'smartchat:input-focus') {
      if (heroKeyboardFocusHandler) heroKeyboardFocusHandler();
    } else if (e.data.type === 'smartchat:input-blur') {
      if (heroKeyboardBlurHandler) heroKeyboardBlurHandler();
    }
  });

  var isOpen = false;
  function openChat() {
    ensureIframeLoaded();
    if (iframeReady) {
      iframe.contentWindow.postMessage({ type: 'smartchat:start' }, '*');
    } else {
      startRequested = true;
    }
    isOpen = true;
    iframe.style.display = 'block';
    if (isMobile()) {
      launcher.style.display = 'none';
      mobileCloseBtn.style.display = 'block';
    }
    hideTeaser(true);
  }
  function closeChat() {
    isOpen = false;
    iframe.style.display = 'none';
    launcher.style.display = '';
    mobileCloseBtn.style.display = 'none';
  }
  launcher.addEventListener('click', function () {
    if (isOpen) {
      closeChat();
    } else {
      openChat();
    }
  });
  mobileCloseBtn.addEventListener('click', function () {
    // While the hero-docked chat is fullscreen for the keyboard (see
    // expandHeroForKeyboard), this button is repurposed: "exit" here means
    // dismiss the keyboard and collapse back into the hero banner, NOT a
    // full close — that keyboard-expanded state and its own show/hide of
    // this button are unrelated to the normal open/close flow below, so
    // heroKeyboardExpanded (declared inside the heroTarget branch, `undefined`
    // — falsy — everywhere else) is checked first.
    if (heroKeyboardExpanded) {
      iframe.contentWindow.postMessage({ type: 'smartchat:blur-input' }, '*');
      return;
    }
    closeChat();
  });

  document.body.appendChild(iframe);
  document.body.appendChild(launcher);
  document.body.appendChild(mobileCloseBtn);

  if (autoOpen) openChat();

  // --- Hero-docked mode (opt-in, see heroTarget above) ---
  // Keeps the iframe truly `position: fixed` throughout (never toggles to
  // static/absolute) so the only thing that ever animates is its box —
  // switching position TYPE mid-transition can't be transitioned smoothly by
  // CSS, fixed coordinates matching wherever the hero element visually sits
  // can. dockToHero() re-syncs those coordinates to the hero element's
  // current on-screen rect every frame while docked, so normal page scroll
  // moves it exactly like a real inline element would, with zero perceived
  // difference from the static mockup it's replacing.
  if (heroTarget) {
    heroDocked = true;
    launcher.style.display = 'none';
    // While docked inline in the hero slot, the box must lose to the site's
    // OWN sticky/fixed header on overlap — it's sitting in normal page flow,
    // not floating above everything the way the launcher/open-chat corner
    // widget legitimately should be. HERO_DOCKED_Z_INDEX/HERO_FLOATING_Z_INDEX
    // get swapped at the two points that actually cross that boundary:
    // collapseHeroChat (start — from here it's shrinking toward the floating
    // corner) and expandHeroChat (once it starts growing back OUT of the
    // corner into the hero slot, see there).
    var HERO_DOCKED_Z_INDEX = 1;
    var HERO_FLOATING_Z_INDEX = 2147483000;
    Object.assign(iframe.style, {
      borderRadius: '20px',
      boxShadow: '0 30px 70px rgba(5,8,25,.45)',
      zIndex: HERO_DOCKED_Z_INDEX,
      // Hints the browser to promote the iframe to its own compositing layer
      // well before the first collapse/expand ever runs — without it, that
      // promotion happens on-demand at the START of the first transition,
      // which is exactly the stutter the visitor would see on that first
      // run (every animation after it reuses the already-promoted layer).
      willChange: 'top, left, width, height, border-radius, opacity',
    });

    // 'docked': sitting in the hero slot (or animating there — see
    // expandHeroChat). 'collapsed': living as the normal floating launcher
    // (or animating into it — see collapseHeroChat). Guards re-entrancy: the
    // IntersectionObserver below fires on every crossing, so scrolling past
    // the hero repeatedly must not stack up duplicate animations.
    var heroState = 'docked';
    var HERO_BOX_TRANSITION =
      'top .7s cubic-bezier(.4,0,.2,1), left .7s cubic-bezier(.4,0,.2,1), width .7s cubic-bezier(.4,0,.2,1), height .7s cubic-bezier(.4,0,.2,1), border-radius .7s cubic-bezier(.4,0,.2,1)';
    var HERO_BOX_MS = 700;
    var HERO_FADE_MS = 130;
    // Both collapse (hero slot -> launcher corner) and expand (launcher
    // corner -> hero slot) move the box between two rects every frame —
    // re-reading the live rect each frame so either keeps tracking if the
    // visitor scrolls mid-animation (see growTrackFrame/heroCollapseFrame).
    // Giving top and left independently-eased curves (an earlier version of
    // this fix: decelerate for top, accelerate for left) bends the path away
    // from a straight diagonal, but it's still fundamentally two straight
    // legs blended together — it reads as "goes this way, THEN that way",
    // not one continuous curve.
    //
    // A real arc instead couples top and left through a SINGLE shared angle,
    // the way an actual quarter-ellipse is drawn: as theta sweeps 0 -> 90°,
    // x follows (1 - cos theta) and y follows sin theta. That pair traces one
    // continuous curve by construction (sin²+cos²=1) — never two segments —
    // while still starting with zero horizontal speed and ending with zero
    // vertical speed, so it still rises out of the corner mostly vertically
    // and swings sideways into place at the end, just along a real curve
    // instead of a bent line. heroArcTimeEase below only paces how fast we
    // sweep along that fixed curve (slow-fast-slow); it doesn't reshape it —
    // reshaping the arc itself would need touching the sin/cos pairing.
    function makeBezierEase(x1, y1, x2, y2) {
      function a(v1, v2) {
        return 1 - 3 * v2 + 3 * v1;
      }
      function b(v1, v2) {
        return 3 * v2 - 6 * v1;
      }
      function c(v1) {
        return 3 * v1;
      }
      function bezier(t, v1, v2) {
        return ((a(v1, v2) * t + b(v1, v2)) * t + c(v1)) * t;
      }
      function slope(t, v1, v2) {
        return 3 * a(v1, v2) * t * t + 2 * b(v1, v2) * t + c(v1);
      }
      return function (x) {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        var t = x;
        for (var i = 0; i < 8; i++) {
          var s = slope(t, x1, x2);
          if (s === 0) break;
          t -= (bezier(t, x1, x2) - x) / s;
        }
        return bezier(t, y1, y2);
      };
    }
    // Standard ease-in-out — paces the sweep along the arc, doesn't touch
    // its shape. Reused as-is for the width/height/radius shrink-or-grow too.
    var heroArcTimeEase = makeBezierEase(0.4, 0, 0.2, 1);
    function heroArcPoint(from, to, pacedT) {
      var theta = pacedT * (Math.PI / 2);
      return {
        top: from.top + (to.top - from.top) * Math.sin(theta),
        left: from.left + (to.left - from.left) * (1 - Math.cos(theta)),
      };
    }

    // Every setTimeout spawned by collapse/expand goes through here instead
    // of a bare setTimeout, so the OTHER direction can cancel all of them in
    // one shot if the visitor reverses mid-animation (scrolls back up before
    // collapse finished landing, or back down before expand finished growing)
    // — otherwise a stale callback fires later and stomps the new animation's
    // styles out from under it.
    var heroPendingTimers = [];
    function heroSetTimeout(fn, ms) {
      var id = setTimeout(fn, ms);
      heroPendingTimers.push(id);
      return id;
    }
    function heroClearPending() {
      heroPendingTimers.forEach(clearTimeout);
      heroPendingTimers = [];
    }

    // The launcher's real resting spot/size — not a guessed approximation.
    // Landing the shrink animation exactly here (rather than at a
    // close-but-not-quite box) is what makes the chat visibly become the
    // circle instead of just fading out near it.
    function launcherTargetRect() {
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var w = 56;
      var h = 56;
      var left = widgetSide === 'right' ? vw - w - 20 : 20;
      var top = vh - h - (20 + offsetBottom);
      return { top: top, left: left, width: w, height: h };
    }

    var dockRaf = null;
    function dockToHero() {
      // Paused while the keyboard-expanded fullscreen override owns the box
      // (see expandHeroForKeyboard) — resumed explicitly by
      // collapseHeroFromKeyboard once that ends, same convention as
      // collapseHeroChat/expandHeroChat's own explicit restarts.
      if (!heroDocked || heroKeyboardExpanded) return;
      var r = heroTarget.getBoundingClientRect();
      Object.assign(iframe.style, {
        top: r.top + 'px',
        left: r.left + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        right: 'auto',
        bottom: 'auto',
        maxWidth: 'none',
        maxHeight: 'none',
      });
      dockRaf = requestAnimationFrame(dockToHero);
    }

    // Mobile-only: the hero-docked box normally sits at whatever small size
    // the hero mockup defines (see dockToHero) — fine for reading, cramped
    // for typing once the on-screen keyboard takes half the screen. While
    // the visitor has the composer focused, take the box fullscreen instead,
    // tracking window.visualViewport (NOT window.innerHeight/the layout
    // viewport, which mobile browsers do NOT shrink when the keyboard opens
    // — visualViewport is the one that actually reflects the visible area
    // above the keyboard). Only ever engaged while heroState is 'docked' —
    // once collapsed to the normal floating widget, that already goes
    // fullscreen on mobile by itself (see applyIframeLayout), so there's
    // nothing extra to do there.
    var heroKeyboardExpanded = false;
    var heroKeyboardSyncFn = null;
    function expandHeroForKeyboard() {
      if (!isMobile() || heroState !== 'docked' || heroKeyboardExpanded) return;
      heroKeyboardExpanded = true;
      if (dockRaf) cancelAnimationFrame(dockRaf);
      iframe.style.zIndex = HERO_FLOATING_Z_INDEX;
      iframe.style.transition = HERO_BOX_TRANSITION;
      mobileCloseBtn.style.display = 'block';

      function sync() {
        if (!heroKeyboardExpanded) return;
        var vv = window.visualViewport;
        Object.assign(iframe.style, {
          top: (vv ? vv.offsetTop : 0) + 'px',
          left: (vv ? vv.offsetLeft : 0) + 'px',
          width: (vv ? vv.width : window.innerWidth) + 'px',
          height: (vv ? vv.height : window.innerHeight) + 'px',
          borderRadius: '0px',
        });
      }
      heroKeyboardSyncFn = sync;
      sync();
      // Fires repeatedly as the keyboard animates open (and again if the
      // visitor scrolls the page — mobile browsers commonly do that to keep
      // the focused input above the keyboard) — re-syncing on every event
      // keeps the box tracking the real visible area the whole time, not
      // just its final resting size.
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', sync);
        window.visualViewport.addEventListener('scroll', sync);
      }
    }
    function collapseHeroFromKeyboard() {
      if (!heroKeyboardExpanded) return;
      heroKeyboardExpanded = false;
      mobileCloseBtn.style.display = 'none';
      if (window.visualViewport && heroKeyboardSyncFn) {
        window.visualViewport.removeEventListener('resize', heroKeyboardSyncFn);
        window.visualViewport.removeEventListener('scroll', heroKeyboardSyncFn);
      }
      heroKeyboardSyncFn = null;
      // heroState may have already flipped to 'collapsed' by the time blur
      // fires (visitor scrolled the hero out of view while still typing) —
      // that path already owns the box for its own shrink animation, so
      // just drop back to plain floating-widget z-index and stop here
      // rather than fighting it with a hero-slot rect that's no longer
      // where the box is headed.
      if (heroState !== 'docked') {
        iframe.style.zIndex = HERO_FLOATING_Z_INDEX;
        return;
      }
      iframe.style.zIndex = HERO_DOCKED_Z_INDEX;
      var r = heroTarget.getBoundingClientRect();
      iframe.style.transition = HERO_BOX_TRANSITION;
      Object.assign(iframe.style, {
        top: r.top + 'px',
        left: r.left + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        borderRadius: '20px',
      });
      heroSetTimeout(function () {
        iframe.style.transition = '';
        dockToHero();
      }, HERO_BOX_MS + 30);
    }
    heroKeyboardFocusHandler = expandHeroForKeyboard;
    heroKeyboardBlurHandler = collapseHeroFromKeyboard;

    ensureIframeLoaded();
    iframe.style.display = 'block';
    isOpen = true;
    dockToHero();
    if (iframeReady) {
      iframe.contentWindow.postMessage({ type: 'smartchat:start' }, '*');
    } else {
      startRequested = true;
    }

    // Reacts to every crossing of the hero's viewport edge, not just the
    // first — the visitor scrolling back up should see the exact reverse of
    // scrolling down (see expandHeroChat), same as any normal inline element
    // would just "still be there" on scroll-back.
    //
    // The hero sits near the very TOP of the page, so both crossings — the
    // chat scrolling away, and it scrolling back — happen at the SAME edge
    // (the hero exits and re-enters exclusively through the viewport's top).
    // A plain {threshold:0} check (root = the real viewport) means: collapse
    // only once literally 0% of the hero is left on screen (feels late —
    // the box has already fully vanished by the time it starts shrinking),
    // and expand fires the instant even a single pixel reappears (feels
    // early — it starts growing back before there's really anything of the
    // hero to dock onto yet). Shrinking the observed root by a top rootMargin
    // moves BOTH trigger points inward from the real edge by the same
    // amount, so collapse starts while a "tail" of the hero is still
    // genuinely visible near the top, and expand only starts once a
    // comparable amount has already scrolled back into view — the same
    // single knob controls both, since they're the same crossing in
    // opposite directions.
    var heroObserver = new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting) {
          expandHeroChat();
        } else {
          collapseHeroChat();
        }
      },
      { threshold: 0, rootMargin: '-28% 0px 0px 0px' },
    );
    heroObserver.observe(heroTarget);

    function collapseHeroChat() {
      if (heroState !== 'docked') return;
      heroState = 'collapsed';
      heroDocked = false;
      heroClearPending();
      if (dockRaf) cancelAnimationFrame(dockRaf);

      // Freeze the iframe at exactly its last on-screen rect (no visual
      // jump), then shrink+move it along a real arc (see heroArcPoint's own
      // comment) to the launcher's real box, landing exactly where the
      // launcher itself sits (see launcherTargetRect) rather than merely
      // fading out somewhere close to it. The launcher's spot doesn't move,
      // so unlike the grow side there's no need to re-read the destination
      // every frame — only the elapsed-time progress changes frame to frame.
      var from = iframe.getBoundingClientRect();
      var t = launcherTargetRect();
      iframe.style.transition = '';

      var collapseStart = null;
      function collapseFrame(now) {
        // Bails if expandHeroChat fired again mid-shrink (visitor reversed
        // and scrolled back up before this finished) — same convention as
        // growTrackFrame's own bail check.
        if (heroState !== 'collapsed') return;
        if (collapseStart === null) collapseStart = now;
        var rawT = Math.min(1, (now - collapseStart) / HERO_BOX_MS);
        var pacedT = heroArcTimeEase(rawT);
        var pos = heroArcPoint(from, t, pacedT);
        Object.assign(iframe.style, {
          top: pos.top + 'px',
          left: pos.left + 'px',
          width: from.width + (t.width - from.width) * pacedT + 'px',
          height: from.height + (t.height - from.height) * pacedT + 'px',
          borderRadius: 20 + (28 - 20) * pacedT + 'px',
        });
        if (rawT < 1) {
          requestAnimationFrame(collapseFrame);
          return;
        }

        // The iframe now exactly overlaps the launcher's real resting spot,
        // down in the corner and away from the header — safe to bump back
        // above everything here (unlike right at collapse's START, where the
        // box is still sitting where it was docked and would otherwise
        // visibly snap on top of the header the instant collapse begins).
        iframe.style.zIndex = HERO_FLOATING_Z_INDEX;
        // Cross-fade the content instead of an abrupt swap, so the shrink
        // reads as "becomes the launcher" rather than a jump-cut.
        iframe.style.transition = 'opacity ' + HERO_FADE_MS + 'ms ease';
        launcher.style.display = '';
        launcher.style.opacity = '0';
        launcher.style.transition = 'opacity ' + HERO_FADE_MS + 'ms ease';
        requestAnimationFrame(function () {
          iframe.style.opacity = '0';
          launcher.style.opacity = '1';
        });

        heroSetTimeout(function () {
          iframe.style.transition = '';
          iframe.style.opacity = '';
          launcher.style.transition = '';
          launcher.style.opacity = '';
          closeChat();
          // Only now does this actually behave like a normal (non-hero)
          // floating widget — a resize before this point must not be allowed
          // to touch the iframe (see heroLayoutLocked's own comment above).
          heroLayoutLocked = false;
          applyIframeLayout();
          // Now behaves exactly like a normal (non-hero) embed from this
          // point on — same teaser and returning-visitor timers a visitor
          // who never saw the hero at all would get.
          heroSetTimeout(showTeaser, teaserDelay);
          heroSetTimeout(checkAndShowReturningNudge, RETURNING_NUDGE_DELAY_MS);
        }, HERO_FADE_MS + 30);
      }
      requestAnimationFrame(collapseFrame);
    }

    function expandHeroChat() {
      if (heroState !== 'collapsed') return;
      heroState = 'docked';
      heroClearPending();
      // Re-lock immediately — we're taking manual control of the iframe box
      // back over for the whole grow animation (see heroLayoutLocked).
      heroLayoutLocked = true;
      // A teaser may already be showing (or about to) from a previous
      // collapse — the chat is about to reopen inline, so it'd be redundant
      // (and would otherwise keep counting as "not yet dismissed").
      hideTeaser(false);

      isOpen = true;
      // Position the (currently hidden) iframe exactly over the launcher's
      // spot, matching its circular look, then cross-fade the launcher into
      // it BEFORE it starts moving at all — starting the grow motion
      // concurrently with the fade (an earlier version of this fix) instead
      // briefly showed TWO circles drifting apart: the fading launcher
      // sitting still at its spot, and the also-fading iframe already
      // sliding away from underneath it. Keeping the box motionless for the
      // whole (short) fade avoids that, at the cost of a brief static pause
      // — kept short via HERO_FADE_MS rather than eliminated outright.
      var growFrom = launcherTargetRect();
      iframe.style.transition = '';
      iframe.style.opacity = '0';
      Object.assign(iframe.style, {
        top: growFrom.top + 'px',
        left: growFrom.left + 'px',
        width: growFrom.width + 'px',
        height: growFrom.height + 'px',
        right: 'auto',
        bottom: 'auto',
        maxWidth: 'none',
        maxHeight: 'none',
        borderRadius: '50%',
        display: 'block',
      });
      // eslint-disable-next-line no-unused-expressions
      iframe.getBoundingClientRect(); // force layout before adding the transition
      iframe.style.transition = 'opacity ' + HERO_FADE_MS + 'ms ease';
      launcher.style.transition = 'opacity ' + HERO_FADE_MS + 'ms ease';
      requestAnimationFrame(function () {
        iframe.style.opacity = '1';
        launcher.style.opacity = '0';
      });

      var growStart = null;
      heroSetTimeout(function () {
        launcher.style.transition = '';
        launcher.style.opacity = '';
        launcher.style.display = 'none';

        // Now grow it back out from the launcher's spot into the hero
        // slot's live position — the exact reverse of the shrink. Back in
        // the hero's own flow from here on, so it must stop sitting above
        // the site's own header (see HERO_DOCKED_Z_INDEX's own comment) —
        // safe now that the box is about to actually start moving away
        // from the launcher corner.
        iframe.style.transition = '';
        iframe.style.zIndex = HERO_DOCKED_Z_INDEX;
        requestAnimationFrame(growTrackFrame);
      }, HERO_FADE_MS + 30);

      // Reads heroTarget's rect fresh every frame (not just once) so it
      // keeps tracking if the visitor keeps scrolling during these 700ms.
      function growTrackFrame(now) {
        // Bails if collapseHeroChat fired again mid-grow (visitor reversed
        // and scrolled back down before this finished) — heroState is the
        // only thing that flips before heroClearPending's timer-only sweep
        // would otherwise miss this rAF loop entirely and leave it running
        // underneath (and fighting) the collapse animation. Also bails if
        // the keyboard-focus override took over mid-grow (heroState stays
        // 'docked' the whole time the keyboard is expanded, by design — see
        // expandHeroForKeyboard — so THAT case needs its own explicit
        // check here; without it this loop keeps fighting sync() every
        // frame, overwriting the fullscreen box back to the hero rect).
        if (heroState !== 'docked' || heroKeyboardExpanded) return;
        if (growStart === null) growStart = now;
        var rawT = Math.min(1, (now - growStart) / HERO_BOX_MS);
        var pacedT = heroArcTimeEase(rawT);
        var r = heroTarget.getBoundingClientRect();
        var pos = heroArcPoint(growFrom, r, pacedT);
        Object.assign(iframe.style, {
          top: pos.top + 'px',
          left: pos.left + 'px',
          width: growFrom.width + (r.width - growFrom.width) * pacedT + 'px',
          height: growFrom.height + (r.height - growFrom.height) * pacedT + 'px',
          borderRadius: 28 + (20 - 28) * pacedT + 'px',
        });
        if (rawT < 1) {
          requestAnimationFrame(growTrackFrame);
        } else {
          iframe.style.transition = '';
          iframe.style.opacity = '';
          heroDocked = true;
          dockToHero();
        }
      }
    }
  }

  // Proactive teaser bubble: pops up on its own after a delay if the visitor
  // hasn't opened the chat, so the widget doesn't just sit there silently — and
  // is animated + paired with a pulsing launcher so it's genuinely hard to miss.
  // Unless a static data-teaser override is given, it shows the bot's actual
  // opening line (fetched for real, including the A/B-tested variant) — so the
  // visitor sees the real hook without even having to open the chat. When they
  // do open it, chat-ui shows that same hook plus a follow-up "reveal" message
  // (self-introduction + first real question) that only fires on open.
  var teaserDismissedKey = 'smartchat_teaser_dismissed_' + botToken;
  var teaserOverride = scriptTag.getAttribute('data-teaser');
  var teaserFallback = 'Я тот самый ИИ-продавец с картинки выше 👆 Проверим на деле?';
  var teaserDelay = Number(scriptTag.getAttribute('data-teaser-delay-ms')) || 3500;
  var teaserEl = null;

  function fetchOpeningReply() {
    return fetch(baseUrl + '/api/widget/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // pageHostname: read here, by our own script, on the actual page it's
      // running on — not something the embedding page hands us, so it's
      // meaningfully harder to fake than a self-typed site URL. See
      // WidgetService.checkDomainIntegrity on the backend, which also relies
      // on isPreview here to skip that check entirely for the cabinet's own
      // "Тестирование" pane (test-widget-preview.html loads this exact
      // script with data-preview="true", on chat.glavinstrument.com itself —
      // without isPreview forwarded here, every use of that pane would look
      // like a domain mismatch).
      body: JSON.stringify({
        botToken: botToken,
        sessionId: sessionId,
        isInit: true,
        isPreview: previewMode,
        pageHostname: window.location.hostname,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('init fetch failed: ' + res.status);
        return res.json();
      })
      .then(function (data) {
        return data.reply;
      });
  }

  // The owner's own cabinet testing pane (ownerTestingMode) re-loads this
  // exact page every time they test — permanently remembering "dismissed"
  // after just a single open-and-close (see hideTeaser below, and openChat's
  // own hideTeaser(true) call) meant the teaser silently stopped appearing
  // for the rest of that browser's life, looking like a bug rather than the
  // intended behavior it is for a real prospect. Real end-visitor dismissal
  // still persists normally; only this owner-testing context ignores it.
  function hideTeaser(remember) {
    if (teaserEl && teaserEl.parentNode) teaserEl.parentNode.removeChild(teaserEl);
    teaserEl = null;
    if (remember && !ownerTestingMode) localStorage.setItem(teaserDismissedKey, '1');
  }

  async function showTeaser() {
    if (isOpen || (!ownerTestingMode && localStorage.getItem(teaserDismissedKey))) return;

    var teaserText = teaserOverride || teaserFallback;
    // Always call isInit — even with a fixed override text — so message #1
    // is actually persisted server-side. Skipping this when an override is
    // set (e.g. the cabinet's own test-chat framing) used to mean the chat
    // window, once opened, found no history and replayed the *entire*
    // opening sequence (real hook + reveal, each split into bubbles) from
    // scratch — five-plus messages before the visitor had said a word.
    try {
      var fetched = await fetchOpeningReply();
      if (!teaserOverride && fetched) teaserText = fetched;
    } catch (err) {
      console.error('[Smartchat]', err);
    }
    // Re-check: the visitor may have opened the chat or dismissed the teaser
    // while we were waiting on the network.
    if (isOpen || (!ownerTestingMode && localStorage.getItem(teaserDismissedKey))) return;

    teaserEl = document.createElement('div');
    Object.assign(teaserEl.style, {
      position: 'fixed',
      bottom: (86 + offsetBottom) + 'px',
      right: '20px',
      left: '20px',
      marginLeft: widgetSide === 'right' ? 'auto' : '0',
      marginRight: widgetSide === 'right' ? '0' : 'auto',
      maxWidth: 'min(280px, calc(100vw - 40px))',
      width: 'fit-content',
      background: '#fff',
      color: '#1a1a1a',
      padding: '14px 34px 14px 16px',
      borderRadius: '14px',
      boxShadow: '0 10px 34px rgba(0,0,0,.25)',
      fontSize: '14.5px',
      fontWeight: '500',
      lineHeight: '1.45',
      cursor: 'pointer',
      zIndex: 2147483000,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      opacity: '0',
      transform: 'scale(0.85) translateY(8px)',
      transformOrigin: 'bottom ' + widgetSide,
      transition: 'opacity .28s ease, transform .28s cubic-bezier(.34,1.56,.64,1)',
    });
    teaserEl.textContent = teaserText;

    var closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      top: '8px',
      right: '10px',
      fontSize: '12px',
      color: '#94a3b8',
      cursor: 'pointer',
      padding: '4px',
    });
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      hideTeaser(true);
    });
    teaserEl.appendChild(closeBtn);

    teaserEl.addEventListener('click', openChat);
    document.body.appendChild(teaserEl);

    // Force layout so the transition below actually animates from the initial state.
    teaserEl.getBoundingClientRect();
    teaserEl.style.opacity = '1';
    teaserEl.style.transform = 'scale(1) translateY(0)';

    // The visitor is looking at the teaser right now — the moment most
    // likely to lead to a real open, and a natural pause to spend on
    // fetching + parsing the chat iframe in the background (autostart=0, so
    // this doesn't also trigger a real completion call — see chatUiUrl).
    // By the time they actually click, the network/JS-boot work that used
    // to happen only then is already done.
    ensureIframeLoaded();
  }

  // While hero-docked, the chat is already open in the hero — showing a
  // floating teaser bubble on top of that would be redundant. collapseHeroChat
  // schedules this same call itself, once the hero actually collapses.
  if (!heroTarget) setTimeout(showTeaser, teaserDelay);

  // Returning-visitor nudge: this browser has been here before (sessionId
  // already existed). Used to trigger off just that plus "teaser was ever
  // dismissed" — but opening the chat at all (even to glance and close it)
  // sets that same dismissed flag via hideTeaser(true) in openChat() below,
  // so it fired the "let's continue" copy on people who'd never actually said
  // a word. Now it checks real history first: only fires when the visitor
  // genuinely sent at least one message last time AND the dialog never
  // reached a real outcome (still "active") — a glance-and-close or an
  // already-completed conversation gets no nudge at all.
  var RETURNING_NUDGE_DELAY_MS = 5000;
  var returningNudgeText = 'С возвращением! Мы почти закончили — продолжим? 👋';

  function showReturningNudge() {
    if (isOpen || teaserEl) return;
    teaserEl = document.createElement('div');
    Object.assign(teaserEl.style, {
      position: 'fixed',
      bottom: (86 + offsetBottom) + 'px',
      right: '20px',
      left: '20px',
      marginLeft: widgetSide === 'right' ? 'auto' : '0',
      marginRight: widgetSide === 'right' ? '0' : 'auto',
      maxWidth: 'min(280px, calc(100vw - 40px))',
      width: 'fit-content',
      background: '#fff',
      color: '#1a1a1a',
      padding: '14px 34px 14px 16px',
      borderRadius: '14px',
      boxShadow: '0 10px 34px rgba(0,0,0,.25)',
      fontSize: '14.5px',
      fontWeight: '500',
      lineHeight: '1.45',
      cursor: 'pointer',
      zIndex: 2147483000,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      opacity: '0',
      transform: 'scale(0.85) translateY(8px)',
      transformOrigin: 'bottom ' + widgetSide,
      transition: 'opacity .28s ease, transform .28s cubic-bezier(.34,1.56,.64,1)',
    });
    teaserEl.textContent = returningNudgeText;

    var closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      top: '8px',
      right: '10px',
      fontSize: '12px',
      color: '#94a3b8',
      cursor: 'pointer',
      padding: '4px',
    });
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      hideTeaser(true);
    });
    teaserEl.appendChild(closeBtn);

    teaserEl.addEventListener('click', openChat);
    document.body.appendChild(teaserEl);

    teaserEl.getBoundingClientRect();
    teaserEl.style.opacity = '1';
    teaserEl.style.transform = 'scale(1) translateY(0)';

    // Same reasoning as showTeaser's own preload — this nudge is just as
    // much a "looking at the chat right now" moment.
    ensureIframeLoaded();
  }

  async function checkAndShowReturningNudge() {
    if (!isReturningVisitor || isOpen) return;
    try {
      var res = await fetch(
        baseUrl + '/api/widget/history?botToken=' + encodeURIComponent(botToken) + '&sessionId=' + encodeURIComponent(sessionId),
      );
      if (!res.ok) return;
      var data = await res.json();
      var hasVisitorMessage = (data.messages || []).some(function (m) { return m.role === 'visitor'; });
      var isUnfinished = data.dialogStatus === 'active';
      if (hasVisitorMessage && isUnfinished) showReturningNudge();
    } catch (err) {
      console.error('[Smartchat]', err);
    }
  }

  // Same reasoning as the showTeaser gate above — the visitor is already
  // mid-conversation in the docked hero chat, there's nothing to "return" to
  // yet. collapseHeroChat schedules this same call once it actually collapses.
  if (!heroTarget) setTimeout(checkAndShowReturningNudge, RETURNING_NUDGE_DELAY_MS);

  // Minimal public API so the embedding page (e.g. the landing page's own CTA
  // buttons) can open the chat programmatically instead of linking away.
  window.SmartchatWidget = { open: openChat };
})();
