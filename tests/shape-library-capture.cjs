// Focused capture regressions: cascade, partial use targets, defs closure/inheritance and viewport units.
const {withEditor} = require('./browser.cjs');

withEditor(async ({evalJS,send}) => {
  await send('Network.setBlockedURLs',{urls:['*ai-config.js*','http://*','https://*']});
  const run=async()=>{
    const results=[];
    const check=(ok,message)=>{if(!ok)throw new Error(message);};
    const near=(a,b,message)=>check(Math.abs(a-b)<.05,message+': '+a+' != '+b);
    const parse=xml=>new DOMParser().parseFromString(xml,'image/svg+xml').documentElement;
    const blank='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="#aa00aa" color="#ee0000" font-family="Arial" font-size="8"/>';
    const load=xml=>{loadSVGText(xml,'capture-regression.svg');state.zoom=1;centerDoc();applyZoom();};
    const capture=(name,ids)=>{
      select(ids.map(id=>doc.querySelector('#'+id)));
      const before=snapshot(),undo=state.undo.length;
      $('libraryName').value=name;
      const item=librarySaveSelection();
      check(item,'capture failed: '+$('shapeLibraryStatus').textContent);
      check(snapshot()===before && state.undo.length===undo,'capture changed source document/history');
      return item;
    };
    const place=(item,xml=blank,x=300,y=200,zoom=1)=>{
      load(xml);state.zoom=zoom;centerDoc();applyZoom();
      setLibraryShape('custom:'+item.id);
      const p=new DOMPoint(x,y).matrixTransform(doc.getScreenCTM());
      placeLibraryShape(p.x,p.y);
      const g=[...state.sel][0];
      check(g && g.localName==='g' && g.parentNode===doc && libraryState.kind===null,'custom placement failed');
      return g;
    };
    const visible=(root,selector)=>[...root.querySelectorAll(selector)].filter(el=>!el.closest('defs'));
    const resolve=(root,value)=>{
      const id=value.match(/#([^'"\s)]+)/)?.[1];
      const el=id&&[root,...root.querySelectorAll('[id]')].find(el=>el.id===decodeURIComponent(id));
      check(el,'missing local reference '+value);return el;
    };
    const closed=root=>{
      const ids=[root,...root.querySelectorAll('[id]')].map(el=>el.id).filter(Boolean);
      check(new Set(ids).size===ids.length,'duplicate IDs in captured closure');
      for(const el of [root,...root.querySelectorAll('*')])for(const attr of el.attributes){
        if(attr.localName==='href')resolve(root,attr.value);
        for(const match of attr.value.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g))resolve(root,match[1]);
      }
    };
    const points=el=>{
      const length=el.getTotalLength(),m=localToRoot(el);
      return Array.from({length:9},(_,i)=>{const p=el.getPointAtLength(length*i/8);return AFF.pt(m,p.x,p.y);});
    };

    load('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="black"><g fill="black"><path id="cascade" d="M40 50H80V70H40Z" fill="red" style="fill:black"/><path id="unrotated" d="M140 50H180V70H140Z" transform="rotate(37 160 60)" style="transform:none"/></g></svg>');
    const original=['cascade','unrotated'].map(id=>({points:points(doc.querySelector('#'+id)),fill:getComputedStyle(doc.querySelector('#'+id)).fill}));
    const cascade=capture('CSS overrides presentation attributes',['cascade','unrotated']);
    const cascadeInstance=place(cascade),paths=visible(cascadeInstance,'path');
    check(paths.length===2,'cascade capture changed leaf count');
    const shift={x:points(paths[0])[0].x-original[0].points[0].x,y:points(paths[0])[0].y-original[0].points[0].y};
    paths.forEach((el,i)=>{
      check(getComputedStyle(el).fill===original[i].fill && original[i].fill==='rgb(0, 0, 0)','stale fill=red survived CSS override');
      points(el).forEach((p,j)=>{near(p.x,original[i].points[j].x+shift.x,'CSS transform override x');near(p.y,original[i].points[j].y+shift.y,'CSS transform override y');});
    });
    const unrotated=localToRoot(paths[1]);
    near(unrotated.a,1,'removed rotation a');near(unrotated.b,0,'removed rotation b');near(unrotated.c,0,'removed rotation c');near(unrotated.d,1,'removed rotation d');
    results.push('CSS fill/transform overrides remain effective when stale presentation attributes are stripped');

    load('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="red"><g id="motif"><path id="first-leaf" d="M20 20H40V40H20Z"/><path d="M100 20H120V40H100Z"/></g><use id="whole-motif" href="#motif" x="160" y="80" fill="blue"/></svg>');
    const sourceUse=doc.querySelector('#whole-motif').getBBox();
    const sourceSize={w:sourceUse.width,h:sourceUse.height};
    const partial=capture('partial visible ancestor plus complete use',['first-leaf','whole-motif']);
    const partialInstance=place(partial),use=partialInstance.querySelector('use'),motif=resolve(partialInstance,use.getAttribute('href'));
    closed(partialInstance);
    check(visible(partialInstance,'path').length===1,'partial visible group incorrectly captured its unselected sibling');
    check(motif.querySelectorAll('path').length===2,'use target reused a pruned visible ancestor');
    near(use.getBBox().width,sourceSize.w,'complete referenced motif width');near(use.getBBox().height,sourceSize.h,'complete referenced motif height');
    check(getComputedStyle(use).fill==='rgb(0, 0, 255)','use lost its own paint');
    check(!motif.style.fill && [...motif.querySelectorAll('path')].every(el=>!el.style.fill && !el.hasAttribute('fill')),'generic use target froze inherited source fill instead of inheriting from use');
    results.push('partial visible motif and a use of its complete ancestor remain separate, complete and independently inheriting');

    load('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" fill="red"><defs><g id="parent-definition"><path id="child-definition" d="M0 0H20V20H0Z"/><path d="M40 0H60V20H40Z"/></g></defs><use id="parent-use" href="#parent-definition" x="40" y="60" fill="green"/><use id="child-use" href="#child-definition" x="220" y="60" fill="blue"/></svg>');
    const parentChild=capture('parent and descendant definition references',['parent-use','child-use']);
    closed(parse(parentChild.svg));
    const parentChildInstance=place(parentChild),uses=visible(parentChildInstance,'use');
    closed(parentChildInstance);
    const parent=resolve(parentChildInstance,uses[0].getAttribute('href')),child=resolve(parentChildInstance,uses[1].getAttribute('href'));
    check(parent.localName==='g' && child.localName==='path' && parent.contains(child),'parent/child references no longer share their one complete definition subtree');
    check(parent.querySelectorAll('path').length===2,'parent definition lost another child');
    near(uses[0].getBBox().width,60,'parent reference width');near(uses[1].getBBox().width,20,'child reference width');
    const allIds=[...doc.querySelectorAll('[id]')].map(el=>el.id);
    check(new Set(allIds).size===allIds.length,'parent/child dependencies produced duplicate document IDs');
    results.push('simultaneous parent and child href dependencies keep one complete subtree, unique IDs and closed references');

    load('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" color="#aa5500" font-family="Georgia" font-size="19"><defs clip-rule="evenodd" color="#1b4d7a" font-family="monospace" font-size="17" font-weight="700"><clipPath id="hole"><path d="M50 50H150V150H50Z M75 75H125V125H75Z"/></clipPath><marker id="tip" viewBox="0 0 20 20" refX="20" refY="10" markerWidth="20" markerHeight="20" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L20 10L0 20Z" fill="currentColor"/><text x="1" y="13">M</text></marker></defs><path id="clipped" d="M50 50H150V150H50Z" fill="#dc2626" clip-path="url(#hole)"/><path id="wire" d="M200 80H320" fill="none" stroke="black" marker-end="url(#tip)"/></svg>');
    const inherited=el=>{const s=getComputedStyle(el);return {font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,color:s.color,fill:s.fill,rule:s.clipRule};};
    const resourceBefore={clip:inherited(doc.querySelector('#hole path')),marker:inherited(doc.querySelector('#tip')),text:inherited(doc.querySelector('#tip text')),path:inherited(doc.querySelector('#tip path'))};
    const resources=capture('defs ancestor styles',['clipped','wire']);
    const resourcesInstance=place(resources),resourcePaths=visible(resourcesInstance,'path');
    const clip=resolve(resourcesInstance,getComputedStyle(resourcePaths[0]).clipPath),marker=resolve(resourcesInstance,getComputedStyle(resourcePaths[1]).markerEnd);
    closed(resourcesInstance);
    for(const [name,el] of [['clip',clip.querySelector('path')],['marker',marker],['text',marker.querySelector('text')],['path',marker.querySelector('path')]]){
      const after=inherited(el),before=resourceBefore[name];
      for(const key of Object.keys(before))check(after[key]===before[key],'defs ancestor '+name+' '+key+' was lost: '+after[key]+' != '+before[key]);
    }
    check(getComputedStyle(clip.querySelector('path')).clipRule==='evenodd','clip hole winding rule was not inherited');
    results.push('clip-rule and marker font/color inherited from original defs survive capture and placement in a differently styled document');

    load('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="100 50 320 160"><rect id="percent" x="50%" y="50%" width="25%" height="25%" fill="#369"/></svg>');
    state.zoom=1.5;centerDoc();applyZoom();
    const percentBefore=bboxInRoot(doc.querySelector('#percent')),percent=capture('nonzero viewport percentages',['percent']);
    near(percentBefore.w,80,'source percent width');near(percentBefore.h,40,'source percent height');
    const percentInstance=place(percent,'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="-200 -100 1800 1200"/>',300,300,.75);
    const rect=visible(percentInstance,'rect')[0],box=bboxInRoot(rect),screen=rect.getBoundingClientRect(),m=doc.getScreenCTM(),scale=Math.hypot(m.a,m.b);
    near(box.w,80,'cross-document percent width');near(box.h,40,'cross-document percent height');
    near(box.x+box.w/2,300,'cross-document center x');near(box.y+box.h/2,300,'cross-document center y');
    near(screen.width,80*scale,'percent screen width follows actual CTM');near(screen.height,40*scale,'percent screen height follows actual CTM');
    check(rect.getAttribute('x')==='50%' && rect.getAttribute('width')==='25%','percentage geometry was flattened or rebound to new viewport');
    check([...percentInstance.querySelectorAll('svg')].some(svg=>svg.getAttribute('viewBox')==='100 50 320 160'),'original nonzero viewport was discarded');
    const beforeAI=snapshot(),ann=AIEditCore.label(beforeAI,[nodePathOf(percentInstance)]);
    const candidate=await AIEditCore.build(ann.xml,[{op:'move',targets:ann.selectedKeys,dx:5,dy:0}]);
    near(candidate.changes[0].after.x-candidate.changes[0].before.x,5,'AI move of native custom group');
    check(parse(candidate.xml).querySelector('rect[width="25%"]') && snapshot()===beforeAI,'AI build lost nested percentage SVG or changed live document');
    results.push('nonzero source viewport and percent geometry remain stable in a different document; native nested group remains AI-editable');
    check(!__auditErrors.length,'browser errors: '+JSON.stringify(__auditErrors));
    return {ok:true,results};
  };
  console.log(JSON.stringify(await evalJS('('+run.toString()+')()'),null,2));
}).catch(error=>{console.error(error);process.exitCode=1;});
