// Run: node tests/ai-preview.cjs (isolated real browser; no API or network service).
const assert = require('node:assert/strict');
const {withEditor} = require('./browser.cjs');

function fixture(viewBox, label, color) {
  const [x,y,w,h] = viewBox;
  return `<svg id="doc" xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}" width="${w}" height="${h}"><rect id="shape" x="${x+w*.2}" y="${y+h*.25}" width="${w*.6}" height="${h*.5}" fill="${color}"/><text id="label" x="${x+w*.5}" y="${y+h*.15}" font-size="${Math.min(w,h)*.08}" text-anchor="middle">${label}</text></svg>`;
}
const BASE = fixture([100,-50,400,220], 'Original', '#c9def2');
const NEXT = fixture([-200,300,800,440], 'Candidate A', '#83c8b4');
const TALL = fixture([2000,-1000,240,600], 'Candidate B', '#e8ba86');

function near(actual, expected, label, tolerance=1e-5) {
  assert.ok(Math.abs(actual-expected) <= tolerance, `${label}: ${actual} != ${expected}`);
}

async function main() {
  const passed = [];
  await withEditor(async ({evalJS,send,delay}) => {
    const page = (fn,...args) => evalJS('('+fn.toString()+')(...'+JSON.stringify(args)+')');
    async function waitFor(expression,label) {
      for (let i=0;i<100;i++) {
        if (await evalJS(expression)) return;
        await delay(25);
      }
      throw new Error('Timed out: '+label);
    }
    async function ready(ids) {
      await waitFor(`(${JSON.stringify(ids)}).every(id=>{const f=$(id),d=f.contentDocument;return !f.hidden && f.style.visibility!=="hidden" && d?.documentElement?.dataset.aiPreviewSerial===String(aiState.previewSerial) && !!d.getElementById('aiPreviewContent')?.querySelector('svg');})`,'preview frames '+ids.join(','));
    }
    const view = () => page(() => ({...aiState.previewView}));
    const canvas = () => page(() => ({
      xml:snapshot(),undo:state.undo.slice(),redo:state.redo.slice(),dirty:state.dirty,
      selection:[...state.sel].map(nodePathOf),zoom:state.zoom,panX:state.panX,panY:state.panY,
      canvasVersionId:aiState.canvasVersionId,prompt:$('aiPrompt').value,
      messages:JSON.stringify(aiState.messages),versions:JSON.stringify(aiState.versions),
      browser:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale}
    }));
    const geometry = (id,fx=.5,fy=.5) => page((id,fx,fy) => {
      const f=$(id),r=f.getBoundingClientRect(),w=f.contentWindow.innerWidth,h=f.contentWindow.innerHeight;
      return {x:r.left+f.clientLeft+w*fx,y:r.top+f.clientTop+h*fy,w,h,localX:w*fx,localY:h*fy};
    },id,fx,fy);
    const move = (x,y,extra={}) => send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,...extra});
    async function clickAt(x,y) {
      await move(x,y);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
    }
    async function click(id) {
      const p=await page(id=>{const r=$(id).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},id);
      await clickAt(p.x,p.y);
    }
    async function key(key,code,modifiers=2) {
      await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});
    }
    async function wheel(id,deltaY,modifiers=0,fx=.5,fy=.5) {
      const p=await geometry(id,fx,fy),before=await view();
      await page(id=>{
        const f=$(id);f.__observedWheel=null;
        f.contentWindow.addEventListener('wheel',event=>{
          const svg=f.contentDocument.querySelector('svg');
          const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());
          f.__observedWheel={x:event.clientX,y:event.clientY,anchor:{x:point.x,y:point.y}};
        },{capture:true,once:true});
      },id);
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:0,deltaY,modifiers});
      const expected=Math.max(.25,Math.min(16,before.scale*Math.exp(-deltaY*.002)));
      await waitFor(`!!$(${JSON.stringify(id)}).__observedWheel`,'wheel event');
      await waitFor(`Math.abs(aiState.previewView.scale-${expected})<1e-7`,'wheel scale');
      return {p,before,after:await view(),event:await page(id=>$(id).__observedWheel,id)};
    }
    async function synchronized(ids) {
      const state=await view();
      const matrices=await page(ids=>ids.map(id=>{
        const f=$(id),c=f.contentDocument.getElementById('aiPreviewContent');
        const m=new DOMMatrix(f.contentWindow.getComputedStyle(c).transform);
        return {a:m.a,d:m.d,x:m.e/f.contentWindow.innerWidth,y:m.f/f.contentWindow.innerHeight};
      }),ids);
      for (const m of matrices) {
        near(m.a,state.scale,'frame horizontal scale',1e-4);
        near(m.d,state.scale,'frame vertical scale',1e-4);
        near(m.x,state.x,'normalized frame pan x',1e-4);
        near(m.y,state.y,'normalized frame pan y',1e-4);
      }
    }
    async function drag(id,fx,fy,dx,dy,button='left') {
      const p=await geometry(id,fx,fy),before=await view(),buttons=button==='middle'?4:1;
      await move(p.x,p.y);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button,buttons,clickCount:1});
      await move(p.x+dx,p.y+dy,{button,buttons});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+dx,y:p.y+dy,button,buttons:0,clickCount:1});
      const after=await view();
      near(after.x,before.x+dx/p.w,'drag pan x');
      near(after.y,before.y+dy/p.h,'drag pan y');
      near(after.scale,before.scale,'drag keeps scale');
      await move(p.x+dx+7,p.y+dy+5);
      assert.deepEqual(await view(),after,'released drag must not keep following the pointer');
      return {p,after};
    }

    await page((base,next,tall) => {
      loadSVGText(base,'ai-preview-test.svg');
      pushUndo();doc.querySelector('#shape').setAttribute('opacity','.9');undo();
      select([doc.querySelector('#shape')]);markDirty(false);aiToggle(true);
      const source={xml:snapshot(),parentId:null};
      aiState.original=source;
      const add=(id,xml,label)=>{
        const message={role:'assistant',text:label,status:'待确认',versionId:id,parentId:null};
        const version={id,base:source,result:{xml,changes:[]},scope:'document',selectionPaths:[],epoch:aiState.epoch,message,request:label};
        aiState.versions.push(version);aiState.messages.push(message);
      };
      add(1,next,'Local preview fixture A');add(2,tall,'Local preview fixture B');
      aiState.nextVersionId=3;$('aiPrompt').value='Unsent preview test draft';
      aiRenderMessages();aiSelectVersion(1);
    },BASE,NEXT,TALL);
    const pair=['aiPreviewLeftFrame','aiPreviewRightFrame'];
    await ready(pair);
    const before=await canvas();
    const sourceXML=await page(()=>({before:aiState.previewSources.before.xml,after:aiState.previewSources.after.xml}));
    assert.deepEqual(await view(),{scale:1,x:0,y:0});
    assert.equal(await page(()=>['aiPreviewZoomOut','aiPreviewZoomIn','aiPreviewFit','aiPreviewZoomValue'].every(id=>$(id))),true);
    const security=await page(ids=>ids.map(id=>{
      const f=$(id),d=f.contentDocument;
      return {sandbox:f.getAttribute('sandbox'),csp:d.querySelector('meta[http-equiv="Content-Security-Policy"]').content};
    }),pair);
    for (const item of security) {
      assert.equal(item.sandbox,'allow-same-origin');
      assert.match(item.csp,/default-src 'none'/);
      assert.doesNotMatch(item.csp,/script-src\s+(?!'none')/);
    }
    passed.push('isolated local candidate fixtures render with the original scriptless sandbox and CSP');

    for (const [id,modifiers] of [[pair[0],0],[pair[1],2],[pair[0],4]]) {
      // WheelEvent exposes integer coordinates even when CDP was sent fractional pixels.
      // Assert against the actual child-frame event, including its pre-zoom SVG point.
      const step=await wheel(id,-105,modifiers,.17,.09);
      const q={x:step.event.x/step.p.w-.5,y:step.event.y/step.p.h-.5},ratio=step.after.scale/step.before.scale;
      near(step.after.x,q.x-(q.x-step.before.x)*ratio,'pointer anchored x');
      near(step.after.y,q.y-(q.y-step.before.y)*ratio,'pointer anchored y');
      const afterAnchor=await page((id,x,y)=>{
        const svg=$(id).contentDocument.querySelector('svg'),p=new DOMPoint(x,y).matrixTransform(svg.getScreenCTM().inverse());
        return {x:p.x,y:p.y};
      },id,step.event.x,step.event.y);
      near(afterAnchor.x,step.event.anchor.x,'same SVG point remains under pointer',.02);
      near(afterAnchor.y,step.event.anchor.y,'same SVG point remains under pointer vertically',.02);
      await synchronized(pair);
      assert.deepEqual((await canvas()).browser,before.browser,'wheel must not zoom the browser page');
    }
    passed.push('ordinary/Ctrl/Meta wheels zoom only the preview, preserve the pointer anchor in meet letterboxing and synchronize both frames');

    await click('aiPreviewFit');
    await drag(pair[0],.12,.08,34,23);
    await synchronized(pair);
    await click('aiPreviewFit');
    await drag(pair[1],.5,.5,-31,19);
    await synchronized(pair);
    await drag(pair[0],.5,.5,24,-17,'middle');
    await synchronized(pair);
    await click('aiPreviewFit');
    const crossing=await geometry(pair[0],.86,.5),crossBefore=await view(),crossDx=crossing.w*.5;
    await move(crossing.x,crossing.y);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:crossing.x,y:crossing.y,button:'left',buttons:1,clickCount:1});
    await move(crossing.x+crossDx,crossing.y+12,{button:'left',buttons:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:crossing.x+crossDx,y:crossing.y+12,button:'left',buttons:0,clickCount:1});
    const crossAfter=await view();
    near(crossAfter.x,crossBefore.x+crossDx/crossing.w,'captured cross-frame pan');
    await move(crossing.x+crossDx+12,crossing.y+20);
    assert.deepEqual(await view(),crossAfter,'cross-frame release must end the gesture');
    passed.push('left/middle drags pan over SVG and blank space; pointer capture survives crossing into the other frame and releases cleanly');

    await click('aiPreviewFit');await click('aiPreviewZoomIn');
    near((await view()).scale,1.2,'zoom-in button');
    assert.equal(await page(()=>$('aiPreviewZoomValue').textContent),'120%');
    await click('aiPreviewZoomOut');near((await view()).scale,1,'zoom-out button');
    await wheel(pair[1],-200,2,.7,.6);
    const kept=await view();
    await click('aiPreviewAfter');await ready(['aiPreviewFrame']);
    assert.deepEqual(await view(),kept,'single mode keeps the preview view');
    await synchronized(['aiPreviewFrame']);
    await click('aiPreviewBefore');await ready(['aiPreviewFrame']);
    assert.deepEqual(await view(),kept,'other single mode keeps the preview view');
    await click('aiPreviewSplit');await ready(pair);
    assert.deepEqual(await view(),kept,'split mode keeps the preview view');
    await page(()=>{$('aiCompareRight').value='2';$('aiCompareRight').dispatchEvent(new Event('change'));});
    await ready(pair);assert.deepEqual(await view(),kept,'changing the candidate keeps the preview view');
    assert.equal(await page(()=>$('aiPreviewRightFrame').contentDocument.querySelector('svg').getAttribute('viewBox')),'2000 -1000 240 600');
    await synchronized(pair);
    passed.push('toolbar controls work; shared normalized view survives single/split layouts and versions with different original viewBoxes');

    await click('aiPreviewFit');
    await page(()=>$('aiPreviewZoomIn').focus());await key('=','Equal',2);
    near((await view()).scale,1.2,'header Ctrl-plus');
    await key('0','Digit0',4);assert.deepEqual(await view(),{scale:1,x:0,y:0},'header Meta-zero');
    const focus=await geometry(pair[0]);await clickAt(focus.x,focus.y);
    assert.equal(await page(id=>document.activeElement===$(id),pair[0]),true,'clicking the preview must focus its iframe for keyboard navigation');
    await page(id=>{
      const frame=$(id);window.__previewChildKeys=[];
      frame.contentWindow.addEventListener('keydown',event=>{
        setTimeout(()=>__previewChildKeys.push({key:event.key,prevented:event.defaultPrevented}),0);
      },{capture:true});
    },pair[0]);
    await key('+','Equal',2);near((await view()).scale,1.2,'iframe Ctrl-plus');
    await key('-','Minus',4);near((await view()).scale,1,'iframe Meta-minus');
    await waitFor('__previewChildKeys.length===2','child-frame zoom shortcuts');
    assert.deepEqual(await page(()=>__previewChildKeys),[{key:'+',prevented:true},{key:'-',prevented:true}]);
    passed.push('Ctrl/Meta +/-/0 shortcuts operate inside frames and on the preview header, not the browser page');

    const clampBefore=await canvas();
    await page(()=>{aiZoomPreview(100000);window.__previewWheelDefaults=[];for(const id of ['aiPreviewLeftFrame','aiPreviewRightFrame']){$(id).contentWindow.addEventListener('wheel',e=>{setTimeout(()=>__previewWheelDefaults.push(e.defaultPrevented),0);},{capture:true});}});
    await wheel(pair[0],-160,2);near((await view()).scale,16,'upper clamp');
    assert.equal(await page(()=>$('aiPreviewZoomIn').disabled),true);
    await page(()=>aiZoomPreview(.000001));
    await wheel(pair[1],160,4);near((await view()).scale,.25,'lower clamp');
    assert.equal(await page(()=>$('aiPreviewZoomOut').disabled),true);
    await waitFor('__previewWheelDefaults.length===2','wheel default suppression at scale limits');
    assert.deepEqual(await page(()=>__previewWheelDefaults),[true,true]);
    assert.deepEqual((await canvas()).browser,clampBefore.browser);
    await click('aiPreviewFit');assert.deepEqual(await view(),{scale:1,x:0,y:0});
    passed.push('zoom clamps at 25–1600%; Ctrl/Meta wheels remain canceled at the limits and Fit resets pan and zoom');

    const sourceNow=await page(()=>({before:aiState.previewSources.before.xml,after:aiState.previewSources.after.xml}));
    assert.equal(sourceNow.before,sourceXML.before);
    assert.equal(sourceNow.after,TALL);
    assert.deepEqual(await canvas(),{...before,versions:before.versions},'navigation must not mutate canvas, editor zoom, undo/redo, selection, drafts, chat or candidate XML');
    await wheel(pair[0],-300,2,.6,.4);
    await click('aiPreviewClose');
    assert.deepEqual(await view(),{scale:1,x:0,y:0});
    await page(()=>aiSelectVersion(1));await ready(pair);
    assert.deepEqual(await view(),{scale:1,x:0,y:0},'close and reopen starts fitted');
    passed.push('all preview gestures leave the editor/history/draft/source SVGs untouched; closing and reopening resets to fit');

    await click('aiPreviewAfter');await ready(['aiPreviewFrame']);
    const unsafe='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="parent.__previewInjected=1"><script>parent.__previewInjected=2</script><a id="previewLink" href="#do-not-navigate"><rect width="100" height="100" fill="teal"/></a></svg>';
    await page(xml=>aiRenderPreviewFrame($('aiPreviewFrame'),xml,aiState.previewSerial),unsafe);
    await ready(['aiPreviewFrame']);
    const link=await geometry('aiPreviewFrame');await clickAt(link.x,link.y);await delay(50);
    assert.equal(await page(()=>typeof window.__previewInjected),'undefined');
    assert.equal(await page(()=>$('aiPreviewFrame').contentWindow.location.hash),'');
    passed.push('sandboxed source scripts/events remain inert and dragging or clicking a source link cannot navigate the preview');

    await page(()=>{aiSelectVersion(1,false);aiShowPreview('split');});await ready(pair);
    await wheel(pair[1],-400,2,.7,.6);await drag(pair[0],.5,.5,20,13);
    const adoptionBefore=await page(()=>({undo:state.undo.length,source:aiState.previewSources.after.xml}));
    await click('aiUseAfter');
    assert.equal(await page(()=>aiSameXML(snapshot(),aiState.versions[0].result.xml)),true,'adoption must use the unchanged source XML, not the preview transform');
    assert.equal(adoptionBefore.source,NEXT);
    assert.equal(await page(()=>doc.getAttribute('viewBox')),'-200 300 800 440');
    assert.equal(await page(()=>doc.querySelector('#aiPreviewContent')),null);
    assert.equal(await page(()=>state.undo.length),adoptionBefore.undo+1);
    await page(()=>undo());assert.equal(await page(xml=>aiSameXML(snapshot(),xml),before.xml),true);
    assert.deepEqual(await page(()=>window.__auditErrors),[]);
    passed.push('adopting a zoomed/panned candidate preserves its original SVG/viewBox and remains one undoable content change');
  });
  console.log('PASS: AI preview navigation ('+passed.length+' scenarios)');
  for (const name of passed) console.log('  '+name);
}

main().catch(error=>{console.error(error);process.exitCode=1;});
