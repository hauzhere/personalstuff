import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, devices } from 'playwright';
import { DAY_MS } from '../task-store.js';

const base = 'http://127.0.0.1:3177';
const fixedNow = new Date('2026-11-04T17:00:00Z').getTime();
let browser;
let server;

before(async () => {
  server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '3177' }, stdio: 'pipe' });
  let ready = false;
  for (let tries = 0; tries < 100; tries++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'Test web server starts');
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});

after(async () => { await browser?.close(); server?.kill(); });

async function openApp(t, { seed, time = fixedNow, url = base } = {}) {
  const context = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: 'chromium', timezoneId: 'America/Indianapolis' });
  t.after(() => context.close());
  await context.addInitScript(({ seed, time }) => {
    window.__testNow = time;
    Date.now = () => window.__testNow;
    if (seed && !sessionStorage.getItem('seeded')) {
      localStorage.setItem('gone.tasks.v1', JSON.stringify({ version: 1, tasks: seed }));
      sessionStorage.setItem('seeded', '1');
    }
  }, { seed, time });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('today-date').textContent.length > 0);
  t.after(() => assert.deepEqual(errors, [], 'No browser JavaScript errors'));
  return { page, context };
}

async function addTask(page, text) {
  const input = page.getByRole('textbox', { name: 'New task' });
  await input.fill(text);
  await input.press('Enter');
  assert.equal(await input.inputValue(), '', 'Enter clears the input for the next task');
  assert.equal(await input.evaluate(element => element === document.activeElement), true, 'Input remains focused for another task');
}

const task = (id, text, createdAt, completedAt = null) => ({ id, text, createdAt, completedAt, expiredAt: null });

async function swipeTask(page, id, dx, dy = 0) {
  const target = page.locator(`.task-toggle[data-task-id="${id}"]`);
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  assert.ok(bounds, 'Task is available for a touch gesture');
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 4; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 4, y: y + dy * step / 4, id: 1 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}

test('touching a task crosses it immediately while typing and survives a refresh during touch-down', async t => {
  const { page } = await openApp(t);
  await addTask(page, 'Finish this on my phone');
  await page.evaluate(() => {
    const button = document.querySelector('.task-toggle');
    window.__originalTaskButton = button;
    button.addEventListener('pointerdown', () => document.dispatchEvent(new Event('visibilitychange')), { once: true });
  });
  await page.locator('.task-check').tap();
  assert.equal(await page.locator('.task-row.done').count(), 1, 'The first circle tap immediately crosses off the task');
  assert.equal(await page.evaluate(() => window.__originalTaskButton === document.querySelector('.task-toggle')), true, 'Refresh retains the touch target');
  const completed = await page.evaluate(() => JSON.parse(localStorage.getItem('gone.tasks.v1')).tasks[0]);
  assert.equal(completed.completedAt, fixedNow, 'Completion is saved without another task or refresh');
  await page.getByRole('textbox', { name: 'New task' }).focus();
  await page.locator('.task-text').tap();
  assert.equal(await page.locator('.task-row.done').count(), 0, 'Tapping task text also reverses completion while the input is focused');
  await page.reload();
  assert.equal(await page.locator('.task-row.done').count(), 0, 'The latest touched state survives reload');
});

test('a left swipe reveals editing without completing the task or extending its deadline', async t => {
  const createdAt = fixedNow - 2 * 60 * 60 * 1000;
  const { page } = await openApp(t, { seed: [task('editable', 'Make a small change', createdAt)] });
  await swipeTask(page, 'editable', -90);
  assert.equal(await page.locator('.task-row.done').count(), 0, 'Swiping does not complete the task');
  const edit = page.getByRole('button', { name: 'Edit task: Make a small change', exact: true });
  assert.equal(await edit.isVisible(), true);
  await edit.tap();
  assert.equal(await page.locator('#edit-dialog').isVisible(), true);
  const input = page.getByRole('textbox', { name: 'Edit task', exact: true });
  assert.equal(await input.inputValue(), 'Make a small change');
  await input.fill('  Call home  ');
  await page.locator('#edit-dialog').getByRole('button', { name: 'Save', exact: true }).tap();
  assert.equal(await page.locator('#edit-dialog').isVisible(), false);
  assert.equal(await page.locator('.task-text').textContent(), 'Call home');
  assert.equal(await page.locator('.task-remaining').textContent(), '22h');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gone.tasks.v1')).tasks[0]);
  assert.equal(saved.createdAt, createdAt, 'Editing preserves the original expiration deadline');
  assert.equal(saved.completedAt, null);
  await swipeTask(page, 'editable', -90);
  await page.getByRole('button', { name: 'Edit task: Call home', exact: true }).tap();
  await input.fill('Discard this draft');
  await page.locator('#edit-dialog').getByRole('button', { name: 'Cancel', exact: true }).tap();
  assert.equal(await page.locator('.task-text').textContent(), 'Call home', 'Cancel leaves the stored task unchanged');
});

