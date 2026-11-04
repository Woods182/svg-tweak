// Geometry regressions: converted group/multi resize, transformed dragging, and bounded nudge transforms.
const assert = require('assert/strict');
const {withEditor} = require('./browser.cjs');

withEditor(async ({evalJS,send}) => {
  const results=[];
  for(const mode of ['group','multi']) {
    const setup=await evalJS(`(async()=>{
      const shapes='<rect id="rot" x="80" y="80" width="80" height="40" transform="rotate(30 120 100)" stroke="black" stroke-width="2" fill="none"/><path id="path" d="M 30 30 L 60 30 L 60 200" stroke="black" fill="none"/><circle id="circle" cx="220" cy="80" r="20" stroke="black" stroke-width="3" fill="none"/><ellipse id="ellipse" cx="220" cy="150" rx="25" ry="15" stroke="black" stroke-width="4" fill="none"/><text id="text" x="40" y="245" font-size="18">Unscaled</text>';
      loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 400">'+(${JSON.stringify(mode)}==='group'?'<g id="group">'+shapes+'</g>':shapes)+'</svg>','scale-'+${JSON.stringify(mode)}+'.svg');
      await new Promise(r=>setTimeout(r,120));
      $('szLock').checked=false;
      select(${JSON.stringify(mode)}==='group'?[doc.querySelector('#group')]:[...doc.children]);
      const st=stageRect(), h=resizeHandles().find(h=>h.k==='r');
      let clientWidth,anchor;
      if(${JSON.stringify(mode)}==='group'){
        const g=doc.querySelector('#group'),fr=frameOf(g),pm=parentCTMOf(g);clientWidth=fr.w*Math.hypot(pm.a,pm.b);anchor=fr.bbox.x;
      }else{const gs=groupScaleSet();clientWidth=gs.box.w*Math.hypot(doc.getScreenCTM().a,doc.getScreenCTM().b);anchor=gs.box.x;}
      window.__ellipseMetric=e=>{const m=localToRoot(e),rx=parseFloat(e.getAttribute('rx')||e.getAttribute('r')),ry=parseFloat(e.getAttribute('ry')||e.getAttribute('r'));return{center:AFF.pt(m,+e.getAttribute('cx'),+e.getAttribute('cy')),rx:Math.hypot(m.a*rx,m.c*ry),ry:Math.hypot(m.b*rx,m.d*ry),cov:m.a*m.b*rx*rx+m.c*m.d*ry*ry};};
      window.__readScale=()=>{
        const el=doc.querySelector('#rot'),m=localToRoot(el),pts=tag(el)==='rect'?[[80,80],[160,80],[160,120],[80,120]].map(([x,y])=>({x,y})):polyPoints(el.getAttribute('points'));
        return {vertices:pts.map(p=>AFF.pt(m,p.x,p.y)),circle:window.__ellipseMetric(doc.querySelector('#circle')),ellipse:window.__ellipseMetric(doc.querySelector('#ellipse')),font:getComputedStyle(doc.querySelector('#text')).fontSize,stroke:getComputedStyle(doc.querySelector('#rot')).strokeWidth};
      };
      return {x:st.left+h.x,y:st.top+h.y,clientWidth,anchor,before:window.__readScale()};
    })()`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:setup.x,y:setup.y,modifiers:1});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:setup.x,y:setup.y,button:'left',buttons:1,clickCount:1,modifiers:1});
    const steps=[];
    for(const ratio of [1.2,1.3,.9,1]){
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:setup.x+setup.clientWidth*(ratio-1),y:setup.y,button:'left',buttons:1,modifiers:1});
      const out=await evalJS('({shape:window.__readScale(),scale:state.resizing.sxCur,mode:state.resizing.mode,converted:state.resizing.converted})');
      const errors=out.shape.vertices.flatMap((p,i)=>[Math.abs(p.x-(setup.anchor+(setup.before.vertices[i].x-setup.anchor)*ratio)),Math.abs(p.y-setup.before.vertices[i].y)]);
      const maxVertexError=Math.max(...errors);
      assert.ok(maxVertexError<.05,mode+' ratio '+ratio+' vertex error '+maxVertexError);
      assert.ok(Math.abs(out.shape.circle.rx-20*ratio)<.02,mode+' circle x radius at '+ratio+' '+JSON.stringify(out.shape.circle));
      assert.ok(Math.abs(out.shape.circle.ry-20)<.02,mode+' circle y radius at '+ratio);
      assert.ok(Math.abs(out.shape.ellipse.rx-25*ratio)<.02,mode+' ellipse x radius at '+ratio);
      assert.ok(Math.abs(out.shape.ellipse.ry-15)<.02,mode+' ellipse y radius at '+ratio);
      for(const id of ['circle','ellipse']){
        const expectedX=setup.anchor+(setup.before[id].center.x-setup.anchor)*ratio;
        assert.ok(Math.abs(out.shape[id].center.x-expectedX)<.03,mode+' '+id+' center x at '+ratio+' actual='+out.shape[id].center.x+' expected='+expectedX+' applied='+out.scale);
        assert.ok(Math.abs(out.shape[id].center.y-setup.before[id].center.y)<.03,mode+' '+id+' center y at '+ratio);
      }
      assert.equal(out.shape.font,setup.before.font);
      assert.equal(out.shape.stroke,setup.before.stroke);
      steps.push({ratio,maxVertexError,scaleRecorded:out.scale,converted:out.converted,mode:out.mode});
    }
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:setup.x,y:setup.y,button:'left',buttons:0,modifiers:1});
    results.push({test:'scale '+mode,steps});
  }

  const ellipseOrder = await evalJS(`(() => {
    loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 400"><ellipse id="affine-ellipse" cx="220" cy="80" rx="20" ry="18" transform="translate(17 23) rotate(90 220 80)" stroke="black" stroke-width="3"/></svg>', 'ellipse-order.svg');
    const el = doc.querySelector('#affine-ellipse'), before = localToRoot(el);
    const affine = {a:1,b:0,c:0,d:2,e:0,f:0}, expectedMatrix = AFF.mul(before, affine);
    const expected = AFF.pt(expectedMatrix,220,80);
    const next = applyAffine(el,affine), after = localToRoot(next);
    const actual = AFF.pt(after,+next.getAttribute('cx'),+next.getAttribute('cy'));
    const rx = +next.getAttribute('rx'), ry = +next.getAttribute('ry');
    return {expected,actual,
      radiusX:Math.hypot(after.a*rx,after.c*ry), expectedRadiusX:Math.hypot(expectedMatrix.a*20,expectedMatrix.c*18),
      radiusY:Math.hypot(after.b*rx,after.d*ry), expectedRadiusY:Math.hypot(expectedMatrix.b*20,expectedMatrix.d*18),
      stroke:next.getAttribute('stroke-width')};
  })()`);
  assert.ok(Math.hypot(ellipseOrder.actual.x-ellipseOrder.expected.x,ellipseOrder.actual.y-ellipseOrder.expected.y)<.001,'local ellipse rotation must follow existing transform');
  assert.ok(Math.abs(ellipseOrder.radiusX-ellipseOrder.expectedRadiusX)<.001,'ellipse x radius');
  assert.ok(Math.abs(ellipseOrder.radiusY-ellipseOrder.expectedRadiusY)<.001,'ellipse y radius');
  assert.equal(ellipseOrder.stroke,'3');
  results.push({test:'ellipse local-axis rotation follows existing transform',...ellipseOrder});

  const dragSetup=await evalJS(`(async()=>{
    loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450"><g transform="translate(20 30) rotate(25) scale(1.3 .8)"><path id="drag" d="M 80 80 L 140 80 L 140 130 L 80 130 Z" transform="translate(5 6) rotate(-17)" fill="orange" stroke="black" stroke-width="3"/></g></svg>','move.svg');
    await new Promise(r=>setTimeout(r,120));
    state.zoom=1;centerDoc();applyZoom();setNodeMode(false);select([doc.querySelector('#drag')]);
    window.__readMove=()=>{const el=doc.querySelector('#drag'),r=el.getBoundingClientRect(),m=localToRoot(el);return {x:r.x,y:r.y,w:r.width,h:r.height,point:AFF.pt(m,80,80),transform:el.getAttribute('transform'),items:el.transform.baseVal.numberOfItems,stroke:getComputedStyle(el).strokeWidth};};
    const b=window.__readMove();return {before:b,x:b.x+b.w/2,y:b.y+b.h/2};
  })()`);
  let dragX=dragSetup.x,dragY=dragSetup.y;
  for(const [dx,dy] of [[20,25],[3,-7]]){
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragX,y:dragY,modifiers:1});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:dragX,y:dragY,button:'left',buttons:1,clickCount:1,modifiers:1});
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragX+dx/2,y:dragY+dy/2,button:'left',buttons:1,modifiers:1});
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragX+dx,y:dragY+dy,button:'left',buttons:1,modifiers:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragX+dx,y:dragY+dy,button:'left',buttons:0,modifiers:1});
    dragX+=dx;dragY+=dy;
  }
  const dragAfter=await evalJS('window.__readMove()');
  assert.ok(Math.abs(dragAfter.x-dragSetup.before.x-23)<.03,'drag x');
  assert.ok(Math.abs(dragAfter.y-dragSetup.before.y-18)<.03,'drag y');
  assert.ok(Math.abs(dragAfter.w-dragSetup.before.w)<.01,'drag width');
  assert.ok(Math.abs(dragAfter.h-dragSetup.before.h)<.01,'drag height');
  assert.equal(dragAfter.stroke,dragSetup.before.stroke);
  assert.ok(dragAfter.items<=3,'drag transforms bounded');
  results.push({test:'repeated transformed drag',before:dragSetup.before,after:dragAfter});

  const mixedMove=await evalJS(`(async()=>{
    loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450"><path id="skew" d="M 30 30 L 60 30 L 60 80 Z" transform="matrix(1 .2 .4 1 12 15)" stroke="black" stroke-width="2"/><rect id="byattr" x="150" y="120" width="40" height="30" transform="rotate(25)" stroke="black" stroke-width="3"/><text id="bytext" x="200" y="220" font-size="24"><tspan x="200" y="220">First</tspan><tspan x="200" y="250">Second</tspan></text></svg>','mixed-move.svg');
    await new Promise(r=>setTimeout(r,120));
    state.zoom=1;centerDoc();applyZoom();setNodeMode(false);
    const els=['skew','byattr','bytext'].map(id=>doc.querySelector('#'+id));
    const read=()=>els.map(el=>{const r=el.getBoundingClientRect();return{id:el.id,x:r.x,y:r.y,w:r.width,h:r.height,transform:el.getAttribute('transform'),font:getComputedStyle(el).fontSize,stroke:getComputedStyle(el).strokeWidth,spans:[...el.querySelectorAll('tspan')].map(s=>[s.getAttribute('x'),s.getAttribute('y')])};});
    const before=read(),snaps=els.map(el=>[el,elSnapshot(el)]);
    moveSelectionByRoot(5,6,snaps);moveSelectionByRoot(13,-8,snaps);
    return {before,after:read()};
  })()`);
  mixedMove.after.forEach((a,i)=>{const b=mixedMove.before[i];assert.ok(Math.abs(a.x-b.x-13)<.02,'mixed move x '+a.id);assert.ok(Math.abs(a.y-b.y+8)<.02,'mixed move y '+a.id);assert.ok(Math.abs(a.w-b.w)<.02,'mixed move width '+a.id);assert.ok(Math.abs(a.h-b.h)<.02,'mixed move height '+a.id);assert.equal(a.font,b.font);assert.equal(a.stroke,b.stroke);if(a.id!=='skew')assert.equal(a.transform,b.transform);});
  results.push({test:'skew matrix and byAttr rect/multiline text, absolute drag snapshots',...mixedMove});

  const nudge=await evalJS(`(async()=>{
    loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450"><path id="nudge" d="M 30 30 L 60 30 L 60 80 Z" transform="translate(5 6) rotate(20)" stroke="black" stroke-width="2" fill="orange"/><g id="nudgegroup" transform="translate(150 100) rotate(-10)"><rect x="0" y="0" width="40" height="30" fill="blue"/></g></svg>','nudge.svg');
    await new Promise(r=>setTimeout(r,120));
    state.zoom=1;centerDoc();applyZoom();setNodeMode(false);
    select([doc.querySelector('#nudge'),doc.querySelector('#nudgegroup')]);
    const read=()=>['nudge','nudgegroup'].map(id=>{const el=doc.querySelector('#'+id),r=el.getBoundingClientRect();return{id,x:r.x,y:r.y,w:r.width,h:r.height,items:el.transform.baseVal.numberOfItems,transform:el.getAttribute('transform'),stroke:getComputedStyle(el).strokeWidth};});
    const before=read();document.body.focus();
    for(let i=0;i<200;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    const after=read();return {before,after,errors:window.__auditErrors};
  })()`);
  nudge.after.forEach((a,i)=>{
    const b=nudge.before[i];
    assert.ok(Math.abs(a.x-b.x-200)<.03,'nudge x '+a.id);
    assert.ok(Math.abs(a.y-b.y)<.03,'nudge y '+a.id);
    assert.ok(Math.abs(a.w-b.w)<.03,'nudge width '+a.id);
    assert.ok(Math.abs(a.h-b.h)<.03,'nudge height '+a.id);
    assert.ok(a.items<=3,'nudge transform count '+a.id);
    assert.equal(a.stroke,b.stroke);
  });
  assert.deepEqual(nudge.errors,[]);
  results.push({test:'200 actual ArrowRight events',...nudge});
  console.log(JSON.stringify({ok:true,results},null,2));
}).catch(e=>{console.error(e);process.exitCode=1;});
