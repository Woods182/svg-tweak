const assert = require('node:assert/strict');
const { withEditor } = require('./browser.cjs');

withEditor(async ({ evalJS, send }) => {
  const result = await evalJS('(' + function () {
    const checks = [];
    function check(name, ok, details) { checks.push({ name, ok, details }); }
    const svg = content => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300">' + content + '</svg>';
    function samples(el) {
      const m = doc.getScreenCTM().inverse().multiply(el.getScreenCTM());
      const length = el.getTotalLength();
      return Array.from({ length: 33 }, (_, i) => {
        const p = el.getPointAtLength(length * i / 32);
        return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
      });
    }
    function mergeCheck(name, content) {
      loadSVGText(svg(content), name + '.svg');
      const els = [doc.querySelector('#a'), doc.querySelector('#b')];
      const before = els.map(samples);
      select(els); mergePaths();
      const merged = [...state.sel][0];
      const groups = [];
      for (const c of parsePathData(merged.getAttribute('d'))) {
        if (c.t === 'M') groups.push([]);
        groups[groups.length - 1].push(c);
      }
      let maxError = 0;
      groups.forEach((cmds, index) => {
        const part = merged.cloneNode(false);
        part.removeAttribute('id');
        part.setAttribute('d', serializePathData(cmds));
        merged.parentNode.appendChild(part);
        samples(part).forEach((p, i) => {
          maxError = Math.max(maxError, Math.hypot(p.x - before[index][i].x, p.y - before[index][i].y));
        });
        part.remove();
      });
      check(name, groups.length === 2 && maxError < 0.08, { subpaths: groups.length, maxError });
      undo();
      check(name + ' undo', !!doc.querySelector('#a') && !!doc.querySelector('#b'));
      redo();
      check(name + ' redo', state.sel.size === 1 && [...state.sel][0].tagName === 'path');
    }
    mergeCheck('translated lines', '<path id="a" transform="translate(100 0)" d="M0 20 L20 20"/><path id="b" transform="translate(200 0)" d="M0 20 L20 20"/>');
    mergeCheck('different parents and curves', '<g transform="translate(30 20) rotate(15)"><path id="a" d="M10 20 C30 70 50 0 80 40"/></g><g transform="translate(200 40) rotate(70)"><path id="b" d="M10 20 Q30 70 80 40"/></g>');
    mergeCheck('rotated elliptical arcs', '<path id="a" transform="translate(30 50) rotate(15) scale(1.2)" d="M20 70 A40 20 20 0 1 100 70"/><path id="b" transform="translate(220 90) rotate(-30) scale(1.5)" d="M10 40 A50 15 10 1 0 100 50"/>');

    const c = { rx: 40, ry: 10, rot: 0, sf: 1 };
    const cs = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
    transformArcCmd(c, { a: cs, b: sn, c: -sn, d: cs });
    check('ellipse matrix rotation', Math.abs(c.rot - 30) < 0.001 && Math.abs(c.rx - 40) < 0.001 && Math.abs(c.ry - 10) < 0.001, c);

    loadSVGText(svg('<g id="g" transform="translate(25 15) rotate(10)" style="fill:red;stroke:blue;stroke-width:4;font-size:30px;font-family:Times New Roman"><rect id="r" x="10" y="10" width="60" height="40"/><rect id="own" x="90" y="10" width="40" height="20" fill="green" style="stroke:purple"/><text id="t" x="10" y="100">Test</text><text id="s" x="120" y="100" font-size="18">Own size</text></g>'), 'ungroup.svg');
    const ids = ['r', 'own', 't', 's'];
    function appearance(id) {
      const el = doc.querySelector('#' + id), cs = getComputedStyle(el), b = bboxInRoot(el);
      return { fill: cs.fill, stroke: cs.stroke, width: cs.strokeWidth, size: cs.fontSize, font: cs.fontFamily, b };
    }
    function sameAppearance(left, right) {
      return left.every((a, i) => {
        const b = right[i];
        return ['fill','stroke','width','size','font'].every(key => a[key] === b[key]) &&
          ['x','y','w','h'].every(key => Math.abs(a.b[key] - b.b[key]) < 1e-7);
      });
    }
    const before = ids.map(appearance);
    select([doc.querySelector('#g')]); ungroupSelection();
    const after = ids.map(appearance);
    check('ungroup styles and child overrides', sameAppearance(before, after), {before, after});
    undo(); check('ungroup undo', !!doc.querySelector('#g'));
    redo(); check('ungroup redo', !doc.querySelector('#g') && sameAppearance(ids.map(appearance), after));
    return { checks, errors: window.__auditErrors };
  } + ')()');
  assert.deepEqual(result.errors, []);
  assert(result.checks.every(c => c.ok), JSON.stringify(result.checks.filter(c => !c.ok)));

  const useHistory = await evalJS('(' + function () {
    loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300"><defs><g id="flatten-symbol"><rect width="30" height="20" fill="#2288aa"/></g></defs><use href="#flatten-symbol" x="40" y="50"/></svg>', 'flatten-use.svg');
    clearSelection();
    const sameSVG = (a, b) => new DOMParser().parseFromString(a, 'image/svg+xml').documentElement.isEqualNode(new DOMParser().parseFromString(b, 'image/svg+xml').documentElement);
    const before = snapshot(), undoCount = state.undo.length;
    $('btnFlatten').click();
    const after = snapshot(), undoSteps = state.undo.length - undoCount;
    const expanded = !doc.querySelector('use') && allTopLevel().some(el => tag(el) === 'rect');
    undo(); const undone = snapshot(), undoExact = sameSVG(undone, before) && !!doc.querySelector('use') && !!doc.querySelector('defs #flatten-symbol');
    redo(); const redone = snapshot(), redoExact = sameSVG(redone, after);
    return { expanded, undoSteps, undoExact, redoExact, before, after, undone, redone, errors: window.__auditErrors };
  } + ')()');
  assert.deepEqual(useHistory.errors, []);
  assert(useHistory.expanded, 'flatten expands symbol instances into editable geometry');
  assert.equal(useHistory.undoSteps, 1, 'expanding and flattening is a single undo step');
  assert(useHistory.undoExact && useHistory.redoExact, 'undo/redo includes use expansion and its original definitions: ' + JSON.stringify(useHistory));

  // Flattening must make leaves directly editable even when group compositing
  // has to remain in the SVG to preserve the artwork.
  const flattenCases = [
    { name: 'ordinary nested groups', effect: '', selected: true },
    { name: 'inherited fill opacity', effect: 'style="fill-opacity:0.4"', selected: true },
    { name: 'group opacity with overlapping shapes', effect: 'opacity="0.45"' },
    { name: 'CSS group opacity', effect: 'class="flatten-css-effect"' },
    { name: 'CSS transformed child under transformed ancestor', effect: 'style="transform:translate(10px,5px)"', selected: true },
    { name: 'group clipping', effect: 'clip-path="url(#flatten-clip)"', selected: true },
    { name: 'group mask', effect: 'mask="url(#flatten-mask)"' },
    { name: 'group filter', effect: 'style="filter:url(#flatten-filter)"', selected: true }
  ];
  for (const fixture of flattenCases) {
    const prepared = await evalJS('(' + async function (fixture) {
      const defs = '<style>.flatten-css-effect{opacity:0.55}</style><defs><clipPath id="flatten-clip" clipPathUnits="userSpaceOnUse"><rect x="40" y="40" width="100" height="110"/></clipPath>' +
        '<mask id="flatten-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="180"><rect width="200" height="180" fill="white"/><circle cx="90" cy="95" r="12" fill="black"/></mask>' +
        '<filter id="flatten-filter" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.5"/></filter></defs>';
      loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300">' + defs +
        '<g id="flatten-root" transform="translate(70 30) rotate(9)" fill="#cc8833" stroke="#123456" stroke-width="2">' +
        '<g ' + fixture.effect + '><g transform="translate(10 8)">' +
        '<rect id="flatten-a" x="40" y="60" width="70" height="60"/>' +
        '<rect id="flatten-b" x="85" y="70" width="70" height="60" fill="#4466bb"/>' +
        '</g></g></g><g id="flatten-outside-group"><rect id="flatten-outside" x="350" y="60" width="45" height="45" fill="#55aa77"/></g></svg>', fixture.name + '.svg');
      state.zoom = 1; centerDoc(); applyZoom(); setNodeMode(false);
      window.__flattenImage = async () => {
        const source = cloneDocForOutput();
        source.setAttribute('width', '500'); source.setAttribute('height', '300');
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(source)], { type: 'image/svg+xml' }));
        try {
          const image = new Image(); image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 300;
          const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
          return [...ctx.getImageData(0, 0, 500, 300).data];
        } finally { URL.revokeObjectURL(url); }
      };
      window.__flattenBoxes = () => ['flatten-a', 'flatten-b', 'flatten-outside'].map(id => ({ id, ...bboxInRoot(doc.querySelector('#' + id)) }));
      const beforeBoxes = window.__flattenBoxes();
      const sameSVG = (a, b) => new DOMParser().parseFromString(a, 'image/svg+xml').documentElement.isEqualNode(new DOMParser().parseFromString(b, 'image/svg+xml').documentElement);
      const beforeImage = await window.__flattenImage();
      const before = snapshot(), undoCount = state.undo.length;
      select(fixture.selected ? [doc.querySelector('#flatten-root')] : []);
      // This is the ordinary toolbar action: neither Alt nor force mode.
      $('btnFlatten').click();
      const after = snapshot(), afterBoxes = window.__flattenBoxes();
      const afterImage = await window.__flattenImage();
      const pixelError = afterImage.reduce((max, value, i) => Math.max(max, Math.abs(value - beforeImage[i])), 0);
      const directlySelectable = ['flatten-a', 'flatten-b'].every(id => {
        const leaf = doc.querySelector('#' + id); return topLevelOf(leaf) === leaf;
      });
      const selectableLeaves = ['flatten-a', 'flatten-b'].every(id => allTopLevel().includes(doc.querySelector('#' + id)));
      const outsideScope = !fixture.selected || topLevelOf(doc.querySelector('#flatten-outside')) === doc.querySelector('#flatten-outside-group');
      const undoSteps = state.undo.length - undoCount;
      undo(); const undoExact = sameSVG(snapshot(), before);
      redo(); const redoExact = sameSVG(snapshot(), after);
      const a = doc.querySelector('#flatten-a');
      const point = new DOMPoint(55, 80).matrixTransform(a.getScreenCTM());
      return { beforeBoxes, afterBoxes, pixelError, directlySelectable, selectableLeaves, outsideScope, undoSteps, undoExact, redoExact, x: point.x, y: point.y, errors: window.__auditErrors };
    } + ')(' + JSON.stringify(fixture) + ')');
    assert.deepEqual(prepared.errors, [], fixture.name);
    assert(prepared.directlySelectable, fixture.name + ': ordinary click must resolve to a leaf');
    assert(prepared.selectableLeaves, fixture.name + ': selection enumeration must include leaves rather than compositing shells');
    assert(prepared.outsideScope, fixture.name + ': unrelated groups stay grouped when flattening a selection');
    assert.equal(prepared.pixelError, 0, fixture.name + ': composited appearance must stay unchanged');
    for (let i = 0; i < prepared.beforeBoxes.length; i++) {
      for (const key of ['x', 'y', 'w', 'h']) {
        assert(Math.abs(prepared.beforeBoxes[i][key] - prepared.afterBoxes[i][key]) < 1e-7, fixture.name + ': preserve ' + prepared.beforeBoxes[i].id + ' ' + key);
      }
    }
    assert.equal(prepared.undoSteps, 1, fixture.name + ': flatten is one undo step');
    assert(prepared.undoExact && prepared.redoExact, fixture.name + ': undo/redo restore the exact SVG');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prepared.x, y: prepared.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: prepared.x, y: prepared.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: prepared.x, y: prepared.y, button: 'left', buttons: 0, clickCount: 1 });
    const clicked = await evalJS('({ ids: [...state.sel].map(el => el.id), before: window.__flattenBoxes() })');
    assert.deepEqual(clicked.ids, ['flatten-a'], fixture.name + ': mouse click without Alt selects only the leaf');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    const moved = await evalJS('({ boxes: window.__flattenBoxes(), errors: window.__auditErrors })');
    assert(moved.boxes[0].x > clicked.before[0].x, fixture.name + ': leaf can be edited independently');
    assert.deepEqual(moved.boxes.slice(1), clicked.before.slice(1), fixture.name + ': editing the leaf leaves siblings untouched');
    assert.deepEqual(moved.errors, [], fixture.name);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    const persisted = await evalJS('(' + async function () {
      const selectedLeaves = ['flatten-a', 'flatten-b'].every(id => state.sel.has(doc.querySelector('#' + id)));
      const source = snapshot(), undoCount = state.undo.length;
      const captured = libraryCaptureSelection();
      const captureValid = !!new DOMParser().parseFromString(captured, 'image/svg+xml').querySelector('rect') && snapshot() === source && state.undo.length === undoCount;
      const before = await window.__flattenImage();
      loadSVGText(snapshot(), 'flatten-round-trip.svg');
      const after = await window.__flattenImage();
      return { selectedLeaves, captureValid, unchanged: before.every((value, i) => value === after[i]),
        selectable: ['flatten-a', 'flatten-b'].every(id => topLevelOf(doc.querySelector('#' + id)) === doc.querySelector('#' + id)), errors: window.__auditErrors };
    } + ')()');
    assert(persisted.selectedLeaves, fixture.name + ': Ctrl+A selects editable leaves');
    assert(persisted.captureValid, fixture.name + ': flattened content remains valid for reusable shape capture');
    assert(persisted.unchanged && persisted.selectable, fixture.name + ': export/reload preserves appearance and leaf editing');
    assert.deepEqual(persisted.errors, [], fixture.name);
  }

  const boundaryFixtures = [
    {
      name: 'nested SVG slice viewport', count: 2,
      definitions: '<defs><path id="boundary-source" d="M0 0H30V20H0Z" fill="#dd6633"/></defs>',
      content: '<svg id="boundary-svg" x="40" y="30" width="140" height="90" viewBox="10 20 100 100" preserveAspectRatio="xMaxYMin slice" style="overflow:hidden"><g transform="translate(3 5)"><rect id="boundary-a" x="0" y="0" width="190" height="180" fill="#ddbb33"/><circle id="boundary-b" cx="80" cy="65" r="30" fill="#3366cc"/></g></svg>'
    },
    {
      name: 'nested symbol and use references', count: 1,
      definitions: '<defs><path id="boundary-source" d="M0 0H60V25H0Z"/>' +
        '<g id="boundary-middle" transform="translate(5 7)"><use href="#boundary-source" style="opacity:0.7"/></g>' +
        '<symbol id="boundary-symbol" viewBox="0 0 100 80" preserveAspectRatio="xMaxYMid meet"><g transform="rotate(7 50 40)"><use href="#boundary-middle" x="3" y="4" opacity="0.6"/></g></symbol></defs>',
      content: '<use href="#boundary-symbol" x="40" y="30" width="150" height="95" opacity="0.8" style="opacity:0.5;fill:#2255cc"/>'
    },
    {
      name: 'use directly references another use with opacity', count: 1,
      definitions: '<defs><path id="boundary-source" d="M0 0H60V25H0Z" fill="#2255cc"/><use id="boundary-reference" href="#boundary-source" opacity="0.5"/></defs>',
      content: '<use href="#boundary-reference" x="60" y="30" style="opacity:0.7"/>'
    }
  ];
  const boundaryResults = [];
  for (const fixture of boundaryFixtures) {
    boundaryResults.push(await evalJS('(' + async function (fixture) {
      loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300">' + fixture.definitions +
        '<g id="boundary-root" transform="translate(20 10) rotate(11 110 90)">' + fixture.content + '</g>' +
        '<use id="boundary-outside" href="#boundary-source" x="350" y="210" fill="#44aa66"/></svg>', fixture.name + '.svg');
      state.zoom = 1; centerDoc(); applyZoom();
      const sameSVG = (a, b) => new DOMParser().parseFromString(a, 'image/svg+xml').documentElement.isEqualNode(new DOMParser().parseFromString(b, 'image/svg+xml').documentElement);
      const before = snapshot(), beforePixels = await window.__flattenImage(), undoCount = state.undo.length;
      const defsBefore = doc.querySelector('defs').outerHTML, outsideBefore = doc.querySelector('#boundary-outside').outerHTML;
      select([doc.querySelector('#boundary-root')]);
      $('btnFlatten').click();
      const after = snapshot(), afterPixels = await window.__flattenImage();
      const leaves = allTopLevel().filter(el => el.id !== 'boundary-outside' && tag(el) !== 'use');
      const ids = [...doc.querySelectorAll('[id]')].map(el => el.id);
      select(leaves);
      const captured = libraryCaptureSelection();
      const output = {
        name: fixture.name, pixelError: afterPixels.reduce((max, value, i) => Math.max(max, Math.abs(value - beforePixels[i])), 0),
        leaves: leaves.map(el => tag(el)), selectable: leaves.every(el => topLevelOf(el) === el),
        remainingUses: [...doc.querySelectorAll('use')].filter(el => isRenderedEl(el) && el.id !== 'boundary-outside').length,
        outsideUnchanged: doc.querySelector('#boundary-outside').outerHTML === outsideBefore,
        defsUnchanged: doc.querySelector('defs').outerHTML === defsBefore,
        uniqueIds: new Set(ids).size === ids.length,
        captureValid: !!new DOMParser().parseFromString(captured, 'image/svg+xml').querySelector('path,rect,circle'),
        undoSteps: state.undo.length - undoCount
      };
      undo(); output.undoExact = sameSVG(snapshot(), before);
      redo(); output.redoExact = sameSVG(snapshot(), after);
      output.errors = window.__auditErrors;
      return output;
    } + ')(' + JSON.stringify(fixture) + ')'));
  }
  for (let i = 0; i < boundaryResults.length; i++) {
    const output = boundaryResults[i], details = output.name + ': ' + JSON.stringify(output);
    assert.deepEqual(output.errors, [], details);
    assert.equal(output.pixelError, 0, 'preserve viewport clipping and nested use appearance; ' + details);
    assert.equal(output.leaves.length, boundaryFixtures[i].count, 'extract all referenced shapes; ' + details);
    assert(output.selectable && output.remainingUses === 0, 'nested references become directly editable leaves; ' + details);
    assert(output.outsideUnchanged && output.defsUnchanged, 'selected flatten must leave outside instances and definitions unchanged; ' + details);
    assert(output.uniqueIds && output.captureValid, 'expanded references keep unique IDs and remain valid for reusable shape capture; ' + details);
    assert.equal(output.undoSteps, 1, details);
    assert(output.undoExact && output.redoExact, 'one undo/redo restores original references and viewports; ' + details);
  }

  const prepared = await evalJS('(' + function () {
    loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150" style="fill:#8844cc;font-family:Times New Roman"><rect x="20" y="20" width="100" height="50"/><path d="M150 30 L270 110" fill="none" stroke="black" stroke-width="3"/><text x="20" y="120" font-size="24">SVG export check</text></svg>', 'pdf-check.svg');
    window.__printCalls = 0;
    window.print = () => { window.__printCalls++; };
    openPdfDialog(); $('pdfW').value = '120'; exportPDF();
    return { calls: window.__printCalls, title: document.title, hasSvg: !!$('printArea').querySelector('svg'), iframe: !!$('printArea').querySelector('iframe') };
  } + ')()');
  assert.equal(prepared.calls, 1);
  assert.equal(prepared.title, 'pdf-check');
  assert(prepared.hasSvg && !prepared.iframe);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  const printed = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
  const pdf = Buffer.from(printed.data, 'base64').toString('latin1');
  assert(pdf.startsWith('%PDF-'));
  assert.equal((pdf.match(/\/Type\s*\/Page\b/g) || []).length, 1);
  const mediaBox = pdf.match(/\/MediaBox\s*\[([^\]]+)\]/)[1].trim().split(/\s+/).map(Number);
  assert(Math.abs(mediaBox[2] - 120 * 72 / 25.4) < 1 && Math.abs(mediaBox[3] - 60 * 72 / 25.4) < 1);
  await send('Emulation.setEmulatedMedia', { media: '' });
  const cleanup = await evalJS('(' + function () {
    window.dispatchEvent(new Event('afterprint'));
    const normal = { title: document.title, empty: !$('printArea').children.length && !$('printStyle').textContent };
    window.print = () => { throw new Error('test failure'); };
    exportPDF();
    return { normal, errorCleanup: !$('printArea').children.length && !$('printStyle').textContent, errorToast: $('toast').textContent, errors: window.__auditErrors };
  } + ')()');
  assert(cleanup.normal.empty && cleanup.errorCleanup);
  assert(cleanup.errorToast.includes('test failure'));
  assert.deepEqual(cleanup.errors, []);
  console.log('PASS: path merging, ungroup styles, recursive leaf editing with preserved group effects, ellipse transforms, single-page PDF and print cleanup');
}).catch(e => { console.error(e); process.exitCode = 1; });
