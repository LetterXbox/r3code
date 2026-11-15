const { readFileSync } = require('node:fs');
const { strict: assert } = require('node:assert');
const source = readFileSync('t3ui/components/thread/timeline/htmlRenderWheel.ts', 'utf8');
const script = source.match(/export const HTML_RENDER_WHEEL_SCRIPT = `([\s\S]*?)`;/)[1];
class Element {
  constructor() { this.parentElement = null; this.scrollHeight = 100; this.clientHeight = 100; this.scrollTop = 0; this.overflowY = 'auto'; }
}
const root = new Element(), child = new Element();
child.parentElement = root;
let wheel;
const sent = [];
const window = { innerHeight: 500, nsh: { postMessage: message => sent.push(JSON.parse(message)) }, addEventListener: (_, handler) => { wheel = handler; } };
new Function('window', 'document', 'Element', 'getComputedStyle', script)(window, { scrollingElement: root }, Element, node => ({ overflowY: node.overflowY }));
let prevented = false;
const event = { target: child, deltaY: 12, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault: () => { prevented = true; } };
wheel(event);
assert.equal(sent[0].timelineWheel, 12);
assert.equal(prevented, true);
child.scrollHeight = 300;
prevented = false;
wheel(event);
assert.equal(sent.length, 1);
assert.equal(prevented, false);
child.scrollTop = 200;
wheel(event);
assert.equal(sent.length, 2);
event.deltaY = -12;
wheel(event);
assert.equal(sent.length, 2);
console.log('Artifact wheel handoff checks passed');
