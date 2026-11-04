// Run: node tests/i18n.cjs (isolated profiles; in-page mock transport, no real API).
const assert = require('node:assert/strict');
const {withEditor} = require('./browser.cjs');

const LANGUAGE_KEY = 'svgtweak.language';
const CUSTOM_NAME = '我的中文元件 <not-markup>';
const BASE = '<svg id="doc" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 220" width="400" height="220"><rect id="box" x="20" y="30" width="120" height="70" fill="#8cbde5"/><text id="caption" x="30" y="65" font-size="18">原图中文不能翻译</text></svg>';
const NEXT = BASE.replace('#8cbde5', '#92cead');
const OTHER = BASE.replace('#8cbde5', '#e6ba85');

function helpers({evalJS,send,delay}) {
  const page = (fn,...args) => evalJS('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  async function waitFor(expression,label) {
    for (let i=0;i<100;i++) {
      try { if (await evalJS(expression)) return; }
      catch (error) {
        if (!/context.*destroy|Cannot find context|Inspected target navigated/i.test(error.message)) throw error;
      }
      await delay(30);
    }
    throw new Error('Timed out: '+label);
  }
  async function reload() {
    await page(()=>{window.__i18nOldDocument=true;});
    await send('Page.reload');
    await waitFor('typeof window.__i18nOldDocument === "undefined" && document.readyState === "complete" && typeof setUILanguage === "function"','language-aware reload');
  }
  const language = () => page(()=>({lang:document.documentElement.lang,value:$('uiLanguage').value}));
  async function choose(value) {
    await page(value=>{$('uiLanguage').value=value;$('uiLanguage').dispatchEvent(new Event('change',{bubbles:true}));},value);
    assert.deepEqual(await language(),{lang:value,value},'language selector must apply without a refresh');
  }
  async function framesReady() {
    await waitFor(`['aiPreviewLeftFrame','aiPreviewRightFrame'].every(id=>{const f=$(id),d=f.contentDocument;return !f.hidden && f.style.visibility!=="hidden" && d?.documentElement?.dataset.aiPreviewSerial===String(aiState.previewSerial) && !!d.querySelector('#aiPreviewContent svg');})`,'translated split preview');
  }
  return {page,waitFor,reload,language,choose,framesReady};
}

