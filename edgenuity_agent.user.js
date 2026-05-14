// ==UserScript==
// @name         Edgenuity AI Agent
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Autonomous AI agent that completes Edgenuity activities, questions, quizzes and unit tests
// @author       Agent-D
// @match        https://*.edgenuity.com/*
// @match        https://learn.edgenuity.com/*
// @match        https://app.edgenuity.com/*
// @match        https://www.edgenuity.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      api.groq.com
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────────────────

  const STORAGE_KEY_API  = 'edgenuity_agent_apikey';
  const POLL_INTERVAL_MS = 3000;
  const ACTION_DELAY_MS  = 1200;

  // ─── System prompt ────────────────────────────────────────────────────────
  // Based on real debug scan of Edgenuity's DOM structure

  const SYSTEM_PROMPT = `
You are an autonomous agent completing Edgenuity coursework inside a real browser.
The page is split across multiple documents. Here is exactly what each contains:

NAVIGATION CONTROLS (in the FrameChain document):
- span#btnCheck        = "Done" / Check answer — click to submit the current answer
- span#btnEntryAudio   = plays intro audio
- span#btnExitAudio    = plays final/exit audio
- li.FrameRight        = advances to the next frame/slide
- li.FrameRight.FrameHighlight = next frame is ready — click this to advance
- li.FrameLeft         = goes back one frame
- li.FrameCurrent      = the currently active frame
- li.FrameComplete     = a frame that is already done
- li.FrameCurrent.FrameComplete = current frame is complete — click li.FrameRight to move on

CONTENT (in the media.edgenuity.com document):
- input, textarea                  = text answer fields — type the answer here
- select                           = dropdown answer
- span.TextAnswerIncorrect         = your last answer was WRONG — try again with a different answer
- span.TextAnswerCorrect           = correct!
- div.sbgTile, .ui-draggable       = draggable tiles for sort/categorize activities
- div.sbgTile.dropped.checked      = tile has been placed correctly (do NOT move again)
- div.sbgTile.incorrect            = tile has NOT been correctly placed yet — must still drag it
- div.dropContainer, .ui-droppable = drop zone categories (e.g. #sbgCata, #sbgCatb)
- div.done-start                   = sort activity is ready — tiles can now be dragged
- div.done-complete                = ALL tiles verified correct — click li.FrameRight to advance
- [draggable="true"]               = drag this element to its matching drop zone

MULTIPLE-CHOICE QUESTIONS:
The page state includes answerChoices[] — an array of all visible answer options.
Each entry has: { index, text, type ("checkbox" or "radio"), checked (true/false) }
- type "radio"    = pick EXACTLY ONE correct answer, then click span#btnCheck
- type "checkbox" = pick ALL correct answers (there may be 2, 3, or more), then click span#btnCheck
- Use action "clickChoice" with the exact label text to select each answer
- Check answerChoices[].checked to avoid re-clicking already-selected options
- Do NOT advance to the next frame until span#btnCheck has been clicked and no TextAnswerIncorrect is shown

SORT / CATEGORIZE ACTIVITIES:
- Read bodyText for category names; drag each unplaced tile to its correct div.dropContainer.
- Tiles with .dropped.checked are done — skip them.
- When div.done-complete is visible, click li.FrameRight to advance (NOT span#btnCheck).

WORKFLOW:
1. If mediaPlaying is true → wait 5 seconds.
2. Fill-in-the-blank: type the correct answer into input/textarea, then click span#btnCheck.
3. Single-answer multiple choice (radio): use clickChoice for ONE answer, then click span#btnCheck.
4. Select-all-that-apply (checkbox): use clickChoice for EACH correct answer, then click span#btnCheck.
5. Sort/categorize: drag unplaced tiles to correct drop zones; click li.FrameRight when done-complete appears.
6. Other drag-and-drop: drag each item to its correct target, then click span#btnCheck.
7. If span.TextAnswerIncorrect is present → wrong answer — retry with a different selection.
8. After checking, if frames without FrameComplete remain → click li.FrameRight to advance.
9. Informational slides (no inputs, no draggables) → click li.FrameRight or span#btnCheck.
10. When ALL frames are FrameComplete → activity is finished.
11. Never touch elements inside #ea-panel.
12. Return ONLY a single JSON object — no markdown fences, no explanation.

Available actions:
  {"action":"click","selector":"<CSS>","reason":"<why>"}
  {"action":"clickChoice","text":"<exact label text>","reason":"<why>"}
  {"action":"type","selector":"<CSS>","text":"<text to type>","reason":"<why>"}
  {"action":"select","selector":"<CSS of select>","value":"<option text or value>","reason":"<why>"}
  {"action":"drag","fromSelector":"<CSS>","toSelector":"<CSS>","reason":"<why>"}
  {"action":"wait","seconds":<number>,"reason":"<why>"}
  {"action":"done","reason":"All activities and tests are complete"}
`.trim();

  // ─── Styles ───────────────────────────────────────────────────────────────

  GM_addStyle(`
    #ea-panel {
      position: fixed; bottom: 18px; right: 18px; z-index: 2147483647;
      width: 315px; background: #1a1a2e; color: #e0e0e0;
      border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
      font-family: 'Segoe UI', sans-serif; font-size: 13px;
      overflow: hidden; user-select: none;
    }
    #ea-header {
      background: #16213e; padding: 10px 14px;
      display: flex; align-items: center; justify-content: space-between; cursor: move;
    }
    #ea-title { font-weight: 700; font-size: 14px; color: #4fc3f7; }
    #ea-badge { background: #0f3460; border-radius: 20px; padding: 2px 10px; font-size: 11px; color: #81d4fa; }
    #ea-body { padding: 12px 14px; }
    #ea-key-row { display: flex; gap: 8px; margin-bottom: 10px; }
    #ea-key-input {
      flex: 1; background: #0f3460; border: 1px solid #1a4a7a; color: #e0e0e0;
      border-radius: 6px; padding: 6px 10px; font-size: 12px; outline: none;
    }
    #ea-save-btn {
      background: #1565c0; border: none; color: #fff;
      border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px;
    }
    #ea-save-btn:hover { background: #1976d2; }
    #ea-controls { display: flex; gap: 8px; margin-bottom: 8px; }
    .ea-btn {
      flex: 1; padding: 8px; border: none; border-radius: 8px;
      cursor: pointer; font-weight: 600; font-size: 13px; transition: opacity .15s;
    }
    .ea-btn:disabled { opacity: .4; cursor: not-allowed; }
    #ea-start-btn { background: #00c853; color: #fff; }
    #ea-stop-btn  { background: #e53935; color: #fff; }
    #ea-debug-btn { background: #7b1fa2; color: #fff; font-size: 11px; padding: 5px; margin-bottom: 8px; }
    #ea-log {
      background: #0a0a1a; border-radius: 8px; padding: 8px;
      height: 120px; overflow-y: auto; font-size: 11px; line-height: 1.5;
    }
    .ea-log-line { padding: 1px 0; border-bottom: 1px solid #111; }
    .ea-log-line.info  { color: #81d4fa; }
    .ea-log-line.ok    { color: #a5d6a7; }
    .ea-log-line.warn  { color: #ffe082; }
    .ea-log-line.error { color: #ef9a9a; }
    #ea-status-row { margin-top: 8px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: #78909c; }
    #ea-dot { width: 9px; height: 9px; border-radius: 50%; background: #546e7a; flex-shrink: 0; }
    #ea-dot.running { background: #00c853; animation: ea-pulse 1s infinite; }
    @keyframes ea-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  `);

  // ─── UI ───────────────────────────────────────────────────────────────────

  const panel = document.createElement('div');
  panel.id = 'ea-panel';
  panel.innerHTML = `
    <div id="ea-header">
      <span id="ea-title">🤖 Edgenuity Agent</span>
      <span id="ea-badge">Groq AI</span>
    </div>
    <div id="ea-body">
      <div id="ea-key-row">
        <input id="ea-key-input" type="password" placeholder="Paste Groq API key…">
        <button id="ea-save-btn">Save</button>
      </div>
      <div id="ea-controls">
        <button class="ea-btn" id="ea-start-btn">▶ Start</button>
        <button class="ea-btn" id="ea-stop-btn" disabled>■ Stop</button>
      </div>
      <button class="ea-btn" id="ea-debug-btn">🔍 Debug: scan page</button>
      <div id="ea-log"></div>
      <div id="ea-status-row">
        <div id="ea-dot"></div>
        <span id="ea-status-text">Idle</span>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // Draggable panel
  const header = document.getElementById('ea-header');
  let dragging = false, dragX = 0, dragY = 0;
  header.addEventListener('mousedown', e => {
    dragging = true;
    dragX = e.clientX - panel.getBoundingClientRect().left;
    dragY = e.clientY - panel.getBoundingClientRect().top;
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    panel.style.left = (e.clientX - dragX) + 'px';
    panel.style.top  = (e.clientY - dragY) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  const keyInput = document.getElementById('ea-key-input');
  keyInput.value = GM_getValue(STORAGE_KEY_API, '');
  document.getElementById('ea-save-btn').addEventListener('click', () => {
    GM_setValue(STORAGE_KEY_API, keyInput.value.trim());
    log('API key saved.', 'ok');
  });

  // ─── Logging ──────────────────────────────────────────────────────────────

  const logEl = document.getElementById('ea-log');
  function log(msg, type = 'info') {
    const line = document.createElement('div');
    line.className = `ea-log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(text, running = false) {
    document.getElementById('ea-status-text').textContent = text;
    document.getElementById('ea-dot').className = running ? 'running' : '';
  }

  // ─── Debug scan ───────────────────────────────────────────────────────────

  function runDebug() {
    const lines = [];
    const cap = (msg, type = 'info') => { lines.push(msg); log(msg, type); };

    cap('── DEBUG SCAN ──', 'warn');
    const iframes = [...document.querySelectorAll('iframe')];
    cap(`Found ${iframes.length} iframe(s) in top document`);
    iframes.forEach((f, i) => {
      let ok = false;
      try { ok = !!(f.contentDocument && f.contentDocument.body); } catch(e){}
      cap(`  iframe[${i}]: ${(f.src||'(no src)').slice(0,80)} — ${ok ? '✓ accessible' : '✗ CROSS-ORIGIN'}`, ok ? 'ok' : 'error');
    });

    const docs = getAllDocs();
    cap(`Total accessible documents: ${docs.length}`);
    docs.forEach((doc, i) => {
      const url  = doc.defaultView?.location?.href || '(unknown)';
      const btns = doc.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],a').length;
      const inps = doc.querySelectorAll('input,textarea,select').length;
      const txt  = (doc.body?.innerText||'').replace(/\s+/g,' ').slice(0,80);
      cap(`doc[${i}]: ${url}`);
      cap(`  std buttons:${btns}  inputs:${inps}`);
      cap(`  text: "${txt}"`);

      const custom = [...doc.querySelectorAll('*')].filter(el => {
        const t = el.tagName.toLowerCase();
        if (['script','style','head','meta','link','br','hr','img'].includes(t)) return false;
        return el.getAttribute('onclick') || el.getAttribute('role') ||
               el.getAttribute('tabindex') || el.getAttribute('draggable') === 'true' ||
               (el.className && /drag|drop|answer|choice|option|word|match|token|btn|button|next|submit|continue|frame/i.test(el.className));
      }).map(el => {
        const id   = el.id ? `#${el.id}` : '';
        const cls  = (el.className||'').replace(/\s+/g,' ').slice(0,60);
        const role = el.getAttribute('role')||'';
        const drag = el.getAttribute('draggable')==='true' ? ' draggable' : '';
        const txt  = (el.innerText||'').trim().slice(0,40);
        return `  ${el.tagName.toLowerCase()}${id} class="${cls}" role="${role}"${drag} text="${txt}"`;
      }).slice(0,30);

      if (custom.length) { cap(`  custom elements (${custom.length}):`, 'warn'); custom.forEach(c => cap(c, 'warn')); }
      else cap(`  NO custom interactive elements found`, 'error');
    });
    cap('── END DEBUG ──', 'warn');

    const win = window.open('', '_blank');
    if (win) {
      win.document.write('<pre style="font:13px monospace;padding:16px;white-space:pre-wrap">' +
        lines.map(l => l.replace(/</g,'&lt;')).join('\n') + '</pre>');
      win.document.close();
    } else {
      navigator.clipboard?.writeText(lines.join('\n'))
        .then(() => log('Copied to clipboard!', 'ok'))
        .catch(() => log('Allow pop-ups for this site to see full output', 'error'));
    }
  }

  // ─── iframe helpers (recursive) ───────────────────────────────────────────

  function getAllDocs(root = document, visited = new Set()) {
    if (visited.has(root)) return [];
    visited.add(root);
    const docs = [root];
    try {
      for (const iframe of root.querySelectorAll('iframe')) {
        try {
          const child = iframe.contentDocument;
          if (child && child.body) docs.push(...getAllDocs(child, visited));
        } catch(e) {}
      }
    } catch(e) {}
    return docs;
  }

  function findElement(selector) {
    for (const doc of getAllDocs()) {
      try { const el = doc.querySelector(selector); if (el) return el; } catch(e) {}
    }
    return null;
  }

  function queryAll(selector) {
    const results = [];
    for (const doc of getAllDocs()) {
      try { results.push(...doc.querySelectorAll(selector)); } catch(e) {}
    }
    return results;
  }

  // ─── Media detection ──────────────────────────────────────────────────────

  function isMediaPlaying() {
    for (const el of queryAll('video, audio')) {
      if (!el.paused && !el.ended && el.currentTime > 0) return true;
    }
    return false;
  }

  // ─── Answer choice reader ─────────────────────────────────────────────────
  // Reads all div.answer-choice elements — works even when inputs are CSS-hidden

  function getAnswerChoices() {
    const choices = [];
    const divs = queryAll('div.answer-choice');
    divs.forEach((div, i) => {
      const input = div.querySelector('input.answer-choice-button, input[type="radio"], input[type="checkbox"]');
      const label = div.querySelector('label.answer-choice-label, label');
      choices.push({
        index:   i + 1,
        text:    (label?.innerText || '').trim(),
        type:    input?.type || 'unknown',
        checked: input?.checked || false,
      });
    });
    return choices;
  }

  // ─── Page state snapshot ──────────────────────────────────────────────────

  function getPageState() {
    function describeEl(el) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return {
          tag:  el.tagName.toLowerCase(),
          id:   el.id || undefined,
          cls:  (el.className || '').slice(0, 80),
          text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 120),
          type: el.type || undefined,
        };
      } catch(e) { return null; }
    }

    const panelEl = document.getElementById('ea-panel');
    const outside = el => !panelEl || !panelEl.contains(el);

    // Known Edgenuity-specific selectors from debug scan
    const navButtons = queryAll(
      'span#btnCheck, span#btnEntryAudio, span#btnExitAudio, span#btnHint, span#btnShowMe,' +
      'li.FrameRight, li.FrameLeft, li.FrameCurrent, li.FrameComplete, li[id^="frame"],' +
      'div.done-start, div.done-complete'
    ).filter(outside).map(describeEl).filter(Boolean);

    // Broad fallback selectors
    const otherButtons = queryAll([
      'button', '[role="button"]', '[role="radio"]', '[role="checkbox"]',
      '[role="option"]', '[role="tab"]', '[role="menuitem"]',
      'input[type="submit"]', 'input[type="button"]', 'a[onclick]', '[onclick]',
      '[tabindex="0"]', '[class*="btn"]', '[class*="answer"]', '[class*="choice"]',
      '[class*="next"]', '[class*="submit"]', '[class*="continue"]',
    ].join(',')).filter(outside).map(describeEl).filter(Boolean).slice(0, 20);

    const inputs = queryAll(
      'input[type="text"], input[type="radio"], input[type="checkbox"], textarea, select'
    ).filter(outside).map(describeEl).filter(Boolean).slice(0, 20);

    const draggables = queryAll(
      '[draggable="true"], [class*="drag"], [class*="token"], [class*="word"], [class*="card"],' +
      'div.sbgTile, .ui-draggable'
    ).filter(outside).map(describeEl).filter(Boolean).slice(0, 20);

    const dropzones = queryAll(
      '[class*="drop"], [class*="blank"], [class*="slot"], [class*="target"], [ondrop],' +
      '.ui-droppable, .dropContainer'
    ).filter(outside).map(describeEl).filter(Boolean).slice(0, 20);

    // Check for wrong/correct answer state
    const hasWrongAnswer  = !!findElement('span.TextAnswerIncorrect');
    const hasRightAnswer  = !!findElement('span.TextAnswerCorrect');
    const completedFrames = queryAll('li.FrameComplete').length;
    const totalFrames     = queryAll('li[id^="frame"]').length;

    const answerChoices = getAnswerChoices();

    const bodyText = getAllDocs()
      .map(doc => (doc.body?.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).join('\n---\n').slice(0, 4000);

    return {
      url: window.location.href,
      title: document.title,
      mediaPlaying: isMediaPlaying(),
      hasWrongAnswer,
      hasRightAnswer,
      completedFrames,
      totalFrames,
      answerChoices,
      navButtons,
      otherButtons,
      inputs,
      draggables,
      dropzones,
      bodyText,
    };
  }

  // ─── Groq API call ────────────────────────────────────────────────────────

  function callLLM(messages) {
    return new Promise((resolve, reject) => {
      const apiKey = GM_getValue(STORAGE_KEY_API, '');
      if (!apiKey) { reject(new Error('No API key set')); return; }

      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        data: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 512,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        }),
        onload(res) {
          try {
            const body = JSON.parse(res.responseText);
            if (body.error) { reject(new Error(body.error.message)); return; }
            const text  = body.choices?.[0]?.message?.content || '{}';
            const clean = text.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
            resolve(JSON.parse(clean));
          } catch(e) {
            reject(new Error('Bad Groq response: ' + res.responseText.slice(0, 200)));
          }
        },
        onerror(e) { reject(new Error('Network error: ' + JSON.stringify(e))); },
      });
    });
  }

  // ─── Action executor ──────────────────────────────────────────────────────

  function simulateClick(el) {
    el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true}));
    el.dispatchEvent(new MouseEvent('mousedown',  {bubbles:true}));
    el.dispatchEvent(new MouseEvent('mouseup',    {bubbles:true}));
    el.click();
  }

  function simulateType(el, text) {
    el.focus();
    el.value = '';
    for (const char of text) {
      el.value += char;
      el.dispatchEvent(new Event('input',  {bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keydown', {key:char, bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keyup',   {key:char, bubbles:true}));
    }
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }

  function simulateSelect(el, value) {
    const opt = [...el.options].find(o =>
      o.value === value || o.text.trim().toLowerCase() === value.toLowerCase()
    );
    el.value = opt ? opt.value : value;
    el.dispatchEvent(new Event('change', {bubbles:true}));
    el.dispatchEvent(new Event('input',  {bubbles:true}));
  }

  function simulateDrag(fromEl, toEl) {
    const fR = fromEl.getBoundingClientRect(), tR = toEl.getBoundingClientRect();
    const fx = fR.left + fR.width/2, fy = fR.top + fR.height/2;
    const tx = tR.left + tR.width/2, ty = tR.top + tR.height/2;

    // jQuery UI drag: mousedown on element, mousemove+mouseup on the element's own document
    // (NOT the top document — the iframe has its own jQuery UI event listeners)
    const ownerDoc = fromEl.ownerDocument;
    fromEl.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, clientX:fx, clientY:fy}));
    for (let i = 1; i <= 15; i++) {
      ownerDoc.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, cancelable:true,
        clientX: fx + (tx-fx)*i/15, clientY: fy + (ty-fy)*i/15}));
    }
    ownerDoc.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, clientX:tx, clientY:ty}));

    // HTML5 drag events as a fallback for non-jQuery drag libraries
    try {
      const dt = new DataTransfer();
      fromEl.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:dt, clientX:fx, clientY:fy}));
      toEl.dispatchEvent(  new DragEvent('dragenter', {bubbles:true, dataTransfer:dt, clientX:tx, clientY:ty}));
      toEl.dispatchEvent(  new DragEvent('dragover',  {bubbles:true, dataTransfer:dt, clientX:tx, clientY:ty}));
      toEl.dispatchEvent(  new DragEvent('drop',      {bubbles:true, dataTransfer:dt, clientX:tx, clientY:ty}));
      fromEl.dispatchEvent(new DragEvent('dragend',   {bubbles:true, dataTransfer:dt, clientX:tx, clientY:ty}));
    } catch(e) {}
  }

  // Selectors that count as "submitting an answer" — trigger post-submit verification
  const SUBMIT_SELECTORS = ['#btnCheck', 'span#btnCheck'];

  async function verifySubmit() {
    // Wait for page to react to the submission
    await sleep(2000);
    const wrong   = !!findElement('span.TextAnswerIncorrect');
    const correct = !!findElement('span.TextAnswerCorrect');
    if (wrong) {
      log('❌ Wrong answer detected — injecting correction notice', 'error');
      // Force the LLM to reconsider by pushing a system-level correction into history
      history.push({
        role: 'user',
        content: '⚠️ VERIFICATION FAILED: span.TextAnswerIncorrect is on screen. ' +
                 'Your last answer was WRONG. You must clear the field, type a DIFFERENT answer, ' +
                 'and click span#btnCheck again. Do NOT advance to the next frame yet.',
      });
    } else if (correct) {
      log('✅ Answer verified correct', 'ok');
    } else {
      log('Answer submitted — no feedback element found yet', 'info');
    }
  }

  async function executeAction(action) {
    switch (action.action) {
      case 'click': {
        const el = findElement(action.selector);
        if (!el) { log(`Click failed — not found: ${action.selector}`, 'warn'); return; }
        log(`Click: ${action.selector} — ${action.reason}`, 'ok');
        simulateClick(el);
        await sleep(ACTION_DELAY_MS);
        // Run post-submit verification whenever the agent clicks the Done/Check button
        if (SUBMIT_SELECTORS.some(s => {
          try { return el === findElement(s); } catch(e) { return false; }
        })) {
          await verifySubmit();
        }
        break;
      }
      case 'clickChoice': {
        // Click an answer choice by its visible label text (for checkbox/radio questions)
        const target = (action.text || '').trim().toLowerCase();
        let clicked = false;
        for (const div of queryAll('div.answer-choice')) {
          const label = div.querySelector('label.answer-choice-label, label');
          if (label && label.innerText.trim().toLowerCase() === target) {
            log(`Select choice: "${action.text}" — ${action.reason}`, 'ok');
            simulateClick(label);
            clicked = true;
            break;
          }
        }
        if (!clicked) log(`clickChoice failed — no label matching: "${action.text}"`, 'warn');
        await sleep(ACTION_DELAY_MS);
        break;
      }
      case 'type': {
        const el = findElement(action.selector);
        if (!el) { log(`Type failed — not found: ${action.selector}`, 'warn'); return; }
        log(`Type "${(action.text||'').slice(0,50)}" → ${action.selector}`, 'ok');
        simulateType(el, action.text || ''); await sleep(ACTION_DELAY_MS); break;
      }
      case 'select': {
        const el = findElement(action.selector);
        if (!el) { log(`Select failed — not found: ${action.selector}`, 'warn'); return; }
        log(`Select "${action.value}" in ${action.selector}`, 'ok');
        simulateSelect(el, action.value || ''); await sleep(ACTION_DELAY_MS); break;
      }
      case 'drag': {
        const fromEl = findElement(action.fromSelector);
        const toEl   = findElement(action.toSelector);
        if (!fromEl) { log(`Drag failed — source not found: ${action.fromSelector}`, 'warn'); return; }
        if (!toEl)   { log(`Drag failed — target not found: ${action.toSelector}`,   'warn'); return; }
        log(`Drag ${action.fromSelector} → ${action.toSelector}`, 'ok');
        simulateDrag(fromEl, toEl); await sleep(ACTION_DELAY_MS * 2); break;
      }
      case 'wait': {
        const secs = Math.min(action.seconds || 3, 15);
        log(`Wait ${secs}s — ${action.reason}`, 'info');
        await sleep(secs * 1000); break;
      }
      case 'done': {
        log('✅ ' + action.reason, 'ok');
        stopAgent(); break;
      }
      default:
        log(`Unknown action: ${action.action}`, 'warn');
    }
  }

  // ─── Agent loop ───────────────────────────────────────────────────────────

  let running = false, loopHandle = null;
  const history = [];

  async function agentTick() {
    if (!running) return;

    if (isMediaPlaying()) {
      log('Media playing — waiting…', 'info');
      setStatus('Waiting for media…', true);
      loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
      return;
    }

    setStatus('Thinking…', true);
    const state = getPageState();
    const userMsg = `Current page state:\n${JSON.stringify(state, null, 2)}\n\nWhat is the next action? Reply with only JSON.`;

    history.push({ role: 'user', content: userMsg });
    if (history.length > 20) history.splice(0, 2);

    let action;
    try {
      action = await callLLM(history);
      history.push({ role: 'assistant', content: JSON.stringify(action) });
    } catch(err) {
      log('Groq error: ' + err.message, 'error');
      setStatus('Error — retrying…', true);
      loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS * 2);
      return;
    }

    setStatus('Acting…', true);
    await executeAction(action);
    if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
  }

  function startAgent() {
    if (!GM_getValue(STORAGE_KEY_API, '')) {
      log('Please paste your Groq API key and click Save first.', 'error'); return;
    }
    running = true; history.length = 0;
    document.getElementById('ea-start-btn').disabled = true;
    document.getElementById('ea-stop-btn').disabled  = false;
    log('Agent started.', 'ok'); setStatus('Running', true);
    agentTick();
  }

  function stopAgent() {
    running = false; clearTimeout(loopHandle);
    document.getElementById('ea-start-btn').disabled = false;
    document.getElementById('ea-stop-btn').disabled  = true;
    setStatus('Stopped', false); log('Agent stopped.', 'warn');
  }

  document.getElementById('ea-start-btn').addEventListener('click', startAgent);
  document.getElementById('ea-stop-btn').addEventListener('click',  stopAgent);
  document.getElementById('ea-debug-btn').addEventListener('click', runDebug);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

})();