test('a right swipe reveals deletion while preserving completed versus removed weekly totals', async t => {
  const hour = 60 * 60 * 1000;
  const { page } = await openApp(t, { seed: [
    task('pending-delete', 'Remove this task', fixedNow - 2 * hour),
    task('done-delete', 'Finished first', fixedNow - 2 * hour, fixedNow - hour),
  ] });
  await swipeTask(page, 'pending-delete', 90);
  assert.equal(await page.locator('.task-row.done').count(), 1, 'Swiping alone leaves completion states unchanged');
  await page.getByRole('button', { name: 'Delete task: Remove this task', exact: true }).tap();
  assert.equal(await page.locator('.task-row').count(), 1);
  const removed = await page.evaluate(() => JSON.parse(localStorage.getItem('gone.tasks.v1')).tasks.find(item => item.id === 'pending-delete'));
  assert.equal(removed.deletedAt, fixedNow, 'Deletion persists a history record');
  await page.getByRole('button', { name: 'Weekly report' }).tap();
  assert.equal(await page.locator('#stat-removed').textContent(), '1');
  assert.equal(await page.locator('#stat-completed').textContent(), '1');
  await page.getByRole('button', { name: 'Today', exact: false }).tap();
  await swipeTask(page, 'done-delete', 90);
  await page.getByRole('button', { name: 'Delete task: Finished first', exact: true }).tap();
  assert.equal(await page.locator('.task-row').count(), 0);
  await page.getByRole('button', { name: 'Weekly report' }).tap();
  assert.equal(await page.locator('#stat-removed').textContent(), '1', 'Removing a completed line does not count it again as removed');
  assert.equal(await page.locator('#stat-completed').textContent(), '1', 'Deleting a completed line retains its completed history');
  await page.reload();
  assert.equal(await page.locator('.task-row').count(), 0, 'Deleted lines stay removed after reload');
});

test('vertical touch gestures do not expose task actions or mark a task complete', async t => {
  const { page } = await openApp(t, { seed: [task('scroll-only', 'Leave this task alone', fixedNow)] });
  await swipeTask(page, 'scroll-only', 4, 90);
  assert.equal(await page.locator('.task-row.done').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Edit task: Leave this task alone', exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Delete task: Leave this task alone', exact: true }).isVisible(), false);
});

