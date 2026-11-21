// Private JSON-line worker for a real Playwright browser. It is not exposed to
// clients directly; the server must authorize and validate every request.
import readline from 'node:readline';

const MAX_LINE = 1024 * 1024;
const MAX_SCREENSHOT = 8 * 1024 * 1024;
let browser;
let context;
let page;
let cdp;
const pressedKeys = new Map();
const pressedButtons = new Map();
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const fail = (id, error) => process.stdout.write(JSON.stringify({ id, error: String(error?.message ?? error).slice(0, 2000) }) + '\n');
const dimension = (n, max) => Number.isInteger(n) && n > 0 && n <= max;
const httpUrl = value => {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) navigation is supported');
  return parsed.href;
};
async function status() {
  const history = await cdp.send('Page.getNavigationHistory');
  return { url: page.url(), title: await page.title(), canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex + 1 < history.entries.length };
}
async function run(input) {
  if (input.op === 'start') {
    if (browser) throw new Error('Browser already started');
    const playwright = await import(process.env.T3_BROWSER_MODULE || 'playwright-core');
    const launch = { headless: true, chromiumSandbox: process.env.T3CODE_SERVER_BROWSER_SANDBOX !== '0' };
    if (process.env.T3_BROWSER_PATH) launch.executablePath = process.env.T3_BROWSER_PATH;
    browser = await playwright.chromium.launch(launch);
    context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    try {
      const { userAgent } = await cdp.send('Browser.getVersion');
      const chromeUa = typeof userAgent === 'string'
        ? userAgent.replace(/HeadlessChrome\//g, 'Chrome/')
        : '';
      if (chromeUa && chromeUa !== userAgent) {
        await cdp.send('Network.setUserAgentOverride', { userAgent: chromeUa });
      }
    } catch {}
    page.setDefaultTimeout(15_000);
    // Browser tabs must not navigate to local files or privileged schemes.
    await page.route('**/*', route => {
      let scheme;
      try { scheme = new URL(route.request().url()).protocol; } catch { return route.abort(); }
      return ['http:', 'https:', 'data:', 'blob:'].includes(scheme) ? route.continue() : route.abort();
    });
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    return { started: true };
  }
  if (!page) throw new Error('Browser is not started');
  switch (input.op) {
    case 'navigate': {
      const target = httpUrl(input.url);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return status();
    }
    case 'screenshot': {
      const quality = Math.max(1, Math.min(100, Number.isInteger(input.quality) ? input.quality : 70));
      const bytes = await page.screenshot({ type: 'jpeg', quality, timeout: 15_000 });
      if (bytes.length > MAX_SCREENSHOT) throw new Error('Screenshot exceeds output limit');
      return { jpeg: bytes.toString('base64') };
    }
    case 'resize':
      if (!dimension(input.width, 3840) || !dimension(input.height, 3840) || input.width * input.height > 3840 * 2160) throw new Error('Invalid viewport');
      await page.setViewportSize({ width: input.width, height: input.height }); return {};
    case 'mouse': {
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('Invalid coordinates');
      const button = ['none','left','middle','right'].includes(input.button) ? input.button : 'none';
      const type = input.action === 'down' ? 'mousePressed' : input.action === 'up' ? 'mouseReleased' : input.action === 'move' ? 'mouseMoved' : null;
      if (!type) throw new Error('Invalid mouse action');
      await cdp.send('Input.dispatchMouseEvent', { type, x: input.x, y: input.y, button, buttons: Number(input.buttons) || 0, clickCount: Number(input.clickCount) || 0, modifiers: Number(input.modifiers) || 0 });
      if (button !== 'none') { if (input.action === 'down') pressedButtons.set(button,{x:input.x,y:input.y}); else if (input.action === 'up') pressedButtons.delete(button); }
      return {};
    }
    case 'key': {
      if (typeof input.key !== 'string' || input.key.length > 128 || typeof input.code !== 'string' || input.code.length > 128) throw new Error('Invalid key');
      const text = typeof input.text === 'string' ? input.text.slice(0, 128) : undefined;
      const type = input.action === 'up' ? 'keyUp' : input.action === 'down' ? (text ? 'keyDown' : 'rawKeyDown') : null;
      if (!type) throw new Error('Invalid key action');
      await cdp.send('Input.dispatchKeyEvent', { type, key:input.key, code:input.code, modifiers:Number(input.modifiers)||0, ...(text ? {text,unmodifiedText:text} : {}), windowsVirtualKeyCode:Number(input.keyCode)||0 });
      if (input.action === 'down') pressedKeys.set(input.code||input.key,{key:input.key,code:input.code}); else pressedKeys.delete(input.code||input.key);
      return {};
    }
    case 'releaseInputs':
      for (const key of pressedKeys.values()) await cdp.send('Input.dispatchKeyEvent', {type:'keyUp',...key}).catch(()=>{});
      for (const [button, at] of pressedButtons) await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button,...at,buttons:0,clickCount:1}).catch(()=>{});
      pressedKeys.clear(); pressedButtons.clear(); return {};
    case 'history':
      if (input.delta === -1) await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      else if (input.delta === 1) await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      else throw new Error('Invalid history delta');
      return status();
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); return status();
    case 'click':
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('Invalid coordinates');
      await page.mouse.click(input.x, input.y); return {};
    case 'type':
      if (typeof input.text !== 'string' || input.text.length > 65_536) throw new Error('Invalid text');
      await page.keyboard.insertText(input.text); return {};
    case 'press':
      if (typeof input.key !== 'string' || input.key.length > 128) throw new Error('Invalid key');
      await page.keyboard.press(input.key); return {};
    case 'scroll':
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('Invalid scroll');
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseWheel',x:Number(input.atX)||0,y:Number(input.atY)||0,deltaX:input.x,deltaY:input.y,modifiers:Number(input.modifiers)||0}); return {};
    case 'close':
      await context.close(); await browser.close(); context = undefined; page = undefined; cdp = undefined; browser = undefined; return {};
    default: throw new Error('Unknown browser operation');
  }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let input;
  try {
    if (line.length > MAX_LINE) throw new Error('Request exceeds input limit');
    input = JSON.parse(line);
    if (!Number.isSafeInteger(input.id)) throw new Error('Invalid request id');
    reply(input.id, await run(input));
  } catch (error) { fail(input?.id ?? null, error); }
}
await browser?.close().catch(() => {});
