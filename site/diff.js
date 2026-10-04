// Draft vs approved copy: blocks aligned by LCS (so an inserted paragraph shifts nothing), then a word-level diff
// inside each modified block. Used by the page and by tests/diff.test.js.
(function (g) {
  function blocks(c) {
    if (!c) return [];
    const out = [];
    const add = (label, text) => out.push({ label, text: String(text ?? '') });
    add('Title tag', c.title_tag); add('Meta description', c.meta_description); add('H1', c.h1);
    [].concat(c.intro).forEach(p => add('Intro', p));
    c.sections.forEach(s => { add('Heading', s.heading); s.paragraphs.forEach(p => add(s.heading, p)); });
    c.faq.forEach(f => { add('FAQ question', f.question); add(f.question, f.answer); });
    add('Call to action', c.cta.heading); add('Call to action', c.cta.text); add('Button', c.cta.button_label);
    return out;
  }
  function lcs(a, b, eq) {
    const n = a.length, m = b.length, T = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = eq(a[i], b[j]) ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
    const ops = []; let i = 0, j = 0;
    while (i < n && j < m) { if (eq(a[i], b[j])) { ops.push(['=', i++, j++]); } else if (T[i + 1][j] >= T[i][j + 1]) ops.push(['-', i++, null]); else ops.push(['+', null, j++]); }
    while (i < n) ops.push(['-', i++, null]); while (j < m) ops.push(['+', null, j++]);
    return ops;
  }
  const tokens = s => s.match(/\S+\s*/g) || [];
  // Word diff; within each changed run, all removed words come first, then all added words.
  function words(before, after) {
    const a = tokens(before), b = tokens(after);
    const ops = lcs(a, b, (x, y) => x.trim() === y.trim());
    const out = []; let del = '', ins = '';
    const flush = () => { if (del) out.push({ t: '-', s: del }); if (ins) out.push({ t: '+', s: ins }); del = ins = ''; };
    for (const [o, i, j] of ops) { if (o === '=') { flush(); out.push({ t: '=', s: b[j] }); } else if (o === '-') del += a[i]; else ins += b[j]; }
    flush();
    return out;
  }
  // Returns [{ label, before, after, finalIndex, parts }], one entry per changed block.
  function changes(draft, final) {
    const a = blocks(draft), b = blocks(final);
    const ops = lcs(a, b, (x, y) => x.text === y.text);
    const res = []; let dels = [], ins = [];
    const flush = () => {
      const n = Math.max(dels.length, ins.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k], s = ins[k];
        res.push({ label: (s ? b[s] : a[d]).label, before: d != null ? a[d].text : '', after: s != null ? b[s].text : '', finalIndex: s ?? null,
          parts: words(d != null ? a[d].text : '', s != null ? b[s].text : '') });
      }
      dels = []; ins = [];
    };
    for (const [o, i, j] of ops) { if (o === '=') flush(); else if (o === '-') dels.push(i); else ins.push(j); }
    flush();
    return res;
  }
  g.WRCDiff = { blocks, changes, words };
})(typeof module !== 'undefined' ? module.exports : window);
