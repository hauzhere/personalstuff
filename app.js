import { DAY_MS, createTask, normalizeTasks, reconcileTasks, toggleTask, editTask, deleteTask, moveTask, weeklyStats, weekBounds } from './task-store.js?v=7';
import { playCompletionSound } from './completion-sound.js?v=7';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'gone.tasks.v1';
const SOUND_KEY = 'gone.sound.v1';
const DRAFT_KEY = 'gone.draft.v1';
let composingEntry = false;
let soundEnabled = true;
try { soundEnabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* Audio preference can stay in memory when storage is unavailable. */ }
let tasks = [];
let canPersist = true;
let weekOffset = 0;
let expiryTimer;
let editingTaskId = null;
let pendingReload = false;
let dragState = null;
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
  if (dragState) return;
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

function placeDraggedTask(clientY) {
  if (!dragState) return;
  dragState.clientY = clientY;
  dragState.row.style.top = `${clientY - dragState.offsetY}px`;
  const others = [...$('task-list').querySelectorAll('.task-row')].filter(row => row !== dragState.row);
  const target = others.find(row => {
    const bounds = row.getBoundingClientRect();
    return clientY < bounds.top + bounds.height / 2;
  });
  const before = target || null;
  if (dragState.placeholder.nextElementSibling !== before) $('task-list').insertBefore(dragState.placeholder, before);
}

function dragScroll() {
  if (!dragState) return;
  const edge = 64;
  const y = dragState.clientY;
  const speed = y < edge ? -Math.ceil((edge - y) / 7)
    : y > innerHeight - edge ? Math.ceil((y - innerHeight + edge) / 7) : 0;
  if (speed) { window.scrollBy(0, speed); placeDraggedTask(y); }
  dragState.frame = requestAnimationFrame(dragScroll);
}

function startDragging(row, gesture) {
  if (dragState || !row.isConnected) return;
  const bounds = row.getBoundingClientRect();
  for (const other of taskRows.values()) setRowAction(other, '');
  const placeholder = document.createElement('div');
  placeholder.className = 'task-placeholder';
  placeholder.style.height = `${bounds.height}px`;
  placeholder.setAttribute('aria-hidden', 'true');
  row.before(placeholder);
  dragState = { row, placeholder, id: row.dataset.taskId, offsetY: gesture.y - bounds.top, clientY: gesture.y };
  row.classList.add('dragging');
  Object.assign(row.style, { position: 'fixed', left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, zIndex: '10' });
  try { row.setPointerCapture(gesture.id); } catch { /* The touch may have already ended. */ }
  row.ignoreClickUntil = performance.now() + 2000;
  announce('Task picked up. Drag up or down, then release.');
  dragScroll();
}

function finishDragging(cancelled = false) {
  if (!dragState) return;
  const drag = dragState;
  let after = drag.placeholder.nextElementSibling;
  while (after && !after.classList.contains('task-row')) after = after.nextElementSibling;
  if (after === drag.row) after = after.nextElementSibling;
  const beforeId = after?.dataset.taskId || null;
  cancelAnimationFrame(drag.frame);
  drag.placeholder.before(drag.row);
  drag.placeholder.remove();
  drag.row.classList.remove('dragging');
  for (const property of ['position', 'left', 'top', 'width', 'z-index']) drag.row.style.removeProperty(property);
  drag.row.ignoreClickUntil = performance.now() + 2000;
  drag.row.suppressClickUntil = performance.now() + 700;
  dragState = null;
  if (canPersist) tasks = readSaved();
  if (!cancelled) { tasks = moveTask(tasks, drag.id, beforeId); persist(); }
  refresh();
  announce(cancelled ? 'Move cancelled.' : 'Task moved.');
}

