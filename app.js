import { DAY_MS, createTask, normalizeTasks, reconcileTasks, toggleTask, editTask, deleteTask, weeklyStats, weekBounds } from './task-store.js?v=5';
import { playCompletionSound } from './completion-sound.js?v=5';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'gone.tasks.v1';
const SOUND_KEY = 'gone.sound.v1';
let soundEnabled = true;
try { soundEnabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* Audio preference can stay in memory when storage is unavailable. */ }
let tasks = [];
let canPersist = true;
let weekOffset = 0;
let expiryTimer;
let editingTaskId = null;
let pendingReload = false;
const taskRows = new Map();

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

function revealActions(row, action = '') {
  for (const other of taskRows.values()) {
    if (other !== row) setRowAction(other, '');
  }
  setRowAction(row, action);
}

function setRowAction(row, action) {
  row.dataset.action = action;
  row.querySelector('.task-actions').hidden = !action;
  row.querySelector('.task-delete').hidden = action !== 'delete' && action !== 'both';
  row.querySelector('.task-edit').hidden = action !== 'edit' && action !== 'both';
  row.querySelector('.task-menu').setAttribute('aria-expanded', String(Boolean(action)));
}

function attachSwipe(row) {
  let gesture = null;
  row.addEventListener('pointerdown', event => {
    if (!event.target.closest('.task-swipe-content') || event.target.closest('.task-menu')
      || (event.pointerType === 'mouse' && event.button !== 0)) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
  });
  row.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      gesture.horizontal = true;
      if (row.setPointerCapture && !row.hasPointerCapture(event.pointerId)) {
        try { row.setPointerCapture(event.pointerId); } catch { /* The pointer may have ended. */ }
      }
      event.preventDefault();
    }
  }, { passive: false });
  row.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.horizontal || (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.3)) {
      row.suppressClickUntil = performance.now() + 500;
      event.preventDefault();
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        revealActions(row, dx > 0 ? 'delete' : 'edit');
      }
    }
    gesture = null;
  });
  row.addEventListener('pointercancel', () => { gesture = null; });
}

function taskRow(task) {
  const row = document.createElement('div');
  row.className = 'task-row';
  row.dataset.taskId = task.id;
  // Icon-only controls are revealed by the swipe; no action happens on swipe alone.
  row.innerHTML = '<div class="task-actions" hidden><button type="button" class="task-delete" hidden><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg></button><button type="button" class="task-edit" hidden><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 15-1 5 5-1L20 8l-4-4L5 15Zm9-9 4 4"/></svg></button></div><div class="task-swipe-content"><button type="button" class="task-toggle"><span class="task-check" aria-hidden="true"></span><span class="task-text"></span><span class="task-remaining"></span></button><button type="button" class="task-menu" aria-expanded="false">···</button></div>';
  row.querySelector('.task-toggle').dataset.taskId = task.id;
  attachSwipe(row);
  taskRows.set(task.id, row);
  return row;
}

function updateTaskRow(row, task, now) {
  const done = task.completedAt !== null;
  row.classList.toggle('done', done);
  const button = row.querySelector('.task-toggle');
  button.setAttribute('aria-pressed', String(done));
  button.setAttribute('aria-label', `${done ? 'Mark unfinished' : 'Complete task'}: ${task.text}`);
  const label = row.querySelector('.task-text');
  if (label.textContent !== task.text) label.textContent = task.text;
  // Update the existing leaf node immediately, including Safari's text paint.
  label.style.textDecorationLine = done ? 'line-through' : 'none';
  const hoursLeft = (task.createdAt + DAY_MS - now) / 3_600_000;
  const urgency = hoursLeft > 18 ? 'faint' : hoursLeft > 3 ? 'normal' : hoursLeft > 1 ? 'soon' : 'urgent';
  const remaining = row.querySelector('.task-remaining');
  remaining.id = `remaining-${task.id}`;
  remaining.className = `task-remaining is-${urgency}`;
  remaining.textContent = formatRemaining(task, now);
  remaining.setAttribute('aria-label', `${Math.max(1, Math.ceil(hoursLeft))} ${Math.ceil(hoursLeft) === 1 ? 'hour' : 'hours'} left`);
  button.setAttribute('aria-describedby', remaining.id);
  row.querySelector('.task-delete').setAttribute('aria-label', `Delete task: ${task.text}`);
  row.querySelector('.task-edit').setAttribute('aria-label', `Edit task: ${task.text}`);
  row.querySelector('.task-menu').setAttribute('aria-label', `Task actions: ${task.text}`);
}

function completeTask(id) {
  if (canPersist) tasks = readSaved();
  const before = tasks.find(task => task.id === id);
  tasks = toggleTask(tasks, id);
  const result = tasks.find(task => task.id === id);
  persist();
  render();
  if (!result || result.expiredAt !== null || result.deletedAt !== null) {
    announce('That task is no longer available.');
    return;
  }
  announce(result.completedAt !== null ? 'Task completed.' : 'Task marked unfinished.');
  // Completion is already saved and visible before optional audio is initialized.
  if (soundEnabled && before?.completedAt === null && result.completedAt !== null) void playCompletionSound();
}

