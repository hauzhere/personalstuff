import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const base = 'http://127.0.0.1:3188';
const fixtures = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
let browser;
let server;

before(async () => {
  server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '3188' }, stdio: 'pipe' });
  let output = '';
  server.stderr.on('data', data => { output += data; });
  let ready = false;
  for (let tries = 0; tries < 100; tries++) {
    try { if ((await fetch(`${base}/reader/`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Reader web server starts: ${output}`);
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});

after(async () => { await browser?.close(); server?.kill(); });

function fakeSpeech() {
  class Utterance extends EventTarget {
    constructor(text = '') { super(); this.text = text; this.rate = 1; this.voice = null; this.lang = ''; }
  }
  const events = new EventTarget();
  const synth = {
    speaking: false,
    paused: false,
    pending: false,
    __spoken: [],
    __current: null,
    getVoices: () => [{ voiceURI: 'fixture-natural-en', name: 'Fixture Natural English', lang: 'en-US', localService: true, default: true }],
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    speak(utterance) {
      this.__spoken.push({ text: utterance.text, rate: utterance.rate });
      this.__current = utterance;
      this.speaking = true;
      this.paused = false;
      queueMicrotask(() => { utterance.onstart?.({ type: 'start' }); utterance.dispatchEvent(new Event('start')); });
    },
    cancel() { this.__current = null; this.speaking = false; this.paused = false; },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    __finish() {
      const current = this.__current;
      this.__current = null;
      this.speaking = false;
      current?.onend?.({ type: 'end' });
      current?.dispatchEvent(new Event('end'));
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  window.SpeechSynthesisUtterance = Utterance;
  window.__speech = synth;
}

async function openReader(t, { mobile = false, speech = false } = {}) {
  const context = await browser.newContext(mobile ? { ...devices['iPhone 13'] } : { viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  if (speech) await context.addInitScript(fakeSpeech);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/reader/`);
  await page.locator('#file-input').waitFor({ state: 'attached' });
  t.after(() => assert.deepEqual(errors, [], 'No unhandled browser JavaScript errors'));
  return { page, context };
}

async function waitReady(page, count) {
  await page.waitForFunction(expected => document.querySelectorAll('#file-list .deck-item[data-state="ready"]').length === expected, count);
}

async function dropFiles(page, names) {
  const files = await Promise.all(names.map(async name => ({ name, bytes: [...await readFile(fixtures(name))] })));
  await page.evaluate(files => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.name.endsWith('.pdf') ? 'application/pdf' : 'text/plain' }));
    document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files);
}

test('PDF.js reads actual slide text and canvas while progressive slides narrate only additions', async t => {
  const { page } = await openReader(t);
  await page.locator('#file-input').setInputFiles(fixtures('mis-544-transitions.pdf'));
  await waitReady(page, 1);
  assert.match(await page.locator('#deck-title').textContent(), /mis-544-transitions/i);
  assert.match(await page.locator('#page-label').textContent(), /1\s*(?:of|\/)\s*3/);
  assert.match(await page.locator('#narration-text').textContent(), /Database systems/);
  await page.waitForFunction(() => {
    const canvas = document.getElementById('slide-canvas');
    if (!canvas || canvas.width < 100 || canvas.height < 100) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 0; index < pixels.length; index += 128) {
      if (pixels[index] !== pixels[0] || pixels[index + 1] !== pixels[1] || pixels[index + 2] !== pixels[2]) return true;
    }
    return false;
  });
  await page.locator('#next-slide').click();
  await page.waitForFunction(() => /2\s*(?:of|\/)\s*3/.test(document.getElementById('page-label').textContent));
  assert.match(await page.locator('#narration-text').textContent(), /Relational tables/);
  assert.doesNotMatch(await page.locator('#narration-text').textContent(), /Database systems|organized for retrieval/);
  assert.match(await page.locator('#skipped-note').textContent(), /repeat|skip/i);
  await page.locator('#slide-canvas').waitFor({ state: 'visible' });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/slidecast-desktop.png', fullPage: true });
  await page.locator('#next-slide').click();
  await page.waitForFunction(() => /3\s*(?:of|\/)\s*3/.test(document.getElementById('page-label').textContent));
  assert.doesNotMatch(await page.locator('#narration-text').textContent(), /Relational tables|Database systems/);
  assert.match((await page.locator('#skipped-note').textContent()) + (await page.locator('#narration-text').textContent()), /repeat|duplicate|nothing new/i);
  await page.locator('#dedupe-toggle').uncheck();
  assert.match(await page.locator('#narration-text').textContent(), /Relational tables/);
  assert.match(await page.locator('#narration-text').textContent(), /Database systems/);
});