test('iPhone layout adds, crosses off, undoes and persists tasks across reload', async t => {
  const { page } = await openApp(t);
  assert.equal(await page.getByRole('textbox', { name: 'New task' }).isVisible(), true);
  assert.equal(await page.locator('.task-row').count(), 0);
  assert.equal(await page.locator('.task-card, .intro, #tasks-view svg:visible').count(), 0, 'Tasks use no card or decorative graphics');
  assert.equal(await page.locator('#task-form button').count(), 0, 'Typing does not require an add button');
  const entryStyles = await page.locator('#task-form, #task-input').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
  }));
  for (const style of entryStyles) {
    assert.equal(style.background, 'rgba(0, 0, 0, 0)', 'Task entry has no box background');
    assert.deepEqual(style.borders, ['0px', '0px', '0px', '0px'], 'Task entry has no box border');
  }
  await addTask(page, 'Take a little walk');
  assert.equal(await page.locator('#task-count').textContent(), '1');
  assert.equal(await page.locator('.task-check').count(), 1, 'Each task has a leading circle');
  await page.getByRole('button', { name: 'Complete task: Take a little walk', exact: true }).click();
  assert.equal(await page.locator('.task-row.done').count(), 1);
  await page.getByRole('button', { name: 'Weekly report' }).click();
  assert.equal(await page.locator('#stat-completed').textContent(), '1');
  await page.reload();
  assert.equal(await page.locator('.task-row.done').count(), 1);
  await page.getByRole('button', { name: 'Mark unfinished: Take a little walk', exact: true }).click();
  assert.equal(await page.locator('#task-count').textContent(), '1');
  assert.equal(await page.locator('.task-row.done').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('24-hour expiration removes tasks and records their original expiry date', async t => {
  const { page } = await openApp(t, { seed: [task('boundary', 'Due in a second', fixedNow - DAY_MS + 1000)] });
  assert.equal(await page.locator('#task-count').textContent(), '1');
  await page.evaluate(now => { window.__testNow = now; document.dispatchEvent(new Event('visibilitychange')); }, fixedNow + 999);
  assert.equal(await page.locator('#task-count').textContent(), '1');
  await page.evaluate(now => { window.__testNow = now; document.dispatchEvent(new Event('visibilitychange')); }, fixedNow + 1000);
  assert.equal(await page.locator('#task-count').textContent(), '0');
  await page.getByRole('button', { name: 'Weekly report' }).click();
  assert.equal(await page.locator('#stat-removed').textContent(), '1');
  assert.equal(await page.locator('#stat-completed').textContent(), '0');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gone.tasks.v1')));
  assert.equal(saved.tasks[0].expiredAt, fixedNow + 1000);
});

test('right-aligned hour countdowns change urgency at exact boundaries without a typing hint', async t => {
  const hour = 60 * 60 * 1000;
  const cases = [
    ['fresh', 19 * hour, '19h', 'is-faint'],
    ['eighteen', 18 * hour, '18h', 'is-normal'],
    ['above-three', 3 * hour + 1, '4h', 'is-normal'],
    ['three', 3 * hour, '3h', 'is-soon'],
    ['above-one', hour + 1, '2h', 'is-soon'],
    ['one', hour, '1h', 'is-urgent'],
  ];
  const longText = 'A longer task that needs to wrap naturally beside its remaining time, keeping the circle, the task text, and the countdown within the width of a small phone screen.';
  const { page } = await openApp(t, { seed: [
    ...cases.map(([id, remaining]) => task(id, id === 'fresh' ? longText : `Task ${id}`, fixedNow - DAY_MS + remaining)),
  ] });
  assert.equal(await page.locator('#input-hint').count(), 0);
  assert.equal(await page.getByText('Type a task. Press enter.', { exact: true }).count(), 0);
  assert.equal(await page.locator('[aria-describedby]').evaluateAll(elements => elements.every(element =>
    element.getAttribute('aria-describedby').split(/\s+/).every(id => document.getElementById(id)))), true, 'All accessible descriptions resolve to existing elements');

  const colors = new Map();
  for (const [id, , text, urgency] of cases) {
    const row = page.locator(`.task-toggle[data-task-id="${id}"]`);
    const timer = row.locator('.task-remaining');
    assert.equal(await timer.textContent(), text, `${id} displays rounded-up remaining hours`);
    assert.equal(await timer.evaluate((element, expected) => element.classList.contains(expected), urgency), true, `${id} has the expected urgency`);
    colors.set(urgency, await timer.evaluate(element => getComputedStyle(element).color));
    const bounds = await row.evaluate(element => {
      const label = element.querySelector('.task-text').getBoundingClientRect();
      const countdown = element.querySelector('.task-remaining').getBoundingClientRect();
      return { labelRight: label.right, timeLeft: countdown.left, timeRight: countdown.right, rowRight: element.getBoundingClientRect().right };
    });
    assert.ok(bounds.timeLeft >= bounds.labelRight, 'Countdown appears to the right of the task text');
    assert.ok(Math.abs(bounds.timeRight - bounds.rowRight) <= 2, 'Countdown aligns with the right edge of the task line');
  }
  assert.equal(new Set(colors.values()).size, 4, 'Faint, normal, soon, and urgent use distinguishable text colors');
  assert.equal(await page.locator('.task-toggle[data-task-id="fresh"] .task-text').evaluate(element =>
    element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight)), true, 'Long task text wraps beside the countdown');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Countdowns do not create horizontal overflow');

  await page.evaluate(now => { window.__testNow = now; document.dispatchEvent(new Event('visibilitychange')); }, fixedNow + 1);
  assert.equal(await page.locator('.task-toggle[data-task-id="above-three"] .task-remaining').textContent(), '3h');
  assert.equal(await page.locator('.task-toggle[data-task-id="above-three"] .task-remaining.is-soon').count(), 1);
  assert.equal(await page.locator('.task-toggle[data-task-id="above-one"] .task-remaining').textContent(), '1h');
  assert.equal(await page.locator('.task-toggle[data-task-id="above-one"] .task-remaining.is-urgent').count(), 1);
  await page.evaluate(now => { window.__testNow = now; document.dispatchEvent(new Event('visibilitychange')); }, fixedNow + hour);
  assert.equal(await page.locator('.task-toggle[data-task-id="fresh"] .task-remaining').textContent(), '18h');
  assert.equal(await page.locator('.task-toggle[data-task-id="fresh"] .task-remaining.is-normal').count(), 1);
  assert.equal(await page.locator('.task-toggle[data-task-id="one"]').count(), 0, 'Deadline still removes the task instead of showing zero hours');
});

