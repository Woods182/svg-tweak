// Circuit symbols: exact sketch geometry, native pointer placement and reusable SVG output.
const assert = require('node:assert/strict');
const {withEditor} = require('./browser.cjs');

const KINDS = ['vdd','gnd','capacitor','junction','crossover'];
const SIZES = [[40,30],[40,40],[40,60],[40,40],[40,40]];
const SEGMENTS = {
  vdd:[[0,0,40,0],[20,0,20,30]],
  gnd:[[20,0,20,24],[0,24,40,24],[8,32,32,32],[16,40,24,40]],
  capacitor:[[20,0,20,24],[20,36,20,60],[0,24,40,24],[0,36,40,36]],
  junction:[[0,20,40,20],[20,0,20,40]]
};
const BLANK = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"/>';
const near = (actual,expected,label,tolerance=.05) =>
  assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} != ${expected}`);

withEditor(async ({evalJS,send}) => {
  const page = (fn,...args) => evalJS('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const results = [];
  const mouse = (type,p,extra={}) => send('Input.dispatchMouseEvent',{type,...p,...extra});
  const clientPoint = (x,y) => page((x,y) => {
    const p = new DOMPoint(x,y).matrixTransform(doc.getScreenCTM()); return {x:p.x,y:p.y};
  },x,y);
  const samples = () => page(() => [...doc.querySelectorAll('g[data-library-shape]')].map(g => {
    const b = bboxInRoot(g);
    return {kind:g.dataset.libraryShape,box:[b.x,b.y,b.w,b.h],leaves:[...g.querySelectorAll('line,path,circle')].map(el => {
      const cs = getComputedStyle(el),m = localToRoot(el),length = el.getTotalLength();
      return {tag:el.localName,fill:cs.fill,stroke:cs.stroke,width:cs.strokeWidth,
        points:Array.from({length:9},(_,i) => {const p=el.getPointAtLength(length*i/8);return AFF.pt(m,p.x,p.y);})};
    })};
  }));
  const compare = (actual,expected,label) => {
    assert.equal(actual.length,expected.length,label+' symbol count');
    actual.forEach((g,i) => {
      const before=expected[i]; assert.equal(g.kind,before.kind,label+' kind');
      g.box.forEach((n,j) => near(n,before.box[j],label+' bbox'));
      assert.equal(g.leaves.length,before.leaves.length,label+' primitive count');
      g.leaves.forEach((leaf,j) => {
        const source=before.leaves[j];
        for(const key of ['tag','fill','stroke','width'])assert.equal(leaf[key],source[key],label+' '+key);
        leaf.points.forEach((p,k) => {near(p.x,source.points[k].x,label+' x');near(p.y,source.points[k].y,label+' y');});
      });
    });
  };
  await send('Network.setBlockedURLs',{urls:['*ai-config.js*','http://*','https://*']});

  const geometry = await page(kinds => kinds.map(kind => {
    const shape=BUILTIN_LIBRARY_SHAPES[kind],g=makeLibraryShape(kind);doc.appendChild(g);
    try {
      const b=g.getBBox(),circle=g.querySelector('circle');
      const arc=[...g.querySelectorAll('path')].find(el => /A/.test(el.getAttribute('d')));
      const vertical=[...g.querySelectorAll('path')].find(el => !/A/.test(el.getAttribute('d')));
      return {kind:g.dataset.libraryShape,dimensions:[shape.w,shape.h],bounds:[b.x,b.y,b.width,b.height],name:shape.name,
        fill:g.getAttribute('fill'),stroke:g.getAttribute('stroke'),width:g.getAttribute('stroke-width'),
        lines:[...g.querySelectorAll('line')].map(el => ['x1','y1','x2','y2'].map(a => +el.getAttribute(a))),
        circle:circle&&{cx:+circle.getAttribute('cx'),cy:+circle.getAttribute('cy'),r:+circle.getAttribute('r'),ownFill:circle.hasAttribute('fill'),fill:getComputedStyle(circle).fill},
        arc:arc&&{d:arc.getAttribute('d'),top:arc.isPointInStroke(new DOMPoint(20,12)),middle:arc.isPointInStroke(new DOMPoint(20,20))},
        vertical:vertical&&{d:vertical.getAttribute('d'),gap:vertical.isPointInStroke(new DOMPoint(20,12)),below:vertical.isPointInStroke(new DOMPoint(20,20))},
        fills:[...g.children].map(el => getComputedStyle(el).fill),dependency:!!g.querySelector('use,image,rect,[id],[href]')};
    } finally {g.remove();}
  }),KINDS);
  for(const [i,kind] of KINDS.entries()) {
    const g=geometry[i];assert.equal(g.kind,kind);assert.ok(g.name.trim());
    assert.deepEqual(g.dimensions,SIZES[i]);assert.deepEqual(g.bounds,[0,0,...SIZES[i]]);
    assert.equal(g.stroke,'#111111');assert.equal(g.width,'1');assert.equal(g.dependency,false);
    assert.equal(g.fill,kind==='junction'?'#111111':'none');
    if(SEGMENTS[kind])assert.deepEqual(g.lines,SEGMENTS[kind],kind+' line endpoints');
    if(kind!=='junction')assert.ok(g.fills.every(fill => fill==='none'),kind+' remains transparent');
  }
  assert.deepEqual(geometry[3].circle,{cx:20,cy:20,r:3,ownFill:false,fill:'rgb(17, 17, 17)'});
  const cross=geometry[4];
  assert.equal(cross.arc.d,'M0 20H12A8 8 0 0 1 28 20H40');assert.ok(cross.arc.top&&!cross.arc.middle);
  assert.equal(cross.vertical.d,'M20 0V8M20 16V40');assert.ok(!cross.vertical.gap&&cross.vertical.below);
  results.push('VDD/GND/capacitor/junction geometry and transparent, genuinely gapped crossover match the sketches');

  await page(xml => {
    loadSVGText(xml,'circuit-test.svg');toggleShapeLibrary(true);$('chkWhite').checked=false;
    state.zoom=1.2;centerDoc();state.panX+=17;state.panY-=11;applyZoom();
  },BLANK);
  const empty=await page(() => snapshot());
  for(const [i,kind] of KINDS.entries()) {
    const x=100+i*95,y=185;
    await page(kind => $('shapeLibraryItems').querySelector('[data-shape-kind="'+kind+'"]').click(),kind);
    const p=await clientPoint(x,y),before=await page(() => ({xml:snapshot(),undo:state.undo.length,dirty:state.dirty}));
    await mouse('mouseMoved',p);
    const hover=await page(() => {
      const ghost=$('libraryGhost'),b=ghost.getBoundingClientRect(),m=doc.getScreenCTM();
      return {x:b.x+b.width/2,y:b.y+b.height/2,w:b.width,h:b.height,scale:Math.hypot(m.a,m.b),
        inHUD:hud.contains(ghost),inDoc:doc.contains(ghost),xml:snapshot(),undo:state.undo.length,dirty:state.dirty};
    });
    near(hover.x,p.x,kind+' ghost center x');near(hover.y,p.y,kind+' ghost center y');
    near(hover.w,SIZES[i][0]*hover.scale,kind+' ghost width');near(hover.h,SIZES[i][1]*hover.scale,kind+' ghost height');
    assert.ok(hover.inHUD&&!hover.inDoc);assert.equal(hover.xml,before.xml);assert.equal(hover.undo,before.undo);assert.equal(hover.dirty,before.dirty);
    await mouse('mousePressed',p,{button:'left',buttons:1,clickCount:1});
    await mouse('mouseReleased',p,{button:'left',buttons:0,clickCount:1});
    const placed=await page(() => {
      const g=[...state.sel][0],b=bboxInRoot(g);
      return {kind:g.dataset.libraryShape,root:g.parentNode===doc,center:[b.x+b.w/2,b.y+b.h/2],size:[b.w,b.h],
        undo:state.undo.length,armed:libraryState.kind,ghost:!!$('libraryGhost')};
    });
    assert.equal(placed.kind,kind);assert.ok(placed.root&&!placed.ghost);assert.equal(placed.armed,null);
    near(placed.center[0],x,kind+' placement x');near(placed.center[1],y,kind+' placement y');
    placed.size.forEach((n,j) => near(n,SIZES[i][j],kind+' placed dimension'));assert.equal(placed.undo,i+1);
  }
  const beforeUndo=await samples();
  const undoRedo=await page(({n,empty}) => {
    undo();const oneStep=doc.querySelectorAll('[data-library-shape]').length;
    for(let i=1;i<n;i++)undo();const blank=aiSameXML(snapshot(),empty);
    for(let i=0;i<n;i++)redo();return {oneStep,blank,count:doc.querySelectorAll('[data-library-shape]').length};
  },{n:KINDS.length,empty});
  assert.deepEqual(undoRedo,{oneStep:4,blank:true,count:5});compare(await samples(),beforeUndo,'undo/redo');
  results.push('all five real pointer ghosts/placements center correctly at non-default zoom; each placement has one undo step');

  const exported=await page(() => buildSVGString());
  const portability=await page(xml => {
    const parsed=new DOMParser().parseFromString(xml,'image/svg+xml');
    return {valid:!parsed.querySelector('parsererror'),kinds:[...parsed.querySelectorAll('[data-library-shape]')].map(el => el.dataset.libraryShape),
      dependency:!!parsed.querySelector('use,image,[href],#libraryGhost')};
  },exported);
  assert.deepEqual(portability,{valid:true,kinds:KINDS,dependency:false});
  await page(xml => loadSVGText(xml,'circuit-roundtrip.svg'),exported);compare(await samples(),beforeUndo,'SVG reload');
  results.push('native SVG export/reload preserves all new symbols, styles and transparent crossover without external resources');

  const saved=await page(() => {
    select([...doc.querySelectorAll('g[data-library-shape]')]);$('libraryName').value='电路符号组合';
    const before=snapshot(),undo=state.undo.length,item=librarySaveSelection();
    if(!item)throw new Error($('shapeLibraryStatus').textContent);
    const prepared=AIEditCore.prepareSVG(item.svg),json=libraryExportText();
    return {item,json,unchanged:snapshot()===before&&state.undo.length===undo,
      kinds:[...prepared.querySelectorAll('[data-library-shape]')].map(el => el.dataset.libraryShape)};
  });
  assert.ok(saved.unchanged);assert.deepEqual(saved.kinds,KINDS);
  const custom=await page(({json,xml}) => {
    libraryState.items=[];libraryRenderCustom();
    const imported=libraryImportText(json),item=libraryState.items[0];loadSVGText(xml,'custom-circuit.svg');
    setLibraryShape('custom:'+item.id);const p=new DOMPoint(300,200).matrixTransform(doc.getScreenCTM());placeLibraryShape(p.x,p.y);
    const g=[...state.sel][0],b=bboxInRoot(g),circle=g.querySelector('[data-library-shape="junction"] circle');
    const crossover=g.querySelector('[data-library-shape="crossover"]');
    return {imported,name:item.name,center:[b.x+b.w/2,b.y+b.h/2],kinds:[...g.querySelectorAll('[data-library-shape]')].map(el => el.dataset.libraryShape),
      dot:getComputedStyle(circle).fill,transparent:[...crossover.children].every(el => getComputedStyle(el).fill==='none'),
      native:!g.querySelector('use,image,[href]'),undo:state.undo.length,errors:__auditErrors};
  },{json:saved.json,xml:BLANK.replace('/>',' fill="#ffcc00" stroke="#ff00ff"/>')});
  assert.equal(custom.imported,1);assert.equal(custom.name,'电路符号组合');assert.deepEqual(custom.kinds,KINDS);
  near(custom.center[0],300,'custom compound center x');near(custom.center[1],200,'custom compound center y');
  assert.equal(custom.dot,'rgb(17, 17, 17)');assert.ok(custom.transparent&&custom.native);assert.equal(custom.undo,1);assert.deepEqual(custom.errors,[]);
  results.push('new metadata survives custom-library capture, strict static validation and JSON import; compound instances stay editable and independent of host styling');
  console.log(JSON.stringify({ok:true,results},null,2));
}).catch(error => {console.error(error);process.exitCode=1;});
