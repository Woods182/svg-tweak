// Run: node tests/text.cjs
const assert = require('node:assert/strict');
const { withEditor } = require('./browser.cjs');

withEditor(async ({ evalJS, send }) => {
  const results = await evalJS(String.raw`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const load = async text => {
      loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="240" viewBox="0 0 500 240">' + text + '</svg>', 'text-test.svg');
      await wait(60);
      const el = doc.querySelector('text'); select([el]); return el;
    };
    const edited = await load('<text id="t" x="10" y="30" font-size="16">A<tspan fill="red" font-size="24">B</tspan>C</text>');
    startTextEdit(edited); $('textInput').value = 'ABCD'; commitTextEdit();
    const style = { xml:edited.outerHTML, content:textValue(edited), spans:[...edited.querySelectorAll('tspan')].map(s => ({text:s.textContent, fill:getComputedStyle(s).fill, size:getComputedStyle(s).fontSize})) };
    const multi = await load('<text id="m" x="10" y="30" font-size="16">A<tspan x="12" dy="35">B<tspan fill="red" font-size="24">C</tspan></tspan><tspan x="14" dy="42">D</tspan></text>');
    const oldXML = multi.outerHTML;
    startTextEdit(multi);
    const inputValue = $('textInput').value;
    const inputRows = $('textInput').rows;
    commitTextEdit();
    const unchanged = oldXML === multi.outerHTML;
    startTextEdit(multi); $('textInput').value = 'A\nBCE\nD'; commitTextEdit();
    const multiline = { inputValue, inputRows, unchanged, content:textValue(multi), lines:[...multi.children].filter(s => s.hasAttribute('dy')).map(s => ({x:s.getAttribute('x'),dy:s.getAttribute('dy')})), preserved:[...multi.querySelectorAll('tspan')].find(s => s.textContent.includes('C') && s.hasAttribute('font-size'))?.outerHTML };
    const undoXML = multi.outerHTML;
    undo(); const undoText = textValue(doc.querySelector('#m'));
    redo(); const redoMatches = doc.querySelector('#m').outerHTML === undoXML;
    const fresh = createTextAt(stageRect().left + 100, stageRect().top + 100);
    $('textInput').value = 'New text';
    $('textInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    const created = { content:textValue(fresh), editing:!!editingEl };
    const transforms = ['translate(100 50) scale(2)','matrix(0 2 -2 0 160 80)','matrix(1.41421356 1.41421356 -1.41421356 1.41421356 100 50)','matrix(1.8 0.8 0.4 1.2 100 40)'];
    const rotation = [];
    for (const transform of transforms) {
      const t = await load('<text id="r" x="10" y="30" font-size="10" transform="' + transform + '">Rotate</text>');
      const read = () => { const fr=frameOf(t),m=matOfEl(t),d=decMat(m); return {cx:fr.cx,cy:fr.cy,sx:d.sx,sy:d.sy,font:$('txtSize').value,angle:$('txtRot').value,m}; };
      const before = read();
      $('txtRot').value='90'; $('txtRot').dispatchEvent(new Event('change'));
      const ninety = read();
      $('txtRot').value='0'; $('txtRot').dispatchEvent(new Event('change'));
      const zero = read();
      rotation.push({transform,before,ninety,zero});
    }
    await load('<text id="drag" x="20" y="40" font-size="16" transform="matrix(2 0 0 2 100 40)">Drag</text>');
    const t=doc.querySelector('#drag'), fr=frameOf(t), h=frameRotHandle(fr,frameInflate(t)), c=frameToStage(fr,0,0), sr=stageRect();
    const rad=37*Math.PI/180,dx=h.x-c.x,dy=h.y-c.y;
    return {style,multiline,undoText,redoMatches,created,rotation,drag:{x:sr.left+h.x,y:sr.top+h.y,toX:sr.left+c.x+Math.cos(rad)*dx-Math.sin(rad)*dy,toY:sr.top+c.y+Math.sin(rad)*dx+Math.cos(rad)*dy},errors:window.__auditErrors};
  })()`);
  assert.equal(results.style.content, 'ABCD');
  assert(results.style.spans.some(s => s.text === 'B' && s.fill === 'rgb(255, 0, 0)' && s.size === '24px'));
  assert.equal(results.multiline.inputValue, 'A\nBC\nD');
  assert.equal(results.multiline.inputRows, 3);
  assert.equal(results.multiline.unchanged, true);
  assert.equal(results.multiline.content, 'A\nBCE\nD');
  assert.deepEqual(results.multiline.lines, [{x:'12',dy:'35'},{x:'14',dy:'42'}]);
  assert(results.multiline.preserved.includes('font-size="24"'));
  assert.equal(results.undoText, 'A\nBC\nD');
  assert.equal(results.redoMatches, true);
  assert.deepEqual(results.created, {content:'New text',editing:false});
  for (const r of results.rotation) {
    for (const [read, angle] of [[r.ninety,'90'],[r.zero,'0']]) {
      assert.equal(read.angle, angle, r.transform);
      assert(Math.hypot(read.cx-r.before.cx,read.cy-r.before.cy)<0.3, JSON.stringify(r));
      assert(Math.abs(read.sx-r.before.sx)<0.002, r.transform);
      assert(Math.abs(read.sy-r.before.sy)<0.002, r.transform);
      assert.equal(read.font,r.before.font,r.transform);
    }
  }
  await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',buttons:1,clickCount:1,x:results.drag.x,y:results.drag.y});
  await send('Input.dispatchMouseEvent', {type:'mouseMoved',buttons:1,x:results.drag.toX,y:results.drag.toY});
  await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:results.drag.toX,y:results.drag.toY});
  const dragged = await evalJS(`({angle:$('txtRot').value,label:$('txtRot').selectedOptions[0]?.textContent,mainAngle:$('inpAngle').value,currentOptions:$('txtRot').querySelectorAll('option[data-current]').length,errors:window.__auditErrors})`);
  assert.equal(dragged.angle,'37');
  assert.equal(dragged.mainAngle,'37');
  assert.equal(dragged.currentOptions,1);
  assert.deepEqual(dragged.errors,[]);
  console.log(JSON.stringify({style:results.style,multiline:results.multiline,undoText:results.undoText,redoMatches:results.redoMatches,created:results.created,rotation:results.rotation,dragged},null,2));
  console.log('PASS: text formatting, multiline placement, undo/redo, new text, matrix rotation and mouse drag angle sync');
}).catch(e => { console.error(e); process.exitCode=1; });
