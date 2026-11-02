import { DAY_MS, createTask, normalizeTasks, reconcileTasks, toggleTask, weeklyStats, weekBounds } from './task-store.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'gone.tasks.v1';
let tasks = [];
let canPersist = true;
let weekOffset = 0;
let expiryTimer;

function storageWarning(message) {
  $('storage-warning').textContent = message;
  $('storage-warning').hidden = false;
}

function readSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('Unsupported data');
    const normalized = normalizeTasks(data.tasks);
    if (normalized.length !== data.tasks.length) throw new Error('Invalid saved tasks');
    return normalized;
  } catch {
    canPersist = false;
    storageWarning('Your saved tasks could not be read. Existing data has been left untouched. New tasks will only last for this session.');
    return tasks;
  }
}

function persist() {
  if (!canPersist) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks }));
    $('storage-warning').hidden = true;
  } catch {
    canPersist = false;
    storageWarning('This device could not save your tasks. Keep this window open; new changes will be lost when you close it.');
  }
}

function announce(message) { $('announcement').textContent = message; }

function refresh() {
  const next = reconcileTasks(tasks);
  if (next.some((task, i) => task.expiredAt !== tasks[i].expiredAt)) {
    tasks = next;
    persist();
  }
  render();
}

function formatRemaining(task, now) {
  const hours = Math.max(1, Math.ceil((task.createdAt + DAY_MS - now) / 3_600_000));
  return `${hours}h`;
}

function taskRow(task, now) {
  const done = task.completedAt !== null;
  const row = document.createElement('div');
  row.className = `task-row${done ? ' done' : ''}`;
  const button = document.createElement('button');
  button.className = 'task-toggle';
  button.type = 'button';
  button.setAttribute('aria-pressed', String(done));
  button.setAttribute('aria-label', `${done ? 'Mark unfinished' : 'Complete task'}: ${task.text}`);
  button.dataset.taskId = task.id;
  const check = document.createElement('span');
  check.className = 'task-check';
  check.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'task-text';
  label.textContent = task.text;
  const hoursLeft = (task.createdAt + DAY_MS - now) / 3_600_000;
  const urgency = hoursLeft > 18 ? 'faint' : hoursLeft > 3 ? 'normal' : hoursLeft > 1 ? 'soon' : 'urgent';
  const remaining = document.createElement('span');
  remaining.id = `remaining-${task.id}`;
  remaining.className = `task-remaining is-${urgency}`;
  remaining.textContent = formatRemaining(task, now);
  remaining.setAttribute('aria-label', `${Math.max(1, Math.ceil(hoursLeft))} ${Math.ceil(hoursLeft) === 1 ? 'hour' : 'hours'} left`);
  button.setAttribute('aria-describedby', remaining.id);
  button.title = done ? 'Completed' : remaining.getAttribute('aria-label');
  button.append(check, label, remaining);
  button.addEventListener('click', event => {
    if (canPersist) tasks = readSaved();
    tasks = toggleTask(tasks, task.id);
    persist();
    render();
    const result = tasks.find(item => item.id === task.id);
    announce(result?.expiredAt !== null ? 'That task has reached its 24 hours and was let go.' : result?.completedAt !== null ? 'A little win. Task completed.' : 'Task marked unfinished.');
    if (event.detail === 0) {
      const replacement = [...document.querySelectorAll('.task-toggle')].find(item => item.dataset.taskId === task.id);
      (replacement || $('task-input')).focus();
    }
  });
  row.append(button);
  return row;
}