test('weekly history retains old completions while the task list gets a fresh start', async t => {
  const { page } = await openApp(t, { seed: [
    task('old-completed', 'A win last week', fixedNow - 7 * DAY_MS, fixedNow - 7 * DAY_MS + 1000),
    task('old-expired', 'Let go last week', fixedNow - 7 * DAY_MS),
    task('this-week', 'A win this week', fixedNow - 1000, fixedNow),
  ] });
  assert.equal(await page.locator('.task-row.done').count(), 1);
  assert.equal(await page.locator('#task-count').textContent(), '0');
  await page.getByRole('button', { name: 'Weekly report' }).click();
  assert.equal(await page.locator('#stat-completed').textContent(), '1');
  assert.equal(await page.locator('#stat-removed').textContent(), '0');
  await page.getByRole('button', { name: 'Previous week' }).click();
  assert.equal(await page.locator('#week-badge').textContent(), 'LAST WEEK');
  assert.equal(await page.locator('#stat-completed').textContent(), '1');
  assert.equal(await page.locator('#stat-removed').textContent(), '1');
  await page.getByRole('button', { name: 'Next week' }).click();
  assert.equal(await page.locator('#week-badge').textContent(), 'THIS WEEK');
  assert.equal(await page.getByRole('button', { name: 'Next week' }).isDisabled(), true);
});

