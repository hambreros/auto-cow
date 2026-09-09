import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNetworkCapture } from './lib/network-capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(ROOT, process.env.PROFILE_DIR_NAME || '.playwright-profile');
const CDP_PORT = process.env.CDP_PORT || '9333';
// Deliberately its own var, not SITE_URL — that one's shared with capture.mjs
// via .env for general recon and points at the bare domain, which isn't
// where we want browser-server.mjs (driving into the active game) to land.
const GAME_URL = process.env.GAME_URL;
if (!GAME_URL) {
  console.error('GAME_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
// Client-side-only preference (see WORK_LOG.md) — never touches the
// network, so it's invisible to capture and has to be seeded directly.
// Game-specific key/value, so both live only in .env, not in source.
const SOUND_SETTINGS_KEY = process.env.SOUND_SETTINGS_KEY;
const SOUND_SETTINGS_VALUE = process.env.SOUND_SETTINGS_VALUE;

// Keeps the browser open and holds the profile lock; scripts/attach.mjs
// connects over CDP to drive/inspect it without needing to relaunch.
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: null,
  args: [`--remote-debugging-port=${CDP_PORT}`],
});

if (SOUND_SETTINGS_KEY && SOUND_SETTINGS_VALUE) {
  await context.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: SOUND_SETTINGS_KEY, value: SOUND_SETTINGS_VALUE }
  );
}

const page = context.pages()[0] ?? (await context.newPage());
const outFile = await attachNetworkCapture(page, ROOT);
// domcontentloaded rather than the default 'load' — this site keeps
// background connections (chat, ads, analytics) open indefinitely, which
// can stall a 'load' wait well past a reasonable timeout.
await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

console.log(`Browser server up. CDP on http://localhost:${CDP_PORT}`);
console.log(`Capturing to ${outFile}`);
console.log('Press Ctrl+C to close.');

process.on('SIGINT', async () => {
  console.log('\nClosing...');
  await context.close();
  process.exit(0);
});
