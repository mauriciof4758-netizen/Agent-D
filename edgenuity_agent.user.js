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
// @connect      media.edgenuity.com
// @connect      cdn.edgenuity.com
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────────────────

  const STORAGE_KEY_API     = 'edgenuity_agent_apikey';
  const STORAGE_KEY_AUTORUN = 'edgenuity_agent_autorun';
  const POLL_INTERVAL_MS    = 1500;
  const ACTION_DELAY_MS     = 800;
  const TEXT_MODEL          = 'llama-3.3-70b-versatile';
  const VISION_MODEL        = 'meta-llama/llama-4-maverick-17b-128e-instruct';
  const STUCK_TICKS_LIMIT   = 20; // ~30 s at 1.5 s/tick before recovery fires

  // ─── System prompt ────────────────────────────────────────────────────────
  // Based on real debug scan of Edgenuity's DOM structure

  const SYSTEM_PROMPT = `
You are an autonomous agent completing Edgenuity coursework inside a real browser.
YOUR MISSION: keep working until every lesson in the entire course is finished.
NEVER stop on your own. NEVER output {"action":"done"}.

════════════════════════════════════════════════════════════
MANDATORY: THINK BEFORE EVERY ANSWER
════════════════════════════════════════════════════════════
Every JSON response MUST contain a "thinking" field where you reason through
the question BEFORE choosing the action. This is not optional.

For multiple-choice questions, your thinking must follow this pattern:
  1. Restate exactly what the question is asking.
  2. Evaluate EACH answer choice — explain why it is correct or incorrect.
  3. Eliminate wrong choices one by one.
  4. Confirm the remaining correct answer.

For fill-in-the-blank / short answer:
  1. Identify the subject and exact topic from bodyText.
  2. Recall the specific term, fact, formula, or phrase that fits.
  3. Make sure it is precise — not a vague synonym.

For visuals (graphs, charts, diagrams):
  1. Describe what you see: axis labels, values, trends, labeled parts.
  2. Apply that observation to answer the question.

Example of a CORRECT response:
{
  "thinking": "The question asks which planet is closest to the Sun. Choice A is Mercury — Mercury IS the closest planet to the Sun, correct. Choice B is Venus — Venus is second closest, not first. Choice C is Earth — Earth is third, wrong. Choice D is Mars — fourth, wrong. Answer: Mercury.",
  "action": "clickChoice",
  "text": "Mercury",
  "reason": "Mercury is the closest planet to the Sun"
}

WRONG — never do this (no thinking, just guesses):
{"action":"clickChoice","text":"Venus","reason":"seems right"}

════════════════════════════════════════════════════════════
WRONG ANSWER — STRICT RETRY RULES
════════════════════════════════════════════════════════════
When hasWrongAnswer:true is in the page state OR the message says ⚠️ WRONG:
  ① You MUST change the answer before clicking span#btnCheck again.
  ② Do NOT click span#btnCheck without first typing a new answer or selecting a different choice.
  ③ Submitting the same wrong answer again scores 0. Each attempt costs points.
  ④ In your thinking field: explain WHY the previous answer was wrong, then give the CORRECT answer.

For wrong text/fill-in-the-blank:
  - The correct action is type — clear the field and type a completely different, factually correct answer.
  - Use your subject knowledge. If you guessed before, look up the concept in your training data.

For wrong multiple-choice:
  - Uncheck the wrong selection with another clickChoice on it (toggles off), then click the correct one.
  - Or simply clickChoice the correct answer directly — Edgenuity will deselect the old one.

════════════════════════════════════════════════════════════
MATCHING ACTIVITIES — PLAN ALL PAIRS BEFORE DRAGGING
════════════════════════════════════════════════════════════
When you see items to match/connect (terms + definitions, words + examples, etc.):

CRITICAL RULE: Use your "thinking" field to PLAN EVERY PAIR before touching anything.
  1. List ALL source items from bodyText/draggables[].
  2. List ALL target slots from bodyText/dropzones[].
  3. For each source, use your subject knowledge to identify its correct target.
  4. Write the complete mapping in thinking: "Item A → Target X, Item B → Target Y, ..."
  5. Only THEN drag one at a time following your plan.

NEVER drag randomly hoping something fits — that scores 0 and wastes attempts.
NEVER click span#btnCheck until every item is placed.
If a placement was wrong (shown as incorrect), drag it away and place it in the correct zone.

Example thinking for matching:
  "draggables are: 'nucleus', 'mitochondria', 'ribosome'. dropzones are: 'controls cell', 'makes energy', 'makes protein'.
   nucleus→controls cell (nucleus contains DNA, controls the cell).
   mitochondria→makes energy (mitochondria = powerhouse).
   ribosome→makes protein (ribosomes synthesize proteins).
   Plan: drag nucleus to 'controls cell', drag mitochondria to 'makes energy', drag ribosome to 'makes protein'."

════════════════════════════════════════════════════════════
SUBJECT KNOWLEDGE
════════════════════════════════════════════════════════════
Use your training knowledge to give the academically correct answer:
- Algebra/Geometry: solve the equation or identify the property exactly
- Biology: cell organelles, genetics (dominant/recessive), ecosystems, body systems
- Chemistry: periodic table trends, balancing equations, types of bonds/reactions
- Physics: F=ma, kinematic equations, Ohm's law, wave properties
- Earth Science: rock cycle, plate tectonics, water cycle, atmospheric layers
- US History: specific dates, causes/effects of wars, amendments, key figures
- World History: ancient civilizations, Industrial Revolution, WWI/WWII, Cold War
- Economics: supply/demand curves, GDP, inflation, types of market structures
- Government: three branches, checks and balances, Bill of Rights, voting process
- English/ELA: identify literary devices (metaphor, simile, alliteration, etc.), grammar rules
- Personal Finance: budgeting, interest types (simple vs compound), credit, investing
- Spanish/French: correct conjugation, vocabulary, gender/number agreement

For fill-in-the-blank: type ONLY the exact word or phrase that fits (e.g. "mitosis", "supply", "1776").
For short answer: 2–3 sentences, specific facts, no filler.
For essay: topic sentence + evidence + explanation, at least 4 sentences.

════════════════════════════════════════════════════════════
PAGE STRUCTURE
════════════════════════════════════════════════════════════
COURSE: Warm-Up → Instruction → Summary → Quiz → Unit Test (repeat per lesson)

QUIZ/TEST (isAssessment:true): use clickChoice per question; auto-advances after each answer.
NAVIGATION: span#btnCheck=Done, li.FrameRight=next slide, li.FrameCurrent.FrameComplete=done
ANSWER STATE: span.TextAnswerIncorrect=WRONG, span.TextAnswerCorrect=correct
SORT/DRAG: div.sbgTile=draggable, .dropContainer=target, div.done-complete=all placed correctly

════════════════════════════════════════════════════════════
ANSWER TYPE RULES
════════════════════════════════════════════════════════════
- textInputs[] non-empty → MUST use {"action":"type",...} — NEVER clickChoice
- answerChoices[] non-empty, textInputs[] empty → use clickChoice
- radio type → choose EXACTLY ONE correct answer
- checkbox type → choose ALL that apply (may be 2, 3, or more)
- sort/drag → drag each tile to its correct zone; li.FrameRight when done-complete visible

════════════════════════════════════════════════════════════
WORKFLOW
════════════════════════════════════════════════════════════
1. mediaPlaying:true → {"action":"wait","seconds":5}
2. textInputs[] has empty field → think → type correct answer → click span#btnCheck
3. radio choices → think → clickChoice the ONE correct answer → click span#btnCheck
4. checkbox choices → think → clickChoice EACH correct answer → click span#btnCheck
5. sort/drag → think → drag each tile → li.FrameRight after done-complete
6. TextAnswerIncorrect visible → think harder → retype ONLY that wrong field
7. Frame done (FrameCurrent.FrameComplete) → click li.FrameRight
8. Informational slide (no inputs) → click span#btnCheck then li.FrameRight
9. All frames complete → click activityNav Next/Continue button
10. No frames, no assessment → click any Next/Continue/Start button visible

Never touch #ea-panel elements.
Return ONLY a single JSON object — no markdown fences, no text outside the JSON.

Available actions:
  {"thinking":"<reasoning>","action":"click","selector":"<CSS>","reason":"<why>"}
  {"thinking":"<reasoning>","action":"clickChoice","text":"<exact label>","reason":"<why>"}
  {"thinking":"<reasoning>","action":"type","selector":"<CSS>","text":"<answer>","reason":"<why>"}
  {"thinking":"<reasoning>","action":"select","selector":"<CSS>","value":"<option>","reason":"<why>"}
  {"thinking":"<reasoning>","action":"drag","fromSelector":"<CSS>","toSelector":"<CSS>","reason":"<why>"}
  {"thinking":"<reasoning>","action":"wait","seconds":<n>,"reason":"<why>"}
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
        const val  = el.tagName === 'INPUT' && el.value ? ` value="${el.value.slice(0,30)}"` : '';
        return `  ${el.tagName.toLowerCase()}${id} class="${cls}" role="${role}"${drag}${val} text="${txt}"`;
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

  // ─── Content document filter ─────────────────────────────────────────────
  // The outer player shell (top document) contains eNotes textarea, Cancel/Delete/Save
  // buttons, glossary tabs, etc. — none of which are lesson content. Any query that
  // looks for interactive lesson elements MUST exclude the top document so those
  // outer-player inputs never show up as question fields.

  function getContentDocs() {
    return getAllDocs().filter(d => d !== document);
  }

  // Like queryAll but restricted to iframe content documents only
  function queryContent(selector) {
    const results = [];
    for (const doc of getContentDocs()) {
      try { results.push(...doc.querySelectorAll(selector)); } catch(e) {}
    }
    return results;
  }

  // Like findElement but restricted to iframe content documents only
  function findContent(selector) {
    for (const doc of getContentDocs()) {
      try { const el = doc.querySelector(selector); if (el) return el; } catch(e) {}
    }
    return null;
  }

  // ─── Answer choice reader ─────────────────────────────────────────────────
  // Only scans content iframes — outer player tabs never have answer choices

  function getAnswerChoices() {
    const choices = [];
    queryContent('div.answer-choice').forEach((div, i) => {
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
          tag:   el.tagName.toLowerCase(),
          id:    el.id || undefined,
          cls:   (el.className || '').slice(0, 80),
          text:  (el.innerText || '').trim().slice(0, 120) || undefined,
          value: el.value || undefined,
          type:  el.type || undefined,
        };
      } catch(e) { return null; }
    }

    const panelEl = document.getElementById('ea-panel');
    const outside = el => !panelEl || !panelEl.contains(el);

    // Known Edgenuity-specific selectors — covers both FrameChain and AssessmentViewer
    const navButtons = queryAll(
      // FrameChain activity controls:
      'span#btnCheck, span#btnEntryAudio, span#btnExitAudio, span#btnHint, span#btnShowMe,' +
      'li.FrameRight, li.FrameLeft, li.FrameCurrent, li.FrameComplete, li[id^="frame"],' +
      'div.done-start, div.done-complete, div.done-retry,' +
      // AssessmentViewer controls:
      'a#nextQuestion, a#saveAndExit, ol#navBtnList a'
    ).filter(outside).map(describeEl).filter(Boolean);

    // Broad fallback selectors
    const otherButtons = queryAll([
      'button', '[role="button"]', '[role="radio"]', '[role="checkbox"]',
      '[role="option"]', '[role="tab"]', '[role="menuitem"]',
      'input[type="submit"]', 'input[type="button"]', 'a[onclick]', '[onclick]',
      '[tabindex="0"]', '[class*="btn"]', '[class*="answer"]', '[class*="choice"]',
      '[class*="next"]', '[class*="submit"]', '[class*="continue"]',
    ].join(',')).filter(outside).map(describeEl).filter(Boolean).slice(0, 20);

    // inputs / draggables / dropzones: CONTENT DOCS ONLY
    // The outer player has its own inputs (eNotes textarea, Cancel/Delete/Save)
    // which are NOT question fields. Using queryContent() excludes them.
    const inputs = queryContent(
      'input[type="text"], input[type="radio"], input[type="checkbox"], textarea, select, [contenteditable="true"]'
    ).map(describeEl).filter(Boolean).slice(0, 20);

    const draggables = queryContent(
      '[draggable="true"], [class*="drag"], [class*="token"], [class*="word"], [class*="card"],' +
      'div.sbgTile, .ui-draggable'
    ).map(describeEl).filter(Boolean).slice(0, 20);

    const dropzones = queryContent(
      '[class*="drop"], [class*="blank"], [class*="slot"], [class*="target"], [ondrop],' +
      '.ui-droppable, .dropContainer'
    ).map(describeEl).filter(Boolean).slice(0, 20);

    // Check for wrong/correct answer state — content docs only
    const hasWrongAnswer  = !!findContent('span.TextAnswerIncorrect');
    const hasRightAnswer  = !!findContent('span.TextAnswerCorrect');
    const completedFrames = queryAll('li.FrameComplete').length;
    const totalFrames     = queryAll('li[id^="frame"]').length;

    // AssessmentViewer (quiz/test) state
    const isAssessment    = !!findElement('ol#navBtnList');
    const qNavBtns        = queryAll('ol#navBtnList a.plainbtn:not([class*="gray"])');
    const totalQuestions  = qNavBtns.length;
    const selQBtn         = [...qNavBtns].find(el => /\bselected\b/.test(el.className));
    const currentQuestion = selQBtn ? (parseInt(selQBtn.innerText) || 1) : (isAssessment ? 1 : 0);

    const answerChoices = getAnswerChoices();

    // Inter-activity navigation — only shown to the LLM after ALL frames are complete.
    // Hiding it until then prevents the agent from jumping to the next activity too early.
    const outerDoc = document;
    const allFramesDone = totalFrames > 0 && completedFrames >= totalFrames;
    const activityNav = allFramesDone ? (() => {
      // Edgenuity uses input.uibtn (no explicit type attr) for Next/Previous buttons.
      // We also catch standard button/link patterns as fallback.
      const navEls = [...outerDoc.querySelectorAll(
        'input[class*="uibtn"], input[type="button"], input[type="submit"], ' +
        'input[type="image"], button, a[class*="nav"], a[href*="Activity"], ' +
        '[class*="next"], [class*="continue"]'
      )].filter(outside);
      const results = navEls.map(el => {
        try {
          const label = (el.value || el.innerText || el.getAttribute('title') || '').trim();
          if (!label) return null;
          return {
            tag:      el.tagName.toLowerCase(),
            id:       el.id || undefined,
            cls:      (el.className || '').slice(0, 60),
            label,
            selector: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}[class*="${(el.className||'').trim().split(/\s+/)[0]}"]`,
          };
        } catch(e) { return null; }
      }).filter(Boolean).slice(0, 10);
      if (results.length) log(`Activity complete — ${results.length} nav button(s) found`, 'ok');
      else log('Activity complete — no next-activity buttons found in outer player', 'warn');
      return results;
    })() : [];

    // textInputs: explicitly lists every writable text field with a ready-to-use CSS selector.
    // Content docs ONLY — the outer player has eNotes textarea and Cancel/Delete/Save inputs
    // that must never be mistaken for question answer fields.
    const textInputs = [];
    for (const doc of getContentDocs()) {
      for (const el of doc.querySelectorAll(
        'textarea, input[type="text"], input:not([type]), [contenteditable="true"]'
      )) {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          let sel = el.id ? `#${el.id}`
            : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]`
            : el.className ? `${el.tagName.toLowerCase()}.${(el.className||'').trim().split(/\s+/)[0]}`
            : el.tagName.toLowerCase();
          textInputs.push({
            selector:     sel,
            tag:          el.tagName.toLowerCase(),
            placeholder:  el.placeholder || undefined,
            currentValue: (el.value || el.textContent || '').trim().slice(0, 60) || '(empty)',
          });
        } catch(e) {}
      }
    }

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
      isAssessment,
      currentQuestion,
      totalQuestions,
      answerChoices,
      activityNav,
      navButtons,
      otherButtons,
      inputs,
      textInputs,
      draggables,
      dropzones,
      bodyText,
    };
  }

  // ─── Groq API call ────────────────────────────────────────────────────────

  // Tracks whether the vision model is available on this account.
  // Set to false on first access-denied error so we stop trying and avoid spamming errors.
  let visionAvailable = true;

  // images: array of {b64, mime} from collectPageImages(); omit or pass [] for text-only.
  // If the vision model is unavailable or the call fails with an access error,
  // automatically retries with the text-only model so the agent keeps running.
  function callLLM(messages, images = []) {
    return new Promise((resolve, reject) => {
      const apiKey = GM_getValue(STORAGE_KEY_API, '');
      if (!apiKey) { reject(new Error('No API key set')); return; }

      const useVision = images.length > 0 && visionAvailable;
      const model     = useVision ? VISION_MODEL : TEXT_MODEL;

      // When images are present, convert the last user message to a multipart content array
      let outMessages = messages;
      if (useVision && messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.role === 'user' && typeof last.content === 'string') {
          const content = [{ type: 'text', text: last.content }];
          for (const img of images) {
            content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } });
          }
          outMessages = [...messages.slice(0, -1), { role: 'user', content }];
        }
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        data: JSON.stringify({
          model,
          max_tokens: 1500,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...outMessages],
        }),
        onload(res) {
          try {
            const body = JSON.parse(res.responseText);
            if (body.error) {
              const msg = body.error.message || '';
              if (useVision && /model|not found|access|permission|tier|vision/i.test(msg)) {
                visionAvailable = false;
                log('⚠️ Vision model unavailable — switching to text-only', 'warn');
                callLLM(messages, []).then(resolve).catch(reject);
                return;
              }
              reject(new Error(msg));
              return;
            }
            const raw = body.choices?.[0]?.message?.content || '{}';
            // Strip markdown fences if present
            let clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
            // If the model wrapped JSON in prose, extract the first {...} block
            if (!clean.startsWith('{')) {
              const m = clean.match(/\{[\s\S]*\}/);
              clean = m ? m[0] : '{}';
            }
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
    // Always use the element's OWN frame's window — using the top window's
    // Event/KeyboardEvent constructors on an iframe element fails instanceof
    // checks inside the iframe's jQuery/Angular listeners.
    const win = el.ownerDocument.defaultView || window;

    el.focus();

    // contenteditable divs (rich-text answer boxes)
    if (el.isContentEditable) {
      el.textContent = '';
      el.dispatchEvent(new win.Event('input', {bubbles:true}));
      for (const char of text) {
        el.dispatchEvent(new win.KeyboardEvent('keydown',  {key:char, bubbles:true}));
        el.dispatchEvent(new win.KeyboardEvent('keypress', {key:char, bubbles:true}));
        el.textContent += char;
        el.dispatchEvent(new win.Event('input', {bubbles:true}));
        el.dispatchEvent(new win.KeyboardEvent('keyup', {key:char, bubbles:true}));
      }
      el.dispatchEvent(new win.Event('change', {bubbles:true}));
      el.blur();
      return;
    }

    // Use the element's own frame's native value setter so Angular/jQuery detect the change
    const proto = el.tagName === 'TEXTAREA'
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeSetter) { nativeSetter.call(el, ''); } else { el.value = ''; }
    el.dispatchEvent(new win.Event('input', {bubbles:true}));

    for (const char of text) {
      el.dispatchEvent(new win.KeyboardEvent('keydown',  {key:char, bubbles:true}));
      el.dispatchEvent(new win.KeyboardEvent('keypress', {key:char, bubbles:true}));
      const next = el.value + char;
      if (nativeSetter) { nativeSetter.call(el, next); } else { el.value = next; }
      el.dispatchEvent(new win.Event('input', {bubbles:true}));
      el.dispatchEvent(new win.KeyboardEvent('keyup', {key:char, bubbles:true}));
    }

    el.dispatchEvent(new win.Event('change', {bubbles:true}));
    el.blur();
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

  // ─── Vision helpers ───────────────────────────────────────────────────────

  function fetchImageAsBase64(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        onload(res) {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result; // data:<mime>;base64,<b64>
            const mime = dataUrl.split(';')[0].split(':')[1] || 'image/png';
            const b64  = dataUrl.split(',')[1] || '';
            resolve({ b64, mime });
          };
          reader.onerror = reject;
          reader.readAsDataURL(res.response);
        },
        onerror: reject,
      });
    });
  }

  async function collectPageImages() {
    const results = [];
    const seenUrls = new Set();

    for (const doc of getAllDocs()) {
      if (results.length >= 5) break;

      // ── img elements ──────────────────────────────────────────────────────
      for (const img of doc.querySelectorAll('img')) {
        if (results.length >= 5) break;
        try {
          const src = img.src;
          if (!src || seenUrls.has(src) || !src.startsWith('http')) continue;
          // Skip tiny icons (< 30px); 0 means not yet loaded — include those
          if (img.naturalWidth  > 0 && img.naturalWidth  < 30) continue;
          if (img.naturalHeight > 0 && img.naturalHeight < 30) continue;
          seenUrls.add(src);
          const data = await fetchImageAsBase64(src).catch(() => null);
          if (data) results.push(data);
        } catch(e) {}
      }

      // ── canvas elements (rendered graphs, charts) ─────────────────────────
      for (const canvas of doc.querySelectorAll('canvas')) {
        if (results.length >= 5) break;
        try {
          if (canvas.width < 30 || canvas.height < 30) continue;
          const dataUrl = canvas.toDataURL('image/png');
          const b64 = dataUrl.split(',')[1];
          if (b64) results.push({ b64, mime: 'image/png' });
        } catch(e) {}
      }
    }

    return results;
  }

  // Selectors that count as "submitting an answer" — trigger post-submit verification
  const SUBMIT_SELECTORS = ['#btnCheck', 'span#btnCheck'];

  async function verifySubmit() {
    await sleep(2000);
    const wrong   = !!findContent('span.TextAnswerIncorrect') || !!findContent('div.done-retry');
    const correct = !!findContent('span.TextAnswerCorrect')   || !!findContent('div.done-complete');
    if (wrong) {
      log('❌ Wrong answer — injecting correction with reasoning requirement', 'error');
      // Capture what was answered so the LLM knows specifically what to change
      const checkedChoices = getAnswerChoices().filter(c => c.checked);
      const wrongDesc = checkedChoices.length > 0
        ? `You selected: ${checkedChoices.map(c => `"${c.text}"`).join(', ')} — this is WRONG.`
        : 'Your typed answer was marked wrong.';
      history.push({
        role: 'user',
        content: `⚠️ WRONG ANSWER: ${wrongDesc} ` +
                 `Think carefully again using your "thinking" field. ` +
                 `Re-read the question in bodyText. Consider what subject this is and recall the correct fact. ` +
                 `Only fix the SPECIFIC field/choice that was wrong — do NOT change anything already correct. ` +
                 `Give a completely different, factually correct answer. Do NOT guess.`,
      });
    } else if (correct) {
      log('✅ Answer verified correct', 'ok');
    } else {
      log('Answer submitted — no feedback element found yet', 'info');
    }
  }

  // ─── Next-course-item finder ─────────────────────────────────────────────
  // Scans the outer (top-level) Edgenuity player document for any button/link
  // that moves the student forward to the next activity, section, or lesson.

  const SKIP_PATTERN = /cancel|delete|save.*exit|exit|sign.?out|log.?out|eNotes|print/i;
  const NEXT_PATTERN = /^(next|continue|start|go to|begin|proceed|resume|launch|open)\b/i;

  function findNextCourseLink() {
    const panelEl = document.getElementById('ea-panel');
    const outside = el => !panelEl?.contains(el);

    // 1. Buttons / inputs in top document with forward-navigation text
    for (const el of document.querySelectorAll(
      'input[type="button"], input[type="submit"], input[type="image"], button, a[href]'
    )) {
      if (!outside(el)) continue;
      const txt = (el.value || el.innerText || el.getAttribute('title') || '').trim();
      if (SKIP_PATTERN.test(txt)) continue;
      if (NEXT_PATTERN.test(txt)) return el;
    }

    // 2. Class-name hints
    for (const el of document.querySelectorAll(
      '[class*="next"], [class*="continue"], [class*="forward"], [class*="proceed"]'
    )) {
      if (!outside(el)) continue;
      const txt = (el.value || el.innerText || '').trim();
      if (SKIP_PATTERN.test(txt)) continue;
      if (txt) return el;
    }

    // 3. a.nav forward link (last = forward in Edgenuity)
    const navLinks = [...document.querySelectorAll('a.nav')].filter(outside);
    if (navLinks.length > 0) return navLinks[navLinks.length - 1];

    return null;
  }

  async function executeAction(action) {
    switch (action.action) {
      case 'click': {
        const el = findElement(action.selector);
        if (!el) { log(`Click failed — not found: ${action.selector}`, 'warn'); return; }

        // Block re-submitting the same wrong answer — the agent must change the answer first.
        // Clicking btnCheck while TextAnswerIncorrect is still visible just burns an attempt.
        const isSubmitClick = SUBMIT_SELECTORS.some(s => {
          try { return el === findElement(s); } catch(e) { return false; }
        });
        if (isSubmitClick && (findContent('span.TextAnswerIncorrect') || findContent('div.done-retry'))) {
          log('🚫 Submit blocked — wrong answer still visible. Must change answer first.', 'error');
          history.push({
            role: 'user',
            content: '🚫 SUBMIT BLOCKED: span.TextAnswerIncorrect is still on screen. ' +
                     'Your previous answer is STILL WRONG and you have NOT changed it yet. ' +
                     'Clicking submit again without changing the answer will score 0. ' +
                     'Use your thinking field to determine the correct answer, ' +
                     'then type or select a DIFFERENT answer before clicking span#btnCheck.',
          });
          await sleep(ACTION_DELAY_MS);
          return;
        }

        log(`Click: ${action.selector} — ${action.reason}`, 'ok');
        simulateClick(el);
        await sleep(ACTION_DELAY_MS);
        if (isSubmitClick) {
          await verifySubmit();
        }
        break;
      }
      case 'clickChoice': {
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
        if (!clicked) {
          log(`clickChoice failed — no label matching: "${action.text}"`, 'warn');
        } else if (findElement('ol#navBtnList')) {
          // Mark this question as answered by the agent so the fast path can advance
          const qBtns  = queryAll('ol#navBtnList a.plainbtn:not([class*="gray"])');
          const selBtn = [...qBtns].find(el => /\bselected\b/.test(el.className));
          assessmentAnsweredQ = selBtn ? (parseInt(selBtn.innerText) || 1) : 1;
        }
        await sleep(ACTION_DELAY_MS);
        break;
      }
      case 'type': {
        const el = findElement(action.selector);
        if (!el) { log(`Type failed — not found: ${action.selector}`, 'warn'); return; }
        log(`Type "${(action.text||'').slice(0,50)}" → ${action.selector}`, 'ok');
        simulateType(el, action.text || '');
        await sleep(ACTION_DELAY_MS);
        // If this is a quiz/test, mark the current question as answered
        // (same logic as clickChoice) so the fast path can auto-advance
        if (findElement('ol#navBtnList')) {
          const qBtns  = queryAll('ol#navBtnList a.plainbtn:not([class*="gray"])');
          const selBtn = [...qBtns].find(b => /\bselected\b/.test(b.className));
          assessmentAnsweredQ = selBtn ? (parseInt(selBtn.innerText) || 1) : 1;
        }
        break;
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
        const fr = queryAll('li[id^="frame"]').length;
        const fc = queryAll('li.FrameComplete').length;
        if (fr > 0 && fc < fr) {
          log('⚠️ LLM called done but frames remain — ignoring', 'warn');
          break;
        }
        // Never stop. Try to navigate to the next activity/lesson.
        log('📚 LLM called done — looking for next activity…', 'ok');
        const nextLink = findNextCourseLink();
        if (nextLink) {
          const label = (nextLink.value || nextLink.innerText || 'link').trim().slice(0, 40);
          log(`Found next: "${label}" — navigating`, 'ok');
          simulateClick(nextLink);
          await sleep(3500);
        } else {
          // Nothing found yet — the player may still be loading the results screen.
          // Wait 5 s and re-evaluate on the next tick (do NOT push history here because
          // that causes the LLM to call "done" again in a tight loop).
          log('Next activity not visible yet — waiting 5 s…', 'warn');
          await sleep(5000);
        }
        break;
      }
      default:
        log(`Unknown action: ${action.action}`, 'warn');
    }
  }

  // ─── Agent loop ───────────────────────────────────────────────────────────

  let running = false, loopHandle = null;
  const history = [];
  let assessmentAnsweredQ = 0; // tracks which question number the agent last answered
  let stuckTicks = 0, lastProgressKey = '';

  async function agentTick() {
    if (!running) return;
    // Top-level safety net: ANY uncaught exception reschedules the loop instead
    // of silently killing it. Without this, a single DOM exception (e.g. accessing
    // a cross-origin iframe mid-navigation) would permanently stop the agent.
    try {
      await _agentTickBody();
    } catch(fatalErr) {
      log('⚠️ Unexpected error — recovering: ' + (fatalErr?.message || fatalErr), 'error');
      if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS * 2);
    }
  }

  async function _agentTickBody() {
    if (isMediaPlaying()) {
      log('Media playing — waiting…', 'info');
      setStatus('Waiting for media…', true);
      stuckTicks = 0; // media playing is intentional — don't count as stuck
      loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
      return;
    }

    // ── Stuck watchdog ────────────────────────────────────────────────────────
    {
      const qBtnsNow = queryAll('ol#navBtnList a.plainbtn:not([class*="gray"])');
      const selBtnNow = [...qBtnsNow].find(el => /\bselected\b/.test(el.className));
      const curQNow = selBtnNow ? (parseInt(selBtnNow.innerText) || 1) : 0;
      const progressKey = `${window.location.href}|${queryAll('li.FrameComplete').length}|${curQNow}`;
      if (progressKey === lastProgressKey) {
        stuckTicks++;
      } else {
        stuckTicks = 0;
        lastProgressKey = progressKey;
      }
      if (stuckTicks >= STUCK_TICKS_LIMIT) {
        log('⚠️ Stuck detected — attempting recovery click', 'warn');
        stuckTicks = 0;
        const rec = findElement('li.FrameRight') || findElement('span#btnCheck') || findElement('a#nextQuestion');
        if (rec) { simulateClick(rec); await sleep(1500); }
        else { log('No recovery target found — continuing', 'warn'); }
        if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
        return;
      }
    }
    // ── End stuck watchdog ────────────────────────────────────────────────────

    // ── Assessment fast path: auto-navigate between quiz/test questions ─────────
    // The LLM only needs to select answers (clickChoice). This code advances
    // to the next question after each answer is chosen, and auto-submits at the end.
    {
      const isAssessment = !!findElement('ol#navBtnList');
      if (isAssessment) {
        const qBtns   = queryAll('ol#navBtnList a.plainbtn:not([class*="gray"])');
        const totalQ  = qBtns.length;
        const selBtn  = [...qBtns].find(el => /\bselected\b/.test(el.className));
        const curQ    = selBtn ? (parseInt(selBtn.innerText) || 1) : 1;

        // Only advance after the agent itself has answered this question.
        // Checking DOM :checked state is unreliable — Edgenuity often has a radio
        // pre-checked on page load (previous attempt), causing false positives.
        // assessmentAnsweredQ is set in clickChoice/click after the agent acts.
        if (assessmentAnsweredQ === curQ) {
          if (curQ < totalQ) {
            const nextBtn = findElement('a#nextQuestion');
            if (nextBtn) {
              log(`Q${curQ}/${totalQ} answered — next question (fast)`, 'ok');
              setStatus(`Quiz Q${curQ}/${totalQ}`, true);
              simulateClick(nextBtn);
              await sleep(800);
              if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
              return;
            }
          } else {
            // Last question answered — find and click Submit
            const submitBtn = [...queryAll('span.buttons a, span.buttons input, span.buttons button')]
              .find(el => /submit/i.test(el.innerText || el.value || ''));
            if (submitBtn) {
              log(`All ${totalQ} questions answered — submitting quiz`, 'ok');
              setStatus('Submitting…', true);
              simulateClick(submitBtn);
              await sleep(3000);
              if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
              return;
            }
          }
        }
        // No answer yet — fall through to LLM to pick one
      }
    }
    // ── End assessment fast path ─────────────────────────────────────────────

    // ── Fast path: no LLM call needed for pure informational slides ───────────
    {
      const completedNow = queryAll('li.FrameComplete').length;
      const totalNow     = queryAll('li[id^="frame"]').length;
      // needsInput: CONTENT DOCS ONLY — outer player eNotes textarea / Cancel-Delete-Save
      // inputs must never make an informational slide appear interactive.
      const needsInput   = queryContent('input[type="text"],input[type="radio"],input[type="checkbox"],textarea,select,div.answer-choice').length > 0
                        || queryContent('div.sbgTile:not(.checked)').length > 0
                        || !!findContent('span.TextAnswerIncorrect')
                        || !!findContent('div.done-retry');
      const currentDone  = !!findElement('li.FrameCurrent.FrameComplete');
      const frameRight   = findElement('li.FrameRight');
      const allDone      = totalNow > 0 && completedNow >= totalNow;

      // ── All frames complete → wait for Edgenuity to transition ──────────────
      if (allDone) {
        setStatus('Activity done — waiting for next…', true);

        // Snapshot the current iframe URL before clicking anything
        const iframeBefore = document.querySelector('iframe')?.contentDocument?.location?.href || '';

        // Click FrameRight: this sends Edgenuity's completion signal.
        // After this click the player may auto-load the next activity in the iframe.
        if (frameRight) {
          log('All frames done — clicking FrameRight (completion signal)', 'ok');
          simulateClick(frameRight);
          await sleep(3500);
          if (!running) return;
        }

        // Check if the iframe content changed — if so, new activity already loaded.
        const iframeAfter  = document.querySelector('iframe')?.contentDocument?.location?.href || '';
        const newTotal     = queryAll('li[id^="frame"]').length;
        const newCompleted = queryAll('li.FrameComplete').length;
        const contentChanged = iframeAfter !== iframeBefore || newTotal !== totalNow || (newTotal > 0 && newCompleted < newTotal);

        if (contentChanged) {
          log('New activity detected — resuming', 'ok');
          if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
          return;
        }

        // Iframe unchanged — find the next forward navigation in the page.
        // findNextCourseLink() searches for Next/Continue buttons then falls
        // back to a.nav (forward link) so we cover all Edgenuity layouts.
        const nextLink = findNextCourseLink();
        if (nextLink) {
          const label = (nextLink.value || nextLink.innerText || 'link').trim().slice(0, 40);
          log(`Clicking next: "${label}"`, 'ok');
          simulateClick(nextLink);
          await sleep(3500);
          if (!running) return;

          // If frame count changed, new activity loaded — resume normally
          const afterNav = queryAll('li[id^="frame"]').length;
          if (afterNav !== totalNow) {
            if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
            return;
          }

          // Still no change — try a.nav[0] as a last resort (might be a two-step flow)
          const navLinks = [...document.querySelectorAll('a.nav')]
            .filter(el => !document.getElementById('ea-panel')?.contains(el));
          if (navLinks.length > 1) {
            log('Trying fallback a.nav[0]', 'info');
            simulateClick(navLinks[0]);
            await sleep(3000);
          }
        } else {
          log('No forward navigation found — will retry', 'warn');
        }

        if (running) loopHandle = setTimeout(agentTick, 2000);
        return;
      }
      // ── End activity transition ───────────────────────────────────────────────

      if (!needsInput && frameRight) {
        if (currentDone) {
          log('Frame complete — advancing (fast)', 'info');
          setStatus('Advancing…', true);
          simulateClick(frameRight);
          await sleep(700);
          if (running) loopHandle = setTimeout(agentTick, 800);
          return;
        }
        const btnCheck = findElement('span#btnCheck');
        if (btnCheck) {
          log('Info slide — Done + advance (fast)', 'info');
          setStatus('Advancing…', true);
          simulateClick(btnCheck);
          await sleep(900);
          const fr = findElement('li.FrameRight');
          if (fr) { simulateClick(fr); await sleep(700); }
          if (running) loopHandle = setTimeout(agentTick, 800);
          return;
        }
      }
    }
    // ── End fast path ─────────────────────────────────────────────────────────

    // ── No-frames fast path: completion/results screens ───────────────────────
    // When totalNow === 0 there is no FrameChain loaded — this happens on score
    // summaries and course-completion screens. Instead of calling the LLM (which
    // ends up looping on "done"), proactively look for a navigation button.
    {
      const totalNow = queryAll('li[id^="frame"]').length;
      const isAssessment = !!findElement('ol#navBtnList');
      if (totalNow === 0 && !isAssessment) {
        const nextLink = findNextCourseLink();
        if (nextLink) {
          const label = (nextLink.value || nextLink.innerText || 'link').trim().slice(0, 40);
          log(`Completion screen — clicking next: "${label}"`, 'ok');
          simulateClick(nextLink);
          await sleep(3500);
        } else {
          log('Completion screen — no nav found, retrying in 5 s', 'warn');
          await sleep(5000);
        }
        if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
        return;
      }
    }
    // ── End no-frames fast path ───────────────────────────────────────────────

    setStatus('Thinking…', true);
    const state = getPageState();

    // ── Build a human-readable choices block so the LLM doesn't miss them ────
    let choicesBlock = '';
    if (state.answerChoices && state.answerChoices.length > 0) {
      choicesBlock = '\n\nANSWER CHOICES (use exact text in clickChoice):\n' +
        state.answerChoices.map(c =>
          `  [${c.index}] (${c.type})${c.checked ? ' ✓SELECTED' : ''} "${c.text}"`
        ).join('\n');
    }

    // ── Wrong-answer warning: name what's wrong and block re-submit ──────────
    let wrongHint = '';
    if (state.hasWrongAnswer) {
      const currentAnswers = (state.textInputs || [])
        .filter(t => t.currentValue && t.currentValue !== '(empty)')
        .map(t => `"${t.currentValue}"`).join(', ');
      const currentChoices = (state.answerChoices || [])
        .filter(c => c.checked).map(c => `"${c.text}"`).join(', ');
      const whatIsWrong = currentAnswers || currentChoices || '(unknown)';
      wrongHint = `\n\n🚫 WRONG ANSWER: The answer ${whatIsWrong} is INCORRECT. ` +
        `DO NOT click span#btnCheck again without changing the answer first — ` +
        `that will score 0. You MUST type a different answer or select a different choice. ` +
        `Use your thinking field to reason about the correct answer from your training knowledge.`;
    }

    // ── Force type action when an empty text field is present ─────────────────
    const emptyTextInputs = (state.textInputs || []).filter(t => t.currentValue === '(empty)');
    const typeHint = emptyTextInputs.length > 0 && !state.hasRightAnswer
      ? `\n\n⚠️ REQUIRED: Empty text field detected (selector: "${emptyTextInputs[0].selector}"). ` +
        `You MUST use {"thinking":"...","action":"type","selector":"${emptyTextInputs[0].selector}","text":"<real answer>","reason":"..."}. ` +
        `Do NOT use clickChoice.`
      : '';

    const userMsg = `Current page state:\n${JSON.stringify(state, null, 2)}${choicesBlock}\n\nWhat is the next action? Reply with only a JSON object (include "thinking" field).${wrongHint}${typeHint}`;

    history.push({ role: 'user', content: userMsg });
    if (history.length > 20) history.splice(0, 2);

    // Collect page images for vision when available
    let pageImages = [];
    if (visionAvailable) {
      try { pageImages = await collectPageImages(); } catch(e) {}
      if (pageImages.length) log(`Vision: ${pageImages.length} image(s) → AI`, 'info');
    }

    let action;
    try {
      action = await callLLM(history, pageImages);
      history.push({ role: 'assistant', content: JSON.stringify(action) });
    } catch(err) {
      log('Groq error: ' + err.message, 'error');
      setStatus('Error — retrying…', true);
      loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS * 2);
      return;
    }

    // Guard: if LLM returns null, a bare string, or any non-action object, skip and retry
    if (!action || typeof action !== 'object' || typeof action.action !== 'string') {
      log('⚠️ LLM returned invalid action — retrying', 'warn');
      if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
      return;
    }

    // Show the model's reasoning in the log panel (first 120 chars)
    if (action.thinking) {
      log(`💭 ${String(action.thinking).slice(0, 120)}`, 'info');
    }

    setStatus('Acting…', true);
    try {
      await executeAction(action);
    } catch(execErr) {
      // Swallow action errors so the loop always continues
      log('⚠️ Action error — recovering: ' + (execErr?.message || execErr), 'error');
    }
    if (running) loopHandle = setTimeout(agentTick, POLL_INTERVAL_MS);
  }

  function startAgent(auto = false) {
    if (!GM_getValue(STORAGE_KEY_API, '')) {
      log('Please paste your Groq API key and click Save first.', 'error'); return;
    }
    GM_setValue(STORAGE_KEY_AUTORUN, true);
    running = true; history.length = 0; assessmentAnsweredQ = 0; stuckTicks = 0; lastProgressKey = '';
    document.getElementById('ea-start-btn').disabled = true;
    document.getElementById('ea-stop-btn').disabled  = false;
    log(auto ? '🔄 Auto-resumed on new activity page.' : 'Agent started.', 'ok');
    setStatus('Running', true);
    agentTick();
  }

  function stopAgent(finished = false) {
    GM_setValue(STORAGE_KEY_AUTORUN, false);
    running = false; clearTimeout(loopHandle);
    document.getElementById('ea-start-btn').disabled = false;
    document.getElementById('ea-stop-btn').disabled  = true;
    setStatus('Stopped', false);
    log(finished ? '🎓 Course complete — agent stopped.' : 'Agent stopped.', 'warn');
  }

  document.getElementById('ea-start-btn').addEventListener('click', () => startAgent(false));
  document.getElementById('ea-stop-btn').addEventListener('click',  () => stopAgent(false));
  document.getElementById('ea-debug-btn').addEventListener('click', runDebug);

  // ─── Auto-resume after page navigation ────────────────────────────────────
  // When the agent clicks "Next Activity", the page navigates to a new URL.
  // The script re-injects and checks this flag to auto-restart seamlessly.
  if (GM_getValue(STORAGE_KEY_AUTORUN, false) && GM_getValue(STORAGE_KEY_API, '')) {
    setTimeout(() => startAgent(true), 2500);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

})();
