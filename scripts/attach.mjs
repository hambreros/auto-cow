import { chromium } from 'playwright';

// Connects to the already-running browser-server.mjs over CDP, does one
// thing, and exits — never calls browser.close(), so the remote browser
// (and its window, visible to the user) stays open across calls.
const CDP_PORT = process.env.CDP_PORT || '9333';
const [, , cmd, ...args] = process.argv;

// A few hundred ms between discrete actions so menus/animations have time
// to settle before the next interaction — plain UI-automation stability,
// not an attempt to disguise this as human input.
function pace(minMs = 200, maxMs = 500) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
const context = browser.contexts()[0];
const page = context.pages()[0];

switch (cmd) {
  case 'screenshot': {
    const outPath = args[0] || 'screenshot.png';
    await page.screenshot({ path: outPath });
    console.log('saved', outPath);
    break;
  }
  case 'click': {
    const [x, y] = args.map(Number);
    await page.mouse.move(x, y);
    await pace(100, 250);
    await page.mouse.click(x, y);
    console.log('clicked', x, y);
    break;
  }
  case 'click-text': {
    const text = args.join(' ');
    const loc = page.getByText(text, { exact: false }).first();
    await loc.scrollIntoViewIfNeeded();
    await pace();
    await loc.click();
    console.log('clicked text:', text);
    break;
  }
  case 'eval': {
    const expr = args.join(' ');
    const result = await page.evaluate(expr);
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case 'url': {
    console.log(page.url());
    break;
  }
  case 'key': {
    const key = args[0];
    await page.keyboard.press(key);
    console.log('pressed', key);
    break;
  }
  case 'drag': {
    const [x1, y1, x2, y2] = args.map(Number);
    await page.mouse.move(x1, y1);
    await pace(100, 200);
    await page.mouse.down();
    await pace(100, 200);
    await page.mouse.move(x2, y2, { steps: 10 });
    await pace(100, 200);
    await page.mouse.up();
    console.log('dragged', x1, y1, '->', x2, y2);
    break;
  }
  case 'scroll': {
    const [x, y, deltaY] = args.map(Number);
    await page.mouse.move(x, y);
    await pace(100, 250);
    await page.mouse.wheel(0, deltaY);
    console.log('scrolled', deltaY, 'at', x, y);
    break;
  }
  default:
    console.error('unknown command:', cmd, '— use screenshot | click | click-text | eval | url');
    process.exit(1);
}

process.exit(0);
