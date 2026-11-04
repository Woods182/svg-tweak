// Native MOS library: preview, placement, normal editing and portable SVG output.
const assert = require('node:assert/strict');
const { withEditor } = require('./browser.cjs');

withEditor(async ({ evalJS, send }) => {
  const page = (fn, ...args) => evalJS('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const results = [];
  const near = (actual, expected, label, tolerance = .05) =>
    assert.ok(Math.abs(actual - expected) < tolerance, label + ': ' + actual + ' != ' + expected);
  const sameSVG = (left, right) => page((left, right) => {
    const parse = xml => new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
    return parse(left).isEqualNode(parse(right));
  }, left, right);
  const mouse = (type, point, extra = {}) => send('Input.dispatchMouseEvent', { type, ...point, ...extra });
  const click = async point => {
    await mouse('mouseMoved', point);
    await mouse('mousePressed', point, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', point, { button: 'left', buttons: 0 });
  };
  const reset = () => page(() => {
    setDrawMode(false); setRectMode(false); setTextMode(false); setNodeMode(false);
    loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"/>', 'mos-test.svg');
    toggleShapeLibrary(true);
    state.zoom = 1; centerDoc(); applyZoom();
    $('szLock').checked = false;
  });
  const clientPoint = (x, y) => page((x, y) => {
    const p = new DOMPoint(x, y).matrixTransform(doc.getScreenCTM());
    return { x: p.x, y: p.y };
  }, x, y);
  const choose = kind => page(kind => $('shapeLibraryItems').querySelector('[data-shape-kind="' + kind + '"]').click(), kind);

  const panel = await page(() => {
    const before = snapshot(), undo = state.undo.length, dirty = state.dirty;
    const initial = $('shapeLibrary').hidden;
    $('btnShapeLibrary').click();
    const open = !$('shapeLibrary').hidden && $('btnShapeLibrary').getAttribute('aria-expanded') === 'true';
    const separate = $('shapeLibrary').parentElement.tagName === 'MAIN' && !$('shapeLibrary').closest('aside');
    const cards = [...$('shapeLibraryItems').querySelectorAll('button[data-shape-kind]')].map(b => b.dataset.shapeKind);
    $('shapeLibraryClose').click();
    const closed = $('shapeLibrary').hidden && $('btnShapeLibrary').getAttribute('aria-expanded') === 'false';
    return { initial, open, separate, cards, closed, unchanged: snapshot() === before && state.undo.length === undo && state.dirty === dirty };
  });
  assert.deepEqual(panel, { initial: true, open: true, separate: true, cards: ['nmos', 'pmos', 'vdd', 'gnd', 'capacitor', 'junction', 'crossover'], closed: true, unchanged: true });
  results.push('independent library panel and toolbar');

  const geometry = await page(() => ['nmos', 'pmos'].map(kind => {
    const g = makeLibraryShape(kind); doc.appendChild(g);
    const b = g.getBBox();
    const result = {
      kind: g.dataset.libraryShape, tag: g.tagName, width: b.width, height: b.height,
      stroke: g.getAttribute('stroke'), lineWidth: g.getAttribute('stroke-width'), fill: g.getAttribute('fill'),
      children: [...g.children].map(el => ({ tag: el.tagName, attrs: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])) })),
      dependency: !!g.querySelector('use,image,[id],[href]')
    };
    g.remove(); return result;
  }));
  for (const [i, kind] of ['nmos', 'pmos'].entries()) {
    const g = geometry[i];
    assert.equal(g.kind, kind); assert.equal(g.tag, 'g');
    assert.equal(g.width, 40); assert.equal(g.height, 60);
    assert.equal(g.lineWidth, '1'); assert.equal(g.fill, 'none'); assert.ok(g.stroke);
    assert.equal(g.dependency, false);
    assert.deepEqual(g.children, [
      { tag: 'line', attrs: { x1: '24', y1: '12', x2: '24', y2: '48' } },
      { tag: 'line', attrs: { x1: '16', y1: '18', x2: '16', y2: '42' } },
      { tag: 'line', attrs: { x1: '0', y1: '30', x2: kind === 'pmos' ? '8' : '16', y2: '30' } },
      { tag: 'polyline', attrs: { points: '24,18 40,18 40,0' } },
      { tag: 'polyline', attrs: { points: '24,42 40,42 40,60' } },
      ...(kind === 'pmos' ? [{ tag: 'circle', attrs: { cx: '12', cy: '30', r: '4' } }] : [])
    ]);
  }
  results.push('40x60 native NMOS/PMOS geometry, shared terminals and inherited styles');

  await reset();
  await choose('pmos');
  const pointer = await clientPoint(220, 150);
  const previewBefore = await page(() => ({ xml: snapshot(), undo: state.undo.length, dirty: state.dirty }));
  await mouse('mouseMoved', pointer);
  const preview = await page(() => {
    window.__mosGhost = () => {
      const ghost = $('libraryGhost'), r = ghost.getBoundingClientRect(), m = doc.getScreenCTM();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height,
        scale: Math.hypot(m.a, m.b), opacity: +ghost.getAttribute('opacity'),
        inHud: hud.contains(ghost), inDoc: doc.contains(ghost), pointer: libraryState.pointer };
    };
    const before = window.__mosGhost();
    state.panX += 27; state.panY -= 19; state.zoom = 1.35; applyZoom();
    return { before, after: window.__mosGhost(), xml: snapshot(), undo: state.undo.length, dirty: state.dirty };
  });
  for (const p of [preview.before, preview.after]) {
    near(p.x, pointer.x, 'ghost center x'); near(p.y, pointer.y, 'ghost center y');
    near(p.width, 40 * p.scale, 'ghost width'); near(p.height, 60 * p.scale, 'ghost height');
    assert.ok(p.opacity > 0 && p.opacity < 1); assert.ok(p.inHud && !p.inDoc);
    assert.deepEqual(p.pointer, pointer);
  }
  assert.equal(preview.xml, previewBefore.xml); assert.equal(preview.undo, previewBefore.undo); assert.equal(preview.dirty, previewBefore.dirty);
  results.push('HUD-only ghost follows the screen pointer through pan and zoom');

  await reset();
  const placementStart = await page(() => snapshot());
  for (const [kind, x, y] of [['nmos', 220, 160], ['pmos', 380, 240]]) {
    await choose(kind);
    await click(await clientPoint(x, y));
    const placed = await page(kind => {
      const g = doc.querySelector('[data-library-shape="' + kind + '"]'), m = localToRoot(g);
      const points = collectSnapPoints([]);
      const terminals = [[0, 30], [40, 0], [40, 60]].map(([x, y]) => {
        const expected = AFF.pt(m, x, y), p = new DOMPoint(x, y).matrixTransform(g.getScreenCTM());
        const snapped = snapClientToVertex(p.x + 2, p.y + 1, points, 6);
        return { expected, snapped };
      });
      return { center: AFF.pt(m, 20, 30), transform: g.getAttribute('transform'), selected: state.sel.size === 1 && state.sel.has(g),
        undo: state.undo.length, kind: libraryState.kind, ghost: !!$('libraryGhost'), panel: !$('shapeLibrary').hidden, terminals };
    }, kind);
    near(placed.center.x, x, kind + ' placement x'); near(placed.center.y, y, kind + ' placement y');
    assert.match(placed.transform, /^translate\([^()]+\)$/);
    assert.ok(placed.selected && placed.panel && !placed.ghost); assert.equal(placed.kind, null);
    assert.equal(placed.undo, kind === 'nmos' ? 1 : 2);
    for (const { expected, snapped } of placed.terminals) {
      assert.ok(snapped, kind + ' terminal is available to line snapping');
      near(snapped.x, expected.x, kind + ' terminal x'); near(snapped.y, expected.y, kind + ' terminal y');
    }
  }
  const undoRedo = await page(() => {
    const placed = snapshot(); undo();
    const one = doc.querySelectorAll('[data-library-shape]').length;
    undo(); const empty = snapshot(); redo(); redo();
    return { one, empty, placed, restored: snapshot(), count: doc.querySelectorAll('[data-library-shape]').length };
  });
  assert.equal(undoRedo.one, 1); assert.ok(await sameSVG(undoRedo.empty, placementStart));
  assert.ok(await sameSVG(undoRedo.restored, undoRedo.placed)); assert.equal(undoRedo.count, 2);
  results.push('real pointer placement, one-step undo/redo and leaf endpoint snapping');

  await reset();
  const cancelPoint = await clientPoint(250, 180);
  for (const mode of ['escape', 'close', 'draw', 'rect', 'text', 'node', 'image', 'crop', 'restore', 'load']) {
    await page(() => { setDrawMode(false); setRectMode(false); setTextMode(false); setNodeMode(false); toggleShapeLibrary(true); });
    await choose('nmos'); await mouse('mouseMoved', cancelPoint);
    const before = await page(() => ({ xml: snapshot(), undo: state.undo.length, dirty: state.dirty, ghost: !!$('libraryGhost') }));
    assert.ok(before.ghost, mode + ' setup ghost');
    if (mode === 'escape') {
      await page(() => document.activeElement.blur());
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    } else {
      await page(async mode => {
        if (mode === 'close') $('shapeLibraryClose').click();
        if (mode === 'draw') $('btnDraw').click();
        if (mode === 'rect') $('btnRect').click();
        if (mode === 'text') $('btnText').click();
        if (mode === 'node') $('btnNode').click();
        if (mode === 'image') {
          // Opening the picker is enough; do not display a native file dialog in a test.
          const click = HTMLInputElement.prototype.click;
          HTMLInputElement.prototype.click = function () { if (this.type !== 'file') return click.call(this); };
          try { pickImageFile(); } finally { HTMLInputElement.prototype.click = click; }
        }
        if (mode === 'crop') await startCrop();
        if (mode === 'restore') restore(snapshot());
        if (mode === 'load') loadSVGText(snapshot(), 'mos-test.svg');
      }, mode);
    }
    const after = await page(() => ({ xml: snapshot(), undo: state.undo.length, dirty: state.dirty, kind: libraryState.kind, ghost: !!$('libraryGhost') }));
    assert.equal(after.kind, null, mode + ' cancels placement'); assert.equal(after.ghost, false, mode + ' removes ghost');
    assert.ok(await sameSVG(after.xml, before.xml), mode + ' leaves document unchanged');
    assert.equal(after.undo, before.undo, mode + ' does not add undo'); assert.equal(after.dirty, before.dirty, mode + ' leaves dirty unchanged');
  }
  results.push('Escape, close, draw/rect/text/node/image/crop and restore/load cancel cleanly');

  await reset(); await choose('pmos'); await click(await clientPoint(300, 200));
  const resize = await page(() => {
    const g = [...state.sel][0], b = bboxInRoot(g), h = resizeHandles().find(h => h.k === 'r'), s = stageRect();
    const m = doc.getScreenCTM();
    return { x: s.left + h.x, y: s.top + h.y, dx: b.w * Math.hypot(m.a, m.b) * .6, width: b.w, height: b.h };
  });
  await mouse('mouseMoved', { x: resize.x, y: resize.y });
  await mouse('mousePressed', { x: resize.x, y: resize.y }, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseMoved', { x: resize.x + resize.dx, y: resize.y }, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', { x: resize.x + resize.dx, y: resize.y }, { button: 'left', buttons: 0 });
  const resized = await page(() => {
    const g = [...state.sel][0], b = bboxInRoot(g), c = g.querySelector('circle,ellipse'), m = localToRoot(c);
    const rx = +(c.getAttribute('rx') || c.getAttribute('r')), ry = +(c.getAttribute('ry') || c.getAttribute('r'));
    return { width: b.w, height: b.h, rx: Math.hypot(m.a * rx, m.c * ry), ry: Math.hypot(m.b * rx, m.d * ry), lock: $('szLock').checked, undo: state.undo.length };
  });
  assert.ok(resized.width > resize.width * 1.4, 'actual resize enlarged the symbol');
  near(resized.width / resized.height, resize.width / resize.height, 'implicit symbol ratio lock', .002);
  near(resized.rx, resized.ry, 'PMOS bubble remains circular'); assert.equal(resized.lock, false); assert.equal(resized.undo, 2);
  results.push('single MOS resizes proportionally without Shift or global ratio lock');

  const drag = await page(() => {
    const g = [...state.sel][0], line = g.querySelector('line'), p = line.getPointAtLength(line.getTotalLength() / 2);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(line.getScreenCTM()), b = bboxInRoot(g), m = doc.getScreenCTM();
    return { x: screen.x, y: screen.y, before: b, scale: Math.hypot(m.a, m.b) };
  });
  await mouse('mouseMoved', { x: drag.x, y: drag.y });
  await mouse('mousePressed', { x: drag.x, y: drag.y }, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseMoved', { x: drag.x + 31, y: drag.y + 19 }, { button: 'left', buttons: 1, modifiers: 1 });
  await mouse('mouseReleased', { x: drag.x + 31, y: drag.y + 19 }, { button: 'left', buttons: 0, modifiers: 1 });
  const edited = await page(() => {
    const g = [...state.sel][0], moved = bboxInRoot(g);
    for (const [id, value] of [['inpAngle', '37'], ['inpStrokeText', '#d43f5a'], ['inpWidthNum', '2.5']]) {
      $(id).value = value; $(id).dispatchEvent(new Event('change'));
    }
    const leaves = [...g.children].map(el => {
      const style = getComputedStyle(el), m = localToRoot(el);
      return { stroke: style.stroke, width: parseFloat(style.strokeWidth) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) };
    });
    return { moved, kind: g.dataset.libraryShape, angle: currentRotationDeg(), leaves };
  });
  assert.equal(edited.kind, 'pmos');
  near(edited.moved.x - drag.before.x, 31 / drag.scale, 'ordinary group drag x');
  near(edited.moved.y - drag.before.y, 19 / drag.scale, 'ordinary group drag y');
  near(edited.moved.w, drag.before.w, 'drag width'); near(edited.moved.h, drag.before.h, 'drag height');
  near(edited.angle, 37, 'rotation input');
  for (const leaf of edited.leaves) { assert.equal(leaf.stroke, 'rgb(212, 63, 90)'); near(leaf.width, 2.5, 'inherited displayed line width'); }
  results.push('ordinary move, rotation, uniform stroke color and width editing');

  const output = await page(() => {
    const samples = root => [...root.querySelectorAll('line,polyline,circle,ellipse,path')].map(el => {
      const m = localToRoot(el), length = el.getTotalLength(), style = getComputedStyle(el);
      return { stroke: style.stroke, fill: style.fill, width: parseFloat(style.strokeWidth) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)),
        points: Array.from({ length: 17 }, (_, i) => { const p = el.getPointAtLength(length * i / 16); return AFF.pt(m, p.x, p.y); }) };
    });
    const before = samples(doc), xml = buildSVGString();
    const exported = new DOMParser().parseFromString(xml, 'image/svg+xml');
    const portable = !exported.querySelector('parsererror,use,image,[href],#libraryGhost') && exported.querySelectorAll('[data-library-shape="pmos"]').length === 1;
    loadSVGText(xml, 'roundtrip.svg');
    const reloaded = samples(doc), g = doc.querySelector('[data-library-shape="pmos"]');
    select([g]); ungroupSelection();
    const ungrouped = samples(doc), leavesSelected = state.sel.size === 6 && [...state.sel].every(el => el.parentNode === doc && !el.hasAttribute('data-library-shape'));
    undo(); const undoGroup = !!doc.querySelector('[data-library-shape="pmos"]'); redo();
    return { before, reloaded, ungrouped, portable, leavesSelected, undoGroup, redoLeaves: !doc.querySelector('[data-library-shape]'), errors: window.__auditErrors };
  });
  assert.ok(output.portable && output.leavesSelected && output.undoGroup && output.redoLeaves);
  for (const [label, leaves] of [['reload', output.reloaded], ['ungroup', output.ungrouped]]) {
    assert.equal(leaves.length, output.before.length, label + ' primitive count');
    leaves.forEach((leaf, i) => {
      const before = output.before[i]; assert.equal(leaf.stroke, before.stroke); assert.equal(leaf.fill, before.fill);
      near(leaf.width, before.width, label + ' line width');
      leaf.points.forEach((p, j) => { near(p.x, before.points[j].x, label + ' point x'); near(p.y, before.points[j].y, label + ' point y'); });
    });
  }
  assert.deepEqual(output.errors, []);
  results.push('portable export/reload and ungroup preserve geometry and styles, with undo/redo');
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
