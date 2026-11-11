const fs = require('fs');
const path = require('path');
const {withEditor} = require('./browser.cjs');

withEditor(async ({evalJS}) => {
  const sourcePath = process.env.SVG_TWEAK_AI_CORE_SOURCE;
  if (sourcePath) {
    const source = fs.readFileSync(path.resolve(sourcePath),'utf8');
    await evalJS('window.__coreUnderTest=(()=>{' + source + ';return AIEditCore;})()');
  } else await evalJS('window.__coreUnderTest=AIEditCore');
  const run = async () => {
    const C = window.__coreUnderTest, results = [], initial = snapshot();
    const frames = () => document.querySelectorAll('iframe').length;
    const baseFrames = frames();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const parse = xml => new DOMParser().parseFromString(xml,'image/svg+xml').documentElement;
    const equal = (a,b,message) => check(Math.abs(a-b)<.00001,message+': '+a+' != '+b);
    const build = async (xml,ops,scope=null) => {
      const out = await C.build(xml,ops,scope);
      check(frames()===baseFrames,'iframe leaked after success');
      check(!out.xml.includes('data-ai-key'),'internal key leaked');
      check(!parse(out.xml).querySelector('parsererror'),'invalid XML output');
      return out;
    };
    const rejects = async (xml,ops,scope=null) => {
      let message='';
      try { await C.build(xml,ops,scope); } catch(e) { message=e.message; }
      check(message,'expected operation to be rejected: '+JSON.stringify(ops));
      check(frames()===baseFrames,'iframe leaked after rejection');
      check(snapshot()===initial,'main document changed after rejected batch');
      return message;
    };
    check(typeof C.prepareSVG==='function' && Array.isArray(C.presentationStyles),'shared SVG preparation API missing');
    check(['fill','stroke','font-size','overflow'].every(name=>C.presentationStyles.includes(name)),'presentation style list is incomplete');
    check(!C.presentationStyles.includes('pointer-events') && !C.presentationStyles.some(name=>name.startsWith('data-')),'presentation styles expose non-presentation metadata');
    const preparationObserver=new MutationObserver(()=>{});
    preparationObserver.observe(document.documentElement,{childList:true,subtree:true});
    try {
      const prepared=C.prepareSVG('<svg xmlns="http://www.w3.org/2000/svg" id="doc" data-ai-key="root" viewBox="0 0 100 80" overflow="visible"><defs><linearGradient id="toast"><stop offset="0" stop-color="red"/></linearGradient><symbol id="btnShapeLibrary"><path d="M0 0L10 10"/></symbol></defs><rect x="10" y="20" width="30" height="40" fill="url(#toast)"/><use href="#btnShapeLibrary"/></svg>');
      check(prepared.localName==='svg' && prepared.ownerDocument.defaultView===null && !document.contains(prepared),'prepareSVG must return an unmounted SVG synchronously');
      check(prepared.id!=='doc' && !document.getElementById(prepared.id),'root ID collision with editor page was not remapped');
      const gradient=prepared.querySelector('linearGradient'), symbol=prepared.querySelector('symbol');
      check(gradient.id!=='toast' && symbol.id!=='btnShapeLibrary','descendant IDs collide with editor page');
      check(prepared.querySelector('rect').getAttribute('fill')==='url(#'+gradient.id+')' && prepared.querySelector('use').getAttribute('href')==='#'+symbol.id,'page collision remapping broke local references');
      check(!prepared.hasAttribute('data-ai-key'),'preparation leaked internal AI labels');
      const target=parse('<svg xmlns="http://www.w3.org/2000/svg" id="target-root"><defs><linearGradient id="target-paint"/><path id="target-shape" d="M0 0L10 10"/></defs></svg>');
      const targetXML=new XMLSerializer().serializeToString(target);
      const intoTarget=C.prepareSVG('<svg xmlns="http://www.w3.org/2000/svg" id="target-root" viewBox="0 0 100 80"><defs><linearGradient id="target-paint"><stop offset="0" stop-color="blue"/></linearGradient><path id="target-shape" d="M0 0L20 20"/></defs><rect width="20" height="20" style="fill:url(#target-paint)"/><use href="#target-shape"/></svg>',target);
      const paint=intoTarget.querySelector('linearGradient'), shape=intoTarget.querySelector('path');
      check(intoTarget.id!=='target-root' && paint.id!=='target-paint' && shape.id!=='target-shape','targetRoot root/descendant collisions were not remapped');
      check(intoTarget.querySelector('rect').style.fill.includes('#'+paint.id) && intoTarget.querySelector('use').getAttribute('href')==='#'+shape.id,'targetRoot remapping broke inline URL/href closure');
      check(new XMLSerializer().serializeToString(target)===targetXML,'preparation mutated targetRoot');
      check(!preparationObserver.takeRecords().length && frames()===baseFrames && snapshot()===initial,'static SVG preparation mounted nodes or changed the editor');
    } finally { preparationObserver.disconnect(); }
    results.push('synchronous static SVG preparation remaps page/targetRoot root and descendant IDs with closed local references, without mounting or mutation');

    for(const value of ['visible','hidden','clip']) {
      const prepared=C.prepareSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" overflow="'+value+'"><svg width="100" height="80" viewBox="0 0 100 80" style="overflow:'+value+'"><rect x="10%" y="20%" width="30%" height="40%"/></svg></svg>');
      check(prepared.getAttribute('overflow')===value && prepared.querySelector('svg').style.overflow===value,'valid overflow presentation lost');
      check(prepared.querySelector('rect').getAttribute('width')==='30%','preparation flattened percentage-based viewport geometry');
    }
    for(const content of [
      '<svg overflow="invalid"/>', '<svg overflow="url(https://example.invalid/x)"/>',
      '<svg style="overflow:var(--external)"/>', '<svg style="overflow:url(https://example.invalid/x)"/>',
      '<svg onload="window.__prepareInjected=true"/>', '<svg><script>window.__prepareInjected=true</script></svg>',
      '<svg><image href="https://example.invalid/x.png" width="1" height="1"/></svg>', '<svg><use href="#missing"/></svg>',
      '<svg data-arbitrary="value"/>', '<svg><g data-library-shape="unknown"/></svg>',
      '<svg><rect id="same"/><circle id="same"/></svg>'
    ]) {
      let message='';
      try { C.prepareSVG(content.replace('<svg','<svg xmlns="http://www.w3.org/2000/svg"')); } catch(error) { message=error.message; }
      check(message,'unsafe static SVG accepted: '+content);
    }
    check(typeof window.__prepareInjected==='undefined' && snapshot()===initial && frames()===baseFrames,'static SVG rejection had side effects');
    results.push('static nested viewports preserve percentages and safe overflow; unsafe overflow, scripts/events, external/dangling references and arbitrary data attributes remain rejected');

    const frozenHost=document.createElement('div');
    frozenHost.style.cssText='position:fixed;left:-100000px;top:0';
    const frozenSource=parse('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect x="10" y="10" width="30" height="40" fill="red"/><text x="50" y="50" font-size="18">Roundtrip 冻结</text></svg>');
    frozenHost.appendChild(frozenSource); stage.appendChild(frozenHost);
    try {
      const frozen=frozenSource.cloneNode(true), live=[frozenSource,...frozenSource.querySelectorAll('*')], clones=[frozen,...frozen.querySelectorAll('*')];
      live.forEach((el,i)=>{
        const computed=getComputedStyle(el);
        clones[i].removeAttribute('style');
        for(const name of C.presentationStyles) {
          const value=computed.getPropertyValue(name).trim();
          if(value) clones[i].style.setProperty(name,value);
        }
      });
      const serialize=el=>new XMLSerializer().serializeToString(el);
      const prepared=C.prepareSVG(serialize(frozen)), repeated=C.prepareSVG(serialize(prepared));
      for(const output of [prepared,repeated]) {
        [output,...output.querySelectorAll('*')].forEach((el,i)=>{
          for(const name of C.presentationStyles) check(el.style.getPropertyValue(name)===clones[i].style.getPropertyValue(name),'frozen '+clones[i].localName+' '+name+' did not roundtrip');
        });
        check(output.querySelector('rect').getAttribute('width')==='30' && output.querySelector('text').textContent==='Roundtrip 冻结','frozen shape/text content changed');
      }
    } finally { frozenHost.remove(); }
    results.push('full computed presentation styles on simple rect/text survive static preparation and a second serialization roundtrip');

    const shorthand=C.prepareSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><defs><mask id="shorthand-mask"><rect width="100" height="80" fill="white"/></mask></defs><g style="font-variant:small-caps tabular-nums;text-decoration:underline dotted rgb(12,34,56);white-space:pre-wrap;mask:url(#shorthand-mask);overflow:hidden visible;pointer-events:none;fill:orange"><text x="10" y="30">Shorthand</text></g></svg>');
    const shorthandGroup=shorthand.querySelector('g'), shorthandStyle=shorthandGroup.style;
    check(shorthandStyle.fontVariant.includes('small-caps') && shorthandStyle.fontVariant.includes('tabular-nums'),'font-variant shorthand was lost');
    check(shorthandStyle.textDecorationLine==='underline' && shorthandStyle.textDecorationStyle==='dotted','text-decoration shorthand was lost');
    check(shorthandStyle.whiteSpace==='pre-wrap' && shorthandStyle.overflow==='hidden visible','white-space/overflow shorthands were lost');
    check(shorthandStyle.mask.includes('#'+shorthand.querySelector('mask').id),'mask shorthand/local reference was lost');
    check(shorthandStyle.fill==='orange' && !shorthandStyle.pointerEvents,'shorthand handling bypassed pointer-events normalization or lost other styles');
    for(const style of [
      'font-variant-ligatures:none', 'text-decoration-color:red', 'white-space-collapse:preserve', 'mask-image:none', 'overflow-x:hidden',
      'font:16px Arial', 'font-variant:normal;position:fixed', 'text-decoration:underline;transform:scale(2)',
      'mask:url(https://example.invalid/mask.svg#x)', 'font-variant:var(--external)', 'white-space:expression(alert(1))'
    ]) {
      let message='';
      try { C.prepareSVG('<svg xmlns="http://www.w3.org/2000/svg" style="'+style+'"/>'); } catch(error) { message=error.message; }
      check(message,'unsupported or unsafe shorthand declaration accepted: '+style);
    }
    check(snapshot()===initial && frames()===baseFrames,'computed/shorthand validation changed the editor');
    results.push('supported font-variant/text-decoration/white-space/mask/overflow shorthands retain values; unsupported declarations and dangerous values still reject');

    const xml='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><linearGradient id="paint"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/></linearGradient></defs><g id="group" transform="translate(25 30) rotate(20) scale(1.3 .8)"><rect id="rect" x="10" y="30" width="50" height="30" transform="rotate(-12 35 45)" fill="white" stroke="black" stroke-width="2"/><text id="text" x="10" y="100" font-size="18">Keep<tspan fill="red" font-size="22"> red</tspan></text></g><rect id="other" x="250" y="70" width="40" height="20" fill="blue"/></svg>';
    const labeled=C.label(xml,[[1],[1,0]]), root=parse(labeled.xml);
    const key=id=>root.querySelector('#'+id).getAttribute('data-ai-key');
    check(root.getAttribute('data-ai-key')==='root','root label missing');
    check(labeled.selectedKeys.join(',')===[key('group'),key('rect')].join(','),'selection paths mislabeled');
    check(new Set([root,...root.querySelectorAll('*')].map(e=>e.getAttribute('data-ai-key'))).size===1+root.querySelectorAll('*').length,'keys not unique');
    results.push('stable request-copy labels and selected paths');

    const ariaLabel='电路模块 "8→4→4" & 彩色节点', ariaLabelXML='电路模块 &quot;8→4→4&quot; &amp; 彩色节点';
    const ariaGroup='<g id="aria-module" aria-label="'+ariaLabelXML+'"><rect x="10" y="10" width="70" height="30" fill="#4a8096"/><text x="15" y="30" font-size="12">Editable module</text></g>';
    const ariaWhole='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" aria-label="'+ariaLabelXML+'">'+ariaGroup+'</svg>';
    const preparedAria=C.prepareSVG(ariaWhole);
    check(preparedAria.getAttribute('aria-label')===ariaLabel && preparedAria.querySelector('g').getAttribute('aria-label')===ariaLabel,'static preparation lost or changed aria-label text');
    const ariaCandidates=[];
    for(const mode of ['insert','replace','document']) {
      const operation=mode==='insert' ? {op:'insert',target:'root',position:'append',svg:ariaGroup} :
        {op:'replace',target:mode==='document'?'root':key('rect'),svg:mode==='document'?ariaWhole:ariaGroup};
      const candidate=await build(labeled.xml,[operation]), candidateRoot=parse(candidate.xml);
      const group=candidateRoot.querySelector('#aria-module');
      check(group && group.getAttribute('aria-label')===ariaLabel,mode+' lost or changed escaped aria-label text');
      check(group.querySelector('text').textContent==='Editable module' && !group.querySelector('image'),'aria-label changed editable content');
      if(mode==='document') check(candidateRoot.getAttribute('aria-label')===ariaLabel,'whole-root replacement lost root aria-label');
      ariaCandidates.push(candidate.xml);
    }
    check(snapshot()===initial && frames()===baseFrames && !document.contains(preparedAria),'aria-label preparation/preview changed the canvas or leaked a frame');
    results.push('aria-label with Chinese, quotes and ampersand survives static preparation and generated insert/local/root replacement without changing the canvas');
    for(const svg of [
      '<g aria-label="module" onload="parent.__ariaInjected=true"/>',
      '<g aria-label="module"><script>parent.__ariaInjected=true</script></g>',
      '<g aria-label="module"><image href="https://example.invalid/module.png" width="10" height="10"/></g>',
      '<g aria-label="module" aria-labelledby="unknown-title"/>',
      '<g aria-label="module" data-arbitrary="value"/>'
    ]) await rejects(labeled.xml,[{op:'insert',target:'root',position:'append',svg}]);
    check(typeof window.__ariaInjected==='undefined','rejected aria-label fragment executed an event or script');
    results.push('aria-label allowance stays exact: events, scripts, external resources, other aria-* and unknown attributes remain rejected');

    const overflowStyled=await build(labeled.xml,[{op:'style',targets:[key('group')],properties:{overflow:'visible'}}]);
    check(parse(overflowStyled.xml).querySelector('#group').style.overflow==='visible','overflow style operation failed');
    await rejects(labeled.xml,[{op:'style',targets:[key('group')],properties:{overflow:'invalid'}}]);
    await rejects(labeled.xml,[{op:'style',targets:[key('group')],properties:{overflow:'url(https://example.invalid/x)'}}]);
    results.push('AI overflow style operations use the same CSS validity and safe-value restrictions');

    const moved=await build(labeled.xml,[{op:'move',targets:[key('rect')],dx:13,dy:-7}],[key('group')]);
    const delta=moved.changes[0];
    equal(delta.after.x-delta.before.x,13,'root-space move x');
    equal(delta.after.y-delta.before.y,-7,'root-space move y');
    equal(delta.after.w,delta.before.w,'move width');
    equal(delta.after.h,delta.before.h,'move height');
    const movedRoot=parse(moved.xml);
    check(movedRoot.querySelector('#group').getAttribute('transform')===root.querySelector('#group').getAttribute('transform'),'parent transform changed');
    check(movedRoot.querySelector('#rect').getAttribute('stroke-width')==='2','stroke width changed');
    check(movedRoot.querySelector('#text').getAttribute('font-size')==='18','unrelated text changed');
    results.push('nested rotate/scale parent: root-space translation preserves size/stroke');

    const aligned=await build(labeled.xml,[
      {op:'move',targets:[key('rect')],dx:1,dy:0},
      {op:'align',targets:[key('rect'),key('other')],axis:'x',edge:'center',reference:'first'}
    ]);
    const anchor=aligned.changes[0].after, alignedOther=aligned.changes.find(c=>c.op==='align').after;
    equal(anchor.x+anchor.w/2,alignedOther.x+alignedOther.w/2,'first-reference alignment');
    const selection=await build(labeled.xml,[
      {op:'move',targets:[key('rect')],dx:1,dy:0},{op:'move',targets:[key('other')],dx:1,dy:0},
      {op:'align',targets:[key('rect'),key('other')],axis:'y',edge:'end',reference:'selection'}
    ]);
    const alignedBoxes=selection.changes.filter(c=>c.op==='align').map(c=>c.after);
    const expectedEnd=Math.max(...selection.changes.filter(c=>c.op==='move').map(c=>c.after.y+c.after.h));
    check(alignedBoxes.length>0,'selection alignment made no changes');
    alignedBoxes.forEach(b=>equal(b.y+b.h,expectedEnd,'selection alignment'));
    results.push('first-object and selection alignment across different parents');

    const text=await build(labeled.xml,[{op:'text',target:key('text'),value:'Keep scarlet'},{op:'style',targets:[key('rect')],properties:{fill:'#c00000','stroke-width':3}}]);
    const textRoot=parse(text.xml);
    check(textRoot.querySelector('#text').textContent==='Keep scarlet','text content mismatch');
    check([...textRoot.querySelectorAll('#text tspan')].some(e=>e.getAttribute('fill')==='red'),'partial text color lost');
    check(textRoot.querySelector('#text').getAttribute('font-size')==='18','base text size lost');
    check(['#c00000','rgb(192, 0, 0)'].includes(textRoot.querySelector('#rect').style.fill),'style not applied');
    results.push('text content with existing partial formatting and presentation styles');

    // Measure the same SVG under the stage and in the candidate frame. Font raster
    // rounding can differ slightly between viewports, so do not compare exact BBoxes.
    const fontHost=document.createElement('div');
    fontHost.style.cssText='position:fixed;left:-100000px;top:0;width:500px;height:220px;pointer-events:none';
    stage.appendChild(fontHost);
    try {
      for (const rootSize of ['', ' font-size="200%"']) {
        const fontXML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 220" width="500" height="220"'+rootSize+'><text id="base-font" x="30" y="60">默认字体对齐检验</text>'+
          (rootSize ? '<text id="nested-font" x="30" y="150" font-size="50%">默认字体对齐检验</text>' : '')+'</svg>';
        const liveFontRoot=parse(fontXML);
        fontHost.replaceChildren(liveFontRoot);
        const textNodes=[...liveFontRoot.querySelectorAll('text')];
        const stageFont=getComputedStyle(stage), stageSize=parseFloat(stageFont.fontSize);
        textNodes.forEach((el,i) => {
          const css=getComputedStyle(el);
          equal(parseFloat(css.fontSize),stageSize*(rootSize && i===0 ? 2 : 1),'live fixture percentage font size');
          check(css.fontFamily===stageFont.fontFamily,'live fixture font family does not inherit stage');
        });
        const fontContext=C.label(fontXML), fontRoot=parse(fontContext.xml);
        const fontKeys=textNodes.map(el=>fontRoot.querySelector('#'+el.id).getAttribute('data-ai-key'));
        const measured=await build(fontContext.xml,[{op:'move',targets:fontKeys,dx:1,dy:0}]);
        measured.changes.forEach((change,i) => {
          const liveBox=textNodes[i].getBBox(), candidateBox=change.before;
          check(Math.abs(candidateBox.w-liveBox.width)<1,'candidate font width differs from stage: '+textNodes[i].id+rootSize);
          check(Math.abs(candidateBox.h-liveBox.height)<1,'candidate font height differs from stage: '+textNodes[i].id+rootSize);
        });
        check(measured.changes.length===textNodes.length,'missing candidate font measurement');
      }
    } finally { fontHost.remove(); }
    results.push('candidate text inherits stage font; root 200% and nested 50% sizes are applied once');

    const added=await build(labeled.xml,[{op:'insert',target:'root',position:'append',svg:'<defs><linearGradient id="paint"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect id="toast" x="100" y="150" width="40" height="20" style="fill:url(#paint);stroke:black"/><text x="100" y="190" font-size="14">New editable text</text>'}]);
    const addedRoot=parse(added.xml), gradients=[...addedRoot.querySelectorAll('linearGradient')];
    check(gradients.length===2 && gradients[0].id!==gradients[1].id,'colliding gradient ID not renamed');
    const newRect=[...addedRoot.querySelectorAll('rect')].find(e=>e.id.startsWith('ai-toast-'));
    check(newRect && newRect.style.fill.includes('#'+gradients[1].id),'renamed local URL not updated');
    check(addedRoot.querySelectorAll('text').length===2,'new text was flattened');
    const referenceAdded=await build(labeled.xml,[{op:'insert',target:'root',position:'append',svg:'<defs><symbol id="rect"><path d="M0 0L10 10"/></symbol></defs><use href="#rect" x="100" y="20"/>'}]);
    const referenceRoot=parse(referenceAdded.xml), symbol=referenceRoot.querySelector('symbol');
    check(symbol.id!=='rect' && referenceRoot.querySelector('use').getAttribute('href')==='#'+symbol.id,'href collision remap failed');
    results.push('new defs/gradient/text, UI/source ID collision remapping and local href/url closure');

    const chart=C.label('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="200" height="120"><rect id="chart-bar" x="10" y="20" width="35" height="80" fill="#cc3333"/></svg>');
    const barKey=parse(chart.xml).querySelector('#chart-bar').getAttribute('data-ai-key');
    const hatch='<defs><pattern id="regression-bar-hatch" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M-2 2L2 -2M0 8L8 0M6 10L10 6" fill="none" stroke="white" stroke-width="1.5"/></pattern></defs>'+
      '<rect id="hatch-overlay" x="10" y="20" width="35" height="80" fill="url(#regression-bar-hatch)" pointer-events="none"/>';
    const star='<polygon id="star-watermark" points="100,15 107,35 128,35 111,48 117,69 100,56 83,69 89,48 72,35 93,35" fill="#ffb400" style="pointer-events:none;opacity:.2"/>';
    const decorated=await build(chart.xml,[
      {op:'style',targets:[barKey],properties:{fill:'#00aa44'}},
      {op:'insert',target:'root',position:'append',svg:hatch+star},
      {op:'style',targets:[barKey],properties:{'pointer-events':'none',fill:'#3366ff'}}
    ]);
    const decoratedRoot=parse(decorated.xml), pattern=decoratedRoot.querySelector('pattern'), overlay=decoratedRoot.querySelector('#hatch-overlay'), watermark=decoratedRoot.querySelector('#star-watermark');
    check(pattern && pattern.getAttribute('patternUnits')==='userSpaceOnUse' && pattern.querySelector('path').getAttribute('d')==='M-2 2L2 -2M0 8L8 0M6 10L10 6','diagonal hatch pattern lost');
    check(overlay && overlay.getAttribute('fill')==='url(#'+pattern.id+')','hatch overlay reference lost');
    check(watermark && watermark.getAttribute('points').trim().split(/[\s,]+/).length===20,'editable five-point star geometry lost');
    equal(Number(watermark.style.opacity),.2,'star watermark opacity');
    check(['#3366ff','rgb(51, 102, 255)'].includes(decoratedRoot.querySelector('#chart-bar').style.fill),'mixed pointer-events/fill style lost its color');
    check(!decorated.xml.includes('pointer-events'),'AI-generated pointer-events must be omitted from attributes, inline styles and style operations');
    check(snapshot()===initial,'chart decoration preview changed the main document');
    const decorationPNG=await (async()=>{
      const url=URL.createObjectURL(new Blob([decorated.xml],{type:'image/svg+xml'}));
      try {
        const image=new Image(); image.src=url; await image.decode();
        const canvas=document.createElement('canvas'); canvas.width=200; canvas.height=120;
        const context=canvas.getContext('2d'); context.fillStyle='white'; context.fillRect(0,0,200,120); context.drawImage(image,0,0);
        const pixel=(x,y)=>[...context.getImageData(x,y,1,1).data];
        return {hatch:pixel(12,27),bar:pixel(12,25),star:pixel(100,40)};
      } finally { URL.revokeObjectURL(url); }
    })();
    check(decorationPNG.hatch.every((v,i)=>i===3 || v>240),'diagonal pattern did not render: '+JSON.stringify(decorationPNG.hatch));
    check(Math.abs(decorationPNG.bar[0]-51)<5 && Math.abs(decorationPNG.bar[1]-102)<5 && decorationPNG.bar[2]>240,'recolored bar did not render: '+JSON.stringify(decorationPNG.bar));
    check(decorationPNG.star[0]>240 && decorationPNG.star[1]>230 && decorationPNG.star[2]>190 && decorationPNG.star[2]<220,'translucent star did not render: '+JSON.stringify(decorationPNG.star));
    const replacedPointer=await build(chart.xml,[{op:'replace',target:barKey,svg:'<rect id="replacement-bar" x="10" y="20" width="35" height="80" fill="orange" pointer-events="none" style="pointer-events:none;opacity:.2"/>'}]);
    check(!replacedPointer.xml.includes('pointer-events') && Number(parse(replacedPointer.xml).querySelector('rect').style.opacity)===.2,'replacement normalization lost opacity or retained AI pointer-events');
    results.push('bar-chart recoloring, diagonal pattern and translucent editable star render together; AI pointer-events is omitted in attributes/inline/style-op/replace');

    const pointerSource=C.label('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="source-pointer" x="10" y="10" width="20" height="30" pointer-events="none" style="pointer-events:auto;opacity:.7" fill="red"/></svg>');
    const pointerKey=parse(pointerSource.xml).querySelector('rect').getAttribute('data-ai-key');
    const keptPointer=await build(pointerSource.xml,[{op:'style',targets:[pointerKey],properties:{'pointer-events':'none',fill:'#aa00cc'}},{op:'move',targets:[pointerKey],dx:3,dy:2}]);
    const keptRect=parse(keptPointer.xml).querySelector('rect');
    check(keptRect.getAttribute('pointer-events')==='none' && keptRect.style.pointerEvents==='auto','normalization must not remove or overwrite existing source pointer-events');
    equal(Number(keptRect.style.opacity),.7,'existing opacity preserved beside source pointer-events');
    check(['#aa00cc','rgb(170, 0, 204)'].includes(keptRect.style.fill),'ignoring new pointer-events must not skip the rest of a source style update');
    results.push('existing source pointer-events attributes and inline values survive ordinary styling/movement');

    const pointerEventError=await rejects(chart.xml,[{op:'style',targets:[barKey],properties:{fill:'blue'}},{op:'insert',target:'root',position:'append',svg:hatch+star+'<rect pointer-events="none" width="5" height="5" onload="window.__decorationInjected=true"/>'}]);
    check(/事件/.test(pointerEventError),'ignoring pointer-events must not bypass event validation');
    const pointerLinkError=await rejects(chart.xml,[{op:'insert',target:'root',position:'append',svg:'<image pointer-events="none" style="pointer-events:none;opacity:.2" href="https://example.invalid/star.png" width="5" height="5"/>'}]);
    check(/外部|链接/.test(pointerLinkError),'ignoring pointer-events must not bypass external resource validation');
    check(typeof window.__decorationInjected==='undefined','rejected decoration executed an event');
    results.push('decorations carrying pointer-events still reject event handlers and external links atomically');

    const replaced=await build(labeled.xml,[{op:'replace',target:key('rect'),svg:'<g id="rect"><path d="M1 2L20 2L20 10Z" fill="none" stroke="black"/><text x="2" y="18" font-size="10">Detail</text></g>'}],[key('group')]);
    const replacedRoot=parse(replaced.xml);
    check(replacedRoot.querySelector('#group > g#rect'),'replacement moved out of existing parent');
    check(replacedRoot.querySelector('#group').getAttribute('transform')===root.querySelector('#group').getAttribute('transform'),'replacement parent context lost');
    const sibling=await build(labeled.xml,[{op:'insert',target:key('group'),position:'before',svg:'<circle id="sibling" cx="20" cy="20" r="5"/>'}],[key('group')]);
    check(parse(sibling.xml).querySelector('#sibling').parentNode.localName==='svg','selected sibling insertion failed');
    const removed=await build(labeled.xml,[{op:'remove',targets:[key('other')]}]);
    check(!parse(removed.xml).querySelector('#other'),'remove failed');
    const whole=await build(labeled.xml,[{op:'replace',target:'root',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="10" y="20" font-size="16">Whole drawing</text></svg>'}]);
    check(parse(whole.xml).getAttribute('viewBox')==='0 0 200 100','whole replacement failed');
    results.push('local redraw, selected sibling insertion, removal and full-SVG replacement');

    const mosXML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'+['nmos','pmos'].map((kind,i)=>{
      const g=makeLibraryShape(kind);
      g.id='source-'+kind; g.setAttribute('transform','translate('+(40+i*120)+' 70)');
      return g.outerHTML;
    }).join('')+'</svg>';
    const mosSource=C.label(mosXML), mosRoot=parse(mosSource.xml);
    const mosKeys=['nmos','pmos'].map(kind=>mosRoot.querySelector('#source-'+kind).getAttribute('data-ai-key'));
    const editedMOS=await build(mosSource.xml,[
      {op:'move',targets:mosKeys,dx:11,dy:-9},
      {op:'style',targets:mosKeys,properties:{stroke:'#3366ff','stroke-width':2.5}}
    ]);
    const editedMOSRoot=parse(editedMOS.xml);
    for(const [i,kind] of ['nmos','pmos'].entries()) {
      const g=editedMOSRoot.querySelector('#source-'+kind), change=editedMOS.changes.find(c=>c.op==='move' && c.key===mosKeys[i]);
      check(g.getAttribute('data-library-shape')===kind,'ordinary move/style lost '+kind+' metadata');
      check(g.children.length===(kind==='pmos'?6:5),'ordinary move/style changed '+kind+' primitives');
      check(['#3366ff','rgb(51, 102, 255)'].includes(g.style.stroke),'MOS group stroke not updated');
      equal(parseFloat(g.style.strokeWidth),2.5,'MOS group stroke width');
      equal(change.after.x-change.before.x,11,'MOS root-space move x');
      equal(change.after.y-change.before.y,-9,'MOS root-space move y');
    }
    results.push('real library NMOS/PMOS sources retain metadata and native geometry through AI move/style');

    const mosCandidates=[];
    for(const [i,kind] of ['nmos','pmos'].entries()) {
      const g=makeLibraryShape(kind); g.id='generated-'+kind;
      const fragment=g.outerHTML;
      for(const mode of ['insert','replace','document']) {
        const op=mode==='insert' ? {op:'insert',target:'root',position:'append',svg:fragment} :
          {op:'replace',target:mode==='document'?'root':mosKeys[i],svg:mode==='document'?'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'+fragment+'</svg>':fragment};
        const candidate=await build(mosSource.xml,[op]), generated=parse(candidate.xml).querySelector('#generated-'+kind);
        check(generated && generated.localName==='g' && generated.getAttribute('data-library-shape')===kind,mode+' rejected or stripped valid '+kind+' metadata');
        check(generated.children.length===g.children.length && !generated.querySelector('image,use'),'generated MOS must remain native editable geometry');
        mosCandidates.push({kind,mode,xml:candidate.xml});
      }
    }
    results.push('exact NMOS/PMOS markers accepted in insert, local replacement and full-SVG replacement');

    const circuitKinds=['vdd','gnd','capacitor','junction','crossover'];
    const circuitShapes=circuitKinds.map((kind,i)=>{
      const g=makeLibraryShape(kind);g.id='generated-'+kind;g.setAttribute('transform','translate('+(20+i*60)+' 170)');return g;
    });
    const circuitSVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">'+circuitShapes.map(g=>g.outerHTML).join('')+'</svg>';
    const preparedCircuit=C.prepareSVG(circuitSVG);
    const insertedCircuit=parse((await build(mosSource.xml,[{op:'insert',target:'root',position:'append',svg:circuitShapes.map(g=>g.outerHTML).join('')}])).xml);
    for(const [i,kind] of circuitKinds.entries()) {
      for(const candidate of [preparedCircuit,insertedCircuit]) {
        const g=candidate.querySelector('[data-library-shape="'+kind+'"]');
        check(g && g.localName==='g','new circuit marker rejected or stripped: '+kind);
        check(g.children.length===circuitShapes[i].children.length && !g.querySelector('image,use'),'new circuit symbol lost native editable geometry: '+kind);
      }
    }
    results.push('VDD/GND/capacitor/junction/crossover markers pass static preparation and a native AI insert batch');

    for(const svg of [
      '<g data-library-shape="mos"><line x2="10"/></g>', '<g data-library-shape="NMOS"><line x2="10"/></g>',
      '<g data-library-shape=""><line x2="10"/></g>', '<g data-library-shape="nmos "><line x2="10"/></g>',
      '<rect data-library-shape="nmos" width="10" height="10"/>', '<line data-library-shape="pmos" x2="10"/>',
      '<rect data-library-shape="vdd" width="10" height="10"/>', '<path data-library-shape="crossover" d="M0 0H10"/>',
      '<g data-library-shape="VDD"><line x2="10"/></g>', '<g data-library-shape="junction "><line x2="10"/></g>',
      '<g data-arbitrary="nmos"><line x2="10"/></g>', '<g data-library-shape="nmos" data-extra="value"><line x2="10"/></g>'
    ]) await rejects(mosSource.xml,[{op:'insert',target:'root',position:'append',svg}]);
    await rejects(mosSource.xml,[{op:'replace',target:'root',svg:'<svg xmlns="http://www.w3.org/2000/svg" data-library-shape="nmos" viewBox="0 0 100 100"><line x2="10"/></svg>'}]);
    const mosEventError=await rejects(mosSource.xml,[{op:'insert',target:'root',position:'append',svg:'<g data-library-shape="nmos" onload="parent.__mosInjected=true"><line x2="10"/></g>'}]);
    check(/事件/.test(mosEventError),'valid MOS marker bypassed event-handler validation');
    const mosLinkError=await rejects(mosSource.xml,[{op:'replace',target:mosKeys[1],svg:'<g data-library-shape="pmos"><image href="https://example.invalid/mos.png" width="10" height="10"/></g>'}]);
    check(/外部|链接/.test(mosLinkError),'valid MOS marker bypassed external-resource validation');
    check(typeof window.__mosInjected==='undefined','rejected MOS fragment executed an event');
    results.push('library marker allowance stays exact: unknown values, non-g markers, arbitrary data attributes, events and external resources still rejected');

    await rejects(labeled.xml,[{op:'move',targets:[key('other')],dx:2,dy:0}],[key('group')]);
    await rejects(labeled.xml,[{op:'insert',target:'root',position:'append',svg:'<rect width="10" height="10"/>'}],[key('group')]);
    await rejects(labeled.xml,[{op:'replace',target:'root',svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}],[key('group')]);
    await rejects(labeled.xml,[{op:'style',targets:[key('rect')],properties:{fill:'green'}},{op:'move',targets:[key('other')],dx:2,dy:0}],[key('group')]);
    await rejects(labeled.xml,[{op:'remove',targets:['root']}]);
    await rejects(labeled.xml,[{op:'move',targets:[key('rect')],dx:Infinity,dy:0}]);
    await rejects(labeled.xml,Array.from({length:101},()=>({op:'remove',targets:[key('rect')]})));
    results.push('selection bounds and whole-batch rejection without main-document changes');

    for(const svg of [
      '<script>parent.__corePwned=true</script>', '<rect width="10" height="10" onload="parent.__corePwned=true"/>',
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>', '<style>rect{fill:red}</style>',
      '<image href="https://example.invalid/track.png" width="10" height="10"/>', '<use href="https://example.invalid/a.svg#x"/>',
      '<rect style="fill:url(https://example.invalid/x)" width="10" height="10"/>', '<rect style="transform:scale(2)" width="10" height="10"/>',
      '<rect id="duplicate"/><rect id="duplicate"/>', '<use href="#missing"/>', '<rect fill="url(#missing)"/>',
      '<path d="M0 0L1e999 1"/>', '<path d="M0 0L1"/>', '<path d="M0 0A-1 2 0 0 0 3 4"/>',
      '<rect width="NaN" height="5"/>', '<rect width="-5" height="5"/>', '<g transform="translate(Infinity)"><rect/></g>'
    ]) await rejects(labeled.xml,[{op:'insert',target:'root',position:'append',svg}]);
    for(const properties of [{transform:'scale(2)'},{position:'fixed'},{fill:'url(https://example.invalid/x)'},{fill:'var(--external)'},{'font-size':'1e999px'}]) {
      await rejects(labeled.xml,[{op:'style',targets:[key('rect')],properties}]);
    }
    const dangling=C.label('<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="shape" d="M0 0L1 1"/></defs><use href="#shape"/></svg>');
    const shapeKey=parse(dangling.xml).querySelector('#shape').getAttribute('data-ai-key');
    await rejects(dangling.xml,[{op:'remove',targets:[shapeKey]}]);
    results.push('model SVG validation: executable content, external resources, ID/reference errors and invalid numbers rejected');

    window.__corePwned=false;
    const unsafeSource=C.label('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>parent.__corePwned=true</script><rect width="10" height="10" onload="parent.__corePwned=true"/></svg>');
    await build(unsafeSource.xml,[]);
    check(window.__corePwned===false,'existing source executed outside sandbox');
    check(snapshot()===initial,'AI core changed main SVG');
    check(frames()===baseFrames,'sandbox iframe leaked');
    results.push('source rendering isolated by scriptless CSP sandbox; success/failure frames always cleaned');

    for(const candidate of mosCandidates) {
      const before=snapshot();
      check(aiUseSnapshot({xml:candidate.xml,label:'MOS regression',parentId:null,safeXML:before}),candidate.mode+' candidate adoption failed');
      const adopted=doc.querySelector('#generated-'+candidate.kind), exported=parse(buildSVGString()).querySelector('#generated-'+candidate.kind);
      check(adopted && adopted.getAttribute('data-library-shape')===candidate.kind,'adoption lost '+candidate.kind+' marker');
      check(exported && exported.getAttribute('data-library-shape')===candidate.kind,'export lost '+candidate.kind+' marker');
      check(exported.children.length===(candidate.kind==='pmos'?6:5),'export flattened MOS native geometry');
      undo(); check(parse(snapshot()).isEqualNode(parse(before)),'adopted MOS cannot be undone');
    }
    check(frames()===baseFrames,'MOS regression leaked a sandbox iframe');
    results.push('all six MOS insert/replace/document candidates adopt and export with metadata/native geometry intact, and undo cleanly');
    const beforeAriaAdopt=snapshot(), ariaUndoCount=state.undo.length;
    check(aiUseSnapshot({xml:ariaCandidates.at(-1),label:'Accessibility regression',parentId:null,safeXML:beforeAriaAdopt}),'aria-label candidate adoption failed');
    for(const candidate of [doc,parse(buildSVGString())]) {
      check(candidate.getAttribute('aria-label')===ariaLabel && candidate.querySelector('#aria-module').getAttribute('aria-label')===ariaLabel,'adoption/export lost root or group aria-label');
    }
    check(state.undo.length===ariaUndoCount+1,'aria-label candidate did not add exactly one undo step');
    undo(); check(parse(snapshot()).isEqualNode(parse(beforeAriaAdopt)),'aria-label candidate adoption cannot be undone');
    results.push('aria-label candidate adopts and exports with exact metadata, and restores the previous drawing in one undo');
    return {ok:true,tests:results};
  };
  console.log(JSON.stringify(await evalJS('('+run.toString()+')()'),null,2));
}).catch(error=>{console.error(error);process.exitCode=1;});
