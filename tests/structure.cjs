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

    for (const language of ['zh-CN', 'en']) {
      setUILanguage(language);
      for (const buttonId of ['btnFlatten', 'tbFlatten']) {
        const name = language + ' ' + buttonId;
        loadSVGText(svg('<g id="effectGroup" opacity=".5"><rect id="first" x="10" y="10" width="40" height="30"/><rect id="second" x="70" y="10" width="40" height="30"/></g>'), 'flatten-effect.svg');
        showTidyBar(true);
        const original = doc.innerHTML;
        const label = $(buttonId).textContent.trim();
        $(buttonId).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        check(name + ' normal click preserves group opacity', doc.innerHTML === original);
        const hint = $('toast').textContent;
        check(name + ' hint names the actual button', hint.includes(label) && hint.includes('Alt') && !hint.includes('⤯') &&
          (language !== 'en' || !/[\u3400-\u9fff]/.test(hint)), {label, hint});
        $(buttonId).dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
        check(name + ' Alt-click forces flatten', !doc.querySelector('#effectGroup') &&
          ['first', 'second'].every(id => {
            const el = doc.querySelector('#' + id);
            return el.parentNode === doc && el.getAttribute('opacity') === '0.5';
          }));
        undo();
        check(name + ' undo restores group and effects', doc.innerHTML === original);
        $(buttonId).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        check(name + ' normal click after undo still preserves effects', doc.innerHTML === original);
      }
    }
    setUILanguage('zh-CN');
    return { checks, errors: window.__auditErrors };
  } + ')()');
  assert.deepEqual(result.errors, []);
  assert(result.checks.every(c => c.ok), JSON.stringify(result.checks.filter(c => !c.ok)));

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
  console.log('PASS: path merging, ungroup styles, bilingual flatten hints and Alt-click/undo, ellipse transforms, single-page PDF and print cleanup');
}).catch(e => { console.error(e); process.exitCode = 1; });
