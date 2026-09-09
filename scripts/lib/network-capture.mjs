import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const BODY_LIMIT = 5000;
// The typed game-state protocol (see WORK_LOG.md) lives on a dedicated
// game-server host and is worth capturing in full — everything else gets
// the normal small cap. A full map/province state dump alone hit the
// previous 500KB cap and got cut off — this is the single richest payload
// type, worth the disk space. The actual hostname suffix is game-specific
// and lives only in .env (gitignored) — GAME_SERVER_HOST_SUFFIX below.
const GAME_SERVER_BODY_LIMIT = 5_000_000;
const GAME_SERVER_HOST_SUFFIX = process.env.GAME_SERVER_HOST_SUFFIX ?? '';
const GAME_SERVER_HOST_RE = GAME_SERVER_HOST_SUFFIX
  ? new RegExp(GAME_SERVER_HOST_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
  : null;

// Generic ad-tech/analytics noise that showed up in early captures and
// isn't game state — filtered so captures stay readable. EXTRA_NOISE_HOSTS
// (comma-separated substrings, e.g. the publisher's own analytics
// subdomain) can be added via .env for game-specific noise on top of this.
const GENERIC_NOISE_HOSTS = 'clevertap|taboola|outbrain|google-analytics|googletagmanager|doubleclick|googlesyndication|google\\.com/(?:ccm|rmkt)|mgid\\.com|helpshift|privacy-center\\.org|yimg\\.com';
const EXTRA_NOISE_HOSTS = (process.env.EXTRA_NOISE_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const NOISE_HOST_RE = new RegExp(`(${GENERIC_NOISE_HOSTS}${EXTRA_NOISE_HOSTS ? '|' + EXTRA_NOISE_HOSTS : ''})`, 'i');
const NOISE_EXT_RE = /\.(?:m4a|mp3|ogg|wav|woff2?|ttf)(?:\?|$)/i;

// Redact credential-shaped fields (login password, session tokens, etc.)
// before anything touches disk — form-encoded (`pwd=...&`) and JSON
// (`"pwd":"..."`). Also catches the game's own userAuth/chatAuth/etc.
const SENSITIVE_KEY = '(?:pwd|pass\\w*|token|secret|apikey|api[_-]?key|auth)';
const FORM_FIELD_RE = new RegExp(`([?&]?)([A-Za-z0-9_]*${SENSITIVE_KEY}[A-Za-z0-9_]*)=([^&]*)`, 'gi');
const JSON_FIELD_RE = new RegExp(`("[A-Za-z0-9_]*${SENSITIVE_KEY}[A-Za-z0-9_]*")\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, 'gi');

function redact(raw) {
  if (!raw) return raw;
  return raw
    .replace(FORM_FIELD_RE, (_m, sep, key) => `${sep}${key}=[REDACTED]`)
    .replace(JSON_FIELD_RE, (_m, key) => `${key}:"[REDACTED]"`);
}

function truncate(value, limit) {
  const s = typeof value === 'string' ? value : String(value);
  return s.length > limit ? s.slice(0, limit) + '…[truncated]' : s;
}

function isNoise(url) {
  return NOISE_HOST_RE.test(url) || NOISE_EXT_RE.test(url);
}

function bodyLimitFor(url) {
  return GAME_SERVER_HOST_RE && GAME_SERVER_HOST_RE.test(new URL(url).host) ? GAME_SERVER_BODY_LIMIT : BODY_LIMIT;
}

// Redact first (needs the full, untruncated string to match complete
// key/value pairs), then truncate for size.
function sanitize(value, limit) {
  if (value == null) return undefined;
  return truncate(redact(typeof value === 'string' ? value : String(value)), limit);
}

const IGNORED_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

// Wires request/response/websocket capture onto `page`, writing redacted,
// noise-filtered JSONL to captures/capture-<timestamp>.jsonl. Returns the
// output file path. Safe to call once per page/context — each call gets
// its own file and its own serialized write queue.
export async function attachNetworkCapture(page, root) {
  const captureDir = path.join(root, 'captures');
  await mkdir(captureDir, { recursive: true });
  const outFile = path.join(captureDir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

  // Response handlers fire concurrently, and payloads can be up to
  // GAME_SERVER_BODY_LIMIT (5MB) — without serializing, two large
  // concurrent appendFile calls can interleave mid-write and corrupt the
  // JSONL. Chaining through one promise queue guarantees writes happen
  // one at a time.
  let writeQueue = Promise.resolve();
  function record(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    writeQueue = writeQueue
      .then(() => appendFile(outFile, line))
      .catch((err) => console.error('write failed', err));
    return writeQueue;
  }

  page.on('request', (request) => {
    const resourceType = request.resourceType();
    const url = request.url();
    if (IGNORED_RESOURCE_TYPES.has(resourceType) || isNoise(url)) return;
    record({
      kind: 'request',
      resourceType,
      method: request.method(),
      url: redact(url),
      postData: sanitize(request.postData(), bodyLimitFor(url)),
    });
  });

  page.on('response', async (response) => {
    const request = response.request();
    const url = response.url();
    if (IGNORED_RESOURCE_TYPES.has(request.resourceType()) || isNoise(url)) return;
    const contentType = response.headers()['content-type'] ?? '';
    let body;
    if (contentType.includes('json') || contentType.includes('text')) {
      body = await response.text().then((t) => sanitize(t, bodyLimitFor(url))).catch(() => undefined);
    }
    record({
      kind: 'response',
      resourceType: request.resourceType(),
      status: response.status(),
      url: redact(url),
      body,
    });
  });

  page.on('websocket', (ws) => {
    record({ kind: 'websocket-open', url: redact(ws.url()) });
    ws.on('framesent', (frame) => record({ kind: 'ws-send', url: redact(ws.url()), payload: sanitize(frame.payload, BODY_LIMIT) }));
    ws.on('framereceived', (frame) => record({ kind: 'ws-recv', url: redact(ws.url()), payload: sanitize(frame.payload, BODY_LIMIT) }));
    ws.on('close', () => record({ kind: 'websocket-close', url: redact(ws.url()) }));
  });

  return outFile;
}
