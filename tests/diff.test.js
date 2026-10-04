// node tests/diff.test.js
const assert = require('assert');
const { WRCDiff } = require('../site/diff.js');
const base = () => ({ title_tag: 'T', meta_description: 'M', h1: 'H', intro: ['First paragraph.', 'Second paragraph.'],
  sections: [{ heading: 'S1', paragraphs: ['Call Dr. Smith at 9 a.m. for the quote.', 'Stump grinding is extra.'] }, { heading: 'S2', paragraphs: ['Wood is hauled away.'] }],
  faq: [{ question: 'Q?', answer: 'A.' }], cta: { heading: 'C', text: 'Call us.', button_label: 'Go' } });
// 1. one inserted paragraph = exactly one change, nothing else shifted
let a = base(), b = base(); b.intro.splice(1, 0, 'A new middle paragraph.');
let ch = WRCDiff.changes(a, b);
assert.strictEqual(ch.length, 1); assert.strictEqual(ch[0].before, ''); assert.strictEqual(ch[0].after, 'A new middle paragraph.'); assert.strictEqual(ch[0].finalIndex, 4);
// 2. "Dr." and "a.m." do not split anything; only changed words are marked
a = base(); b = base(); b.sections[0].paragraphs[0] = 'Call Dr. Smith at 10 a.m. for the quote.';
ch = WRCDiff.changes(a, b);
assert.strictEqual(ch.length, 1);
assert.deepStrictEqual(ch[0].parts.filter(p => p.t !== '=').map(p => p.t + p.s.trim()), ['-9', '+10']);
// 3. a sentence added to the CTA is attributed to the CTA block, not to an identical earlier text
a = base(); b = base(); b.cta.text = 'Call us. Stump grinding is extra.';
ch = WRCDiff.changes(a, b);
assert.strictEqual(ch.length, 1); assert.strictEqual(ch[0].label, 'Call to action'); assert.strictEqual(ch[0].finalIndex, WRCDiff.blocks(b).length - 2);
// 4. removed paragraph
a = base(); b = base(); b.sections[1].paragraphs = [];
ch = WRCDiff.changes(a, b);
assert.strictEqual(ch.length, 1); assert.strictEqual(ch[0].after, ''); assert.strictEqual(ch[0].finalIndex, null);
// 5. identical copies
assert.strictEqual(WRCDiff.changes(base(), base()).length, 0);
// 6. a rewritten clause is shown as one removal then one addition, not interleaved
let w = WRCDiff.words('Tell the crew or send a photo showing:', 'When you call or fill in the form, tell the crew:');
assert.strictEqual(w.map(p => p.t).join(''), '-+=-+');
assert.ok(!/\+-|-\+-/.test(w.map(p => p.t).join('')), 'no interleaving');
console.log('diff tests: 6 passed');
