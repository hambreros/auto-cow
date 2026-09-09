import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNetworkCapture } from './lib/network-capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Override with PROFILE_DIR_NAME for a throwaway profile (e.g. smoke tests) —
// the default holds your real logged-in session; don't rm -rf it by accident.
const PROFILE_DIR = path.join(ROOT, process.env.PROFILE_DIR_NAME || '.playwright-profile');

const SITE_URL = process.env.SITE_URL;
const HEADLESS = (process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
const { GAME_USERNAME } = process.env;

if (!SITE_URL) {
  console.error('SITE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (GAME_USERNAME) {
  console.log(`Credentials configured for ${GAME_USERNAME} (auto-login isn't wired up yet — log in by hand).`);
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: HEADLESS,
  viewport: null,
});

// The game's sound toggle is client-side only (a localStorage key, found
// by inspecting the persisted profile — never touches the network, so
// capture can't see it). Seeding it via addInitScript runs before the
// client's own scripts do, so it starts muted instead of needing a click
// after every fresh profile/login. Key/value are game-specific — set via
// .env, not hardcoded here.
const MUTE_SOUND = (process.env.MUTE_SOUND ?? 'true').toLowerCase() !== 'false';
const SOUND_SETTINGS_KEY = process.env.SOUND_SETTINGS_KEY;
const SOUND_SETTINGS_VALUE = process.env.SOUND_SETTINGS_VALUE;
if (MUTE_SOUND && SOUND_SETTINGS_KEY && SOUND_SETTINGS_VALUE) {
  await context.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: SOUND_SETTINGS_KEY, value: SOUND_SETTINGS_VALUE }
  );
}

const page = context.pages()[0] ?? (await context.newPage());
const outFile = await attachNetworkCapture(page, ROOT);

console.log(`Capturing to ${outFile}`);
console.log('Log in and play normally — the session persists in .playwright-profile/ for next time.');
console.log('Press Ctrl+C here when done.');

await page.goto(SITE_URL);

process.on('SIGINT', async () => {
  console.log('\nClosing browser...');
  await context.close();
  process.exit(0);
});
