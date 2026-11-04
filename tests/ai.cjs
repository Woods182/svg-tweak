// Run: node tests/ai.cjs (uses a loopback-only mock API; no real API key or external calls).
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { withEditor } = require('./browser.cjs');

const MOCK_KEY = 'svg-tweak-test-key-not-a-real-secret';
const FILE_MOCK_KEY = 'svg-tweak-file-test-key-not-a-real-secret';
const SAVE_MOCK_KEY = 'save-only-dummy-"quoted"-\\slash\nnext-line';
const FIXTURE = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><g id="scope"><rect id="box" x="10" y="10" width="70" height="35" fill="#008855"/><text id="label" x="15" y="32" font-size="14">Before</text></g><rect id="outside" x="180" y="10" width="35" height="35" fill="#888888"/></svg>';
const NEXT_DOCUMENT = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><rect id="next-document" width="20" height="20" fill="orange"/></svg>';

function readContext(body) {
  const message = body.messages.filter(m => m.role === 'user').at(-1);
  const text = typeof message.content === 'string'
    ? message.content
    : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  try { return JSON.parse(text).document || null; }
  catch { return null; } // Connection checks deliberately send only a short text prompt.
}

function keyFor(context, id) {
  for (const match of context.xml.matchAll(/<[^!?/][^>]*>/g)) {
    const idAttr = match[0].match(/\bid=(['"])(.*?)\1/);
    if (idAttr && idAttr[2] === id) {
      const key = match[0].match(/\bdata-ai-key=(['"])(.*?)\1/);
      if (key) return key[2];
    }
  }
  throw new Error('Mock cannot find AI key for #' + id);
}

function configFromScript(source) {
  const context = {window:{}};
  vm.runInNewContext(source, context, {timeout:1000});
  return JSON.parse(JSON.stringify(context.window.SVG_TWEAK_AI_CONFIG));
}

async function waitForRequest(entry) {
  let timer;
  try {
    return await Promise.race([entry.seen, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The AI UI did not reach the local mock API')), 8000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function createMock() {
  const queue = [], requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin === 'null' ? 'null' : '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      assert.equal(req.method, 'POST');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), context = readContext(body);
      const request = { path:req.url, origin:req.headers.origin, authorization:req.headers.authorization, body, context };
      requests.push(request);
      const entry = queue.shift();
      if (!entry) throw new Error('Unexpected mock request');
      entry.release = () => {
        if (res.destroyed || res.writableEnded) return;
        const plan = typeof entry.plan === 'function' ? entry.plan(context) : entry.plan;
        res.writeHead(entry.status || 200, { 'Content-Type':'application/json' });
        res.end(JSON.stringify(entry.status
          ? { error:{ message:'Intentional local mock failure' } }
          : { choices:[{ message:{ role:'assistant', content:typeof plan === 'string' ? plan : JSON.stringify(plan) } }] }));
      };
      entry.resolve(request);
      if (!entry.hold) entry.release();
    } catch (error) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ error:{ message:error.message } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url:'http://127.0.0.1:' + server.address().port + '/v1', requests,
    enqueue(plan, options = {}) {
      const entry = { plan, ...options };
      entry.seen = new Promise(resolve => { entry.resolve = resolve; });
      queue.push(entry);
      return entry;
    },
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  };
}

async function main() {
  const mock = await createMock();
  const passed = [];
  try {
    await withEditor(async ({ evalJS, send, delay }) => {
      async function waitFor(expression, label) {
        for (let i=0; i<100; i++) {
          if (await evalJS(expression)) return;
          await delay(30);
        }
        throw new Error('Timed out: ' + label);
      }
      // Start from a blank bootstrap, blocking the user's real config before the
      // editor is opened. Only these dummy loopback settings enter the test page.
      await send('Network.enable');
      await send('Network.setBlockedURLs', { urls:['*ai-config.js*'] });
      await send('Page.addScriptToEvaluateOnNewDocument', { source:
        'window.SVG_TWEAK_AI_CONFIG=' + JSON.stringify({baseURL:mock.url,model:'file-svg-model',apiKey:FILE_MOCK_KEY}) + ';'
      });
      await send('Page.navigate', { url:pathToFileURL(path.resolve(__dirname, '..', 'svg-tweak.html')).href });
      await waitFor('document.readyState === "complete" && typeof aiSend === "function"', 'AI UI startup');
      assert.equal(await evalJS('typeof aiAdoptPreview === "function" && typeof aiSelectOriginal === "function" && typeof aiTestConnection === "function"'), true, 'AI UI/API is not available in the HTML');
      assert.deepEqual(await evalJS(`['aiPending','aiApply','aiReroll','aiContinue','aiAdopt','aiDiscard','aiSource','aiUseVersion'].filter(id=>$(id))`), [], 'legacy candidate-card and source controls must be removed');
      await evalJS(`window.__aiTestConfirmAnswer=false; window.__aiTestConfirms=[];
        window.confirm=message=>{__aiTestConfirms.push(message);return __aiTestConfirmAnswer;};`);
      const setPrompt = prompt => evalJS(`$('aiPrompt').value = ${JSON.stringify(prompt)}`);
      const connectionState = () => evalJS(`({
        xml:snapshot(),undo:state.undo.slice(),redo:state.redo.slice(),dirty:state.dirty,fileName:state.fileName,
        pending:JSON.stringify(aiState.pending),messages:JSON.stringify(aiState.messages),prompt:$('aiPrompt').value
      })`);
      function checkConnectionPayload(request) {
        assert.equal(request.context, null, 'connection test must not send editing context');
        assert.equal(request.body.messages.length, 1, 'connection test must not send chat history');
        const message = request.body.messages[0];
        assert.equal(message.role, 'user');
        assert.equal(typeof message.content, 'string', 'connection test must not send an image');
        assert(message.content.length > 0 && message.content.length < 200, 'connection test must be a minimal text prompt');
        assert.doesNotMatch(message.content, /<svg|data:image|selectedKeys|document\.xml/i);
      }
      async function prepare(prompt = 'Adjust the selected module') {
        await evalJS(`(() => {
          loadSVGText(${JSON.stringify(FIXTURE)}, 'ai-test.svg', window.__aiTestHandle);
          select([doc.querySelector('#scope')]); aiRefreshScope();
          $('aiScope').value = 'selection'; $('aiVision').checked = false;
          $('aiPrompt').value = ${JSON.stringify(prompt)};
        })()`);
      }
      async function submit(plan, prompt = 'Adjust the selected module', options) {
        const entry = mock.enqueue(plan, options);
        await setPrompt(prompt);
        const result = await evalJS('(async () => { await aiSend(); return {busy:aiState.busy,pending:!!aiState.pending,status:$("aiStatus").textContent}; })()');
        return { entry, result };
      }
      const moveBox = context => ({ summary:'Move the selected box', operations:[{ op:'move', targets:[keyFor(context, 'box')], dx:4, dy:2 }] });

      const fileConfig = {baseURL:mock.url,model:'file-svg-model',apiKey:FILE_MOCK_KEY};
      assert.deepEqual(await evalJS('aiGetConfig()'), fileConfig);
      assert.deepEqual(await evalJS('[ $("aiBaseURL").value, $("aiModel").value, $("aiKey").value ]'), ['', '', ''], 'file config must not be copied into the web inputs');
      for (const [id,field,value] of [
        ['aiBaseURL','baseURL',mock.url + '/web'], ['aiModel','model','web-svg-model'], ['aiKey','apiKey',MOCK_KEY]
      ]) {
        const config = await evalJS(`(() => {
          for (const id of ['aiBaseURL','aiModel','aiKey']) { $(id).value='  '; $(id).dispatchEvent(new Event('change')); }
          $(${JSON.stringify(id)}).value=${JSON.stringify('  ' + value + '  ')};
          $(${JSON.stringify(id)}).dispatchEvent(new Event('change'));
          return aiGetConfig();
        })()`);
        assert.deepEqual(config, {...fileConfig,[field]:value}, field + ': nonempty trimmed web value overrides only this file field');
        assert.equal(await evalJS(`$('aiConfigSource').textContent.includes(${JSON.stringify(MOCK_KEY)}) || $('aiConfigSource').textContent.includes(${JSON.stringify(FILE_MOCK_KEY)})`), false, 'config source hint must never reveal a key');
      }
      await evalJS(`for (const id of ['aiBaseURL','aiModel','aiKey']) { $(id).value=''; $(id).dispatchEvent(new Event('change')); }`);
      assert.deepEqual(await evalJS('aiGetConfig()'), fileConfig, 'clearing web overrides must restore per-field file fallback');
      assert.equal(await evalJS(`JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(FILE_MOCK_KEY)})`), false, 'file key must not be persisted');
      passed.push('per-field file fallback, trimmed web overrides, empty input preservation and key-free source hints/storage');

      const readLayout = () => evalJS(`(() => {
        const read = el => { const r=el.getBoundingClientRect(); return {x:r.x,w:r.width,visible:!el.hidden && getComputedStyle(el).display!=='none'}; };
        const main=document.querySelector('main');
        return {stage:read(stage),aside:read(document.querySelector('main > aside')),ai:read($('aiPanel')),scrollW:main.scrollWidth,clientW:main.clientWidth,overflow:getComputedStyle(main).overflowX};
      })()`);
      const closedLayout = await readLayout();
      await evalJS('$("btnAI").click()');
      const openLayout = await readLayout();
      for (const name of ['stage','aside','ai']) {
        assert(openLayout[name].visible && openLayout[name].w > 100, name + ': must remain visible while AI is open');
      }
      assert(openLayout.stage.x < openLayout.aside.x && openLayout.aside.x < openLayout.ai.x, 'columns must remain stage | properties | AI');
      await send('Emulation.setDeviceMetricsOverride', {width:760,height:1000,deviceScaleFactor:1,mobile:false});
      const narrowLayout = await readLayout();
      assert(narrowLayout.stage.w > 200 && narrowLayout.aside.w > 200 && narrowLayout.ai.w > 200, 'a narrow viewport must not collapse any column');
      assert(narrowLayout.scrollW > narrowLayout.clientW && ['auto','scroll'].includes(narrowLayout.overflow), 'a narrow main area must allow horizontal scrolling');
      await send('Emulation.clearDeviceMetricsOverride');
      await delay(50);
      await evalJS('$("aiClose").click()');
      const restoredLayout = await readLayout();
      assert.equal(restoredLayout.ai.visible, false);
      assert.equal(restoredLayout.aside.visible, true, 'closing AI must not hide properties');
      assert(Math.abs(restoredLayout.stage.w-closedLayout.stage.w)<1, 'closing AI must restore the canvas column width');
      assert(restoredLayout.stage.w > openLayout.stage.w, 'closing AI should release its column width');
      passed.push('stage/properties/AI column order, narrow-screen scrolling and closing AI restores the canvas');

      await evalJS('aiToggle(true)');
      assert.equal(await evalJS('typeof aiSaveConfig === "function" && !!$("aiSaveConfig")'), true, 'local configuration save UI is unavailable');
      const draftConfig = {baseURL:'offline draft, not a URL',model:'draft "model"\\folder',apiKey:SAVE_MOCK_KEY};
      const saveRequestCount = mock.requests.length;
      const saveEditorBase = await connectionState();
      await evalJS(`(() => {
        window.__configSaveOriginal={picker:Object.getOwnPropertyDescriptor(window,'showSaveFilePicker'),handle:aiState.configHandle,
          inputs:['aiBaseURL','aiModel','aiKey'].map(id=>$(id).value)};
        window.__configSaveMock={pickerCalls:[],writes:[],creates:0,writeStarted:0,closed:0,mode:'ok'};
        const m=window.__configSaveMock;
        window.__configFakeHandle={kind:'file',name:'ai-config.js',async createWritable(){
          m.creates++; if(m.mode==='create-fail') throw new Error('Intentional config create failure');
          return {async write(source){
            m.writeStarted++; if(m.mode==='write-fail') throw new Error('Intentional config write failure');
            if(m.mode==='hold-write') await new Promise(resolve=>m.releaseWrite=resolve);
            const data=source && source.type==='write' ? source.data : source;
            m.writes.push(typeof data==='string' ? data : await data.text());
          },async close(){
            if(m.mode==='close-fail') throw new Error('Intentional config close failure'); m.closed++;
          },async abort(){}};
        }};
        Object.defineProperty(window,'showSaveFilePicker',{configurable:true,writable:true,value:async options=>{
          m.pickerCalls.push(options);
          if(m.mode==='picker-cancel') throw new DOMException('Intentional picker cancellation','AbortError');
          if(m.mode==='picker-fail') throw new Error('Intentional config picker failure');
          return window.__configFakeHandle;
        }});
        aiState.configHandle=null;
        window.SVG_TWEAK_AI_CONFIG={...window.SVG_TWEAK_AI_CONFIG,apiKey:${JSON.stringify(SAVE_MOCK_KEY)}};
        $('aiBaseURL').value=${JSON.stringify('  ' + draftConfig.baseURL + '  ')};
        $('aiModel').value=${JSON.stringify('  ' + draftConfig.model + '  ')}; $('aiKey').value='';
      })()`);
      try {
        const saveInputsBefore = await evalJS('["aiBaseURL","aiModel","aiKey"].map(id=>$(id).value)');
        // Saving is a purely local operation: even an untested, incomplete URL
        // draft is valid, and quoted/backslashed/multiline values must round-trip.
        await evalJS('(async () => { await aiSaveConfig(); })()');
        const firstSave = await evalJS(`({calls:__configSaveMock.pickerCalls,writes:__configSaveMock.writes,closed:__configSaveMock.closed,
          sameHandle:aiState.configHandle===window.__configFakeHandle,saving:aiState.savingConfig,file:window.SVG_TWEAK_AI_CONFIG,
          inputs:['aiBaseURL','aiModel','aiKey'].map(id=>$(id).value),status:$('aiStatus').textContent})`);
        assert.equal(firstSave.calls.length, 1);
        assert.equal(firstSave.calls[0].suggestedName, 'ai-config.js');
        assert.equal(firstSave.closed, 1);
        assert.equal(firstSave.sameHandle, true);
        assert.equal(firstSave.saving, false);
        assert.deepEqual(configFromScript(firstSave.writes[0]), draftConfig, 'saved JavaScript must reliably escape config values');
        assert.deepEqual(firstSave.file, draftConfig, 'successful file write updates this page\'s file fallback');
        assert.deepEqual(firstSave.inputs, saveInputsBefore, 'saving must not fill or rewrite web inputs');
        assert.match(firstSave.status, /保存|写入/);
        assert.deepEqual(await connectionState(), saveEditorBase);

        await evalJS('$("aiSaveConfig").click()');
        await waitFor('__configSaveMock.closed === 2 && !aiState.savingConfig', 'save config button reuses its handle');
        assert.equal(await evalJS('__configSaveMock.pickerCalls.length'), 1, 'subsequent saves must reuse the selected in-memory handle');
        await evalJS(`$('aiModel').value=''; $('aiBaseURL').value='';`);
        assert.deepEqual(await evalJS('aiGetConfig()'), draftConfig, 'cleared web fields use the newly saved file fallback');

        const writesBeforeHold = await evalJS('__configSaveMock.writeStarted');
        await evalJS('__configSaveMock.mode="hold-write"; void aiSaveConfig()');
        await waitFor('__configSaveMock.releaseWrite && aiState.savingConfig', 'held local configuration write');
        assert.equal(await evalJS('$("aiSaveConfig").disabled && !aiState.busy && aiState.controller === null'), true, 'config saving needs its own lock, not AI request busy state');
        await evalJS('(async () => { await aiSaveConfig(); })()');
        assert.equal(await evalJS('__configSaveMock.writeStarted'), writesBeforeHold + 1, 'a second save must not overlap a pending write');
        await evalJS('__configSaveMock.releaseWrite()');
        await waitFor('!aiState.savingConfig', 'held config save completes');
        assert.equal(await evalJS('__configSaveMock.closed'), 3);
        passed.push('local draft config save round-trips escaped values, updates fallback only after close, reuses its picker handle and prevents concurrent writes');

        for (const mode of ['picker-cancel','picker-fail','create-fail','write-fail','close-fail']) {
          const result = await evalJS(`(async () => {
            __configSaveMock.mode=${JSON.stringify(mode)};
            aiState.configHandle=${mode.startsWith('picker') ? 'null' : 'window.__configFakeHandle'};
            $('aiModel').value='must not become the saved fallback';
            await aiSaveConfig();
            return {saving:aiState.savingConfig,disabled:$('aiSaveConfig').disabled,file:window.SVG_TWEAK_AI_CONFIG,status:$('aiStatus').textContent};
          })()`);
          assert.equal(result.saving, false, mode + ': save lock must be released');
          assert.equal(result.disabled, false, mode + ': save must be retryable');
          assert.deepEqual(result.file, draftConfig, mode + ': an incomplete write must not update file fallback');
          assert.match(result.status, mode==='picker-cancel' ? /取消|未保存|停止/ : /失败|错误|failure/i);
          assert.deepEqual(await connectionState(), saveEditorBase, mode + ': saving must not change editor state');
        }
        passed.push('config picker cancellation and picker/create/write/close failures report clearly, release the lock and retain the previous fallback/editor state');

        const downloadConfig = {baseURL:'download-only offline draft',model:'download "model"',apiKey:'download-only-dummy-key'};
        const downloaded = await evalJS(`(async () => {
          const create=URL.createObjectURL,revoke=URL.revokeObjectURL,click=HTMLAnchorElement.prototype.click;
          const blobs=[],clicks=[],urls=[];
          URL.createObjectURL=function(blob){const url=create.call(this,blob);blobs.push(blob);urls.push(url);return url;};
          HTMLAnchorElement.prototype.click=function(){clicks.push({name:this.download,href:this.href});};
          try {
            window.showSaveFilePicker=undefined; aiState.configHandle=null; __configSaveMock.mode='ok';
            $('aiBaseURL').value=${JSON.stringify(downloadConfig.baseURL)}; $('aiModel').value=${JSON.stringify(downloadConfig.model)};
            $('aiKey').value=${JSON.stringify(downloadConfig.apiKey)};
            await aiSaveConfig();
            return {source:await blobs[0]?.text(),clicks,file:window.SVG_TWEAK_AI_CONFIG,status:$('aiStatus').textContent,saving:aiState.savingConfig};
          } finally {
            URL.createObjectURL=create; HTMLAnchorElement.prototype.click=click;
            urls.forEach(url=>revoke.call(URL,url));
          }
        })()`);
        assert.equal(downloaded.clicks.length, 1);
        assert.equal(downloaded.clicks[0].name, 'ai-config.js');
        assert.deepEqual(configFromScript(downloaded.source), downloadConfig);
        assert.deepEqual(downloaded.file, draftConfig, 'a download is not a confirmed file write and must not update file fallback');
        assert.equal(downloaded.saving, false);
        assert.match(downloaded.status, /下载/);
        assert.match(downloaded.status, /同.*目录|同.*文件夹|网页.*目录|html.*目录/i);
        assert.match(downloaded.status, /刷新/);
        assert.doesNotMatch(downloaded.status, /已保存|已写入/);
        assert.deepEqual(await connectionState(), saveEditorBase);
        assert.equal(mock.requests.length, saveRequestCount, 'saving config must not make an API request');
        assert.equal(await evalJS(`JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes('save-only-dummy-') || JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(downloadConfig.apiKey)})`), false, 'saved/downloaded keys must never enter web storage');
        assert.equal(await evalJS(`$('aiConfigSource').textContent.includes(${JSON.stringify(SAVE_MOCK_KEY)}) || $('aiConfigSource').textContent.includes(${JSON.stringify(downloadConfig.apiKey)})`), false);
        passed.push('unsupported picker downloads correctly named JavaScript with placement/refresh instructions, without pretending it saved or updating fallback/storage/API/editor state');
      } finally {
        await evalJS(`(() => {
          const original=window.__configSaveOriginal;
          if(original.picker) Object.defineProperty(window,'showSaveFilePicker',original.picker); else delete window.showSaveFilePicker;
          aiState.configHandle=original.handle;
          window.SVG_TWEAK_AI_CONFIG=${JSON.stringify(fileConfig)};
          ['aiBaseURL','aiModel','aiKey'].forEach((id,i)=>$(id).value=original.inputs[i]);
          aiUpdateConfigHint();
        })()`);
      }

      // A connection check is useful even before any SVG has been opened.
      await evalJS('$("aiPrompt").value="Keep this draft during a connection check"');
      assert.equal(await evalJS('doc.children.length'), 0, 'connection test should run with no loaded document');
      const emptyConnectionBase = await connectionState();
      const connectionOK = mock.enqueue('OK');
      await evalJS('$("aiTest").click()');
      const connectionRequest = await waitForRequest(connectionOK);
      await waitFor('!aiState.busy', 'successful connection test');
      checkConnectionPayload(connectionRequest);
      assert.equal(connectionRequest.authorization, 'Bearer ' + FILE_MOCK_KEY);
      assert.equal(connectionRequest.body.model, 'file-svg-model');
      assert.match(await evalJS('$("aiStatus").textContent'), /成功|OK|可用/);
      assert.deepEqual(await connectionState(), emptyConnectionBase, 'connection success must not touch document, undo, pending, chat or draft');
      const connectionFailed = mock.enqueue('unused', {status:500});
      await evalJS('void aiTestConnection()');
      checkConnectionPayload(await waitForRequest(connectionFailed));
      await waitFor('!aiState.busy', 'failed connection test');
      assert.match(await evalJS('$("aiStatus").textContent'), /500|失败|错误/);
      assert.deepEqual(await connectionState(), emptyConnectionBase);
      const connectionCancelled = mock.enqueue('OK', {hold:true});
      await evalJS('void aiTestConnection()');
      checkConnectionPayload(await waitForRequest(connectionCancelled));
      assert.deepEqual(await evalJS('({kind:aiState.busyKind,progressHidden:$("aiProgress").hidden,testDisabled:$("aiTest").disabled})'), {kind:'connection',progressHidden:true,testDisabled:true});
      await evalJS('$("aiCancel").click()');
      await waitFor('!aiState.busy', 'cancelled connection test');
      connectionCancelled.release();
      assert.match(await evalJS('$("aiStatus").textContent'), /停止|取消/);
      assert.deepEqual(await connectionState(), emptyConnectionBase);
      assert.equal(await evalJS('aiState.controller === null && aiState.progressTimer === null'), true);
      passed.push('minimal text-only connection checks before opening SVG: success, HTTP failure, cancellation and unchanged editor/chat');

      await evalJS(`(() => {
        $('aiBaseURL').value = ${JSON.stringify(mock.url)};
        $('aiModel').value = 'mock-svg-model'; $('aiKey').value = ${JSON.stringify(MOCK_KEY)};
        for (const id of ['aiBaseURL','aiModel','aiKey']) $(id).dispatchEvent(new Event('change'));
        window.__aiTestHandle = { name:'ai-test.svg', kind:'file' };
      })()`);
      assert.equal(await evalJS('$("aiKey").type'), 'password');
      await prepare('Keep generation pending to inspect its real progress UI');
      const progressHeld = mock.enqueue(moveBox, {hold:true});
      await evalJS('void aiSend()');
      await waitForRequest(progressHeld);
      const progress = await evalJS(`(() => {
        const box=$('aiProgress').getBoundingClientRect(),bar=$('aiProgressBar');
        return {visible:!$('aiProgress').hidden && box.width>0 && box.height>0,kind:aiState.busyKind,
          native:bar.tagName,hasValue:bar.hasAttribute('value'),indeterminate:bar.matches(':indeterminate'),
          label:$('aiProgressLabel').textContent,timer:aiState.progressTimer!==null,started:aiState.startedAt>0};
      })()`);
      assert.equal(progress.visible, true);
      assert.equal(progress.kind, 'generation');
      assert.equal(progress.native, 'PROGRESS');
      assert.equal(progress.hasValue, false, 'unknown network progress must not display a fabricated percentage');
      assert.equal(progress.indeterminate, true);
      assert.equal(progress.timer, true);
      assert.equal(progress.started, true);
      assert.match(progress.label, /等待|返回|AI/);
      await waitFor('Number($("aiElapsed").textContent.match(/\\d+/)?.[0]) >= 1', 'generation elapsed time advances');
      await evalJS('$("aiCancel").click()');
      await waitFor('!aiState.busy', 'generation progress cancellation');
      progressHeld.release();
      assert.deepEqual(await evalJS('({hidden:$("aiProgress").hidden,timer:aiState.progressTimer,kind:aiState.busyKind})'), {hidden:true,timer:null,kind:''});
      const stoppedElapsed = await evalJS('$("aiElapsed").textContent');
      await delay(1100);
      assert.equal(await evalJS('$("aiElapsed").textContent'), stoppedElapsed, 'cancelled generation must stop its elapsed-time interval');
      passed.push('held generation shows native indeterminate progress, meaningful phase and advancing time; cancellation hides and stops it');

      await prepare();
      const before = await evalJS(`(() => {
        pushUndo(); doc.querySelector('#box').setAttribute('x','31'); doc.querySelector('#label').textContent = 'Manual label'; markDirty();
        window.__aiTestBase = snapshot(); window.__aiTestUndoCount = state.undo.length;
        window.__aiTestZoom = state.zoom;
        return snapshot();
      })()`);
      const mixed = await submit(context => ({ summary:'Move, restyle and extend the selected module', operations:[
        { op:'move', targets:[keyFor(context, 'box')], dx:12, dy:7 },
        { op:'style', targets:[keyFor(context, 'box')], properties:{ fill:'#3366ff' } },
        { op:'text', target:keyFor(context, 'label'), value:'AI label' },
        { op:'insert', target:keyFor(context, 'scope'), position:'append', svg:'<circle id="added" cx="60" cy="75" r="4" fill="red"/>' }
      ] }));
      assert.equal(mixed.result.busy, false);
      assert.equal(mixed.result.pending, true, mixed.result.status);
      const request = await waitForRequest(mixed.entry);
      assert.equal(request.path, '/v1/chat/completions');
      assert.equal(request.origin, 'null');
      assert.equal(request.authorization, 'Bearer ' + MOCK_KEY);
      assert.equal(request.body.model, 'mock-svg-model');
      assert.equal(request.context.scope, 'selection');
      assert(request.context.selectedKeys.includes(keyFor(request.context, 'scope')));
      assert(request.context.xml.includes('Manual label'), 'request must include the latest manual text');
      assert(request.context.xml.includes('x="31"'), 'request must include the latest manual position');
      assert(request.context.index, 'request should contain the element index');
      assert.equal(await evalJS('$("aiPrompt").value'),'Adjust the selected module','a successful generation must retain the submitted draft');
      assert.equal(await evalJS('snapshot()'), before, 'preview must not mutate the working SVG');
      assert.equal(await evalJS('$("aiProgress").hidden && aiState.progressTimer === null'), true, 'completed generation must clear progress timing');
      const previewReady = (id, text) => `(() => {
        const frame=$(${JSON.stringify(id)}),d=frame.contentDocument;
        return d?.documentElement?.dataset.aiPreviewSerial===String(aiState.previewSerial) && frame.style.visibility!=='hidden' && d.querySelector('#label')?.textContent===${JSON.stringify(text)};
      })()`;
      await waitFor(previewReady('aiPreviewLeftFrame', 'Manual label'), 'split before preview');
      await waitFor(previewReady('aiPreviewRightFrame', 'AI label'), 'split after preview');
      assert.deepEqual(await evalJS(`(() => {
        const left=$('aiPreviewLeftFrame'),right=$('aiPreviewRightFrame');
        return {mode:aiState.previewMode,splitHidden:$('aiPreviewSplitView').hidden,singleHidden:$('aiPreviewFrame').hidden,
          beforeAdded:!!left.contentDocument.querySelector('#added'),afterAdded:!!right.contentDocument.querySelector('#added'),
          beforeX:left.contentDocument.querySelector('#box').getAttribute('x'),afterFill:right.contentWindow.getComputedStyle(right.contentDocument.querySelector('#box')).fill,
          leftFirst:left.getBoundingClientRect().x<right.getBoundingClientRect().x};
      })()`), {mode:'split',splitHidden:false,singleHidden:true,beforeAdded:false,afterAdded:true,beforeX:'31',afterFill:'rgb(51, 102, 255)',leftFirst:true});
      await evalJS('$("aiPreviewBefore").click()');
      await waitFor(previewReady('aiPreviewFrame', 'Manual label'), 'single before button');
      assert.deepEqual(await evalJS('({mode:aiState.previewMode,splitHidden:$("aiPreviewSplitView").hidden,singleHidden:$("aiPreviewFrame").hidden})'), {mode:'before',splitHidden:true,singleHidden:false});
      await evalJS('aiShowPreview(true)');
      await waitFor(previewReady('aiPreviewFrame', 'AI label'), 'legacy true after preview');
      assert.equal(await evalJS('aiState.previewMode'), 'after');
      await evalJS('aiShowPreview(false)');
      await waitFor(previewReady('aiPreviewFrame', 'Manual label'), 'legacy false before preview');
      await evalJS('$("aiPreviewAfter").click()');
      await waitFor(previewReady('aiPreviewFrame', 'AI label'), 'single after button');
      await evalJS('$("aiPreviewSplit").click()');
      await waitFor(previewReady('aiPreviewLeftFrame', 'Manual label'), 'return to split before');
      await waitFor(previewReady('aiPreviewRightFrame', 'AI label'), 'return to split after');
      assert.equal(await evalJS('snapshot()'), before, 'switching split/single preview modes must never touch the working SVG');
      passed.push('default split preview has independent before/after content; single buttons and legacy booleans preserve the original document');

      const pendingConnectionBase = await connectionState();
      const pendingConnection = mock.enqueue('OK');
      await evalJS('$("aiTest").click()');
      const pendingConnectionRequest = await waitForRequest(pendingConnection);
      await waitFor('!aiState.busy', 'connection test with a pending edit');
      checkConnectionPayload(pendingConnectionRequest);
      assert.equal(pendingConnectionRequest.authorization, 'Bearer ' + MOCK_KEY, 'web key must override the file key for connection tests');
      assert.equal(pendingConnectionRequest.body.model, 'mock-svg-model');
      assert.deepEqual(await connectionState(), pendingConnectionBase, 'connection test must retain an existing candidate, nonempty history and undo stack');
      passed.push('connection test uses web overrides while preserving an existing edit candidate, chat and undo history');

      const pendingSaveBase = await connectionState(), pendingSaveRequests = mock.requests.length;
      const pendingSaveConfig = await evalJS('aiGetConfig()');
      await evalJS(`(() => {
        window.__pendingSaveOriginal={handle:aiState.configHandle,file:window.SVG_TWEAK_AI_CONFIG};
        window.__pendingSaveSource=null;
        aiState.configHandle={kind:'file',name:'ai-config.js',async createWritable(){return {
          async write(source){window.__pendingSaveSource=source;},async close(){},async abort(){}
        };}};
        $('aiSaveConfig').click();
      })()`);
      try {
        await waitFor('typeof window.__pendingSaveSource === "string" && !aiState.savingConfig', 'save configuration with an existing edit candidate');
        assert.deepEqual(configFromScript(await evalJS('window.__pendingSaveSource')), pendingSaveConfig);
        assert.deepEqual(await connectionState(), pendingSaveBase, 'saving connection settings must preserve pending SVG, nonempty chat, undo/redo and draft');
        assert.equal(mock.requests.length, pendingSaveRequests, 'saving settings must not call the API even with an edit pending');
      } finally {
        await evalJS('aiState.configHandle=__pendingSaveOriginal.handle; window.SVG_TWEAK_AI_CONFIG=__pendingSaveOriginal.file; aiUpdateConfigHint()');
      }
      passed.push('save-config button writes current effective settings without changing an existing candidate, SVG, chat, undo/redo or making API requests');

      const applied = await evalJS(`(() => {
        $('aiUseAfter').click();
        const box = bboxInRoot(doc.querySelector('#box'));
        const result = { x:round(box.x), y:round(box.y), fill:getComputedStyle(doc.querySelector('#box')).fill, text:doc.querySelector('#label').textContent, added:!!doc.querySelector('#added'), sameHandle:state.fileHandle === window.__aiTestHandle, name:state.fileName, sameZoom:state.zoom === window.__aiTestZoom, oneUndo:state.undo.length === window.__aiTestUndoCount + 1, cleanExport:!buildSVGString().includes('data-ai-key') };
        const same = (a,b) => new DOMParser().parseFromString(a,'image/svg+xml').documentElement.isEqualNode(new DOMParser().parseFromString(b,'image/svg+xml').documentElement);
        const after = snapshot(); undo(); result.undoMatches = same(snapshot(),window.__aiTestBase); redo(); result.redoMatches = same(snapshot(),after);
        return result;
      })()`);
      assert.deepEqual(applied, { x:43,y:17,fill:'rgb(51, 102, 255)',text:'AI label',added:true,sameHandle:true,name:'ai-test.svg',sameZoom:true,oneUndo:true,cleanExport:true,undoMatches:true,redoMatches:true });
      assert.equal(await evalJS(`JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(MOCK_KEY)})`), false, 'API key must not be persisted');
      passed.push('latest live-canvas context, retained draft, preview adoption/undo/redo, file association and no leaked keys');

      await prepare();
      const scopedBase = await evalJS('snapshot()');
      const outside = await submit(context => ({ summary:'Out-of-scope change', operations:[{ op:'style', targets:[keyFor(context,'outside')], properties:{ fill:'red' } }] }));
      assert.equal(outside.result.pending, false, 'an out-of-scope plan must be rejected as a whole');
      assert.equal(await evalJS('snapshot()'), scopedBase);
      const ready = await submit(moveBox);
      assert.equal(ready.result.pending, true, ready.result.status);
      const scopedVersions = await evalJS('aiState.versions.map(v=>v.id)');
      await evalJS('aiHidePreview()');
      assert.equal(await evalJS('snapshot()'), scopedBase);
      assert.deepEqual(await evalJS('aiState.versions.map(v=>v.id)'),scopedVersions,'closing a preview must retain its saved candidate');
      assert.equal(await evalJS('$("aiPreview").hidden'), true);
      passed.push('selection boundary and closing a preview without deleting its candidate');

      for (const answerOnly of [true, false]) {
        await prepare(answerOnly ? 'Explain the selected module' : 'Move the selected box');
        const delayed = mock.enqueue(answerOnly ? { summary:'The selected module has a box and label', operations:[] } : moveBox, { hold:true });
        await evalJS('void aiSend()'); await waitForRequest(delayed);
        const draft = answerOnly ? 'New draft while waiting for an answer' : 'New draft while waiting for a candidate';
        await setPrompt(draft); delayed.release();
        await waitFor('!aiState.busy', 'reply with a new composer draft');
        assert.equal(await evalJS('$("aiPrompt").value'), draft, 'a returning reply must not erase a new composer draft');
        assert.equal(await evalJS('!!aiState.pending'), !answerOnly);
        if (!answerOnly) await evalJS('aiHidePreview()');
      }
      await prepare('Keep this unchanged explanation draft');
      const explanation = await submit({summary:'The selected module has a box and label',operations:[]},'Keep this unchanged explanation draft');
      assert.equal(explanation.result.pending,false);
      assert.equal(await evalJS('$("aiPrompt").value'),'Keep this unchanged explanation draft','a no-operation reply must retain the original submitted draft too');
      passed.push('answer-only and candidate replies preserve submitted drafts and any newer draft typed during the request');

      await prepare('Replace the whole drawing with a wider canvas');
      await evalJS('$("aiScope").value = "document"');
      const rootPlan = await submit({ summary:'Replace the whole drawing and enlarge the canvas', operations:[{
        op:'replace', target:'root', svg:'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180" viewBox="0 0 420 180"><rect id="replacement" x="10" y="10" width="150" height="80" fill="teal"/></svg>'
      }] }, 'Replace the whole drawing with a wider canvas');
      assert.equal(rootPlan.result.pending, true, rootPlan.result.status);
      const canvasStates = await evalJS(`(() => {
        const read = () => { const vb=doc.viewBox.baseVal,box=doc.getBoundingClientRect(); return {docW:state.docW,docH:state.docH,viewBoxW:vb.width,viewBoxH:vb.height,styleW:parseFloat(doc.style.width),styleH:parseFloat(doc.style.height),renderW:box.width,renderH:box.height,zoom:state.zoom,uiScale:parseFloat(getComputedStyle(document.documentElement).zoom)||1}; };
        const before=read(); $('aiUseAfter').click(); const applied=read(); undo(); const undone=read(); redo(); const redone=read();
        return {before,applied,undone,redone};
      })()`);
      for (const [name,width,height] of [['before',240,120],['applied',420,180],['undone',240,120],['redone',420,180]]) {
        const canvas = canvasStates[name];
        assert.deepEqual([canvas.docW,canvas.docH,canvas.viewBoxW,canvas.viewBoxH], [width,height,width,height], name + ': cached canvas size must match the viewBox');
        assert(Math.abs(canvas.styleW-width*canvas.zoom)<0.01, name + ': CSS canvas width');
        assert(Math.abs(canvas.styleH-height*canvas.zoom)<0.01, name + ': CSS canvas height');
        assert(Math.abs(canvas.renderW-canvas.styleW*canvas.uiScale)<0.1, name + ': rendered canvas width');
        assert(Math.abs(canvas.renderH-canvas.styleH*canvas.uiScale)<0.1, name + ': rendered canvas height');
      }
      passed.push('document root replacement keeps viewBox, cached canvas size and displayed size consistent through apply/undo/redo');

      await prepare();
      const stalePreview = await submit(moveBox);
      assert.equal(stalePreview.result.pending, true, stalePreview.result.status);
      const manuallyChanged = await evalJS(`(() => { pushUndo(); doc.querySelector('#outside').setAttribute('x','181'); markDirty(); return snapshot(); })()`);
      const staleConfirms = await evalJS('__aiTestConfirms.length');
      await evalJS('$("aiUseAfter").click()');
      assert.equal(await evalJS('snapshot()'), manuallyChanged, 'a pending preview must not overwrite a later manual edit');
      assert.equal(await evalJS('__aiTestConfirms.length'),staleConfirms+1,'using a stale preview must require explicit overwrite confirmation');

      await prepare();
      const inFlight = mock.enqueue(moveBox, { hold:true });
      await evalJS('void aiSend()'); await waitForRequest(inFlight);
      const changedInFlight = await evalJS(`(() => { pushUndo(); doc.querySelector('#outside').setAttribute('x','182'); markDirty(); return snapshot(); })()`);
      inFlight.release(); await waitFor('!aiState.busy', 'stale request completion');
      const inFlightConfirms = await evalJS('__aiTestConfirms.length');
      await evalJS('$("aiUseAfter").click()');
      assert.equal(await evalJS('snapshot()'), changedInFlight, 'a delayed result must not overwrite a manual edit made during the request');
      assert.equal(await evalJS('__aiTestConfirms.length'),inFlightConfirms+1,'a delayed stale result must use the same confirmed-adoption path');
      passed.push('manual conflicts both during request and after preview');

      await prepare();
      const selectionOnly = mock.enqueue(moveBox, { hold:true });
      await evalJS('void aiSend()'); const frozenScope = await waitForRequest(selectionOnly);
      const zoom = await evalJS(`(() => { select([doc.querySelector('#outside')]); aiRefreshScope(); state.zoom *= 1.1; applyZoom(); return state.zoom; })()`);
      selectionOnly.release(); await waitFor('!aiState.busy', 'selection-only request completion');
      assert.equal(await evalJS('!!aiState.pending'), true, await evalJS('$("aiStatus").textContent'));
      await evalJS('$("aiUseAfter").click()');
      assert.deepEqual(await evalJS('({x:round(bboxInRoot(doc.querySelector("#box")).x),outsideX:round(bboxInRoot(doc.querySelector("#outside")).x),zoom:state.zoom})'), {x:14,outsideX:180,zoom});
      assert(frozenScope.context.selectedKeys.includes(keyFor(frozenScope.context,'scope')));
      passed.push('selection captured per request; selection/zoom changes do not create a content conflict');

      await prepare();
      const switched = mock.enqueue(moveBox, { hold:true });
      await evalJS('void aiSend()'); await waitForRequest(switched);
      assert.equal(await evalJS('!$("aiProgress").hidden && aiState.progressTimer !== null'), true);
      const newDocument = await evalJS(`(() => { loadSVGText(${JSON.stringify(NEXT_DOCUMENT)}, 'ai-test.svg'); return snapshot(); })()`);
      switched.release(); await delay(150);
      assert.equal(await evalJS('snapshot()'), newDocument);
      assert.deepEqual(await evalJS('({busy:aiState.busy,pending:aiState.pending,messages:aiState.messages.length})'), {busy:false,pending:null,messages:0});
      assert.equal(await evalJS('$("aiProgress").hidden && aiState.progressTimer === null && aiState.controller === null'), true, 'switching documents must hide progress and stop its interval/request');
      passed.push('same-name document switch clears/cancels the old session and generation progress interval');

      await prepare();
      const failed = await submit(moveBox, 'Exercise a local HTTP failure', { status:500 });
      assert.equal(failed.result.busy, false);
      assert.equal(failed.result.pending, false);
      assert.match(failed.result.status, /500|失败|错误|服务|failure/i);
      const cancelled = mock.enqueue(moveBox, { hold:true });
      await setPrompt('Cancel this local request'); await evalJS('void aiSend()'); await waitForRequest(cancelled);
      await evalJS('$("aiCancel").click()'); await waitFor('!aiState.busy', 'cancelled request'); cancelled.release();
      assert.equal(await evalJS('aiState.pending === null'), true);
      const recovered = await submit(moveBox, 'Successful request after cancellation');
      assert.equal(recovered.result.pending, true, recovered.result.status);
      await evalJS('aiHidePreview()');
      passed.push('HTTP failure and cancellation release busy state and permit another request');

      await prepare();
      const safeBase = await evalJS('snapshot()');
      const malicious = await submit(context => ({ summary:'Unsafe SVG', operations:[{ op:'insert',target:keyFor(context,'scope'),position:'append',svg:'<g onload="window.__aiInjected=1"><rect width="5" height="5"/></g>' }] }));
      assert.equal(malicious.result.pending, false, 'an SVG event handler must be rejected');
      assert.equal(await evalJS('snapshot()'), safeBase);
      assert.equal(await evalJS('typeof window.__aiInjected'), 'undefined');
      passed.push('malicious SVG is rejected without changing or executing in the document');

      await prepare();
      const secretBase = await evalJS('snapshot()');
      const echoed = await submit(context => ({ summary:'Do not echo ' + MOCK_KEY, operations:[{ op:'move',targets:[keyFor(context,'box')],dx:1,dy:1 }] }));
      assert.equal(echoed.result.pending, false, 'a valid plan that echoes the API key must be rejected');
      assert.equal(await evalJS('snapshot()'), secretBase);
      assert.equal(await evalJS(`JSON.stringify(aiState.messages).includes(${JSON.stringify(MOCK_KEY)})`), false, 'the echoed key must not enter chat history');
      assert.equal(await evalJS(`$('aiStatus').textContent.includes(${JSON.stringify(MOCK_KEY)})`), false, 'the echoed key must not enter the error status');
      const encodedKey = [...MOCK_KEY].map(character => '&#' + character.charCodeAt(0) + ';').join('');
      const encoded = await submit(context => ({ summary:'Reject a decoded secret in the fragment', operations:[{ op:'insert',target:keyFor(context,'scope'),position:'append',svg:'<text x="5" y="95">' + encodedKey + '</text>' }] }));
      assert.equal(encoded.result.pending, false, 'an entity-encoded API key in candidate SVG must be rejected');
      assert.equal(await evalJS('snapshot()'), secretBase);
      assert.equal(await evalJS(`JSON.stringify(aiState.messages).includes(${JSON.stringify(MOCK_KEY)}) || JSON.stringify(aiState.messages).includes(${JSON.stringify(encodedKey)})`), false, 'neither decoded nor entity-encoded keys may enter history');
      assert.equal(await evalJS(`$('aiStatus').textContent.includes(${JSON.stringify(MOCK_KEY)})`), false);
      passed.push('literal and SVG-entity-encoded API keys never enter candidates, chat history, status or document');

      const screenshot = await evalJS(`(async () => {
        const png = await aiScreenshot('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" fill="#ff0000"/></svg>');
        const image = new Image(); image.src = png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(image,0,0);
        return {png:png.startsWith('data:image/png;base64,'),width:canvas.width,height:canvas.height,pixel:[...context.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data]};
      })()`);
      assert.equal(screenshot.png, true);
      assert(screenshot.width > 0 && screenshot.height > 0);
      assert(screenshot.pixel[0] > 240 && screenshot.pixel[1] < 15 && screenshot.pixel[2] < 15 && screenshot.pixel[3] > 240, JSON.stringify(screenshot));
      await prepare('Inspect the selected module with the image context');
      await evalJS('$("aiVision").checked = true');
      const vision = await submit(moveBox, 'Inspect the selected module with the image context');
      assert.equal(vision.result.pending, true, vision.result.status);
      const visionRequest = await waitForRequest(vision.entry);
      assert(visionRequest.body.messages.at(-1).content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')));
      await evalJS('aiHidePreview()');
      assert.deepEqual(await evalJS('window.__auditErrors'), []);
      passed.push('PNG screenshot pixels and multimodal request image');

      await send('Page.reload'); await delay(250);
      await waitFor('document.readyState === "complete" && typeof aiSend === "function"', 'AI UI reload');
      assert.equal(await evalJS('$("aiKey").value'), '', 'API key must not survive reload');
      assert.equal(await evalJS('aiGetConfig().apiKey'), FILE_MOCK_KEY, 'an empty web key falls back to the mocked config file, not the previous web key');
      assert.equal(await evalJS(`JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(MOCK_KEY)}) || JSON.stringify({local:{...localStorage},session:{...sessionStorage}}).includes(${JSON.stringify(FILE_MOCK_KEY)})`), false);
      passed.push('web key stays empty after reload; dummy file-key fallback works without persisting either key');
    }, { url:'data:text/html,<script>function loadSVGText(){}</script>' });
  } finally {
    await mock.close();
  }
  console.log('PASS: AI UI end-to-end (' + passed.length + ' scenarios, ' + mock.requests.length + ' loopback requests)');
  for (const scenario of passed) console.log('  ' + scenario);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
