// Run against a disposable Chromium profile and local Vite server:
// node scripts/check-display-preferences-layout.mjs [origin] [CDP endpoint]
import assert from 'node:assert/strict';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const endpoint = process.argv[3] ?? 'http://127.0.0.1:9222';
const tab = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0, checks = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data), item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id); clearTimeout(item.timer);
  message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, label) => { assert.ok(value, label); checks++; };
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`!!document.querySelector('.display-preferences input')`)) return;
    await wait(100);
  }
  throw new Error('Display preferences did not mount');
}
try {
  await send('Page.enable');
  await send('Page.navigate', { url: `${origin}/karaoke-sync/?mode=simulation` });
  await ready();
  const initial = await evaluate(`document.querySelector('.display-preferences input').checked`);
  for (const width of [320, 375, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const enabled of [false, true]) {
      await evaluate(`if(document.querySelector('.display-preferences input').checked!==${enabled}) document.querySelector('.display-preferences input').click()`);
      const rect = await evaluate(`(() => {
        const panel=document.querySelector('.display-preferences'), text=panel.querySelector('.display-preferences-text'), input=panel.querySelector('input'), status=panel.querySelector('.display-preferences-control > span');
        const t=text.getBoundingClientRect(), c=input.getBoundingClientRect(), s=status.getBoundingClientRect(), p=panel.getBoundingClientRect();
        return {textWidth:t.width,textHeight:t.height,lineHeight:parseFloat(getComputedStyle(text).lineHeight),horizontal:getComputedStyle(text).writingMode==='horizontal-tb',inputWidth:c.width,inputRight:c.x>=t.right,statusAdjacent:s.x-c.right<=12,aligned:Math.abs(c.y+c.height/2-(s.y+s.height/2))<2,height:p.height,overflow:document.documentElement.scrollWidth>innerWidth,checked:input.checked};
      })()`);
      check(rect.horizontal && rect.textWidth >= 110 && rect.textHeight <= rect.lineHeight * 1.1, `${width}: horizontal label (${enabled})`);
      check(rect.inputRight && rect.inputWidth <= 24 && rect.statusAdjacent && rect.aligned, `${width}: adjacent right-hand control (${enabled})`);
      check(rect.height <= 48 && !rect.overflow, `${width}: compact without overflow (${enabled})`);
      check(rect.checked === enabled, `${width}: toggle (${enabled})`);
      check(await evaluate(`document.querySelector('main').dataset.showHelp==='${enabled}' && JSON.parse(localStorage.getItem('karaokesync.display-preferences.v1')).showHelp===${enabled}`), `${width}: UI and persistence (${enabled})`);
      await send('Page.reload'); await wait(150); await ready();
      check(await evaluate(`document.querySelector('.display-preferences input').checked===${enabled}`), `${width}: restored (${enabled})`);
    }
    await evaluate(`document.querySelector('.display-preferences').style.fontSize='1.8rem'`);
    check(await evaluate(`document.querySelector('.display-preferences').getBoundingClientRect().height<150 && document.documentElement.scrollWidth<=innerWidth`), `${width}: large text can wrap without huge whitespace`);
    await evaluate(`document.querySelector('.display-preferences').style.fontSize=''`);
  }
  await evaluate(`if(document.querySelector('.display-preferences input').checked!==${initial}) document.querySelector('.display-preferences input').click()`);
  console.log(JSON.stringify({ checks, status: 'PASS', widths: [320, 375, 390] }));
} finally {
  await fetch(`${endpoint}/json/close/${tab.id}`);
  socket.close();
}
