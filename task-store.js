export const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= MAX_TIMESTAMP - DAY_MS;
}

function requireTime(value) {
  if (!timestamp(value)) throw new TypeError('A valid timestamp is required.');
  return value;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createTask(text, nowMs = Date.now()) {
  requireTime(nowMs);
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('Write a task first.');
  }
  const trimmed = text.trim();
  if (trimmed.length > 240) throw new RangeError('Keep tasks to 240 characters.');
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${nowMs.toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { id, text: trimmed, createdAt: nowMs, completedAt: null, expiredAt: null };
}

/** Discard malformed storage entries without trusting extra object properties. */
export function normalizeTasks(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  const tasks = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string'
      || !item.id || item.id.length > 128 || ids.has(item.id)
      || typeof item.text !== 'string' || !item.text.trim()
      || !timestamp(item.createdAt)) continue;
    const deadline = item.createdAt + DAY_MS;
    const completedAt = timestamp(item.completedAt)
      && item.completedAt >= item.createdAt && item.completedAt < deadline
      ? item.completedAt : null;
    const expiredAt = completedAt === null && timestamp(item.expiredAt)
      && item.expiredAt >= deadline ? deadline : null;
    tasks.push({
      id: item.id,
      text: item.text.trim().slice(0, 240),
      createdAt: item.createdAt,
      completedAt,
      expiredAt,
    });
    ids.add(item.id);
  }
  return tasks;
}

/** Expiration is recorded at its deadline, even if the app was closed then. */
export function reconcileTasks(tasks, nowMs = Date.now()) {
  requireTime(nowMs);
  return tasks.map(task => {
    if (task.expiredAt === null && task.completedAt === null
      && nowMs >= task.createdAt + DAY_MS) {
      return { ...task, expiredAt: task.createdAt + DAY_MS };
    }
    return { ...task };
  });
}

/** A completed task can be unchecked; its original 24-hour deadline still applies. */
export function toggleTask(tasks, id, nowMs = Date.now()) {
  return reconcileTasks(tasks, nowMs).map(task => {
    if (task.id !== id || task.expiredAt !== null) return task;
    if (task.completedAt === null) return { ...task, completedAt: nowMs };
    return {
      ...task,
      completedAt: null,
      expiredAt: nowMs >= task.createdAt + DAY_MS ? task.createdAt + DAY_MS : null,
    };
  });
}

/** Local calendar weeks run from Monday 00:00 to the following Monday. */
export function weekBounds(nowMs = Date.now()) {
  requireTime(nowMs);
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start: start.getTime(), end: end.getTime() };
}

export function weeklyStats(tasks, nowMs = Date.now()) {
  const { start, end } = weekBounds(nowMs);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    return {
      date: localDateKey(day),
      label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getDay()],
      completed: 0,
      removed: 0,
    };
  });
  let completed = 0;
  let removed = 0;
  for (const task of reconcileTasks(tasks, nowMs)) {
    for (const [field, key] of [['completedAt', 'completed'], ['expiredAt', 'removed']]) {
      const eventTime = task[field];
      if (eventTime === null || eventTime < start || eventTime >= end || eventTime > nowMs) continue;
      const day = days.find(item => item.date === localDateKey(new Date(eventTime)));
      if (!day) continue;
      day[key] += 1;
      if (key === 'completed') completed += 1;
      else removed += 1;
    }
  }
  return { completed, removed, days, start, end };
}