function renderReport(now) {
  const reference = new Date(now);
  reference.setDate(reference.getDate() + weekOffset * 7);
  const bounds = weekBounds(reference.getTime());
  const stats = weeklyStats(tasks, weekOffset === 0 ? now : bounds.end - 1);
  $('stat-completed').textContent = stats.completed;
  $('stat-removed').textContent = stats.removed;
  const rangeFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  $('week-range').textContent = `${rangeFormat.format(stats.start)} – ${rangeFormat.format(stats.end - 1)}, ${new Date(stats.end - 1).getFullYear()}`;
  $('week-badge').textContent = weekOffset === 0 ? 'THIS WEEK' : weekOffset === -1 ? 'LAST WEEK' : `${Math.abs(weekOffset)} WEEKS AGO`;
  $('next-week').disabled = weekOffset === 0;
  const firstTime = tasks.length ? Math.min(...tasks.map(task => task.createdAt)) : now;
  $('previous-week').disabled = stats.start <= weekBounds(firstTime).start;
  const breakdown = $('week-breakdown');
  breakdown.replaceChildren();
  for (const day of stats.days) {
    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.scope = 'row';
    label.textContent = day.label;
    const completed = document.createElement('td');
    completed.textContent = day.completed;
    const removed = document.createElement('td');
    removed.textContent = day.removed;
    row.append(label, completed, removed);
    breakdown.append(row);
  }
}

function render() {
  const focusedTaskId = document.activeElement?.dataset?.taskId;
  const now = Date.now();
  const active = tasks.filter(task => task.completedAt === null && task.expiredAt === null).sort((a, b) => a.createdAt - b.createdAt);
  const completed = tasks.filter(task => task.completedAt !== null && now < task.createdAt + DAY_MS).sort((a, b) => b.completedAt - a.completedAt);
  const visible = [...active, ...completed].sort((a, b) => a.createdAt - b.createdAt);
  $('task-list').replaceChildren(...visible.map(task => taskRow(task, now)));
  $('task-count').textContent = active.length;
  $('today-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  renderReport(now);
  if (focusedTaskId) {
    const replacement = [...document.querySelectorAll('.task-toggle')].find(item => item.dataset.taskId === focusedTaskId);
    (replacement || $('task-input')).focus({ preventScroll: true });
  }
  clearTimeout(expiryTimer);
  const deadlines = [...active, ...completed].map(task => task.createdAt + DAY_MS - now).filter(delay => delay > 0);
  if (deadlines.length) expiryTimer = setTimeout(refresh, Math.min(...deadlines, 2_147_483_647));
}

$('task-input').addEventListener('input', () => $('task-input').setCustomValidity(''));
$('task-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    // Let the keyboard finish an IME composition without creating a task.
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    $('task-form').requestSubmit();
  }
});
$('task-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('task-input');
  try {
    const task = createTask(input.value);
    if (canPersist) tasks = readSaved();
    tasks = reconcileTasks([...tasks, task]);
    persist();
    input.value = '';
    input.setCustomValidity('');
    render();
    input.focus();
    announce('Task added.');
  } catch (error) {
    input.setCustomValidity(error.message);
    input.reportValidity();
  }
});

function changeView(report) {
  $('tasks-view').hidden = report;
  $('report-view').hidden = !report;
  for (const [id, active] of [['tasks-tab', !report], ['report-tab', report]]) {
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
  refresh();
}
$('tasks-tab').addEventListener('click', () => changeView(false));
$('report-tab').addEventListener('click', () => changeView(true));
$('previous-week').addEventListener('click', () => { weekOffset -= 1; render(); });
$('next-week').addEventListener('click', () => { weekOffset = Math.min(0, weekOffset + 1); render(); });
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = $('help-dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('help-dialog').close(); } });
window.addEventListener('storage', event => { if (event.key === STORAGE_KEY || event.key === null) { tasks = readSaved(); refresh(); } });
window.addEventListener('pageshow', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (canPersist) tasks = readSaved(); refresh(); } });

tasks = readSaved();
refresh();
setInterval(refresh, 60_000);

async function prepareOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    $('offline-status').textContent = 'Offline access requires an HTTPS website. Your host needs to serve Gone securely.';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = 'Ready for offline use. Your fresh start can come with you.';
  } catch {
    $('offline-status').textContent = 'Offline access isn’t available yet. Reconnect and reopen the app to try again.';
  }
}
prepareOffline();