test('offline reload keeps saved tasks and the installable app shell', async t => {
  const { page, context } = await openApp(t);
  await addTask(page, 'Works without Wi-Fi');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  assert.equal(await page.getByRole('button', { name: 'Complete task: Works without Wi-Fi', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Complete task: Works without Wi-Fi', exact: true }).click();
  assert.equal(await page.locator('.task-row.done').count(), 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(247, 248, 242)');
  await page.getByRole('button', { name: 'About Gone and install on iPhone' }).click();
  assert.match(await page.locator('#offline-status').textContent(), /Ready for offline/);
  const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.name, 'Gone');
});

test('task text is literal, blank submissions are rejected, keyboard focus survives refresh', async t => {
  const { page } = await openApp(t);
  const input = page.getByRole('textbox', { name: 'New task' });
  await input.fill('   ');
  await input.press('Enter');
  assert.equal(await page.locator('#task-count').textContent(), '0');
  await input.fill('A task being composed');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  assert.equal(await page.locator('#task-count').textContent(), '0', 'IME confirmation does not submit a task');
  assert.equal(await input.inputValue(), 'A task being composed');
  await addTask(page, '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('.task-text').textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('.task-list img').count(), 0);
  await page.locator('.task-toggle').focus();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.locator('.task-toggle').evaluate(element => element === document.activeElement), true);
});

test('corrupt saved data is preserved with an explicit unsaved-session warning', async t => {
  const { page } = await openApp(t, { seed: [null] });
  assert.equal(await page.locator('#storage-warning').isVisible(), true);
  await addTask(page, 'Temporary task');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gone.tasks.v1')));
  assert.deepEqual(stored.tasks, [null]);
  assert.equal(await page.locator('#task-count').textContent(), '1');
});

test('completion chime works offline, stays silent on undo, and remembers the sound preference', async t => {
  const { page, context } = await openApp(t);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.addInitScript(() => {
    window.__toneStarts = 0;
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.__toneStarts += 1;
      return start.apply(this, args);
    };
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await addTask(page, 'A quiet little win');
  assert.equal(await page.evaluate(() => window.__toneStarts), 0, 'Adding a task is silent');
  await page.getByRole('button', { name: 'Complete task: A quiet little win', exact: true }).tap();
  await page.waitForFunction(() => window.__toneStarts > 0);
  const firstChime = await page.evaluate(() => window.__toneStarts);
  await page.getByRole('button', { name: 'Mark unfinished: A quiet little win', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__toneStarts), firstChime, 'Undoing completion is silent');
  await page.getByRole('button', { name: 'About Gone and install on iPhone' }).click();
  await page.getByRole('checkbox', { name: 'Completion sound' }).uncheck();
  await page.getByRole('button', { name: 'Close about dialog' }).click();
  await page.getByRole('button', { name: 'Complete task: A quiet little win', exact: true }).tap();
  assert.equal(await page.evaluate(() => window.__toneStarts), firstChime, 'Disabled sound never schedules tones');
  await page.reload();
  assert.equal(await page.evaluate(() => window.__toneStarts), 0, 'Reloading completed tasks is silent');
  await page.getByRole('button', { name: 'About Gone and install on iPhone' }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Completion sound' }).isChecked(), false, 'Sound preference survives an offline reload');
  await page.getByRole('checkbox', { name: 'Completion sound' }).check();
  await page.getByRole('button', { name: 'Close about dialog' }).click();
  await page.getByRole('button', { name: 'Mark unfinished: A quiet little win', exact: true }).click();
  await page.getByRole('button', { name: 'Complete task: A quiet little win', exact: true }).tap();
  await page.waitForFunction(() => window.__toneStarts > 0);
  const completedChime = await page.evaluate(() => window.__toneStarts);
  await page.evaluate(now => { window.__testNow = now; document.dispatchEvent(new Event('visibilitychange')); }, fixedNow + DAY_MS);
  assert.equal(await page.evaluate(() => window.__toneStarts), completedChime, 'Expiration does not play a sound');
});

test('the synthesized chime renders non-silent audio with a quiet peak and a finite decay', async t => {
  const { page } = await openApp(t);
  const audio = await page.evaluate(async () => {
    const { scheduleCompletionChime } = await import('./completion-sound.js');
    const sampleRate = 44100;
    const context = new OfflineAudioContext(2, sampleRate * 3, sampleRate);
    const { endsAt } = scheduleCompletionChime(context, 0);
    const buffer = await context.startRendering();
    let peak = 0;
    let energy = 0;
    let tailEnergy = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        peak = Math.max(peak, Math.abs(samples[i]));
        energy += samples[i] ** 2;
        if (i > samples.length - sampleRate / 10) tailEnergy += samples[i] ** 2;
      }
    }
    return { peak, energy, tailEnergy, endsAt };
  });
  assert.ok(audio.peak > 0.01, 'The actual audio graph produces a chime');
  assert.ok(audio.peak < 0.35, 'The chime stays comfortably below clipping');
  assert.ok(audio.energy > 1, 'Audio is more than an isolated click');
  assert.ok(audio.tailEnergy < 0.00001, 'The sound decays to silence');
  assert.ok(audio.endsAt > 0.3 && audio.endsAt < 3, 'The sound has a brief finite duration');
});

test('an older offline worker cannot supply incompatible task code to a new page', async t => {
  const legacyWorker = `
    self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', event => {
      const url = new URL(event.request.url);
      if (url.pathname.endsWith('/task-store.js') && !url.search) {
        event.respondWith(new Response('export const oldTaskCode = true;', { headers: { 'Content-Type': 'text/javascript' } }));
      }
    });
  `;
  const fixture = createServer(async (request, response) => {
    if (new URL(request.url, base).pathname === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(legacyWorker);
      return;
    }
    const upstream = await fetch(`${base}${request.url}`);
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'text/plain', 'Cache-Control': 'no-store' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const { page } = await openApp(t, { url: `http://127.0.0.1:${fixture.address().port}` });
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  assert.match(await page.evaluate(async () => (await fetch('./task-store.js')).text()), /oldTaskCode/, 'The old worker really serves the incompatible unversioned code');
  await page.reload();
  await addTask(page, 'The updated app still works');
  await page.locator('.task-check').tap();
  assert.equal(await page.locator('.task-row.done').count(), 1, 'Versioned imports bypass old task code, so touch completion still works');
});

test('mobile and desktop screens have no horizontal overflow and create preview images', async t => {
  const { page } = await openApp(t);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/gone-iphone.png', fullPage: true });
  await addTask(page, 'Make time for a little walk');
  await addTask(page, 'Call someone you miss');
  await addTask(page, 'Read a few pages');
  await page.getByRole('button', { name: 'Complete task: Read a few pages', exact: true }).click();
  await page.screenshot({ path: 'artifacts/gone-iphone-tasks.png', fullPage: true });
  await page.getByRole('button', { name: 'Weekly report' }).click();
  await page.screenshot({ path: 'artifacts/gone-iphone-report.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole('button', { name: 'Today', exact: false }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/gone-desktop.png', fullPage: true });
});
