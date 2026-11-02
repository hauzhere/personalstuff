import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

async function openApp(t, { seed, time = fixedNow } = {}) {
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
  await page.goto(base);
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

test('iPhone layout adds, crosses off, undoes and persists tasks across reload', async t => {
  const { page } = await openApp(t);
  assert.equal(await page.getByRole('textbox', { name: 'New task' }).isVisible(), true);
  assert.equal(await page.locator('.task-row').count(), 0);
  assert.equal(await page.locator('.task-card, .intro, #tasks-view svg').count(), 0, 'Tasks use no card or decorative graphics');
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