test('a single real drop accepts multiple decks and the queue can switch, remove, and clear them', async t => {
  const { page } = await openReader(t);
  await dropFiles(page, ['mis-544-transitions.pdf', 'networking.pdf']);
  await waitReady(page, 2);
  assert.equal(await page.locator('#file-list .deck-item').count(), 2);
  const network = page.locator('#file-list .deck-item').filter({ hasText: 'networking.pdf' });
  await network.locator('.deck-button').click();
  assert.match(await page.locator('#deck-title').textContent(), /networking/i);
  assert.match(await page.locator('#narration-text').textContent(), /Network communication/);
  await network.locator('.deck-remove').click();
  assert.equal(await page.locator('#file-list .deck-item').count(), 1);
  assert.match(await page.locator('#deck-title').textContent(), /mis-544-transitions/i);
  await page.locator('#clear-files').click();
  assert.equal(await page.locator('#file-list .deck-item').count(), 0);
  await page.locator('#file-input').setInputFiles(fixtures('networking.pdf'));
  await waitReady(page, 1);
  assert.match(await page.locator('#deck-title').textContent(), /networking/i);
});

test('unsupported and corrupt files do not poison the next valid PDF, and image-only slides are labelled honestly', async t => {
  const { page } = await openReader(t);
  await page.locator('#file-input').setInputFiles([fixtures('notes.txt'), fixtures('corrupt.pdf'), fixtures('networking.pdf')]);
  await waitReady(page, 1);
  await page.waitForFunction(() => document.querySelectorAll('#file-list .deck-item[data-state="error"]').length === 1);
  assert.equal(await page.locator('#file-list .deck-item[data-state="ready"]').count(), 1);
  assert.match(await page.locator('#file-list .deck-item[data-state="error"]').textContent(), /corrupt|invalid|could not|cannot|unable/i);
  await page.locator('#clear-files').click();
  await page.locator('#file-input').setInputFiles(fixtures('image-only.pdf'));
  await waitReady(page, 1);
  const message = await page.locator('#narration-text, #skipped-note, #app-status').allTextContents();
  assert.match(message.join(' '), /image|scann|no.*text/i);
  assert.equal(await page.locator('#play-button').isDisabled(), true, 'A slide with no extracted text is not presented as speakable');
});

test('narration pauses and resumes, skips duplicate reveals, and continues into the next deck', async t => {
  const { page } = await openReader(t, { speech: true });
  await page.locator('#file-input').setInputFiles([fixtures('mis-544-transitions.pdf'), fixtures('networking.pdf')]);
  await waitReady(page, 2);
  await page.locator('#speed-select').selectOption('1.25');
  await page.locator('#play-button').click();
  await page.waitForFunction(() => window.__speech.__spoken.length === 1);
  assert.match(await page.evaluate(() => window.__speech.__spoken[0].text), /Database systems/);
  assert.equal(await page.evaluate(() => window.__speech.__spoken[0].rate), 1.25);
  await page.locator('#play-button').click();
  assert.equal(await page.evaluate(() => window.__speech.paused), true);
  await page.locator('#play-button').click();
  assert.equal(await page.evaluate(() => window.__speech.paused), false);
  assert.equal(await page.evaluate(() => window.__speech.__spoken.length), 1, 'Resuming does not duplicate the current utterance');
  await page.evaluate(() => window.__speech.__finish());
  await page.waitForFunction(() => window.__speech.__spoken.length === 2);
  assert.match(await page.evaluate(() => window.__speech.__spoken[1].text), /Relational tables/);
  assert.doesNotMatch(await page.evaluate(() => window.__speech.__spoken[1].text), /Database systems/);
  await page.evaluate(() => window.__speech.__finish());
  await page.waitForFunction(() => window.__speech.__spoken.length === 3);
  assert.match(await page.locator('#deck-title').textContent(), /networking/i);
  assert.match(await page.evaluate(() => window.__speech.__spoken[2].text), /Network communication/);
  await page.evaluate(() => window.__speech.__finish());
  await page.waitForFunction(() => window.__speech.__spoken.length === 4);
  assert.match(await page.evaluate(() => window.__speech.__spoken[3].text), /Protocols define/);
  await page.evaluate(() => window.__speech.__finish());
  const spoken = await page.evaluate(() => window.__speech.__spoken.map(item => item.text).join(' '));
  assert.equal((spoken.match(/Database systems/g) || []).length, 1);
  assert.equal((spoken.match(/Relational tables/g) || []).length, 1);
});

