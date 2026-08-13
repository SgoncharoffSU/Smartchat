(function () {
  const API_BASE = (document.currentScript && document.currentScript.dataset.apiBase) || '';

  const style = document.createElement('style');
  style.textContent = `
    .sc-bubble { position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 50%;
      background: #1a1a2e; color: #fff; display: flex; align-items: center; justify-content: center;
      cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); z-index: 9999; font-size: 24px; }
    .sc-window { position: fixed; bottom: 92px; right: 24px; width: 340px; max-width: calc(100vw - 32px);
      height: 480px; max-height: calc(100vh - 140px); background: #fff; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.2); display: none; flex-direction: column; overflow: hidden;
      z-index: 9999; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .sc-window.open { display: flex; }
    .sc-header { background: #1a1a2e; color: #fff; padding: 12px 16px; font-size: 14px; font-weight: 600; }
    .sc-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: #f7f7fb; }
    .sc-msg { max-width: 85%; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; }
    .sc-msg.bot { background: #fff; border: 1px solid #e5e5ef; align-self: flex-start; }
    .sc-msg.user { background: #1a1a2e; color: #fff; align-self: flex-end; }
    .sc-buttons { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
    .sc-btn { border: 1px solid #1a1a2e; color: #1a1a2e; background: #fff; border-radius: 16px; padding: 6px 10px;
      font-size: 12px; cursor: pointer; }
    .sc-btn:hover { background: #1a1a2e; color: #fff; }
    .sc-input-row { display: flex; border-top: 1px solid #e5e5ef; padding: 8px; gap: 6px; }
    .sc-input { flex: 1; border: 1px solid #e5e5ef; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .sc-send { background: #1a1a2e; color: #fff; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  `;
  document.head.appendChild(style);

  const bubble = document.createElement('div');
  bubble.className = 'sc-bubble';
  bubble.textContent = '💬';

  const win = document.createElement('div');
  win.className = 'sc-window';
  win.innerHTML = `
    <div class="sc-header">Умный чат для сайта</div>
    <div class="sc-messages"></div>
    <div class="sc-buttons"></div>
    <div class="sc-input-row">
      <input class="sc-input" type="text" placeholder="Напишите сообщение..." />
      <button class="sc-send">Отпр.</button>
    </div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(win);

  const messagesEl = win.querySelector('.sc-messages');
  const buttonsEl = win.querySelector('.sc-buttons');
  const inputEl = win.querySelector('.sc-input');
  const sendEl = win.querySelector('.sc-send');

  let sessionId = null;
  let started = false;

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `sc-msg ${role}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderButtons(buttons) {
    buttonsEl.innerHTML = '';
    (buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'sc-btn';
      btn.textContent = b.label;
      btn.addEventListener('click', () => sendTurn(b.label, b.value));
      buttonsEl.appendChild(btn);
    });
  }

  async function sendTurn(displayText, buttonValue) {
    if (displayText) addMessage('user', displayText);
    buttonsEl.innerHTML = '';
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: buttonValue ? '' : displayText, buttonValue }),
      });
      const data = await res.json();
      sessionId = data.sessionId || sessionId;
      addMessage('bot', data.reply);
      renderButtons(data.buttons);
      if (data.sessionEnded) {
        inputEl.disabled = true;
        sendEl.disabled = true;
      }
    } catch (e) {
      addMessage('bot', 'Не удалось связаться с сервером. Попробуйте позже.');
    }
  }

  async function startSession() {
    if (started) return;
    started = true;
    try {
      const res = await fetch(`${API_BASE}/api/session`, { method: 'POST' });
      const data = await res.json();
      sessionId = data.sessionId;
      addMessage('bot', data.reply);
      renderButtons(data.buttons);
    } catch (e) {
      addMessage('bot', 'Не удалось связаться с сервером. Попробуйте позже.');
    }
  }

  bubble.addEventListener('click', () => {
    win.classList.toggle('open');
    if (win.classList.contains('open')) startSession();
  });

  sendEl.addEventListener('click', () => {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    sendTurn(text);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendEl.click();
  });
})();