function activateTaskButton(button, event) {
  const row = button?.closest('.task-row');
  if (!row) return;
  const id = row.dataset.taskId;
  const keyboard = event.type === 'click' && event.detail === 0;
  if (button.classList.contains('task-menu')) {
    revealActions(row, row.dataset.action ? '' : 'both');
  } else if (button.classList.contains('task-delete')) {
    if (canPersist) tasks = readSaved();
    tasks = deleteTask(tasks, id);
    persist();
    render();
    announce('Task deleted.');
    if (keyboard) $('task-input').focus();
  } else if (button.classList.contains('task-edit')) {
    const task = tasks.find(item => item.id === id);
    if (!task) return;
    editingTaskId = id;
    $('edit-input').value = task.text;
    $('edit-input').setCustomValidity('');
    revealActions(row);
    $('edit-dialog').showModal();
    $('edit-input').focus();
    $('edit-input').select();
  } else if (button.classList.contains('task-toggle')) {
    if (performance.now() < (row.suppressClickUntil || 0)) return;
    if (row.dataset.action) { revealActions(row); return; }
    completeTask(id);
    if (keyboard && !row.isConnected) $('task-input').focus();
  }
}

let touchTap = null;
$('task-list').addEventListener('pointerdown', event => {
  const button = event.target.closest('button');
  if (event.pointerType === 'touch' && button) touchTap = { button, id: event.pointerId, x: event.clientX, y: event.clientY };
});
$('task-list').addEventListener('pointercancel', () => { touchTap = null; });
$('task-list').addEventListener('pointerup', event => {
  const tap = touchTap;
  touchTap = null;
  if (!tap || event.pointerId !== tap.id || event.target.closest('button') !== tap.button
    || Math.abs(event.clientX - tap.x) > 12 || Math.abs(event.clientY - tap.y) > 12) return;
  tap.button.lastTouchActivation = performance.now();
  event.preventDefault();
  activateTaskButton(tap.button, event);
});
$('task-list').addEventListener('click', event => {
  const button = event.target.closest('button');
  const touchClick = event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents
    || (!('pointerType' in event) && event.detail > 0);
  if (!button || (touchClick && performance.now() - (button.lastTouchActivation ?? -1000) < 750)) return;
  activateTaskButton(button, event);
});

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.task-row')) for (const row of taskRows.values()) setRowAction(row, '');
});

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
  const active = tasks.filter(task => task.deletedAt === null && task.completedAt === null && task.expiredAt === null).sort((a, b) => a.createdAt - b.createdAt);
  const completed = tasks.filter(task => task.deletedAt === null && task.completedAt !== null && now < task.createdAt + DAY_MS).sort((a, b) => b.completedAt - a.completedAt);
  const visible = [...active, ...completed].sort((a, b) => a.createdAt - b.createdAt);
  const visibleIds = new Set(visible.map(task => task.id));
  for (const [id, row] of taskRows) {
    if (!visibleIds.has(id)) { row.remove(); taskRows.delete(id); }
  }
  const list = $('task-list');
  visible.forEach((task, index) => {
    const row = taskRows.get(task.id) || taskRow(task);
    updateTaskRow(row, task, now);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
  $('task-count').textContent = active.length;
  $('today-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  renderReport(now);
  if (focusedTaskId && document.activeElement?.dataset?.taskId !== focusedTaskId) {
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
    reloadIfReady();
  } catch (error) {
    input.setCustomValidity(error.message);
    input.reportValidity();
  }
});

function reloadIfReady() {
  if (pendingReload && !$('task-input').value && !$('edit-dialog').open) location.reload();
}

$('edit-input').addEventListener('input', () => $('edit-input').setCustomValidity(''));
$('edit-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if (canPersist) tasks = readSaved();
    tasks = editTask(tasks, editingTaskId, $('edit-input').value);
    persist();
    render();
    $('edit-dialog').close();
    editingTaskId = null;
    announce('Task updated.');
    reloadIfReady();
  } catch (error) {
    $('edit-input').setCustomValidity(error.message);
    $('edit-input').reportValidity();
  }
});
$('cancel-edit').addEventListener('click', () => { $('edit-dialog').close(); editingTaskId = null; reloadIfReady(); });
$('edit-dialog').addEventListener('close', () => { editingTaskId = null; reloadIfReady(); });

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
$('sound-toggle').checked = soundEnabled;
$('sound-toggle').addEventListener('change', () => {
  soundEnabled = $('sound-toggle').checked;
  try { localStorage.setItem(SOUND_KEY, soundEnabled ? 'on' : 'off'); } catch { /* Task saving reports storage problems separately. */ }
});
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = $('help-dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('help-dialog').close(); } });
window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY || event.key === null) { tasks = readSaved(); refresh(); }
  if (event.key === SOUND_KEY || event.key === null) {
    soundEnabled = event.newValue !== 'off';
    $('sound-toggle').checked = soundEnabled;
  }
});
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
    let controller = navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const nextController = navigator.serviceWorker.controller;
      if (controller && nextController && nextController !== controller) { pendingReload = true; reloadIfReady(); }
      controller = nextController;
    });
    await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = 'Ready for offline use. Your fresh start can come with you.';
  } catch {
    $('offline-status').textContent = 'Offline access isn’t available yet. Reconnect and reopen the app to try again.';
  }
}
prepareOffline();
