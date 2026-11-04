// Run: node tests/ai-versions.cjs (real browser, loopback mock, dummy key only).
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {withEditor} = require('./browser.cjs');

const KEY = 'svg-tweak-versions-dummy-key';
const FIXTURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 220" width="400" height="220" color="#ff0000"><g id="scope"><rect id="box" x="10" y="10" width="100" height="50" fill="currentColor"/><text id="label" x="15" y="40" font-size="16" font-family="Arial">Base</text></g><rect id="outside" x="270" y="10" width="30" height="30" fill="gray"/></svg>';
const OTHER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><text x="10" y="30">Other document</text></svg>';

function payloadOf(body) {
  const message = body.messages.filter(m => m.role === 'user').at(-1);
  const text = typeof message.content === 'string' ? message.content
    : message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  return JSON.parse(text);
}
function keyFor(context, id) {
  for (const match of context.xml.matchAll(/<[^!?/][^>]*>/g)) {
    if (!new RegExp('\\bid=["\']' + id + '["\']').test(match[0])) continue;
    const key = match[0].match(/\bdata-ai-key=(["'])(.*?)\1/);
    if (key) return key[2];
  }
  throw new Error('Mock cannot find #' + id);
}
const summary = label => 'SUMMARY_' + label + '_ONLY';
const planFor = label => context => ({summary:summary(label),operations:[
  {op:'text',target:keyFor(context, 'label'),value:label}
]});
const historyText = request => JSON.stringify(request.body.messages.slice(1, -1));

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
      const body = JSON.parse(raw), payload = payloadOf(body);
      const request = {body,payload,authorization:req.headers.authorization};
      requests.push(request);
      const entry = queue.shift();
      if (!entry) throw new Error('Unexpected version mock request');
      entry.release = () => {
        if (res.destroyed || res.writableEnded) return;
        const plan = typeof entry.plan === 'function' ? entry.plan(payload.document) : entry.plan;
        res.writeHead(entry.status || 200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(entry.status ? {error:{message:'Intentional version mock failure'}}
          : {choices:[{message:{role:'assistant',content:JSON.stringify(plan)}}]}));
      };
      entry.resolve(request);
      if (!entry.hold) entry.release();
    } catch (error) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:error.message}}));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url:'http://127.0.0.1:' + server.address().port + '/v1', requests,
    enqueue(plan, options = {}) {
      const entry = {plan,...options};
      entry.seen = new Promise(resolve => { entry.resolve = resolve; });
      queue.push(entry); return entry;
    },
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    }
  };
}
async function received(entry) {
  let timer;
  try {
    return await Promise.race([entry.seen,new Promise((_,reject) => {
      timer = setTimeout(() => reject(new Error('Version action did not reach the loopback mock')), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const mock = await createMock(), passed = [];
  try {
    await withEditor(async ({evalJS,send,delay}) => {
      async function waitFor(expression, label) {
        for (let i=0;i<100;i++) { if (await evalJS(expression)) return; await delay(30); }
        throw new Error('Timed out: ' + label);
      }
      // Never load the user's private ai-config.js, including on first navigation.
      await send('Network.enable');
      await send('Network.setBlockedURLs', {urls:['*ai-config.js*']});
      await send('Page.addScriptToEvaluateOnNewDocument', {source:
        'window.SVG_TWEAK_AI_CONFIG=' + JSON.stringify({baseURL:mock.url,model:'version-mock',apiKey:KEY}) + ';'
      });
      await send('Page.navigate', {url:pathToFileURL(path.resolve(__dirname, '..', 'svg-tweak.html')).href});
      await waitFor('document.readyState === "complete" && typeof aiSend === "function"', 'editor startup');
      const page = (fn, ...args) => evalJS('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
      assert.equal(await page(() => ['aiSelectVersion','aiAdoptVersion','aiAdoptPreview','aiSelectOriginal','aiDeleteVersion','aiCompareVersions'].every(name=>typeof window[name]==='function')),true,'version API is not ready');
      await page(() => {
        window.__versionConfirms=[]; window.__versionConfirmAnswer=false;
        window.confirm=message=>{__versionConfirms.push(message);return __versionConfirmAnswer;}; aiToggle(true);
      });
      const canvas = () => page(() => ({
        xml:snapshot(),undo:state.undo.slice(),redo:state.redo.slice(),dirty:state.dirty,
        selection:[...state.sel].map(nodePathOf),canvasVersionId:aiState.canvasVersionId
      }));
      const ids = () => page(() => aiState.versions.map(v=>v.id));
      const label = () => page(() => doc.querySelector('#label')?.textContent);
      const setPrompt = value => page(value => {$('aiPrompt').value=value;},value);
      const composer = () => page(() => ({prompt:$('aiPrompt').value,scope:$('aiScope').value}));
      const chooseScope = () => page(() => {select([doc.querySelector('#scope')]);aiRefreshScope();$('aiScope').value='selection';});
      async function prepare() {
        await page(xml => {loadSVGText(xml,'versions.svg');$('aiVision').checked=false;},FIXTURE);
        await chooseScope();
      }
      async function sameSVG(expected, message) {
        assert.equal(await page(expected => {
          const parse=s=>new DOMParser().parseFromString(s,'image/svg+xml').documentElement;
          return parse(snapshot()).isEqualNode(parse(expected));
        },expected),true,message);
      }
      async function setAnswer(answer) { await page(answer => {__versionConfirmAnswer=answer;},answer); }
      async function chat(id, text, answer) {
        if (answer !== undefined) await setAnswer(answer);
        await page((id,text) => {
          const row=$('aiMessages').querySelector('.aiMessage[data-version-id="'+id+'"]');
          [...row.querySelectorAll('button')].find(b=>b.textContent===text).click();
        },id,text);
      }
      async function useSide(side, answer = true) {
        await setAnswer(answer);
        await page(side => {$(side==='before'?'aiUseBefore':'aiUseAfter').click();},side);
      }
      async function useResult(id, answer = true) {
        await page(id => aiSelectVersion(id),id); await useSide('after',answer);
      }
      const selectCompare = (id,value) => page((id,value) => {$(id).value=String(value);$(id).dispatchEvent(new Event('change'));},id,value);
      async function generate(resultLabel, prompt) {
        const count=(await ids()).length, entry=mock.enqueue(planFor(resultLabel));
        if (prompt !== null) await setPrompt(prompt);
        const draft=await composer(), before=await canvas();
        await page(async () => {await aiSend();});
        const request=await received(entry);
        const result=await page(() => ({id:aiState.pending?.id,count:aiState.versions.length,busy:aiState.busy,status:$('aiStatus').textContent}));
        assert.equal(result.count,count+1,result.status); assert.equal(typeof result.id,'number',result.status);
        assert.equal(result.busy,false); assert.equal(request.authorization,'Bearer '+KEY);
        assert.deepEqual(await composer(),draft,'generation must preserve the current prompt and scope');
        assert.deepEqual(await canvas(),before,'generation must never adopt a result or change live selection/undo');
        return {id:result.id,request};
      }
      const frameReady = (id,text) => '(() => {const f=$('+JSON.stringify(id)+'),d=f.contentDocument;return d?.documentElement?.dataset.aiPreviewSerial===String(aiState.previewSerial) && f.style.visibility!=="hidden" && d.querySelector("#label")?.textContent==='+JSON.stringify(text)+';})()';

      // restore simulates drawing into an empty editor without using the import path.
      assert.equal(await page(() => aiState.original),null);
      await page(xml => {restore(xml);markDirty();$('aiVision').checked=false;},FIXTURE);
      await page(() => aiResetDocument());
      assert.equal(await page(() => aiState.original),null,'new chat must not capture a hand-drawn document before its first send');
      await chooseScope();
      const manualInitial=await page(() => snapshot());
      await generate('MANUAL_FIRST','MANUAL_FIRST_REQUEST');
      assert.equal(await page(() => aiState.original.xml),manualInitial,'the first send from a hand-drawn document must freeze its initial drawing');
      passed.push('a document drawn without import gets a recoverable initial snapshot on its first send');

      await page(xml => loadSVGText(xml,'blank.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"/>');
      const blankOriginal=await page(() => aiState.original.xml);
      assert.equal(blankOriginal,await page(() => snapshot()),'a successfully imported empty SVG must immediately become the original');
      assert.equal(await page(() => !doc.children.length && !$('aiOriginalBar').hidden),true,'an empty imported drawing must still expose its original entry');
      await page(() => {
        const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
        rect.setAttribute('width','20');rect.setAttribute('height','15');doc.appendChild(rect);markDirty();
      });
      assert.equal(await page(() => aiState.original.xml),blankOriginal,'drawing into an imported empty SVG must not replace its empty original');
      await page(() => aiResetDocument());
      assert.equal(await page(() => aiState.original.xml),blankOriginal,'new chat must preserve the imported empty original after later drawing');
      assert.equal(await page(() => !$('aiOriginalBar').hidden),true);

      await prepare();
      const loadedXML=await page(() => snapshot());
      assert.equal(await page(() => aiState.original.xml),loadedXML,'import must freeze the original before any AI request');
      await page(() => {pushUndo();doc.querySelector('#outside').setAttribute('x','271');markDirty();});
      const baseState=await canvas();
      const a=await generate('A','REQUEST_ROOT_ORIGINAL');
      const b=await generate('B','REQUEST_ROOT_ORIGINAL');
      assert.notEqual(a.id,b.id);
      assert.equal(await page(() => aiState.original.xml),loadedXML,'manual edits before the first generation must not redefine the imported original');
      assert.equal(a.request.payload.document.xml,b.request.payload.document.xml);
      assert.equal(a.request.payload.variation,undefined);
      assert.deepEqual(b.request.payload.variation.previous,[summary('A')]);
      assert.doesNotMatch(historyText(b.request),/SUMMARY_A_ONLY/,'a sibling candidate must not enter branch history');
      assert.equal(await page(() => {const [a,b]=aiState.versions;return a.base===b.base && a.base.parentId===null;}),true);
      assert.equal(await page(() => aiState.versions.every(v=>!('context' in v) && !('index' in v) && !('screenshot' in v) && !('context' in v.base))),true);
      passed.push('same live-canvas requests share their base and match variations without auto-adopting; imported original predates manual edits');

      const versionUI=await page(() => ({
        legacy:['aiVersions','aiPending','aiApply','aiReroll','aiContinue','aiAdopt','aiDiscard','aiSource','aiUseVersion'].filter(id=>$(id)),
        hasSourceState:'source' in aiState,originalVisible:!$('aiOriginalBar').hidden,originalButton:$('aiViewOriginal').textContent,
        adoption:['aiUseBefore','aiUseAfter'].map(id=>!!$(id) && $('aiPreview').contains($(id))),
        messages:aiState.versions.map(v=>{
          const row=$('aiMessages').querySelector('.aiMessage[data-version-id="'+v.id+'"]');
          return {id:v.id,buttons:[...row.querySelectorAll('button')].map(b=>b.textContent),menus:row.querySelectorAll('details').length};
        })
      }));
      assert.deepEqual(versionUI.legacy,[]); assert.equal(versionUI.hasSourceState,false);
      assert.equal(versionUI.originalVisible,true); assert.equal(versionUI.originalButton,'最初原图 · 查看 / 恢复');
      assert.deepEqual(versionUI.adoption,[true,true]);
      for (const message of versionUI.messages) {
        assert.deepEqual(message.buttons,['查看 / 对比','用到画布','删除']);
        assert.equal(message.menus,0,'the three chat actions must be explicit, without a hidden menu');
      }
      passed.push('chat exposes view/use/delete directly, the fixed original entry remains available and obsolete source/card/menu controls are absent');

      const viewRequests=mock.requests.length;
      await setPrompt('UNSENT_VIEW_DRAFT');
      const beforeView=await composer();
      await chat(a.id,'查看 / 对比');
      await waitFor(frameReady('aiPreviewLeftFrame','Base'),'default base frame');
      await waitFor(frameReady('aiPreviewRightFrame','A'),'default result frame');
      assert.deepEqual(await page(() => ({before:$('aiUseBefore').textContent,after:$('aiUseAfter').textContent})),
        {before:'用修改前这张',after:'用修改后这张'});
      await page(() => {$('aiPreviewBefore').click();});
      assert.deepEqual(await page(() => [!$('aiUseBefore').hidden,!$('aiUseAfter').hidden]),[true,false]);
      await page(() => {$('aiPreviewAfter').click();});
      assert.deepEqual(await page(() => [!$('aiUseBefore').hidden,!$('aiUseAfter').hidden]),[false,true]);
      await page(() => {$('aiPreviewSplit').click();});
      await selectCompare('aiCompareLeft',a.id); await selectCompare('aiCompareRight',b.id);
      await waitFor(frameReady('aiPreviewLeftFrame','A'),'left A comparison');
      await waitFor(frameReady('aiPreviewRightFrame','B'),'right B comparison');
      assert.equal(await page(() => aiState.pending.id),b.id);
      assert.deepEqual(await page(() => ({before:$('aiUseBefore').textContent,after:$('aiUseAfter').textContent})),
        {before:'用左侧这张',after:'用右侧这张'});
      for (const id of ['aiCompareLeft','aiCompareRight']) {
        assert.equal(await page(id => ['base','original','canvas'].every(value=>[...$(id).options].some(o=>o.value===value)),id),true);
      }
      await page(() => aiShowPreview(false)); await waitFor(frameReady('aiPreviewFrame','A'),'single before keeps selected left A');
      await page(() => aiShowPreview(true)); await waitFor(frameReady('aiPreviewFrame','B'),'single after keeps selected right B');
      await page(() => aiHidePreview());
      assert.deepEqual(await canvas(),baseState); assert.deepEqual(await composer(),beforeView);
      assert.deepEqual(await ids(),[a.id,b.id]); assert.equal(mock.requests.length,viewRequests);
      passed.push('default and arbitrary A/B comparisons use explicit before/after controls; single modes keep selected sides and viewing never changes canvas/draft');

      await page((a,b) => aiCompareVersions(a,b),a.id,b.id);
      const beforeUseLeft=await page(() => state.undo.length);
      await useSide('before');
      assert.equal(await label(),'A','using the left side must adopt A, not pending B or B base');
      assert.equal(await page(() => state.undo.length),beforeUseLeft+1);
      await page(() => undo()); await sameSVG(baseState.xml,'left-side adoption must be one undo');
      await page(id => aiSelectVersion(id),a.id);
      await selectCompare('aiCompareRight','original');
      await waitFor(frameReady('aiPreviewRightFrame','Base'),'original selected on the right');
      await useSide('after'); await sameSVG(loadedXML,'right-side original must not apply the pending result');
      await page(() => undo()); await sameSVG(baseState.xml,'restoring right-side original must be one undo');
      await page(id => aiSelectVersion(id),a.id);
      await selectCompare('aiCompareRight','canvas');
      const displayedCanvas=await page(() => snapshot());
      await waitFor(frameReady('aiPreviewRightFrame','Base'),'canvas selected on the right');
      await page(() => {pushUndo();doc.querySelector('#outside').setAttribute('x','278');markDirty();});
      const laterManual=await canvas();
      await useSide('after',false); assert.deepEqual(await canvas(),laterManual);
      await useSide('after',true); await sameSVG(displayedCanvas,'adoption must use the actually previewed canvas snapshot, not a newer live snapshot');
      await page(() => {undo();undo();}); await sameSVG(baseState.xml,'both real canvas changes remain individually undoable');
      passed.push('before/after adopt the actual displayed candidate/original/canvas snapshot; conflicts confirm and each real change is one undo');

      await page(() => {select([doc.querySelector('#outside')]);state.dirty=false;});
      await page(id => aiSelectVersion(id),a.id);
      const noOpBase=await canvas(), noOpConfirms=await page(() => __versionConfirms.length);
      await useSide('before');
      assert.deepEqual(await canvas(),noOpBase,'using an equivalent base must preserve redo, dirty, selection and branch marker exactly');
      assert.equal(await page(() => __versionConfirms.length),noOpConfirms);
      assert.equal(await page(() => $('aiPreview').hidden),true);
      await useResult(a.id); assert.equal(await label(),'A');
      await page(() => undo()); await sameSVG(baseState.xml,'undo A restores equivalent XML regardless of xmlns order');
      const beforeBConfirms=await page(() => __versionConfirms.length);
      await useResult(b.id,false); assert.equal(await label(),'B');
      assert.equal(await page(() => __versionConfirms.length),beforeBConfirms,'equivalent XML after undo must not cause a false conflict');
      await page(() => {select([doc.querySelector('#outside')]);state.dirty=false;});
      const noOpResult=await canvas();
      await chat(b.id,'用到画布',false);
      assert.deepEqual(await canvas(),noOpResult,'direct chat use of the live result must be a complete no-op');
      passed.push('equivalent preview/chat use preserves every editor field and redo; real use is undoable and ignores only XML attribute ordering');

      await chooseScope();
      const c=await generate('C','REQUEST_BRANCH_B_CHILD');
      assert.equal(await page(id => aiVersion(id).base.parentId,c.id),b.id);
      assert.match(historyText(c.request),/SUMMARY_B_ONLY/); assert.doesNotMatch(historyText(c.request),/SUMMARY_A_ONLY/);
      assert.equal(await label(),'B');
      await chat(a.id,'用到画布',true); assert.equal(await label(),'A');
      await chooseScope();
      const d=await generate('D','REQUEST_BRANCH_A_CHILD');
      assert.equal(await page(id => aiVersion(id).base.parentId,d.id),a.id);
      assert.match(historyText(d.request),/SUMMARY_A_ONLY/);
      assert.doesNotMatch(historyText(d.request),/SUMMARY_B_ONLY|SUMMARY_C_ONLY|REQUEST_BRANCH_B_CHILD/);
      passed.push('continuing a branch means using its chat result first; the next send reads that live canvas and only its ancestor history');

      await page(() => {pushUndo();doc.querySelector('#outside').setAttribute('x','275');markDirty();});
      const conflictBase=await canvas(), conflictConfirms=await page(() => __versionConfirms.length);
      await chat(d.id,'用到画布',false);
      assert.deepEqual(await canvas(),conflictBase);
      assert.equal(await page(() => __versionConfirms.length),conflictConfirms+1);
      await chat(d.id,'用到画布',true);
      assert.equal(await label(),'D'); assert.equal(await page(() => state.undo.length),conflictBase.undo.length+1);
      await page(() => undo()); await sameSVG(conflictBase.xml,'undo direct chat use restores later manual edits');
      await page(() => redo());
      assert.deepEqual(await ids(),[a.id,b.id,c.id,d.id]);
      passed.push('direct chat use shares overwrite confirmation, preserves cancelled manual edits, adds one undo and retains later branches');

      await page((a,d) => aiCompareVersions(a,d),a.id,d.id);
      const beforeDelete=await canvas(), deleteRequests=mock.requests.length;
      await chat(a.id,'删除',false); assert.deepEqual(await ids(),[a.id,b.id,c.id,d.id]);
      await chat(a.id,'删除',true); assert.deepEqual(await ids(),[b.id,c.id,d.id]);
      assert.deepEqual(await canvas(),beforeDelete);
      assert.equal(await page(id => aiState.messages.find(m=>m.role==='assistant' && m.versionId===id).status,a.id),'结果已删除');
      assert.equal(await page(id => new DOMParser().parseFromString(aiVersion(id).base.xml,'image/svg+xml').querySelector('#label').textContent,d.id),'A');
      assert.equal(await page(() => aiState.original.xml),loadedXML,'deleting candidates must not release the independent original');
      await chat(b.id,'用到画布',true); await chat(d.id,'用到画布',true); assert.equal(await label(),'D');
      await chat(c.id,'查看 / 对比'); await chat(c.id,'删除',true);
      assert.equal(await page(() => $('aiPreview').hidden),true,'deleting the viewed result must close its preview');
      assert.equal(mock.requests.length,deleteRequests);
      passed.push('deletion confirms without editing the canvas; descendants remain restorable and the independent original is never a deletable candidate');

      await chooseScope();
      const frozen=await page(() => aiDocumentContext(snapshot(),[...state.sel].map(nodePathOf)));
      await chat(b.id,'查看 / 对比'); await setPrompt('LIVE_RETRY_REQUEST');
      const held=mock.enqueue(planFor('R'),{hold:true}), retryCount=(await ids()).length;
      await page(() => {void aiSend();});
      const retryRequest=await received(held);
      assert.equal(retryRequest.payload.request,'LIVE_RETRY_REQUEST');
      assert.equal(retryRequest.payload.document.xml,frozen.xml,'viewing an old B must not make it the next generation source');
      assert.deepEqual(retryRequest.payload.document.selectedKeys,frozen.selectedKeys);
      assert.match(retryRequest.payload.document.xml,/>D<\/text>/);
      await page(() => {pushUndo();doc.querySelector('#outside').setAttribute('x','279');markDirty();select([doc.querySelector('#outside')]);aiRefreshScope();});
      await setPrompt('NEW_DRAFT_WHILE_GENERATING');
      const duringRequest=await canvas(), nextDraft=await composer();
      held.release(); await waitFor('!aiState.busy','live request settles');
      assert.equal((await ids()).length,retryCount+1);
      assert.deepEqual(await canvas(),duringRequest); assert.deepEqual(await composer(),nextDraft);
      const r=await page(() => aiState.pending.id);
      await useResult(r,false); assert.deepEqual(await canvas(),duringRequest);
      await chooseScope();
      const r2=await generate('R2','LIVE_RETRY_REQUEST');
      assert.match(r2.request.payload.document.xml,/x="279"/,'a new send must use newer live manual edits, not the previous frozen base');
      assert.equal(r2.request.payload.variation,undefined,'the same prompt on a changed live base is not a repeat of the old request');
      assert.equal(await page((r,r2) => aiVersion(r).base!==aiVersion(r2).base,r,r2.id),true);
      const r3=await generate('R3','EDITED_LIVE_REQUIREMENT');
      assert.equal(r3.request.payload.request,'EDITED_LIVE_REQUIREMENT'); assert.equal(r3.request.payload.variation,undefined);
      assert.equal(await page((a,b) => aiVersion(a).base===aiVersion(b).base,r2.id,r3.id),true);
      passed.push('every send freezes the current canvas/selection and current draft, not the viewed version; newer live edits/drafts survive replies and feed the next send');

      const retained=await ids(), beforeFailure=await canvas();
      const cancelled=mock.enqueue(planFor('CANCELLED'),{hold:true});
      await setPrompt('CANCELLED_TURN_MUST_NOT_BECOME_HISTORY');
      await page(() => {void aiSend();}); await received(cancelled);
      await page(() => {$('aiCancel').click();}); await waitFor('!aiState.busy','cancelled request'); cancelled.release();
      assert.deepEqual(await ids(),retained); assert.deepEqual(await canvas(),beforeFailure);
      const failed=mock.enqueue(planFor('FAILED'),{status:500});
      await setPrompt('FAILED_TURN_MUST_NOT_BECOME_HISTORY'); await page(async () => {await aiSend();}); await received(failed);
      assert.deepEqual(await ids(),retained); assert.deepEqual(await canvas(),beforeFailure);
      const recovered=await generate('RECOVERED','RECOVERED_REQUEST');
      assert.doesNotMatch(historyText(recovered.request),/CANCELLED_TURN_MUST_NOT|FAILED_TURN_MUST_NOT/);
      passed.push('cancel/HTTP failure preserve all versions and canvas and do not pollute later branch history');

      const beforeClear=await canvas(), beforeClearIds=await ids(), savedOriginal=await page(() => aiState.original.xml);
      const clearHeld=mock.enqueue(planFor('OLD_CHAT_REPLY'),{hold:true});
      await setPrompt('PENDING_BEFORE_NEW_CHAT'); await page(() => {void aiSend();}); await received(clearHeld);
      await setAnswer(false); await page(() => {$('aiClearChat').click();});
      assert.deepEqual(await ids(),beforeClearIds); assert.equal(await page(() => aiState.busy),true);
      await setAnswer(true); await page(() => {$('aiClearChat').click();});
      clearHeld.release(); await delay(100);
      assert.deepEqual(await page(() => ({versions:aiState.versions.length,messages:aiState.messages.length,pending:aiState.pending,busy:aiState.busy,controller:aiState.controller,timer:aiState.progressTimer})),
        {versions:0,messages:0,pending:null,busy:false,controller:null,timer:null});
      assert.deepEqual(await canvas(),{...beforeClear,canvasVersionId:null}); assert.equal(await page(() => aiState.original.xml),savedOriginal);
      assert.equal(await page(() => aiVersionBytes()),savedOriginal.length*2,'new chat must retain and budget the original even with no candidate history');
      const rememberedMode=await page(() => aiState.previewMode);
      await page(() => {$('aiViewOriginal').click();});
      assert.equal(await page(() => aiState.pending),null); assert.equal(await page(() => $('aiUseBefore').textContent),'用最初原图');
      assert.deepEqual(await page(() => [!$('aiUseBefore').hidden,!$('aiUseAfter').hidden]),[true,false]);
      assert.equal(await page(() => aiState.previewMode),rememberedMode,'viewing only the original must not change the remembered candidate-preview mode');
      assert.equal(await page(() => ['aiPreviewSplit','aiPreviewBefore','aiPreviewAfter'].every(id=>$(id).hidden)),true,'the original-only preview must hide meaningless mode switches');
      await useSide('before'); await sameSVG(savedOriginal,'the fixed original entry must still restore the imported image after new chat');
      await page(() => undo()); await sameSVG(beforeClear.xml,'restoring the original after clearing chat remains undoable');
      passed.push('new chat cancels/clears only session candidates and keeps the budgeted import-time original available through its fixed restore entry');

      await chooseScope();
      await generate('BEFORE_SWITCH','BEFORE_SWITCH_REQUEST');
      const switchHeld=mock.enqueue(planFor('LATE_SWITCH_REPLY'),{hold:true});
      await page(() => {void aiSend();}); await received(switchHeld);
      const confirmations=await page(() => __versionConfirms.length);
      await page(xml => loadSVGText(xml,'versions.svg'),OTHER);
      const switchedXML=await page(() => snapshot());
      switchHeld.release(); await delay(100);
      assert.deepEqual(await page(() => ({versions:aiState.versions.length,messages:aiState.messages.length,pending:aiState.pending,busy:aiState.busy})),
        {versions:0,messages:0,pending:null,busy:false});
      assert.equal(await page(() => aiState.original.xml),switchedXML,'opening another document must replace the original snapshot too');
      assert.equal(await page(() => doc.textContent),'Other document');
      assert.equal(await page(() => __versionConfirms.length),confirmations);
      passed.push('same-name document switch updates the original, clears/cancels the old session and prevents late-result resurrection');

      await prepare();
      const historical=await generate('VISION_ORIGINAL','VISION_ORIGINAL_REQUEST');
      await page(() => {pushUndo();doc.setAttribute('color','#0000ff');doc.setAttribute('viewBox','0 0 800 440');layoutDoc();markDirty();$('aiViewOriginal').click();});
      await useSide('before');
      await chooseScope(); await page(() => {$('aiVision').checked=true;});
      const vision=await generate('VISION_ORIGINAL','VISION_ALTERNATIVE_REQUEST');
      assert.equal(vision.request.payload.document.viewBox,'0 0 400 220','after restoring the original, the next request must describe that current red 400x220 canvas');
      const imagePart=vision.request.body.messages.at(-1).content.find(part=>part.type==='image_url');
      assert(imagePart?.image_url.url.startsWith('data:image/png;base64,'));
      const png=await page(async url => {
        const image=new Image();image.src=url;await image.decode();
        const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        return {w:canvas.width,h:canvas.height,pixel:[...context.getImageData(10,10,1,1).data]};
      },imagePart.image_url.url);
      assert.deepEqual([png.w,png.h],[400,220]); assert(png.pixel[0]>240 && png.pixel[1]<15 && png.pixel[2]<15 && png.pixel[3]>240,JSON.stringify(png));
      await chat(historical.id,'用到画布',true);
      await page(() => {select([doc.querySelector('#outside')]);state.dirty=false;});
      const equivalentState=await canvas();
      await chat(vision.id,'用到画布',false);
      assert.deepEqual(await canvas(),equivalentState,'using an equivalent result with a different version id must not rewrite the live branch marker or editor state');
      passed.push('restoring the original makes its actual canvas/viewBox/red PNG the next request context; equivalent-version adoption does not rewrite branch identity');

      await prepare();
      await page(() => {pushUndo();doc.querySelector('#outside').setAttribute('x','272');markDirty();});
      await generate('BUDGET_TEMPLATE','BUDGET_TEMPLATE_REQUEST');
      const beforeLimitRequests=mock.requests.length;
      await page(() => {window.__versionLimitOriginal=aiState.versions;});
      try {
        const countLimit=await page(async () => {
          const template=__versionLimitOriginal[0];
          aiState.versions=Array.from({length:AI_VERSION_LIMIT},(_,i)=>({...template,id:10000+i}));
          $('aiPrompt').value='COUNT_LIMIT_NO_REQUEST';await aiSend();
          return {count:aiState.versions.length,limit:AI_VERSION_LIMIT,status:$('aiStatus').textContent};
        });
        assert.equal(countLimit.count,countLimit.limit); assert.match(countLimit.status,/上限|容量|清理|删除|40/);
        assert.equal(mock.requests.length,beforeLimitRequests);
        const byteLimit=await page(async () => {
          const template=__versionLimitOriginal[0],large='x'.repeat(Math.floor(AI_VERSION_BYTES/2)+1);
          aiState.versions=[{...template,id:20000,result:{xml:large,changes:[]}},{...template,id:20001,result:{xml:large,changes:[]}}];
          const bytes=aiVersionBytes(),expected=(large.length+template.base.xml.length+aiState.original.xml.length)*2;
          $('aiPrompt').value='BYTE_LIMIT_NO_REQUEST';await aiSend();
          return {bytes,expected,distinctOriginal:template.base.xml!==aiState.original.xml,limit:AI_VERSION_BYTES,count:aiState.versions.length,status:$('aiStatus').textContent};
        });
        assert.equal(byteLimit.distinctOriginal,true); assert.equal(byteLimit.bytes,byteLimit.expected,'memory accounting must include the independent original and deduplicate shared candidate strings');
        assert(byteLimit.bytes>byteLimit.limit); assert.equal(byteLimit.count,2); assert.match(byteLimit.status,/上限|容量|清理|删除|32/);
        assert.equal(mock.requests.length,beforeLimitRequests);
      } finally {await page(() => {aiState.versions=__versionLimitOriginal;delete window.__versionLimitOriginal;});}
      assert.deepEqual(await page(() => window.__auditErrors),[]);
      passed.push('count/byte budgets stop requests without eviction, include the independent original and deduplicate shared SVG strings');
    }, {url:'data:text/html,<script>function loadSVGText(){}</script>'});
  } finally { await mock.close(); }
  console.log('PASS: AI versions (' + passed.length + ' scenarios, ' + mock.requests.length + ' loopback requests)');
  for (const scenario of passed) console.log('  ' + scenario);
}
main().catch(error => { console.error(error); process.exitCode=1; });