async function main() {
  const passed = [];
  await withEditor(async context=>{
    const {page,reload,language,choose,framesReady,waitFor}=helpers(context);
    assert.equal(await page(()=>typeof setUILanguage==='function' && typeof uiT==='function' && typeof uiText==='function'),true,'public i18n helpers must be available');
    assert.deepEqual(await language(),{lang:'zh-CN',value:'zh-CN'},'existing suites default to Chinese');
    const languageLabel=()=>page(()=>{
      const label=document.querySelector('label[for="uiLanguage"]'),rect=label?.getBoundingClientRect();
      return {text:label?.textContent.trim(),associated:label?.control===$('uiLanguage'),visible:!!rect&&rect.width>0&&rect.height>0&&getComputedStyle(label).visibility==='visible'};
    });
    const fixedLanguageLabel={text:'Language / 语言',associated:true,visible:true};
    assert.deepEqual(await languageLabel(),fixedLanguageLabel,'language selector has a visible, associated bilingual label');
    const staticText=()=>page(()=>({
      open:$('btnOpen').textContent.trim(),openTitle:$('btnOpen').title,
      library:$('shapeLibraryTitle').textContent.trim(),selection:$('selSec').querySelector('h4').textContent.trim(),
      namePlaceholder:$('libraryName').placeholder,nameLabel:$('libraryName').getAttribute('aria-label'),
      promptPlaceholder:$('aiPrompt').placeholder,textTitle:$('textInput').title,
      previewLabel:$('aiPreviewZoomIn').getAttribute('aria-label'),generate:$('aiSend').textContent.trim()
    }));
    const chinese=await staticText();
    assert.equal(chinese.open,'打开');assert.equal(chinese.library,'形状库');
    await choose('en');
    assert.deepEqual(await languageLabel(),fixedLanguageLabel,'English mode keeps the fixed language label visible');
    const english=await staticText();
    assert.match(english.open,/open/i);assert.match(english.library,/shape library/i);
    assert.match(english.selection,/select/i);assert.match(english.generate,/generat/i);
    for(const [key,value] of Object.entries(english)) {
      assert.ok(value,'translated '+key+' is not empty');
      assert.doesNotMatch(value,/[\u3400-\u9fff]/,'English '+key+' must not keep Chinese UI text');
    }
    await reload();
    assert.deepEqual(await language(),{lang:'en',value:'en'},'reload preserves the user choice instead of the harness seed');
    assert.deepEqual(await languageLabel(),fixedLanguageLabel,'reload keeps the fixed language label visible');
    assert.deepEqual(await staticText(),english);
    await choose('zh-CN');assert.deepEqual(await staticText(),chinese,'switching back restores labels and attributes');
    assert.deepEqual(await languageLabel(),fixedLanguageLabel,'switching back to Chinese keeps the fixed language label visible');
    passed.push('static buttons/headings/tooltips/accessibility labels/placeholders switch immediately; saved choice survives a real reload');

    await page((base,name)=>{
      window.__i18nFileHandle={name:'中文图稿.svg',kind:'file'};
      loadSVGText(base,'中文图稿.svg',__i18nFileHandle);
      aiToggle(true);toggleShapeLibrary(true);
      select([doc.querySelector('#box'),doc.querySelector('#caption')]);
      $('libraryName').value=name;
      librarySaveSelection();
      $('libraryName').value='未保存的中文元件名称';
      $('aiPrompt').value='还没有发送的中文提示词';
      $('aiBaseURL').value='https://i18n.invalid/v1';$('aiModel').value='mock-中文-model';$('aiKey').value='i18n-dummy-key';
      $('aiVision').checked=false;aiUpdateConfigHint();
      pushUndo();doc.querySelector('#box').setAttribute('rx','5');undo();
      select([doc.querySelector('#box'),doc.querySelector('#caption')]);
      markDirty(true);state.zoom=1.7;state.panX=83;state.panY=-29;applyZoom();
      $('inpDash').value='custom';$('inpDash').dispatchEvent(new Event('change'));
      $('inpDashCustom').value='13 5 2 5 ';
      window.__i18nSelection=[...state.sel];
    },BASE,CUSTOM_NAME);
    const preserved=()=>page(()=>({
      xml:snapshot(),undo:state.undo.slice(),redo:state.redo.slice(),dirty:state.dirty,
      selection:[...state.sel].map(nodePathOf),sameNodes:[...state.sel].every((el,i)=>el===__i18nSelection[i]),
      zoom:state.zoom,panX:state.panX,panY:state.panY,fileName:state.fileName,sameHandle:state.fileHandle===__i18nFileHandle,
      prompt:$('aiPrompt').value,config:['aiBaseURL','aiModel','aiKey'].map(id=>$(id).value),
      dash:{mode:$('inpDash').value,draft:$('inpDashCustom').value,display:$('rowDashCustom').style.display,visible:getComputedStyle($('rowDashCustom')).display!=='none'},
      nameDraft:$('libraryName').value,library:JSON.stringify(libraryState.items),
      messages:JSON.stringify(aiState.messages),versions:JSON.stringify(aiState.versions),
      original:aiState.original?.xml,canvasVersionId:aiState.canvasVersionId
    }));
    const stateBefore=await preserved();
    assert.equal(stateBefore.sameNodes,true);assert.equal(stateBefore.sameHandle,true);
    assert.deepEqual(stateBefore.dash,{mode:'custom',draft:'13 5 2 5 ',display:'',visible:true},'custom dash draft starts visible without being committed to the SVG');
    const dynamicText=()=>page(()=>({
      count:$('stCount').textContent,scope:$('aiScopeHint').textContent,dirty:$('stDirty').textContent,
      capacitor:$('shapeLibraryItems').querySelector('[data-shape-kind="capacitor"]').textContent.trim(),
      capacitorTitle:$('shapeLibraryItems').querySelector('[data-shape-kind="capacitor"]').title,
      custom:$('customLibraryItems').querySelector('.shapeCard span').textContent,
      customTitle:$('customLibraryItems').querySelector('.shapeCard').title,
      status:$('aiStatus').textContent,source:$('aiConfigSource').textContent
    }));
    const dynamicZH=await dynamicText();
    assert.match(dynamicZH.count,/已选 2 个对象/);assert.equal(dynamicZH.capacitor,'电容');
    await choose('en');
    const dynamicEN=await dynamicText();
    assert.match(dynamicEN.count,/2/);assert.match(dynamicEN.count,/select|object/i);
    assert.match(dynamicEN.scope,/2/);assert.match(dynamicEN.capacitor,/capacitor/i);
    for(const key of ['count','scope','dirty','capacitor','capacitorTitle','status','source']) {
      assert.ok(dynamicEN[key],'dynamic '+key+' remains visible');
      assert.doesNotMatch(dynamicEN[key],/[\u3400-\u9fff]/,'English dynamic '+key);
    }
    assert.equal(dynamicEN.custom,CUSTOM_NAME,'custom names are user content');
    assert.ok(dynamicEN.customTitle.includes(CUSTOM_NAME),'translated title keeps the custom name');
    assert.deepEqual(await preserved(),stateBefore,'language changes must not mutate SVG text/geometry, history, selection identity, drafts, file binding or canvas camera');
    await page(()=>{$('aiPrompt').value='';});
    await page(async()=>{await aiSend();});
    const emptyPrompt=await page(()=>$('aiStatus').textContent);
    assert.match(emptyPrompt,/write|tell|describ|request|change/i);assert.doesNotMatch(emptyPrompt,/[\u3400-\u9fff]/);
    const confirm=await page(()=>{
      const old=window.confirm;let text='';window.confirm=message=>{text=message;return false;};
      try{libraryRemoveShape(libraryState.items[0].id);return text;}finally{window.confirm=old;}
    });
    assert.ok(confirm.includes(CUSTOM_NAME));
    assert.match(confirm.replace(CUSTOM_NAME,''),/delete|remove/i);
    assert.doesNotMatch(confirm.replace(CUSTOM_NAME,''),/[\u3400-\u9fff]/,'confirmation translates only its surrounding UI');
    const toast=await page(()=>{
      $('libraryName').value='第二个中文元件';librarySaveSelection();return $('toast').textContent;
    });
    assert.match(toast,/第二个中文元件/);assert.match(toast.replace('第二个中文元件',''),/sav|librar/i);
    assert.doesNotMatch(toast.replace('第二个中文元件',''),/[\u3400-\u9fff]/);
    passed.push('dynamic selection/dirty/AI status, built-in names, empty-prompt errors, confirmations and toasts translate without touching Chinese document/user content');

    await page((next,other)=>{
      $('aiPrompt').value='预览时不能丢失的中文草稿';
      const source={xml:snapshot(),parentId:null};aiState.original=source;
      for(const [id,xml] of [[1,next],[2,other]]) {
        const message={role:'assistant',text:'中文候选说明 '+id,status:'待确认',versionId:id,parentId:null};
        const version={id,base:source,result:{xml,changes:[]},scope:'document',selectionPaths:[],epoch:aiState.epoch,message,request:'中文请求 '+id};
        aiState.messages.push(message);aiState.versions.push(version);
      }
      aiState.nextVersionId=3;aiRenderMessages();aiSelectVersion(1);aiShowPreview('split');
      aiState.previewView={scale:2.4,x:.12,y:-.08};aiUpdatePreviewView();
      window.__i18nUnexpectedRequests=0;
      window.__i18nOriginalFetch=window.fetch;
      window.fetch=()=>{__i18nUnexpectedRequests++;return Promise.reject(new Error('Language switching must not request the network'));};
    },NEXT,OTHER);
    await framesReady();
    const preview=()=>page(()=>({
      camera:{...aiState.previewView},mode:aiState.previewMode,pending:aiState.pending?.id,
      choices:[$('aiCompareLeft').value,$('aiCompareRight').value],
      sources:[aiState.previewSources.before.xml,aiState.previewSources.after.xml],
      frameXML:['aiPreviewLeftFrame','aiPreviewRightFrame'].map(id=>$(id).contentDocument.querySelector('#aiPreviewContent svg').outerHTML),
      // Language-dependent wrapping may resize the frame. Compare the shared
      // normalized camera, not pixel translations tied to the old frame size.
      frameViews:['aiPreviewLeftFrame','aiPreviewRightFrame'].map(id=>{
        const f=$(id),c=f.contentDocument.querySelector('#aiPreviewContent');
        const matrix=new DOMMatrix(f.contentWindow.getComputedStyle(c).transform),round=n=>Math.round(n*1e6)/1e6;
        return {scale:round(matrix.a),x:round(matrix.e/f.contentWindow.innerWidth),y:round(matrix.f/f.contentWindow.innerHeight)};
      })
    }));
    const previewBefore=await preview(),canvasBeforePreviewSwitch=await preserved();
    for(const view of previewBefore.frameViews)assert.deepEqual(view,previewBefore.camera,'both frames render the shared normalized camera');
    const previewLabels=()=>page(()=>({
      title:$('aiPreviewTitle').textContent,split:$('aiPreviewSplit').textContent,
      before:$('aiPreviewBefore').textContent,after:$('aiPreviewAfter').textContent,
      left:$('aiPreviewLeftLabel').textContent,right:$('aiPreviewRightLabel').textContent,
      useBefore:$('aiUseBefore').textContent,useAfter:$('aiUseAfter').textContent,
      version:$('aiCompareRight').querySelector('option[value="1"]').textContent,
      actions:[...$('aiMessages').querySelectorAll('.aiMessage[data-version-id="1"] button')].map(b=>b.textContent),
      message:$('aiMessages').querySelector('.aiMessage[data-version-id="1"] > div').textContent
    }));
    const previewEN=await previewLabels();
    assert.match(previewEN.version,/version 1/i);assert.equal(previewEN.message,'中文候选说明 1');
    for(const key of ['title','split','before','after','left','right','useBefore','useAfter']) {
      assert.doesNotMatch(previewEN[key],/[\u3400-\u9fff]/,'English preview '+key);
    }
    assert.ok(previewEN.actions.some(text=>/view|compar/i.test(text)));
    assert.ok(previewEN.actions.some(text=>/canvas|use|apply/i.test(text)));
    assert.ok(previewEN.actions.some(text=>/delete|remove/i.test(text)));
    await choose('zh-CN');await framesReady();
    assert.match((await previewLabels()).version,/版本 1/);
    assert.deepEqual(await preview(),previewBefore,'translation must preserve preview candidate, source SVGs and normalized camera');
    assert.deepEqual(await preserved(),canvasBeforePreviewSwitch,'preview translation preserves canvas/history/chat/candidates/drafts');
    await choose('en');await framesReady();
    assert.deepEqual(await previewLabels(),previewEN);
    assert.deepEqual(await preview(),previewBefore);
    assert.equal(await page(()=>__i18nUnexpectedRequests),0,'switching or re-rendering preview never calls an API');
    passed.push('candidate history/actions/version labels and split preview translate while retaining summaries, candidate XML, selections and preview camera; no request is sent');

    await page(()=>{
      aiHidePreview();$('aiPrompt').value='进行中请求保持原来的中文要求';$('aiScope').value='document';$('aiVision').checked=false;
      window.__i18nMock={calls:0,aborts:0};
      window.fetch=(url,options)=>new Promise((resolve,reject)=>{
        __i18nMock.calls++;
        if(url!=='https://i18n.invalid/v1/chat/completions') {reject(new Error('Unexpected mock URL'));return;}
        const body=JSON.parse(options.body),payload=JSON.parse(body.messages.at(-1).content);
        const svg=new DOMParser().parseFromString(payload.document.xml,'image/svg+xml');
        const target=svg.querySelector('#caption').getAttribute('data-ai-key');
        options.signal.addEventListener('abort',()=>{__i18nMock.aborts++;reject(new DOMException('mock cancelled','AbortError'));},{once:true});
        window.__i18nRelease=()=>resolve(new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({
          summary:'模型返回的中文说明不能翻译',operations:[{op:'text',target,value:'生成后的中文正文'}]
        })}}]}),{status:200,headers:{'Content-Type':'application/json'}}));
      });
      window.__i18nRequestPromise=aiSend();
      return true;
    });
    await waitFor('__i18nMock.calls===1 && aiState.busy && typeof __i18nRelease === "function"','held mocked AI request');
    await page(()=>{window.__i18nController=aiState.controller;});
    const busyBefore=await preserved();
    await choose('zh-CN');
    assert.deepEqual(await page(()=>({busy:aiState.busy,sameController:aiState.controller===__i18nController,aborted:__i18nController.signal.aborted,...__i18nMock})),
      {busy:true,sameController:true,aborted:false,calls:1,aborts:0},'switching language cannot cancel or duplicate an active request');
    assert.deepEqual(await preserved(),busyBefore,'busy translation preserves the in-flight conversation and user state');
    assert.match(await page(()=>$('aiProgressLabel').textContent),/[\u3400-\u9fff]/,'active progress translates immediately');
    await choose('en');
    assert.doesNotMatch(await page(()=>$('aiProgressLabel').textContent),/[\u3400-\u9fff]/,'active progress switches back without restarting work');
    await page(async()=>{__i18nRelease();await __i18nRequestPromise;});
    await waitFor('!aiState.busy && aiState.versions.length===3','held request finishes after translation');
    const completed=await page(()=>({
      calls:__i18nMock.calls,aborts:__i18nMock.aborts,ids:aiState.versions.map(v=>v.id),
      summary:aiState.versions.at(-1).message.text,xml:aiState.versions.at(-1).result.xml,
      canvas:snapshot(),prompt:$('aiPrompt').value,status:$('aiStatus').textContent
    }));
    assert.equal(completed.calls,1);assert.equal(completed.aborts,0);assert.deepEqual(completed.ids,[1,2,3]);
    assert.equal(completed.summary,'模型返回的中文说明不能翻译');assert.match(completed.xml,/生成后的中文正文/);
    assert.equal(completed.canvas,busyBefore.xml,'request completion remains a candidate, not a canvas mutation');
    assert.equal(completed.prompt,busyBefore.prompt);assert.doesNotMatch(completed.status,/[\u3400-\u9fff]/);
    assert.deepEqual(await page(()=>__auditErrors),[]);
    passed.push('switching during an active mocked AI request preserves its controller and history, sends no duplicate request, and lets the original candidate finish');
  });

  await withEditor(async context=>{
    const {page,reload,language,choose}=helpers(context);
    const userAgent=await page(()=>navigator.userAgent);
    async function startFor(locale,preference) {
      await context.send('Emulation.setUserAgentOverride',{userAgent,acceptLanguage:locale});
      await page((key,value)=>{if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);},LANGUAGE_KEY,preference);
      await reload();
      assert.equal(await page(()=>navigator.language),locale,'test locale override is active');
      return language();
    }
    assert.deepEqual(await startFor('zh-TW',null),{lang:'zh-CN',value:'zh-CN'},'Chinese browser locales default to Simplified Chinese UI');
    assert.deepEqual(await startFor('en-GB',null),{lang:'en',value:'en'},'other browser locales default to English UI');
    assert.deepEqual(await startFor('fr-FR','unsupported'),{lang:'en',value:'en'},'invalid stored language falls back to browser locale');
    assert.deepEqual(await startFor('zh-TW','en'),{lang:'en',value:'en'},'valid saved preference wins over browser locale');
    await choose('zh-CN');await reload();
    assert.deepEqual(await language(),{lang:'zh-CN',value:'zh-CN'});
    assert.equal(await page(key=>localStorage.getItem(key),LANGUAGE_KEY),'zh-CN');
    assert.deepEqual(await page(()=>__auditErrors),[]);
    passed.push('no-preference startup follows browser locale, ignores invalid values and gives a saved explicit choice precedence across reloads');
  },{language:null});

  console.log('PASS: i18n ('+passed.length+' scenarios, isolated browser profiles and mocked transport)');
  for(const name of passed)console.log('  '+name);
}

main().catch(error=>{console.error(error);process.exitCode=1;});