function attachSwipe(row) {
  let gesture = null;
  let holdTimer;
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  row.addEventListener('contextmenu', event => event.preventDefault());
  row.addEventListener('pointerdown', event => {
    if (!event.target.closest('.task-toggle') || (event.pointerType === 'mouse' && event.button !== 0) || dragState) return;
    cancelHold();
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false };
    holdTimer = setTimeout(() => { if (gesture) startDragging(row, gesture); }, 400);
  });
  row.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (dragState?.row === row) { event.preventDefault(); placeDraggedTask(event.clientY); return; }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancelHold();
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      gesture.horizontal = true;
      if (row.setPointerCapture && !row.hasPointerCapture(event.pointerId)) {
        try { row.setPointerCapture(event.pointerId); } catch { /* The pointer may have ended. */ }
      }
      event.preventDefault();
    }
  }, { passive: false });
  // Prevent scrolling only once a stationary hold has become a drag.
  row.addEventListener('touchmove', event => {
    if (dragState?.row !== row) return;
    event.preventDefault();
    if (event.touches[0]) placeDraggedTask(event.touches[0].clientY);
  }, { passive: false });
  row.addEventListener('pointerup', event => {
    cancelHold();
    if (!gesture || event.pointerId !== gesture.id) return;
    if (dragState?.row === row) { event.preventDefault(); finishDragging(); gesture = null; return; }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.horizontal || (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.3)) {
      row.suppressClickUntil = performance.now() + 500;
      row.ignoreClickUntil = performance.now() + 2000;
      event.preventDefault();
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.3) revealActions(row, dx > 0 ? 'edit' : 'delete');
    }
    gesture = null;
  });
  row.addEventListener('pointercancel', () => {
    cancelHold();
    if (dragState?.row === row) finishDragging(true);
    gesture = null;
  });
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
  if (button) {
    button.ignoreClickUntil = 0;
    button.closest('.task-row').ignoreClickUntil = 0;
  }
  if (event.pointerType === 'touch' && button) touchTap = { button, id: event.pointerId, x: event.clientX, y: event.clientY };
});
$('task-list').addEventListener('pointercancel', () => { touchTap = null; });
$('task-list').addEventListener('pointerup', event => {
  const tap = touchTap;
  touchTap = null;
  if (!tap || event.pointerId !== tap.id || event.target.closest('button') !== tap.button
    || Math.abs(event.clientX - tap.x) > 12 || Math.abs(event.clientY - tap.y) > 12) return;
  tap.button.ignoreClickUntil = performance.now() + 2000;
  event.preventDefault();
  activateTaskButton(tap.button, event);
});
$('task-list').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    const button = event.target.closest('button');
    if (button) { button.ignoreClickUntil = 0; button.closest('.task-row').ignoreClickUntil = 0; }
  }
  if (event.key === 'Escape' && dragState) finishDragging(true);
});
$('task-list').addEventListener('click', event => {
  const button = event.target.closest('button');
  const row = button?.closest('.task-row');
  if (!button || performance.now() < (button.ignoreClickUntil || 0) || performance.now() < (row?.ignoreClickUntil || 0)) return;
  activateTaskButton(button, event);
});

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.task-form') && !composingEntry && commitCurrentLine()) updateEntryLines();
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
  if (dragState) return;
  const focusedTaskId = document.activeElement?.dataset?.taskId;
  const now = Date.now();
  const active = tasks.filter(task => task.deletedAt === null && task.completedAt === null && task.expiredAt === null).sort((a, b) => a.createdAt - b.createdAt);
  const completed = tasks.filter(task => task.deletedAt === null && task.completedAt !== null && now < task.createdAt + DAY_MS).sort((a, b) => b.completedAt - a.completedAt);
  const visible = tasks.filter(task => task.deletedAt === null && task.expiredAt === null && now < task.createdAt + DAY_MS);
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

function saveDraft() {
  try {
    const value = $('task-input').value;
    if (value) localStorage.setItem(DRAFT_KEY, value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    if (canPersist) storageWarning('Your current line could not be saved on this device. Keep the app open until you add it.');
  }
}

function updateEntryLines() {
  $('next-task-form').hidden = !$('task-input').value.trim();
  saveDraft();
}

function commitCurrentLine() {
  const input = $('task-input');
  if (composingEntry || !input.value.trim()) return false;
  try {
    const task = createTask(input.value);
    if (canPersist) tasks = readSaved();
    tasks = reconcileTasks([...tasks, task]);
    persist();
    input.value = '';
    input.setCustomValidity('');
    saveDraft();
    render();
    announce('Task added.');
    return true;
  } catch (error) {
    input.setCustomValidity(error.message);
    input.reportValidity();
    return false;
  }
}

function advanceEntryLine() {
  if (composingEntry || !$('task-input').value.trim()) return;
  const previousForm = $('task-form');
  const previousInput = $('task-input');
  const nextForm = $('next-task-form');
  const nextInput = $('next-task-input');
  if (!commitCurrentLine()) return;
  // Rotate roles without replacing or refocusing the input the finger just chose.
  previousForm.removeAttribute('id');
  previousInput.removeAttribute('id');
  nextForm.id = 'task-form';
  nextInput.id = 'task-input';
  nextForm.querySelector('label').htmlFor = 'task-input';
  nextForm.querySelector('label').textContent = 'New task';
  previousForm.id = 'next-task-form';
  previousInput.id = 'next-task-input';
  previousForm.querySelector('label').htmlFor = 'next-task-input';
  previousForm.querySelector('label').textContent = 'Next task';
  nextForm.after(previousForm);
  updateEntryLines();
}

for (const form of document.querySelectorAll('.task-form')) {
  const input = form.querySelector('input');
  input.addEventListener('focus', () => {
    if (input.id === 'next-task-input') advanceEntryLine();
  });
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    updateEntryLines();
  });
  input.addEventListener('compositionstart', () => { composingEntry = true; });
  input.addEventListener('compositionend', () => {
    composingEntry = false;
    updateEntryLines();
    if (document.activeElement === $('next-task-input')) advanceEntryLine();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      if (event.isComposing || event.keyCode === 229 || composingEntry) return;
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!document.hidden && !document.activeElement?.closest('.task-form') && !composingEntry) {
        if (commitCurrentLine()) updateEntryLines();
        reloadIfReady();
      }
    }, 0);
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (input.id === 'next-task-input') advanceEntryLine();
    else if (commitCurrentLine()) {
      updateEntryLines();
      $('task-input').focus();
      reloadIfReady();
    }
  });
}
try { $('task-input').value = (localStorage.getItem(DRAFT_KEY) || '').slice(0, 240); } catch { /* Task storage reports inaccessible storage. */ }
updateEntryLines();

function reloadIfReady() {
  if (pendingReload && !dragState && !$('task-input').value && !$('edit-dialog').open) location.reload();
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
