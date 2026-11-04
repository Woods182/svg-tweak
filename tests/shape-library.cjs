// Run: node tests/shape-library.cjs (isolated real browser; no API or network service).
const assert = require('node:assert/strict');
const {withEditor} = require('./browser.cjs');

const FORMAT = 'svg-tweak-shape-library';
const STORAGE = 'svgtweak.shapeLibrary';
const BUILTIN_KINDS = ['nmos','pmos','vdd','gnd','capacitor','junction','crossover'];
const NAME = '缓存 “电路” <img src=x onerror=alert(1)>';
const FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="50 -20 600 400" color="#305070" font-family="Arial">
  <style>.tile {stroke:#285d7c;stroke-width:3}.caption {font-size:15px;font-weight:600}</style>
  <defs>
    <linearGradient id="basePaint"><stop offset="0" stop-color="#e8b25a"/><stop offset="1" stop-color="#6cadbd"/></linearGradient>
    <linearGradient id="paint" href="#basePaint" x1="0" x2="1"/>
    <clipPath id="window"><rect x="8" y="18" width="76" height="50" rx="5"/></clipPath>
    <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#305070"/></marker>
    <g id="motif"><circle cx="0" cy="0" r="10" fill="#f1d18a"/><path d="M-5 0H5M0-5V5" fill="none"/></g>
  </defs>
  <g id="ancestor" transform="translate(110 65) rotate(17) scale(1.1 .85)" opacity=".8" stroke="#305070" stroke-width="2" fill="none">
    <rect id="tile" class="tile" x="10" y="20" width="70" height="45" rx="4" fill="url(#paint)" clip-path="url(#window)"/>
    <path id="wire" d="M0 82H100" marker-end="url(#arrow)"/>
    <use id="repeated" href="#motif" x="125" y="40"/>
    <text id="caption" class="caption" x="0" y="116" fill="currentColor" stroke="none">模块 A</text>
  </g>
  <rect id="unselectedSibling" x="500" y="20" width="20" height="20" fill="#ff00ff"/>
</svg>`;
const BLANK = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="50 -20 600 400"/>';
const simpleSVG = color => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><rect width="40" height="30" fill="${color}"/></svg>`;
const library = shapes => JSON.stringify({format:FORMAT,version:1,shapes});
const near = (actual,expected,label,tolerance=.06) => assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} != ${expected}`);

async function main() {
  const passed=[];
  await withEditor(async ({evalJS,send,delay})=>{
    const page=(fn,...args)=>evalJS('('+fn.toString()+')(...'+JSON.stringify(args)+')');
    async function waitFor(expression,label) {
      for(let i=0;i<150;i++) {
        try { if(await evalJS(expression))return; } catch(_) {}
        await delay(30);
      }
      throw new Error('Timed out: '+label);
    }
    const canvas=()=>page(()=>({
      xml:snapshot(),undo:state.undo.slice(),redo:state.redo.slice(),dirty:state.dirty,
      selection:[...state.sel].map(nodePathOf),fileName:state.fileName,
      ownHandle:!!window.__shapeOriginalHandle&&state.fileHandle===__shapeOriginalHandle,
      zoom:state.zoom,panX:state.panX,panY:state.panY
    }));
    const items=()=>page(()=>JSON.parse(JSON.stringify(libraryState.items)));
    const exportText=()=>page(()=>libraryExportText());
    const storage=()=>page(key=>localStorage.getItem(key),STORAGE);
    async function reload() {
      const token='reload-'+Math.random();
      await page(token=>window.__shapeReloadToken=token,token);
      await send('Page.reload');
      await waitFor(`window.__shapeReloadToken!==${JSON.stringify(token)}&&document.readyState==='complete'&&typeof librarySaveSelection==='function'&&Array.isArray(libraryState.items)`,'library initialization after real reload');
    }
    const clientPoint=(x,y)=>page((x,y)=>{
      const p=new DOMPoint(x,y).matrixTransform(doc.getScreenCTM());return {x:p.x,y:p.y};
    },x,y);
    const mouse=(type,p,extra={})=>send('Input.dispatchMouseEvent',{type,...p,...extra});
    async function clickAt(p) {
      await mouse('mouseMoved',p);
      await mouse('mousePressed',p,{button:'left',buttons:1,clickCount:1});
      await mouse('mouseReleased',p,{button:'left',buttons:0,clickCount:1});
    }
    const choose=id=>page(id=>{
      const card=[...$('customLibraryItems').querySelectorAll('button[data-shape-kind]')].find(b=>b.dataset.shapeKind==='custom:'+id);
      if(!card)throw new Error('Missing custom card '+id);card.click();
    },id);
    const samples=root=>page(root=>{
      const target=root==='source'?doc.querySelector('#ancestor'):window[root];
      return [...target.querySelectorAll('rect,path,use,text')].filter(el=>!el.closest('defs,clipPath,marker,symbol,pattern')).map(el=>{
        const b=el.getBBox(),m=localToRoot(el),style=getComputedStyle(el);
        let opacity=1;for(let current=el;current&&current!==doc;current=current.parentElement)opacity*=parseFloat(getComputedStyle(current).opacity);
        // Text ink BBoxes can change by a subpixel with glyph hinting at a new
        // screen translation. Compare the exact baseline anchor and typography.
        const points=el.localName==='text'?[el.getStartPositionOfChar(0)]:[[b.x,b.y],[b.x+b.width,b.y],[b.x+b.width,b.y+b.height],[b.x,b.y+b.height]].map(([x,y])=>({x,y}));
        return {tag:el.localName,text:el.localName==='text'?el.textContent:null,
          stroke:style.stroke,width:parseFloat(style.strokeWidth),fill:style.fill.startsWith('url(')?'url':style.fill,
          opacity,font:el.localName==='text'?{family:style.fontFamily,size:style.fontSize,weight:style.fontWeight}:null,
          points:points.map(({x,y})=>AFF.pt(m,x,y))};
      });
    },root);
    function compareSamples(actual,expected,label) {
      assert.equal(actual.length,expected.length,label+' graphic count');
      const shift={x:actual[0].points[0].x-expected[0].points[0].x,y:actual[0].points[0].y-expected[0].points[0].y};
      actual.forEach((leaf,i)=>{
        const before=expected[i];
        for(const key of ['tag','text','stroke','fill','font'])assert.deepEqual(leaf[key],before[key],label+' '+key);
        near(leaf.opacity,before.opacity,label+' effective inherited opacity',.001);
        near(leaf.width,before.width,label+' inherited stroke width',.001);
        leaf.points.forEach((p,j)=>{
          near(p.x,before.points[j].x+shift.x,label+' '+i+':'+leaf.tag+' point '+j+' relative x');
          near(p.y,before.points[j].y+shift.y,label+' '+i+':'+leaf.tag+' point '+j+' relative y');
        });
      });
    }
    const references=root=>page(root=>{
      const target=window[root],ids=[...target.querySelectorAll('[id]')].map(el=>el.id),refs=[];
      for(const el of [target,...target.querySelectorAll('*')])for(const attr of el.attributes){
        if((attr.localName==='href')&&attr.value.startsWith('#'))refs.push(attr.value.slice(1));
        for(const match of attr.value.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)){
          const value=match[1],hash=value.lastIndexOf('#');if(hash>=0)refs.push(value.slice(hash+1));
        }
      }
      return {ids,refs,closed:refs.every(id=>ids.includes(id)),allIds:[...doc.querySelectorAll('[id]')].map(el=>el.id)};
    },root);
    const definitions=root=>page(root=>{
      const target=root==='source'?doc:window[root];
      const visible=[...target.querySelectorAll('rect,path,use')].filter(el=>!el.closest('defs,clipPath,marker,symbol,pattern'));
      const resolve=value=>{
        const id=value.match(/#([^'"\s)]+)/)?.[1];
        const found=id&&[...target.querySelectorAll('[id]')].find(el=>el.id===decodeURIComponent(id));
        if(!found)throw new Error('Missing definition for '+value);return found;
      };
      const attrs=(el,names)=>Object.fromEntries(names.map(name=>[name,el.getAttribute(name)]));
      const rect=visible.find(el=>el.localName==='rect'),wire=visible.find(el=>el.localName==='path'),use=visible.find(el=>el.localName==='use');
      const gradients=[];let paint=resolve(getComputedStyle(rect).fill);
      for(let depth=0;paint&&depth<10;depth++){
        gradients.push({type:paint.localName,attrs:attrs(paint,['gradientUnits','gradientTransform','x1','y1','x2','y2','spreadMethod']),
          stops:[...paint.querySelectorAll(':scope > stop')].map(stop=>({offset:stop.getAttribute('offset'),color:getComputedStyle(stop).stopColor,opacity:getComputedStyle(stop).stopOpacity}))});
        const href=paint.getAttribute('href');paint=href?resolve(href):null;
      }
      const clip=resolve(getComputedStyle(rect).clipPath),marker=resolve(getComputedStyle(wire).markerEnd),motif=resolve(use.getAttribute('href'));
      return {gradients,clip:{type:clip.localName,units:clip.getAttribute('clipPathUnits'),rect:attrs(clip.querySelector('rect'),['x','y','width','height','rx'])},
        marker:{type:marker.localName,attrs:attrs(marker,['viewBox','refX','refY','markerWidth','markerHeight','orient']),path:marker.querySelector('path').getAttribute('d'),fill:getComputedStyle(marker.querySelector('path')).fill},
        motif:[...motif.children].map(el=>({type:el.localName,attrs:attrs(el,['cx','cy','r','d']),fill:getComputedStyle(el).fill}))};
    },root);

    await send('Network.setBlockedURLs',{urls:['*ai-config.js*','http://*','https://*']});
    assert.equal(await page(()=>['librarySaveSelection','libraryExportText','libraryImportText','libraryExportFile','libraryRemoveShape'].every(name=>typeof window[name]==='function')),true);
    const controls=await page(()=>({
      ids:['libraryName','librarySaveSelection','libraryImport','libraryExport','libraryFileInput','customLibraryItems','shapeLibraryStatus'].every(id=>!!$(id)),
      accept:$('libraryFileInput').accept,maxLength:$('libraryName').maxLength,
      builtins:[...$('shapeLibraryItems').querySelectorAll('[data-shape-kind]')].map(el=>el.dataset.shapeKind)
    }));
    assert.equal(controls.ids,true);assert.match(controls.accept,/\.json|application\/json/);assert.equal(controls.maxLength,80);
    assert.deepEqual(controls.builtins,BUILTIN_KINDS);assert.deepEqual(await items(),[]);
    passed.push('custom controls coexist with all built-in circuit symbol cards');

    await page(xml=>{
      window.__shapeOriginalHandle={name:'source.svg',kind:'file'};
      loadSVGText(xml,'source.svg',__shapeOriginalHandle);toggleShapeLibrary(true);
      state.zoom=1;centerDoc();applyZoom();
      pushUndo();doc.querySelector('#tile').setAttribute('rx','6');undo();markDirty(false);
      select([]);
    },FIXTURE);
    const noSelection=await canvas();
    assert.equal(await page(()=>librarySaveSelection()),null);
    assert.deepEqual(await items(),[]);assert.deepEqual(await canvas(),noSelection);
    await page(()=>select(['caption','repeated','wire','tile'].map(id=>doc.querySelector('#'+id))));
    const sourceSamples=await samples('source'),sourceDefinitions=await definitions('source'),saveBefore=await canvas();
    const saveResult=await page(name=>{$('libraryName').value=name;$('librarySaveSelection').click();return {item:libraryState.items[0]||null,status:$('shapeLibraryStatus').textContent};},NAME);
    assert.ok(saveResult.item,'selection capture: '+saveResult.status);const saved=saveResult.item;
    assert.ok(saved.id);assert.equal(saved.name,NAME);assert.ok(saved.svg);
    assert.deepEqual(await canvas(),saveBefore,'saving and naming a selection must leave canvas/history/selection/file binding unchanged');
    assert.equal(await page(name=>[...$('customLibraryItems').querySelectorAll('span')].some(el=>el.textContent===name&&el.children.length===0),NAME),true,'names are text, not HTML');
    assert.equal(await page(()=>$('customLibraryItems').querySelector('script,img[onerror]')),null);
    const savedXML=await page(xml=>{
      const parsed=new DOMParser().parseFromString(xml,'image/svg+xml'),svg=parsed.documentElement;
      return {viewBox:svg.getAttribute('viewBox').split(/[ ,]+/).map(Number),invalid:!!parsed.querySelector('parsererror,script,style,foreignObject'),
        gradients:svg.querySelectorAll('linearGradient').length,clips:svg.querySelectorAll('clipPath').length,markers:svg.querySelectorAll('marker').length,uses:svg.querySelectorAll('use').length};
    },saved.svg);
    assert.deepEqual(savedXML.viewBox.slice(0,2),[0,0]);assert.ok(savedXML.viewBox[2]>0&&savedXML.viewBox[3]>0);
    assert.equal(savedXML.invalid,false);assert.ok(savedXML.gradients>=2&&savedXML.clips===1&&savedXML.markers===1&&savedXML.uses===1);
    assert.deepEqual(JSON.parse(await storage()),JSON.parse(await exportText()));
    await page(()=>{doc.querySelector('#tile').setAttribute('width','12');doc.querySelector('#basePaint stop').setAttribute('stop-color','red');});
    assert.equal((await items())[0].svg,saved.svg,'saved templates are detached from source edits');
    passed.push('saving nested reverse-order selections captures geometry/styles/defs without editing the source; names remain plain text');

    await reload();
    assert.deepEqual(await items(),[saved],'same-profile page reload must restore the custom library');
    assert.equal(await page(id=>[...$('customLibraryItems').querySelectorAll('[data-shape-kind]')].some(b=>b.dataset.shapeKind==='custom:'+id),saved.id),true);
    assert.deepEqual(await page(()=>[...$('shapeLibraryItems').querySelectorAll('[data-shape-kind]')].map(el=>el.dataset.shapeKind)),BUILTIN_KINDS);
    passed.push('localStorage restores the named template and usable card across a real page reload');

    await page(xml=>{
      loadSVGText(xml,'placement.svg');toggleShapeLibrary(true);state.zoom=1;centerDoc();applyZoom();
      // Deliberate source-ID collisions must not leak references into new instances.
      const defs=createSvgEl('defs');defs.innerHTML='<linearGradient id="paint"><stop stop-color="red"/></linearGradient><clipPath id="window"><rect width="1" height="1"/></clipPath><g id="motif"/>';
      doc.appendChild(defs);markDirty(false);
    },BLANK);
    const placementStart=await canvas();
    await choose(saved.id);const hover=await clientPoint(300,160);await mouse('mouseMoved',hover);
    const ghost=await page(()=>({exists:!!$('libraryGhost'),inHUD:!!$('libraryGhost')&&hud.contains($('libraryGhost')),inDoc:!!doc.querySelector('#libraryGhost'),kind:libraryState.kind}));
    assert.deepEqual(ghost,{exists:true,inHUD:true,inDoc:false,kind:'custom:'+saved.id});
    assert.deepEqual(await canvas(),placementStart,'custom hover is HUD-only');
    const places=[{x:300,y:150,name:'__shapeFirst'},{x:460,y:270,name:'__shapeSecond'}];
    let firstPlacementXML;
    for(const [i,p] of places.entries()){
      if(i)await choose(saved.id);
      await clickAt(await clientPoint(p.x,p.y));
      const placed=await page((name)=>{
        const g=[...state.sel][0];window[name]=g;
        // A group's rotated ancestor-spine BBox can be looser than the union used
        // at capture time. Placement anchors the stored viewport, not that BBox.
        const svg=g.querySelector('svg'),box=svg.viewBox.baseVal;
        const center=AFF.pt(localToRoot(svg),box.x+box.width/2,box.y+box.height/2);
        return {root:g.parentNode===doc,selected:state.sel.size===1,kind:libraryState.kind,ghost:!!$('libraryGhost'),undo:state.undo.length,center,tag:g.localName};
      },p.name);
      assert.ok(placed.root&&placed.selected&&!placed.ghost);assert.equal(placed.tag,'g');assert.equal(placed.kind,null);
      assert.equal(placed.undo,placementStart.undo.length+i+1);
      near(placed.center.x,p.x,'custom placement center x');near(placed.center.y,p.y,'custom placement center y');
      compareSamples(await samples(p.name),sourceSamples,p.name);
      assert.deepEqual(await definitions(p.name),sourceDefinitions,'gradient stops, transitive href, clip/marker geometry and referenced motif retain their meaning');
      const refs=await references(p.name);
      assert.ok(refs.refs.length>=5&&refs.closed,'each instance owns its complete defs/use reference closure');
      assert.equal(new Set(refs.allIds).size,refs.allIds.length,'all source and instance IDs must remain unique');
      if(!i)firstPlacementXML=await page(()=>snapshot());
    }
    const edit=await page(()=>{
      const before=__shapeSecond.outerHTML,template=libraryState.items[0].svg;
      pushUndo();__shapeFirst.querySelector('linearGradient stop').setAttribute('stop-color','#ff00ff');__shapeFirst.querySelector('clipPath rect').setAttribute('width','10');
      return {unchanged:__shapeSecond.outerHTML===before,template:libraryState.items[0].svg===template};
    });
    assert.deepEqual(edit,{unchanged:true,template:true});
    const placedXML=await page(()=>{undo();return snapshot();});
    const undoRedo=await page(()=>{
      undo();const one=snapshot();undo();const empty=snapshot();redo();redo();return {one,empty,restored:snapshot()};
    });
    assert.equal(await page((a,b)=>aiSameXML(a,b),undoRedo.empty,placementStart.xml),true);
    assert.equal(await page((a,b)=>aiSameXML(a,b),undoRedo.restored,placedXML),true);
    assert.equal(await page((a,b)=>aiSameXML(a,b),undoRedo.one,firstPlacementXML),true,'one undo must remove exactly the latest placed instance');
    passed.push('real custom placement preserves inherited appearance and relative geometry; private defs/IDs, independent instances and one-step undo/redo');

    const portable=await page(()=>buildSVGString());
    await page((xml,key)=>{
      localStorage.removeItem(key);libraryState.items=[];loadSVGText(xml,'portable.svg');
      const groups=[...doc.children].filter(el=>el.localName==='g');
      window.__shapePortableFirst=groups[0];window.__shapePortableSecond=groups[1];
    },portable,STORAGE);
    assert.equal(await page(()=>doc.querySelectorAll('use').length),2);
    assert.equal(await page(()=>doc.querySelectorAll('linearGradient').length>=5),true);
    assert.equal(await page(()=>!!doc.querySelector('#libraryGhost')),false);
    for(const name of ['__shapePortableFirst','__shapePortableSecond']){
      compareSamples(await samples(name),sourceSamples,'portable '+name);
      assert.deepEqual(await definitions(name),sourceDefinitions,'portable definition semantics survive without library storage');
      assert.equal((await references(name)).closed,true,'portable references remain instance-local without library storage');
    }
    assert.deepEqual(await page(()=>__auditErrors),[]);
    assert.equal(await page(text=>libraryImportText(text),library([saved])),1);
    passed.push('placed SVG remains self-contained and editable when the library storage is removed');

    const beforeExports=await canvas();
    const fileExport=await page(async()=>{
      const old=Object.getOwnPropertyDescriptor(window,'showSaveFilePicker'),oldHandle=state.fileHandle;
      const marker={name:'canvas-original.svg'};state.fileHandle=marker;
      let options;const writes=[];
      Object.defineProperty(window,'showSaveFilePicker',{configurable:true,writable:true,value:async value=>{
        options=value;return {name:'shape-library.json',createWritable:async()=>({write:async data=>writes.push(typeof data==='string'?data:await data.text()),close:async()=>{}})};
      }});
      try{await libraryExportFile();return {options,writes,ownHandle:state.fileHandle===marker};}
      finally{state.fileHandle=oldHandle;if(old)Object.defineProperty(window,'showSaveFilePicker',old);else delete window.showSaveFilePicker;}
    });
    assert.equal(fileExport.writes.length,1);assert.equal(fileExport.ownHandle,true);
    assert.match(fileExport.options.suggestedName,/\.json$/);assert.deepEqual(JSON.parse(fileExport.writes[0]),JSON.parse(await exportText()));
    const exportFailure=await page(async()=>{
      const old=Object.getOwnPropertyDescriptor(window,'showSaveFilePicker'),oldHandle=state.fileHandle;
      let aborted=0,downloaded=0;const create=URL.createObjectURL;
      URL.createObjectURL=function(blob){downloaded++;return create.call(this,blob);};
      Object.defineProperty(window,'showSaveFilePicker',{configurable:true,writable:true,value:async()=>({
        createWritable:async()=>({write:async()=>{throw new Error('mock library write failure');},close:async()=>{},abort:async()=>aborted++})
      })});
      try{
        await libraryExportFile();
        const failed={status:$('shapeLibraryStatus').textContent,exporting:libraryState.exporting,disabled:$('libraryExport').disabled};
        window.showSaveFilePicker=async()=>{throw new DOMException('cancelled','AbortError');};await libraryExportFile();
        return {failed,aborted,downloaded,cancelReleased:!libraryState.exporting,ownHandle:state.fileHandle===oldHandle};
      }finally{URL.createObjectURL=create;if(old)Object.defineProperty(window,'showSaveFilePicker',old);else delete window.showSaveFilePicker;}
    });
    assert.match(exportFailure.failed.status,/导出失败.*mock library write failure/);
    const {failed,...failureOutcome}=exportFailure;
    assert.deepEqual(failureOutcome,{aborted:1,downloaded:0,cancelReleased:true,ownHandle:true});
    assert.equal(failed.exporting,false);assert.equal(failed.disabled,false);
    const download=await page(async()=>{
      const old=Object.getOwnPropertyDescriptor(window,'showSaveFilePicker'),create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
      const blobs=[],clicks=[];Object.defineProperty(window,'showSaveFilePicker',{configurable:true,writable:true,value:undefined});
      URL.createObjectURL=function(blob){blobs.push(blob);return create.call(this,blob);};
      HTMLAnchorElement.prototype.click=function(){clicks.push({name:this.download,href:this.href});};
      try{await libraryExportFile();return {clicks,text:await blobs[0].text()};}
      finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;if(old)Object.defineProperty(window,'showSaveFilePicker',old);else delete window.showSaveFilePicker;}
    });
    assert.equal(download.clicks.length,1);assert.match(download.clicks[0].name,/\.json$/);assert.match(download.clicks[0].href,/^blob:/);
    assert.deepEqual(JSON.parse(download.text),JSON.parse(await exportText()));
    assert.deepEqual(await canvas(),beforeExports,'both export paths leave the live SVG and file binding untouched');
    passed.push('single-JSON export works through picker/download; failed writes abort and cancellation releases controls without borrowing the SVG file handle');

    const roundtrip=await exportText();
    await page(key=>{localStorage.removeItem(key);libraryState.items=[];},STORAGE);await reload();
    assert.deepEqual(await items(),[]);
    await page(text=>{
      const dt=new DataTransfer();dt.items.add(new File([text],'portable-library.json',{type:'application/json'}));
      $('libraryFileInput').files=dt.files;$('libraryFileInput').dispatchEvent(new Event('change',{bubbles:true}));
    },roundtrip);
    await waitFor('libraryState.items.length===1','import file input');
    assert.deepEqual(await items(),[saved]);
    const mergeBefore=await canvas();
    assert.equal(await page(text=>libraryImportText(text),roundtrip),0,'identical import is idempotent');
    assert.equal(await page(text=>libraryImportText(text),library([])),0,'empty library is valid');
    const other={id:saved.id,name:saved.name,svg:simpleSVG('#35a7a0')};
    assert.equal(await page(text=>libraryImportText(text),library([other])),1);
    const merged=await items();assert.equal(merged.length,2);assert.notEqual(merged[1].id,saved.id);assert.equal(merged[1].name,saved.name);
    assert.equal(merged[0].svg,saved.svg);assert.equal(merged[1].svg,other.svg);
    assert.deepEqual(await canvas(),mergeBefore,'import/merge never loads a shape into the current canvas');
    passed.push('file import round-trips exported JSON; identical records skip and conflicting IDs get independent IDs without overwriting names or MOS');

    const invalidBefore={items:await items(),storage:await storage(),canvas:await canvas()};
    const valid={id:'valid-first',name:'valid first',svg:simpleSVG('#123456')};
    const invalid=[
      '{',JSON.stringify({format:'other',version:1,shapes:[]}),JSON.stringify({format:FORMAT,version:2,shapes:[]}),JSON.stringify({format:FORMAT,version:1,shapes:{}}),
      library([{...valid,name:''}]),library([{...valid,name:'n'.repeat(81)}]),library([{...valid,id:'i'.repeat(101)}]),
      library([valid,{id:'bad-second',name:'bad',svg:'<svg>'}]),
      library([{...valid,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>parent.__shapeInjected=1</script><rect width="10" height="10"/></svg>'}]),
      library([{...valid,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>rect{fill:red}</style><rect width="10" height="10"/></svg>'}]),
      library([{...valid,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.invalid/shape.png" width="10" height="10"/></svg>'}]),
      library([{...valid,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect onload="parent.__shapeInjected=1" width="10" height="10"/></svg>'}])
    ];
    for(const [i,text] of invalid.entries()){
      const error=await page(text=>{try{libraryImportText(text);return null;}catch(error){return error.message;}},text);
      assert.ok(error,'invalid import '+i+' must throw');
      assert.deepEqual(await items(),invalidBefore.items,'invalid import '+i+' must be atomic');
      assert.equal(await storage(),invalidBefore.storage);
    }
    const limitErrors=await page(()=>{
      const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
      const errors=[];for(const text of [JSON.stringify({format:'svg-tweak-shape-library',version:1,shapes:Array.from({length:201},(_,i)=>({id:'bulk-'+i,name:'bulk '+i,svg}))}),JSON.stringify({format:'svg-tweak-shape-library',version:1,shapes:[]})+' '.repeat(4*1024*1024)]){
        try{libraryImportText(text);errors.push(null);}catch(error){errors.push(error.message);}
      }return errors;
    });
    assert.match(limitErrors[0],/200/);assert.match(limitErrors[1],/4\s*MiB/i);
    assert.deepEqual(await items(),invalidBefore.items);assert.equal(await storage(),invalidBefore.storage);
    assert.deepEqual(await canvas(),invalidBefore.canvas);assert.equal(await page(()=>typeof __shapeInjected),'undefined');
    passed.push('invalid schema/names/SVG, executable or external resources and size/count limits reject atomically');

    const deleteId=merged[1].id,removeBefore=await canvas();
    await page(id=>{window.confirm=()=>false;libraryRemoveShape(id);},deleteId);assert.equal((await items()).length,2);
    await choose(deleteId);await mouse('mouseMoved',await clientPoint(200,150));
    await page(id=>{window.confirm=()=>true;const button=[...$('customLibraryItems').querySelectorAll('[data-remove-shape]')].find(b=>b.dataset.removeShape===id);button.click();},deleteId);
    assert.deepEqual(await items(),[saved]);assert.equal(await page(()=>libraryState.kind),null);assert.equal(await page(()=>!!$('libraryGhost')),false);
    assert.deepEqual(await canvas(),removeBefore);
    assert.deepEqual(await page(()=>[...$('shapeLibraryItems').querySelectorAll('[data-shape-kind]')].map(el=>el.dataset.shapeKind)),BUILTIN_KINDS);
    passed.push('confirmed deletion affects only the library record and cancels its armed placement; cancel keeps the record and built-ins are untouched');

    await page(xml=>{loadSVGText(xml,'quota.svg');select([doc.querySelector('#ancestor')]);$('libraryName').value='';},FIXTURE);
    const quotaBefore={canvas:await canvas(),storage:await storage()};
    const quota=await page(()=>{
      const old=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='svgtweak.shapeLibrary')throw new DOMException('full','QuotaExceededError');return old.call(this,key,value);};
      try{const added=librarySaveSelection();return {added:added&&{id:added.id,name:added.name},status:$('shapeLibraryStatus').textContent,count:libraryState.items.length,exported:JSON.parse(libraryExportText()).shapes.length};}
      finally{Storage.prototype.setItem=old;}
    });
    assert.ok(quota.added);assert.match(quota.added.name,/自定义形状/);assert.equal(quota.count,2);assert.equal(quota.exported,2);
    assert.match(quota.status,/导出/,'storage failure must make the export recovery path visible');
    assert.equal(await storage(),quotaBefore.storage);assert.deepEqual(await canvas(),quotaBefore.canvas);
    await reload();assert.deepEqual(await items(),[saved]);
    passed.push('storage quota failure keeps an exportable in-memory template, warns clearly and does not claim persisted success');

    await page(key=>localStorage.setItem(key,'{"broken":'),STORAGE);await reload();
    assert.deepEqual(await items(),[]);
    assert.deepEqual(await page(()=>[...$('shapeLibraryItems').querySelectorAll('[data-shape-kind]')].map(el=>el.dataset.shapeKind)),BUILTIN_KINDS);
    assert.deepEqual(await page(()=>__auditErrors),[]);
    passed.push('corrupt persisted JSON cannot prevent startup or remove the built-in library');
  });
  console.log('PASS: custom shape library ('+passed.length+' scenarios)');
  for(const name of passed)console.log('  '+name);
}

main().catch(error=>{console.error(error);process.exitCode=1;});