test('narration waits for a loading next PDF and resumes in queue order when it is ready', async t => {
  const { page, context } = await openReader(t, { speech: true });
  let workerRequests = 0;
  let releaseSecondWorker;
  let secondWorkerStarted;
  const heldWorker = new Promise(resolve => { releaseSecondWorker = resolve; });
  const workerStarted = new Promise(resolve => { secondWorkerStarted = resolve; });
  t.after(() => releaseSecondWorker());
  await context.route('**/vendor/pdf.worker.mjs', async route => {
    workerRequests += 1;
    if (workerRequests === 2) {
      secondWorkerStarted();
      await heldWorker;
    }
    if (!page.isClosed()) await route.continue();
  });
  await page.locator('#file-input').setInputFiles([fixtures('mis-544-transitions.pdf'), fixtures('networking.pdf')]);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The second PDF must start its real PDF.js worker')), 10_000);
    workerStarted.then(() => { clearTimeout(timer); resolve(); });
  });
  await waitReady(page, 1);
  assert.equal(await page.locator('#file-list .deck-item[data-state="loading"]').count(), 1);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => window.__speech.__spoken.length === 1);
  await page.evaluate(() => window.__speech.__finish());
  await page.waitForFunction(() => window.__speech.__spoken.length === 2);
  await page.evaluate(() => window.__speech.__finish());
  await page.waitForFunction(() => /waiting/i.test(document.getElementById('play-button').textContent));
  assert.equal(await page.locator('#play-button').isDisabled(), true, 'Playback waits instead of getting stuck at the end of the first deck');
  assert.equal(await page.locator('#stop-button').isDisabled(), false, 'Waiting playback can still be stopped');
  assert.equal(await page.evaluate(() => window.__speech.__spoken.length), 2);
  releaseSecondWorker();
  await waitReady(page, 2);
  await page.waitForFunction(() => window.__speech.__spoken.length === 3);
  assert.match(await page.locator('#deck-title').textContent(), /networking/i);
  assert.match(await page.evaluate(() => window.__speech.__spoken[2].text), /Network communication/);
});

test('the iPhone file picker accepts multiple PDFs without horizontal layout overflow', async t => {
  const { page } = await openReader(t, { mobile: true });
  await page.locator('#file-input').setInputFiles([fixtures('mis-544-transitions.pdf'), fixtures('networking.pdf')]);
  await waitReady(page, 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const network = page.locator('#file-list .deck-item').filter({ hasText: 'networking.pdf' });
  await network.locator('.deck-button').tap();
  assert.match(await page.locator('#deck-title').textContent(), /networking/i);
  await page.locator('#next-slide').tap();
  assert.match(await page.locator('#narration-text').textContent(), /Protocols define/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#slide-canvas').waitFor({ state: 'visible' });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/slidecast-iphone.png', fullPage: true });
});

test('an installed Gone service worker does not replace the separate slide-reader website', async t => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'Both websites load without browser JavaScript errors'));
  await page.goto(`${base}/`);
  await page.locator('#task-input').waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  assert.match(await page.title(), /Gone/);
  await page.goto(`${base}/reader/`);
  assert.match(await page.title(), /Slidecast/);
  await page.locator('#file-input').setInputFiles(fixtures('mis-544-transitions.pdf'));
  await waitReady(page, 1);
  assert.match(await page.locator('#narration-text').textContent(), /Database systems/);
  await page.locator('#next-slide').click();
  assert.match(await page.locator('#narration-text').textContent(), /Relational tables/);
  assert.doesNotMatch(await page.locator('#narration-text').textContent(), /Database systems/);
});
