const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

async function withEditor(run, options = {}) {
  const language = options.language === undefined ? 'zh-CN' : options.language;
  if (language !== null && !['zh-CN', 'en'].includes(language)) {
    throw new Error('Unsupported editor test language: ' + language);
  }
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  const browser = options.browser || process.env.SVG_TWEAK_BROWSER || candidates.find(p => p && fs.existsSync(p));
  if (!browser || !fs.existsSync(browser)) {
    throw new Error('Chrome not found. Set SVG_TWEAK_BROWSER to the full path of Chrome or Chromium.');
  }

  const tempRoot = fs.realpathSync(os.tmpdir());
  const prefix = 'svg-tweak-test-browser-';
  const profile = fs.mkdtempSync(path.join(tempRoot, prefix));
  const chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-pipe', '--user-data-dir=' + profile, '--window-size=1440,1000'
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', stderr = '', closed = false, closing = false, processError;
  const pending = new Map();
  function failPending(error) {
    processError = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }
  const closePromise = new Promise(resolve => chrome.once('close', () => { closed = true; resolve(); }));
  chrome.once('error', e => failPending(new Error('Cannot start browser: ' + browser + '\n' + e.message)));
  chrome.once('exit', (code, signal) => failPending(new Error(
    (closing ? 'Browser closed' : 'Browser exited unexpectedly') +
    ' (code ' + code + ', signal ' + signal + ').' + (stderr ? '\n' + stderr : '')
  )));
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  chrome.stdio[3].on('error', e => failPending(new Error('Browser pipe failed: ' + e.message)));
  chrome.stdio[4].setEncoding('utf8');
  chrome.stdio[4].on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\0')) >= 0;) {
      const raw = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!raw) continue;
      const msg = JSON.parse(raw);
      if (!msg.id || !pending.has(msg.id)) continue;
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  function send(method, params = {}, sessionId, timeout = 15000) {
    if (processError) return Promise.reject(processError);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Browser command timed out: ' + method + (stderr ? '\n' + stderr : '')));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      const data = { id, method, params };
      if (sessionId) data.sessionId = sessionId;
      chrome.stdio[3].write(JSON.stringify(data) + '\0');
    });
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    // No test should load the user's private API configuration, even before its setup callback.
    await send('Network.enable', {}, sessionId);
    await send('Network.setBlockedURLs', { urls: ['*ai-config.js*'] }, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source:
      'window.__auditErrors=[];window.addEventListener("error",e=>window.__auditErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.__auditErrors.push(String(e.reason)));'
    }, sessionId);
    // Seed only the first navigation. Re-seeding on every reload would hide bugs
    // in the editor's own saved-language preference and overwrite later choices.
    const languageSeed = language === null ? null : await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try{localStorage.setItem("svgtweak.language",' + JSON.stringify(language) + ');}catch(_){}'
    }, sessionId);
    await send('Page.navigate', {
      url: options.url || pathToFileURL(path.resolve(__dirname, '..', 'svg-tweak.html')).href
    }, sessionId);
    async function evalJS(expression) {
      const r = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    }
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (await evalJS('document.readyState === "complete" && typeof loadSVGText === "function"')) {
        ready = true; break;
      }
      await delay(100);
    }
    if (!ready) throw new Error('Editor initialization timed out. Check the HTML URL and browser errors.');
    if (languageSeed) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: languageSeed.identifier }, sessionId);
    return await run({ evalJS, send: (method, params) => send(method, params, sessionId), delay, profile });
  } finally {
    closing = true;
    if (!closed) { try { await send('Browser.close', {}, undefined, 2000); } catch (_) {} }
    if (!closed) chrome.kill();
    await closePromise;
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    const target = path.resolve(profile);
    if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(prefix)) {
      throw new Error('Refusing to remove an unexpected browser profile path: ' + target);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
}

module.exports = { withEditor };
