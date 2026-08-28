(function () {
  var params = new URLSearchParams(location.search);
  var botToken = params.get('token');
  var apiBase = params.get('api') || location.origin;
  // Watermark for pollForNewMessages below — bumped in renderMessage itself
  // (every message shown, from ANY source: history, a normal turn, or the
  // poll) so the poll's own "createdAt > lastSeenAt" query never re-fetches
  // something already on screen. Starts at page-load time, which is exactly
  // the cutoff we want: anything from before this is already covered by the
  // initial loadHistory() render.
  var lastSeenAt = new Date().toISOString();
  // Belt-and-suspenders against the poll re-rendering a message the normal
  // turn flow is ALSO about to render (or just did): the assistant reply for
  // the visitor's own in-flight turn is saved server-side, with its own
  // createdAt, well BEFORE requestReplyAndRender's fetch resolves and
  // actually renders it client-side — a slow reply (LLM generation is often
  // the slowest part of a turn) leaves a real window where a background poll
  // can land in between "row saved" and "client renders it", see it as
  // "newer than lastSeenAt", and render it a beat before the turn's own code
  // does — both then render it, once each. Every message actually rendered,
  // by ANY path, gets its id recorded here first; the poll skips anything
  // already in this set.
  var renderedMessageIds = {};
  // No more mode-switching or storage-based flags inside this file at all —
  // every embedding context (a real customer's site, the landing page, the
  // cabinet's training pane, the cabinet's testing pane, the public
  // test-chat.html demo link) explicitly sets its OWN params once, in the
  // URL it constructs for its OWN iframe. Nothing here is read from
  // localStorage/sessionStorage, so there is no shared state left that could
  // ever leak between tabs or contexts — the entire class of bug that kept
  // showing up when this used to switch modes live inside one loaded iframe.
  var sessionId = params.get('session');
  // The owner testing/training their own bot, not a real visitor — every
  // request says so, so the backend never mistakes a deliberate test
  // question for a real customer stuck on something (see isPreview on
  // SendMessageDto), and it's excluded from real analytics.
  var isPreview = params.get('preview') === '1';
  // Menu-driven training configurator vs the real sales funnel — set only by
  // the cabinet's own training pane, which is the one place that ever passes
  // trainingMode=1 when building this iframe's URL.
  var trainingMode = isPreview && params.get('trainingMode') === '1';
  // Only ever set by test-widget-preview.html (the cabinet's own
  // "Тестирование" pane) — never by test-chat.html (the public demo link),
  // which also sets isPreview. Just a UI hint: showing "mark as bad" when
  // the viewer isn't actually the authenticated owner would just 401 on
  // submit, since ownership is verified server-side (see
  // WidgetController#addCorrection), same as trainingMode already is.
  var ownerPreview = isPreview && params.get('ownerPreview') === '1';
  // The public test-chat.html demo link specifically — isPreview but neither
  // the cabinet's own richer ownerPreview correction tool nor the
  // menu-driven trainingMode wizard. A tester here has no cabinet session at
  // all, so unlike attachCorrectionControl this never writes anything to the
  // bot directly — it only flags the message for the owner to review later
  // (see WidgetController#dislikeMessage, deliberately public/unauthenticated
  // for exactly that reason).
  var publicDislikeMode = isPreview && !ownerPreview && !trainingMode;
  if (params.get('mode') === 'fullscreen') {
    document.body.classList.add('fullscreen');
  }
  // Owner-configurable in the cabinet's "Обучение бота" section — the loader
  // (widget.js) and the cabinet's own pane URLs both pass this through; chat.css
  // reads it via the --primary custom property instead of a hardcoded hex.
  var colorParam = params.get('color');
  if (colorParam && /^#[0-9a-fA-F]{6}$/.test(colorParam)) {
    document.documentElement.style.setProperty('--primary', colorParam);
  }
  // widget.js now preloads this iframe (network fetch, JS parse/compile) the
  // moment the outside teaser bubble becomes visible, well before the visitor
  // actually clicks — but must NOT also trigger loadHistory()'s real
  // isInit/reveal call at that point, since most people who see the teaser
  // never open the chat at all (that'd be a wasted YandexGPT completion per
  // impression, not per open). autostart=0 defers the real start until
  // widget.js posts the go-ahead at the moment of a genuine open; every other
  // embedding context (cabinet panes, the public demo link) never sets this
  // param, so params.get() returns null there and behaves exactly as before —
  // start immediately, no waiting on a message that will never come.
  var autostart = params.get('autostart') !== '0';

  var messagesEl = document.getElementById('messages');
  var buttonsEl = document.getElementById('buttons');
  var form = document.getElementById('composer');
  var input = document.getElementById('input');
  // Lets the PARENT (widget.js) know the visitor is about to type — only it
  // can act on this: on a hero-docked mobile chat, the box normally sits at
  // the small in-page size the hero mockup defines, which the on-screen
  // keyboard would otherwise crush down to almost nothing. widget.js expands
  // the iframe to fill the real visible area (tracking window.visualViewport,
  // since the keyboard shrinks that, not the layout viewport) while focused,
  // and restores it on blur. A no-op everywhere else (normal floating widget,
  // desktop, cabinet test panes) — nothing listens for these there.
  if (window.parent !== window) {
    input.addEventListener('focus', function () {
      window.parent.postMessage({ type: 'smartchat:input-focus' }, '*');
    });
    input.addEventListener('blur', function () {
      window.parent.postMessage({ type: 'smartchat:input-blur' }, '*');
    });
  }
  var botNameLabel = document.getElementById('botNameLabel');
  var botNameSet = false;

  // bot.name in the DB is an admin-facing label ("Alina — Smartchat self-sell
  // demo bot", "ООО Ромашка — ИИ-консультант") — take the part before the
  // dash as the visitor-facing display name, same convention both the seeded
  // demo bot and every auto-provisioned client bot already follow.
  function updateBotName(rawName) {
    if (botNameSet || !rawName) return;
    var displayName = String(rawName).split(/\s+[—-]\s+/)[0].trim();
    if (displayName) {
      botNameLabel.textContent = displayName;
      botNameSet = true;
    }
  }

  // Same URL boundary rule as splitIntoBubbles below (stops before trailing
  // sentence punctuation, not just whitespace) — a real link handed to the
  // visitor (e.g. the cabinet registration link) must render as an actual
  // clickable <a>, not plain text they'd have to select and copy by hand.
  // Builds the bubble out of text nodes + <a> elements rather than innerHTML,
  // so nothing in the message content is ever interpreted as markup.
  //
  // Real visitors reported this still "just looked like text" even though it
  // was a genuine <a href> — a raw 80-character URL, same color as the
  // surrounding sentence, word-broken across 3 lines by CSS, reads as noise
  // rather than a button. Showing a short friendly label instead of the raw
  // URL (see linkLabelFor) plus a distinct link color (see chat.css) is what
  // actually makes it *look* clickable, not just technically be clickable.
  function linkLabelFor(url) {
    if (/\/cabinet\/register\.html(?:[?#]|$)/.test(url)) return 'Перейти к регистрации →';
    if (/\/test-chat\.html(?:[?#]|$)/.test(url)) return 'Открыть тестового бота →';
    if (/\/cabinet\/privacy\.html(?:[?#]|$)/.test(url)) return 'Политика обработки данных →';
    return 'Открыть ссылку →';
  }

  // beforeNode lets a slower-resolving call (the automatic reveal message —
  // see loadHistory's revealAnchor) insert its bubble at the point in the
  // transcript it logically belongs, even if it resolves AFTER a visitor
  // message that was typed and sent while it was still in flight. The
  // visitor's own bubble still renders the instant they hit send — nothing
  // ever delays or blocks that — this only affects where a LATE-arriving
  // bubble gets inserted once it finally does resolve.
  function insertBubble(bubble, beforeNode) {
    if (beforeNode && beforeNode.parentNode === messagesEl) {
      messagesEl.insertBefore(bubble, beforeNode);
    } else {
      messagesEl.appendChild(bubble);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // A file the bot attached from the knowledge base (StructuredReply.
  // attachmentUrl — see widget.service.ts) — an image renders inline,
  // anything else (contract PDFs, docs) as a plain download link. Always a
  // SEPARATE bubble after the text reply, never a replacement for it.
  function renderAttachment(attachment, beforeNode) {
    var bubble = document.createElement('div');
    bubble.className = 'bubble bubble-assistant bubble-attachment';
    if (attachment.mimeType && attachment.mimeType.indexOf('image/') === 0) {
      var img = document.createElement('img');
      img.src = attachment.url;
      img.alt = attachment.name || 'Изображение';
      img.className = 'attachment-image';
      bubble.appendChild(img);
    } else {
      var link = document.createElement('a');
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'attachment-file-link';
      link.textContent = '📎 ' + (attachment.name || 'Файл');
      bubble.appendChild(link);
    }
    insertBubble(bubble, beforeNode);
    return bubble;
  }

  function renderMessage(role, content, beforeNode, attachment) {
    // See lastSeenAt's own comment — every render, regardless of source,
    // advances the poll's watermark so it never re-shows this same message.
    lastSeenAt = new Date().toISOString();
    var bubble = document.createElement('div');
    bubble.className = 'bubble ' + (role === 'visitor' ? 'bubble-visitor' : 'bubble-assistant');

    // The friendly-label rewrite (linkLabelFor) only makes sense for the
    // bot's OWN curated links (registration, test-chat, etc). A visitor's
    // own typed message must render back exactly as they typed it — relabeling
    // a link the visitor themselves pasted (e.g. their own site's URL) as a
    // generic "Открыть ссылку →" hides what they actually sent.
    if (role !== 'assistant') {
      bubble.appendChild(document.createTextNode(content));
      insertBubble(bubble, beforeNode);
      return bubble;
    }

    // Trailing punctuation is stripped from the match via the lookahead so a
    // URL at the end of a sentence doesn't pull the period into its href.
    // Closing brackets/quotes belong in that same "safe to strip" set — found
    // live: a URL wrapped in "(...)" pulled the ")" straight into the href,
    // producing a real link to ".../privacy.html)" that 404s.
    var urlPattern = /https?:\/\/[^\s]+?(?=[.,!?;:)\]}»"']*(?:\s|$))/g;
    var lastIndex = 0;
    var match;
    while ((match = urlPattern.exec(content)) !== null) {
      if (match.index > lastIndex) {
        bubble.appendChild(document.createTextNode(content.slice(lastIndex, match.index)));
      }
      var link = document.createElement('a');
      link.href = match[0];
      link.textContent = linkLabelFor(match[0]);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      bubble.appendChild(link);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < content.length) {
      bubble.appendChild(document.createTextNode(content.slice(lastIndex)));
    }

    insertBubble(bubble, beforeNode);
    if (attachment && attachment.url) renderAttachment(attachment, beforeNode);
    return bubble;
  }

  // Owner-only (see ownerPreview above): a small control under the bot's
  // LAST bubble of a turn, not each individual bubble — a multi-bubble reply
  // reads as one response to react to, not several. Clicking reveals an
  // inline "what should it have said" field; submitting stores the (bad,
  // good) pair against the situation that preceded it, so a similar future
  // situation retrieves this correction instead of repeating the mistake
  // (see WidgetService/KnowledgeService.createCorrection on the backend).
  function attachCorrectionControl(lastBubble, situationContext, badReply) {
    var wrap = document.createElement('div');
    wrap.className = 'correction-control';

    var flagBtn = document.createElement('button');
    flagBtn.type = 'button';
    flagBtn.className = 'correction-flag-btn';
    flagBtn.textContent = '👎 Плохой ответ?';
    wrap.appendChild(flagBtn);

    // Regenerates a candidate reply from the note instead of saving it
    // verbatim, so the owner sees whether it actually reads better before
    // anything is remembered — "Попробовать ещё раз" just refines the note
    // and re-previews; only the final confirm step calls /api/widget/correction.
    function showEditor() {
      wrap.innerHTML = '';

      var textarea = document.createElement('textarea');
      textarea.className = 'correction-textarea';
      textarea.placeholder = 'Что не так и/или как надо было ответить?';
      wrap.appendChild(textarea);

      var actions = document.createElement('div');
      actions.className = 'correction-actions';
      wrap.appendChild(actions);

      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'correction-cancel-btn';
      cancelBtn.textContent = 'Отмена';
      actions.appendChild(cancelBtn);
      cancelBtn.addEventListener('click', function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      });

      // Direct path — no regeneration, no rewording: for when there's already
      // a finished correct answer typed out and running it through the model
      // again would just be a chance for it to get reworded or ignored.
      var saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'correction-submit-btn';
      saveBtn.textContent = 'Сохранить как есть';
      actions.appendChild(saveBtn);
      saveBtn.addEventListener('click', function () {
        var goodReply = textarea.value.trim();
        if (!goodReply) return;
        saveBtn.disabled = true;
        previewBtn.disabled = true;
        cancelBtn.disabled = true;
        saveBtn.textContent = 'Сохраняю…';
        fetch(apiBase + '/api/widget/correction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: botToken,
            situationContext: situationContext,
            badReply: badReply,
            goodReply: goodReply,
          }),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('save failed');
            wrap.innerHTML = '';
            wrap.textContent = 'Учла — в похожей ситуации отвечу иначе.';
            wrap.classList.add('correction-saved');
          })
          .catch(function () {
            wrap.innerHTML = '';
            wrap.textContent = 'Не получилось сохранить. Вы точно вошли в кабинет владельцем этого бота?';
            wrap.classList.add('correction-error');
          });
      });

      var previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'correction-submit-btn';
      previewBtn.textContent = 'Показать вариант ответа';
      actions.appendChild(previewBtn);
      previewBtn.addEventListener('click', function () {
        var note = textarea.value.trim();
        if (!note) return;
        previewBtn.disabled = true;
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        previewBtn.textContent = 'Генерирую…';
        fetch(apiBase + '/api/widget/correction/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: botToken,
            situationContext: situationContext,
            badReply: badReply,
            note: note,
          }),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('preview failed');
            return res.json();
          })
          .then(function (result) {
            showPreview(result.candidateReply);
          })
          .catch(function (err) {
            wrap.innerHTML = '';
            wrap.textContent = (err && err.message) || 'Не получилось сгенерировать вариант. Вы точно вошли в кабинет владельцем этого бота?';
            wrap.classList.add('correction-error');
          });
      });
    }

    function showPreview(candidateReply) {
      wrap.innerHTML = '';

      var label = document.createElement('div');
      label.className = 'correction-preview-label';
      label.textContent = 'Новый вариант ответа — можно поправить перед сохранением:';
      wrap.appendChild(label);

      // Editable, not a static line — the model's own wording is a starting
      // point, not the final word; the owner can fix it by hand instead of
      // choosing only between "accept as-is" or "start over".
      var editArea = document.createElement('textarea');
      editArea.className = 'correction-preview-text';
      editArea.value = candidateReply;
      wrap.appendChild(editArea);

      var actions = document.createElement('div');
      actions.className = 'correction-actions';
      wrap.appendChild(actions);

      var retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'correction-cancel-btn';
      retryBtn.textContent = 'Попробовать ещё раз';
      actions.appendChild(retryBtn);
      retryBtn.addEventListener('click', showEditor);

      var confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'correction-submit-btn';
      confirmBtn.textContent = 'Ответ подходит — запомнить';
      actions.appendChild(confirmBtn);
      confirmBtn.addEventListener('click', function () {
        var finalReply = editArea.value.trim();
        if (!finalReply) return;
        confirmBtn.disabled = true;
        retryBtn.disabled = true;
        confirmBtn.textContent = 'Сохраняю…';
        fetch(apiBase + '/api/widget/correction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: botToken,
            situationContext: situationContext,
            badReply: badReply,
            goodReply: finalReply,
          }),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('save failed');
            wrap.innerHTML = '';
            wrap.textContent = 'Учла — в похожей ситуации отвечу иначе.';
            wrap.classList.add('correction-saved');
          })
          .catch(function () {
            wrap.innerHTML = '';
            wrap.textContent = 'Не получилось сохранить. Вы точно вошли в кабинет владельцем этого бота?';
            wrap.classList.add('correction-error');
          });
      });
    }

    flagBtn.addEventListener('click', showEditor);

    lastBubble.insertAdjacentElement('afterend', wrap);
  }

  // Public tester (publicDislikeMode only) — a single click, no form. Unlike
  // attachCorrectionControl this can't target an individual bubble: it flags
  // the actual stored Message row (one per TURN, see messageId on the
  // response), which is the granularity the owner's later review queue in
  // "Обучение бота" works at. Never writes anything to the bot itself —
  // see WidgetController#dislikeMessage.
  function attachDislikeControl(lastBubble, messageId) {
    if (!messageId) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dislike-flag-btn';
    btn.textContent = '👎 Не понравился ответ';
    btn.title = 'Сообщить о неудачном ответе';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      fetch(apiBase + '/api/widget/dislike', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken, sessionId: sessionId, messageId: messageId }),
      })
        .then(function () {
          btn.textContent = '👎 Спасибо, передано';
          btn.classList.add('dislike-flag-sent');
        })
        .catch(function () {
          btn.disabled = false;
        });
    });
    lastBubble.insertAdjacentElement('afterend', btn);
  }

  function renderButtons(buttons) {
    buttonsEl.innerHTML = '';
    (buttons || []).forEach(function (label) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-reply';
      btn.textContent = label;
      btn.addEventListener('click', function () {
        send(null, label);
      });
      buttonsEl.appendChild(btn);
    });
  }

  // Returns the element instead of tracking it in one shared/module-level
  // variable — a visitor is never blocked from sending a second message
  // before the first one's reply has finished rendering (that's just normal
  // chat behavior, real widgets don't lock the composer), so two
  // requestReplyAndRender calls can genuinely be in flight at once. A single
  // shared "current typing element" broke exactly that case: the second
  // call's showTyping() silently overwrote the first call's reference, so
  // the first call's own hideTyping() then removed the SECOND call's
  // indicator instead of its own — leaving one bubble's dots stuck forever
  // and the other rendering under whichever element was left. Each call now
  // owns and clears only the element it created.
  function showTyping(beforeNode) {
    var el = document.createElement('div');
    el.className = 'bubble bubble-assistant typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    if (beforeNode && beforeNode.parentNode === messagesEl) {
      messagesEl.insertBefore(el, beforeNode);
    } else {
      messagesEl.appendChild(el);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }
  function hideTyping(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // Real humans don't start typing the instant a message arrives — they read it
  // first. This "reading" pause happens before the typing indicator even appears.
  // Same sqrt reasoning as typingDelayFor below: a low linear cap makes every
  // visitor message past ~160 chars "read" in the same fixed time.
  // Tuned so a short greeting ("здравствуйте", ~12 chars) reads as ~1-2s, and a
  // longer/more involved question reads visibly slower, up to the cap.
  function readingDelayFor(text) {
    var len = (text || '').length;
    var base = 900 + Math.random() * 700;
    var scaled = 130 * Math.sqrt(len);
    return base + Math.min(scaled, 3000);
  }

  // The bot's very first message in a brand-new dialog isn't a reply to
  // anything — there's no visitor text to "read". What a live operator does
  // instead is notice the new chat request and pick it up (accept it in the
  // CRM/inbox) before typing a word — a distinct, usually longer and more
  // variable pause than reading a message that's already open in front of you.
  function acceptDialogDelay() {
    return 1800 + Math.random() * 2400;
  }

  // Then a "typing" pause, scaled by reply length with enough randomness that it
  // doesn't feel like a fixed formula every time.
  //
  // Deliberately sqrt-scaled instead of linear-then-capped: a linear-per-char
  // delay with a low ceiling (the previous version capped at 3800ms, which a
  // 100-300 char reply already reaches) means a two-sentence reply and a
  // five-sentence reply end up waiting the exact same amount of time — that
  // sameness is itself a tell that gives away the fixed formula underneath.
  // sqrt keeps growing (no hard wall) while still flattening out for very
  // long replies so the wait never becomes annoying.
  function typingDelayFor(text) {
    var len = (text || '').length;
    var base = 900 + Math.random() * 1100;
    var scaled = 320 * Math.sqrt(len);
    return base + Math.min(scaled, 8000);
  }

  // Splits a reply into 1-3 separate bubbles instead of one wall of text — the
  // way a person sends a couple of short messages in a row. A trailing question
  // (the call-to-action) always lands in its own final bubble.
  //
  // The sentence-boundary regex below treats "." and "?" as sentence enders —
  // which a URL is full of (domain dots, a "?" query string). Splitting a URL
  // like that on every internal dot means no valid sentence match exists
  // anywhere in it until the LAST dot-free run (e.g. the token value at the
  // end of ?token=...), so the entire scheme+domain+path silently vanishes and
  // the visitor is left staring at a bare "token=<uuid>" with no link at all.
  // Fix: pull any URL out into a placeholder first, split on sentences, then
  // put the real URL back — so it can never be chopped up by "." or "?".
  function splitIntoBubbles(text) {
    var urls = [];
    var textNoUrls = text.replace(/https?:\/\/[^\s]+?(?=[.,!?;:]*(?:\s|$))/g, function (url) {
      urls.push(url);
      return '\x00URL' + (urls.length - 1) + '\x00';
    });

    // Walked with .exec()/lastIndex instead of a single .match() call: a reply
    // whose final sentence has no closing "." (very common right after a raw
    // URL/token — the model just stops there) used to have that ENTIRE tail
    // silently discarded. .match() only ever returns what the pattern
    // matched, never "whatever text came after the last match" — so a
    // registration link with nothing following it vanished with no error
    // anywhere, and the visitor saw a reply that just stopped short. Seen
    // live: exactly this, on a real prospect's signup. Any leftover text
    // after the last real sentence is now kept as one final sentence of its
    // own, punctuation or not.
    var sentencePattern = /[^.!?]+[.!?]+(?:\s+|$)/g;
    var rawSentences = [];
    var match;
    var lastMatchEnd = 0;
    // Track the end position ourselves — a global regex's own .lastIndex
    // resets to 0 the moment .exec() returns null, so reading it AFTER the
    // loop (instead of capturing it on each successful iteration) would
    // always see 0, silently undoing this whole fix.
    while ((match = sentencePattern.exec(textNoUrls)) !== null) {
      rawSentences.push(match[0]);
      lastMatchEnd = sentencePattern.lastIndex;
    }
    if (lastMatchEnd < textNoUrls.length) {
      var remainder = textNoUrls.slice(lastMatchEnd);
      if (remainder.trim()) rawSentences.push(remainder);
    }
    if (rawSentences.length === 0) rawSentences = [textNoUrls];

    var sentences = rawSentences
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean)
      .map(function (s) {
        return s.replace(/\x00URL(\d+)\x00/g, function (_, i) { return urls[Number(i)]; });
      });

    if (sentences.length <= 1) return [text];

    var lastIndex = sentences.length - 1;
    var lastIsQuestion = /\?\s*$/.test(sentences[lastIndex]);
    var body = lastIsQuestion ? sentences.slice(0, lastIndex) : sentences;
    var question = lastIsQuestion ? sentences[lastIndex] : null;

    var bubbles = [];
    if (body.length > 0) {
      if (body.length <= 2) {
        bubbles.push(body.join(' '));
      } else {
        var mid = Math.ceil(body.length / 2);
        bubbles.push(body.slice(0, mid).join(' '));
        bubbles.push(body.slice(mid).join(' '));
      }
    }
    if (question) bubbles.push(question);

    return bubbles.length ? bubbles : [text];
  }

  // Tracks what the visitor last said, so if the owner flags the bot's NEXT
  // reply as bad (ownerPreview only), the correction is stored against the
  // situation that actually triggered it. Empty for isInit/isReveal turns —
  // there's no preceding visitor message yet, and that's fine, the same as
  // AddCorrectionDto treats situationContext as optional.
  var lastVisitorText = '';

  // Tracks what the bot said in its PREVIOUS turn — a bare "Да" or "Я
  // передумал" means something completely different depending on what
  // question it's answering, so the situation stored for a correction (and
  // matched against later) needs both halves, not just the visitor's own
  // one-word reply. Updated at the end of each requestReplyAndRender call,
  // AFTER it's been read for the CURRENT turn's situation — see there.
  var lastBotText = '';

  // Set by sendInit/sendReveal while their own auto-fired completion is in
  // flight, cleared once it settles. send() aborts it the instant the
  // visitor submits their own real message during that window — the
  // backend then merges the missing self-intro into that real message's own
  // reply instead of ever finishing (and saving) a reveal nobody will read.
  // See WidgetService.processMessage's SupersededTurnError handling.
  var pendingAutoTurnAbort = null;

  // Never a fake bot reply — a failed send shows up as a small labeled pill
  // right after the visitor's OWN message, similar to how WhatsApp/Telegram
  // mark an undelivered message. Only ever used for a visitor's own message
  // that genuinely couldn't be sent — never for a failed opening line (see
  // requestReplyAndRenderWithRetries, used silently there instead), so an
  // icon never appears floating in an otherwise-empty chat with nothing to
  // explain it. The visitor's question is already saved server-side
  // regardless of whether a reply came back (see MessagesService.append in
  // processMessage, which runs before the model is ever asked for anything),
  // so "Повторить" just asks for a fresh reply to what's already there — see
  // the `retry` request flag — never resends (and so never duplicates) the
  // question itself. "Удалить" instead discards it server-side too (see
  // MessagesService.discardLastUnanswered) so an abandoned question doesn't
  // sit in the transcript forever looking unanswered.
  function showSendFailure(anchorEl, retryFn, deleteFn) {
    var pill = document.createElement('div');
    pill.className = 'send-failed-pill';

    var icon = document.createElement('span');
    icon.className = 'send-failed-pill-icon';
    icon.textContent = '!';
    pill.appendChild(icon);

    var label = document.createElement('span');
    label.textContent = 'Не отправлено';
    pill.appendChild(label);

    var retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'send-failed-pill-action';
    retryBtn.textContent = 'Повторить';
    pill.appendChild(retryBtn);
    retryBtn.addEventListener('click', function () {
      pill.remove();
      retryFn();
    });

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'send-failed-pill-action';
    deleteBtn.textContent = 'Удалить';
    pill.appendChild(deleteBtn);
    deleteBtn.addEventListener('click', function () {
      pill.remove();
      if (anchorEl && anchorEl.parentNode) anchorEl.parentNode.removeChild(anchorEl);
      deleteFn();
    });

    anchorEl.insertAdjacentElement('afterend', pill);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function requestReplyAndRender(body, initialDelayMs, onFailure, beforeNode, signal) {
    // Kick off the real request immediately so network latency overlaps with the
    // reading/typing pauses rather than adding on top of them.
    var requestPromise = fetch(apiBase + '/api/widget/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal,
    });

    // The composer is never locked — a visitor can type and send again
    // before this turn's reply has even come back, same as any real chat
    // widget. showTyping/hideTyping take the element explicitly (see there)
    // specifically so this can safely overlap with another in-flight call.
    // `beforeNode`, when given (only the automatic reveal call passes one —
    // see loadHistory's revealAnchor), is where THIS call's own bubbles get
    // inserted instead of appended to the end — so a visitor who sends their
    // own message while this one is still in flight never has it render out
    // of order ahead of this one, without ever blocking their composer.
    var typingEl = null;

    try {
      if (initialDelayMs > 0) await sleep(initialDelayMs);
      typingEl = showTyping(beforeNode);
      var typingStartedAt = Date.now();

      var res = await requestPromise;
      if (!res.ok) throw new Error('Request failed with status ' + res.status);
      var data = await res.json();
      // Recorded as early as possible — before any of the typing-delay
      // sleeps and rendering below — to close the race with pollForNewMessages
      // as tightly as this code can (see renderedMessageIds' own comment).
      if (data.messageId) renderedMessageIds[data.messageId] = true;
      updateBotName(data.botName);
      var bubbles = splitIntoBubbles(data.reply);

      // Captured BEFORE lastBotText is overwritten below — this is what the
      // bot said in the PRECEDING turn, i.e. the question lastVisitorText is
      // actually answering. Combined, these two lines are the real
      // "situation": a bare "Да" or "Я передумал" only means something once
      // you know what it's a reply to.
      var situationContext = lastBotText ? lastBotText + '\n' + lastVisitorText : lastVisitorText;
      lastBotText = data.reply;

      // First bubble covers whatever's left of the network wait, so its pause
      // feels proportional to its own length rather than to raw request time.
      var elapsed = Date.now() - typingStartedAt;
      var wantDelay = typingDelayFor(bubbles[0]);
      if (elapsed < wantDelay) await sleep(wantDelay - elapsed);
      hideTyping(typingEl);
      var bubbleEl0 = renderMessage('assistant', bubbles[0], beforeNode);
      var lastBubbleEl = bubbleEl0;
      // One control per BUBBLE, not per turn — a multi-bubble reply often has
      // only ONE bad message in it (e.g. the 2nd of 3), and a control that
      // only shows up after the last bubble reads as "flag the whole batch",
      // leaving no way to point at the one that was actually wrong.
      if (ownerPreview) attachCorrectionControl(bubbleEl0, situationContext, bubbles[0]);

      // Any further bubbles read as separate follow-up texts, each with its own
      // brief pause and typing indicator — UNLESS the network wait already ran
      // long. The first bubble's delay above only ever overlaps real network
      // time, so it's harmless regardless of backend speed — but every bubble
      // after that adds a brand new pause with nothing to overlap it. That's
      // fine on top of a normal ~1s reply; stacked on top of an already-slow
      // reasoning-model reply (a real one seen live: 35s) it turns one slow
      // reply into a much slower one for zero benefit — a visitor who already
      // waited that long no longer reads extra "typing…" pauses as human, just
      // as more waiting.
      var alreadySlow = elapsed > 4000;
      for (var i = 1; i < bubbles.length; i++) {
        await sleep(alreadySlow ? 200 : 300 + Math.random() * 400);
        if (!alreadySlow) {
          typingEl = showTyping(beforeNode);
          await sleep(typingDelayFor(bubbles[i]));
          hideTyping(typingEl);
        }
        lastBubbleEl = renderMessage('assistant', bubbles[i], beforeNode);
        if (ownerPreview) attachCorrectionControl(lastBubbleEl, situationContext, bubbles[i]);
      }

      if (data.attachmentUrl) {
        renderAttachment({ url: data.attachmentUrl, name: data.attachmentName, mimeType: data.attachmentMimeType }, beforeNode);
      }
      renderButtons(data.buttons);

      // Unlike the correction control, this is per TURN (last bubble only) —
      // it flags the one stored Message row the whole reply lives in, not
      // an individual visual bubble (see messageId comment on the backend).
      if (publicDislikeMode) attachDislikeControl(lastBubbleEl, data.messageId);
    } catch (err) {
      hideTyping(typingEl);
      // A deliberate cancellation (the visitor's own real message superseded
      // this call — see loadHistory's revealAbort) is not a failure to show
      // any UI for or retry through; it's the abort working as intended.
      if (err && err.name === 'AbortError') return;
      console.error('[Smartchat]', err);
      if (onFailure) onFailure();
    }
  }

  // Silent retries before ever showing the visitor a failure state — most
  // real-device failures are the mobile connection dropping out for a
  // moment, not a genuine backend problem, and a visitor should essentially
  // never see any failure UI for those. `retryBody` (not `initialBody`
  // again) is used for every retry attempt so each one is flagged the same
  // way a manual retry click would be — see the `retry` request flag.
  // `extraDelaysMs` is a list of pauses, one per additional silent attempt —
  // increasing delays give a longer outage progressively more patience
  // instead of hammering the network right away. `onFinalFailure` is
  // optional: the opening-line callers below pass none at all, since a
  // failure there should never surface the message-failure pill (see
  // showSendFailure) — it just quietly gives up and lets the visitor's own
  // first typed message carry the full retry/delete treatment instead.
  async function requestReplyAndRenderWithRetries(initialBody, retryBody, initialDelayMs, extraDelaysMs, onFinalFailure, beforeNode, signal) {
    var failed = false;
    await requestReplyAndRender(initialBody, initialDelayMs, function () {
      failed = true;
    }, beforeNode, signal);
    for (var i = 0; failed && (!signal || !signal.aborted) && i < extraDelaysMs.length; i++) {
      failed = false;
      await sleep(extraDelaysMs[i]);
      await requestReplyAndRender(retryBody, 0, function () {
        failed = true;
      }, beforeNode, signal);
    }
    if (failed && onFinalFailure) onFinalFailure();
  }

  async function send(message, buttonPayload) {
    var visitorText = buttonPayload || message;
    if (!visitorText) return;
    // The visitor's own real message always wins over an auto-fired reveal/
    // init still in flight — cancel it rather than let both land. The
    // backend folds the missing self-intro into THIS message's own reply
    // instead (see WidgetService's blended-instructions branch).
    if (pendingAutoTurnAbort) {
      pendingAutoTurnAbort.abort();
      pendingAutoTurnAbort = null;
      // The abort can still arrive at the server AFTER its own LLM call has
      // already resolved (aborting something already finished does nothing)
      // — when that happens the reveal is a real, saved message the visitor
      // never saw rendered, not a cancelled one. Check for exactly that and
      // splice it in before continuing, so nothing the bot actually said
      // silently vanishes from view while still existing in history for
      // every later turn to reference.
      try {
        var histRes = await fetch(
          apiBase + '/api/widget/history?botToken=' + encodeURIComponent(botToken) + '&sessionId=' + encodeURIComponent(sessionId),
        );
        var histData = await histRes.json();
        var secondMsg = histData.messages && histData.messages[1];
        if (secondMsg && secondMsg.role === 'assistant') {
          splitIntoBubbles(secondMsg.content).forEach(function (chunk) {
            renderMessage('assistant', chunk);
          });
          renderButtons(secondMsg.buttons || []);
          lastBotText = secondMsg.content;
        }
      } catch (err) {
        console.error('[Smartchat]', err);
      }
    }
    lastVisitorText = visitorText;
    var visitorBubbleEl = renderMessage('visitor', visitorText);
    renderButtons([]);

    // Retry resends this SAME body (not just a bare "try again" signal) —
    // that's what makes it correct no matter WHERE the previous attempt
    // actually failed. If it never even reached the backend (pure network
    // failure), this is genuinely the first arrival of the text and gets
    // saved normally. If the backend DID receive and save it but the reply
    // itself failed to generate afterwards, the backend recognizes this as
    // the same unanswered message already on file and skips re-saving it —
    // either way, never a duplicated question in the transcript.
    var baseBody = {
      botToken: botToken,
      sessionId: sessionId,
      message: buttonPayload ? undefined : message,
      buttonPayload: buttonPayload || undefined,
      isPreview: isPreview,
      trainingMode: trainingMode,
    };
    var retryBody = Object.assign({}, baseBody, { retry: true });

    function manualRetry() {
      requestReplyAndRender(retryBody, 0, function () {
        showSendFailure(visitorBubbleEl, manualRetry, discardFailed);
      });
    }

    // "Удалить" — tells the backend to drop this still-unanswered message
    // too (see MessagesService.discardLastUnanswered), not just hide it
    // locally, so it doesn't linger in the transcript looking unanswered.
    function discardFailed() {
      fetch(apiBase + '/api/widget/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken, sessionId: sessionId }),
      }).catch(function (err) {
        console.error('[Smartchat]', err);
      });
    }

    // One silent retry before ever showing the visitor a failure state —
    // most real-world failures are a transient mobile-network blip, not an
    // actual backend problem. See requestReplyAndRenderWithRetries.
    await requestReplyAndRenderWithRetries(baseBody, retryBody, readingDelayFor(visitorText), [1200], function () {
      showSendFailure(visitorBubbleEl, manualRetry, discardFailed);
    });
  }

  // Opens the conversation with the bot's own opening line — no fake visitor
  // message. Only valid for a brand-new dialog (backend enforces this too).
  // Uses acceptDialogDelay, not readingDelayFor: there's nothing to read yet,
  // this is the "operator noticed and picked up the new chat" pause instead.
  // No visitor message exists yet, so a failure here never shows the
  // message-failure pill (see requestReplyAndRenderWithRetries) — just a
  // few extra silent attempts, then a quiet give-up.
  async function sendInit(beforeNode) {
    var body = { botToken: botToken, sessionId: sessionId, isInit: true, isPreview: isPreview, trainingMode: trainingMode };
    pendingAutoTurnAbort = new AbortController();
    await requestReplyAndRenderWithRetries(body, body, acceptDialogDelay(), [1500, 3000], undefined, beforeNode, pendingAutoTurnAbort.signal);
  }

  // Fires right when the visitor actually opens the chat, immediately after
  // the outside teaser hook — a second bot message that introduces her by
  // name and asks the first real question, distinct from the hook itself.
  // Deliberately a bit longer than a mid-conversation reply: right after
  // opening is exactly where a rapid-fire second message reads as "the bot
  // writes a lot right away" — a beat here makes it feel like two separate
  // thoughts, not one dump of text.
  async function sendReveal(beforeNode) {
    var body = { botToken: botToken, sessionId: sessionId, isReveal: true, isPreview: isPreview, trainingMode: trainingMode };
    pendingAutoTurnAbort = new AbortController();
    await requestReplyAndRenderWithRetries(body, body, 1300 + Math.random() * 1000, [1500, 3000], undefined, beforeNode, pendingAutoTurnAbort.signal);
  }

  async function loadHistory() {
    // Marks where THIS call's own automatic message belongs in the transcript
    // — inserted now, before any network call, so it's already in place if a
    // visitor sends their own message while this one is still generating.
    // Never blocks the composer: the visitor can type and send immediately;
    // this only decides where the automatic reply lands once it does arrive
    // (see requestReplyAndRender's beforeNode).
    var revealAnchor = document.createComment('smartchat-reveal-anchor');
    messagesEl.appendChild(revealAnchor);
    try {
      try {
        var res = await fetch(
          apiBase +
            '/api/widget/history?botToken=' +
            encodeURIComponent(botToken) +
            '&sessionId=' +
            encodeURIComponent(sessionId),
        );
        var data = await res.json();
        updateBotName(data.botName);
        if (data.messages && data.messages.length > 0) {
          // Only the outside teaser hook has happened so far (one assistant
          // message, no visitor reply yet). The visitor already read that hook
          // as the popup bubble outside — re-showing the exact same text as
          // message #1 inside the chat just repeats it and reads as "writes a
          // lot right away". Skip straight to the reveal instead; it becomes
          // the visible first message.
          var onlyTeaserHookSoFar = data.messages.length === 1 && data.messages[0].role === 'assistant';
          if (!onlyTeaserHookSoFar) {
            data.messages.forEach(function (m) {
              if (m.id) renderedMessageIds[m.id] = true;
              if (m.role === 'assistant') {
                splitIntoBubbles(m.content).forEach(function (chunk) {
                  renderMessage('assistant', chunk, revealAnchor);
                });
                if (m.attachmentUrl) {
                  renderAttachment({ url: m.attachmentUrl, name: m.attachmentName, mimeType: m.attachmentMimeType }, revealAnchor);
                }
              } else {
                renderMessage(m.role, m.content, revealAnchor);
              }
            });
            var last = data.messages[data.messages.length - 1];
            if (last.role === 'assistant') renderButtons(last.buttons);
          } else {
            await sendReveal(revealAnchor);
          }
          return;
        }
      } catch (err) {
        console.error('[Smartchat]', err);
      }
      // No prior history at all — the visitor opened the chat before the
      // outside teaser bubble had a chance to fire (its own independent timer
      // hadn't elapsed yet). There's no hook to react to, so don't print one as
      // a separate first message here — go straight to a self-contained
      // greeting instead (see COLD_OPEN_INSTRUCTIONS on the backend). Training
      // mode has no separate "hook then reveal" — the menu message IS the
      // opening turn, so it still uses isInit.
      if (trainingMode) {
        await sendInit(revealAnchor);
      } else {
        await sendReveal(revealAnchor);
      }
    } finally {
      if (revealAnchor.parentNode) revealAnchor.parentNode.removeChild(revealAnchor);
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });

  // The old floating "Дать совет боту" / "Добавить информацию" bar and the
  // Тестирование/Обучение switch both lived in this file, gated by a preview
  // flag — removed entirely, not just re-gated. Testing (isPreview, no
  // trainingMode) is now a byte-for-byte copy of the real customer
  // experience, full stop; training (isPreview + trainingMode) already has
  // its own menu-driven configurator covering the same ground (advice, KB,
  // site, goal, variant, Telegram) via processTrainingMessage on the
  // backend, so there's nothing left for a second, overlapping control to do.
  // The cabinet embeds this same file twice, side by side, each with its own
  // fixed identity baked into its own iframe URL — see cabinet/index.html.

  // The only channel a team member's confirmed Telegram/dislike-resolve
  // answer (see backend TelegramService.handleReplyAnswer,
  // DislikesService.resolve) has to reach a tab that's already sitting open
  // — there's no WebSocket/SSE here, just a cheap periodic check. Runs the
  // whole time this page is loaded, independent of autostart/isOpen: a
  // preloaded-but-not-yet-opened iframe polling a little early is harmless
  // (the visitor has no dialog row yet, so getNewMessages just returns
  // nothing), and it means the poll is already running by the time they do
  // open it instead of only starting then.
  var POLL_INTERVAL_MS = 8000;
  function pollForNewMessages() {
    fetch(
      apiBase +
        '/api/widget/messages/poll?botToken=' +
        encodeURIComponent(botToken) +
        '&sessionId=' +
        encodeURIComponent(sessionId) +
        '&after=' +
        encodeURIComponent(lastSeenAt),
    )
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.messages || data.messages.length === 0) return;
        // Only ever render 'assistant' messages here — the visitor's OWN
        // messages are already rendered locally, optimistically, the instant
        // send() fires, well before this poll's request even goes out. The
        // server timestamps a visitor message's createdAt AFTER that local
        // render (it's saved on the round trip send() itself makes), so it's
        // almost always > lastSeenAt by the time this poll asks for
        // "anything after lastSeenAt" — rendering it again here duplicated
        // every visitor bubble the moment a poll happened to land in that
        // window (this is what caused messages appearing sent twice).
        // Also skips anything already rendered by requestReplyAndRender's own
        // turn flow (or the initial loadHistory) — closes the reverse race:
        // a slow-generating reply can finish saving server-side well before
        // the client's own fetch resolves, giving this poll a real window to
        // see it as "new" and render it here first, moments before the
        // turn's own code renders that SAME message again.
        var assistantMessages = data.messages.filter(function (m) {
          return m.role === 'assistant' && !(m.id && renderedMessageIds[m.id]);
        });
        if (assistantMessages.length === 0) return;
        assistantMessages.forEach(function (m) {
          if (m.id) renderedMessageIds[m.id] = true;
          splitIntoBubbles(m.content).forEach(function (chunk) { renderMessage('assistant', chunk); });
          if (m.attachmentUrl) {
            renderAttachment({ url: m.attachmentUrl, name: m.attachmentName, mimeType: m.attachmentMimeType });
          }
        });
        renderButtons(assistantMessages[assistantMessages.length - 1].buttons);
      })
      .catch(function (err) { console.error('[Smartchat]', err); });
  }
  setInterval(pollForNewMessages, POLL_INTERVAL_MS);

  if (autostart) {
    loadHistory();
  } else {
    // Tell the parent this preloaded iframe is ready to receive the start
    // signal — without this, a parent that posts "start" immediately after
    // creating the iframe would race this listener's own registration and
    // the message would simply be lost (postMessage never buffers).
    window.addEventListener('message', function (e) {
      if (e.source !== window.parent || !e.data) return;
      if (e.data.type === 'smartchat:start') loadHistory();
      // The parent's own close ("✕") button while the hero-docked chat is
      // fullscreen for the keyboard (see widget.js's expandHeroForKeyboard) —
      // blurring the REAL focused input is what actually dismisses the
      // on-screen keyboard; the parent can't do that itself since the input
      // lives in this frame, possibly cross-origin. This blur then fires
      // input's own 'blur' listener above, which tells the parent to collapse
      // back to the hero slot — same path as focus just leaving naturally.
      if (e.data.type === 'smartchat:blur-input') input.blur();
    });
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'smartchat:ready' }, '*');
    }
  }
})();
