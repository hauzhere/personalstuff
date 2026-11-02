import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, reconcileTasks, toggleTask, weeklyStats, weekBounds, normalizeTasks, DAY_MS } from '../task-store.js';

const monday = new Date(2026, 10, 2, 12).getTime();

test('creation trims text, creates independent IDs, and rejects empty or oversized input', () => {
  const task = createTask('  Take a walk  ', monday);
  assert.equal(task.text, 'Take a walk');
  assert.equal(task.createdAt, monday);
  assert.equal(task.completedAt, null);
  assert.equal(task.expiredAt, null);
  assert.notEqual(createTask('Take a walk', monday).id, task.id);
  assert.throws(() => createTask(' \n '), TypeError);
  assert.throws(() => createTask('x'.repeat(241)), RangeError);
  assert.throws(() => createTask('Task', NaN), TypeError);
});

test('unfinished tasks expire exactly at 24 hours without mutating stored input', () => {
  const task = createTask('Call home', monday);
  assert.equal(reconcileTasks([task], monday + DAY_MS - 1)[0].expiredAt, null);
  const expired = reconcileTasks([task], monday + DAY_MS)[0];
  assert.equal(expired.expiredAt, monday + DAY_MS);
  assert.equal(task.expiredAt, null);
  assert.deepEqual(reconcileTasks([expired], monday + 8 * DAY_MS), [expired]);
});

test('completion stops expiration and toggling is reversible before the deadline', () => {
  const task = createTask('Read', monday);
  const completed = toggleTask([task], task.id, monday + 1000);
  assert.equal(completed[0].completedAt, monday + 1000);
  assert.equal(reconcileTasks(completed, monday + 8 * DAY_MS)[0].expiredAt, null);
  const undone = toggleTask(completed, task.id, monday + 2000);
  assert.equal(undone[0].completedAt, null);
  assert.equal(undone[0].expiredAt, null);
  assert.equal(task.completedAt, null);
});

test('expired tasks cannot be completed; undoing after the deadline expires the task', () => {
  const task = createTask('Read', monday);
  const tooLate = toggleTask([task], task.id, monday + DAY_MS);
  assert.equal(tooLate[0].completedAt, null);
  assert.equal(tooLate[0].expiredAt, monday + DAY_MS);
  const completed = toggleTask([task], task.id, monday + 1000);
  const undone = toggleTask(completed, task.id, monday + DAY_MS + 5000);
  assert.equal(undone[0].completedAt, null);
  assert.equal(undone[0].expiredAt, monday + DAY_MS);
});

test('reopening after several days attributes expiration to its original day', () => {
  const task = createTask('Clean desk', monday);
  const stats = weeklyStats([task], monday + 4 * DAY_MS);
  assert.equal(stats.completed, 0);
  assert.equal(stats.removed, 1);
  assert.equal(stats.days[1].label, 'Tue');
  assert.equal(stats.days[1].removed, 1);
});

test('weekly report counts completions and removals in the local Monday week', () => {
  const { start, end } = weekBounds(monday);
  const earlier = { ...createTask('Earlier', start - 2 * DAY_MS), completedAt: start - DAY_MS };
  const onBoundary = { ...createTask('Monday', start - 1000), completedAt: start };
  const active = createTask('Still active', monday);
  const expired = createTask('Expired', start - DAY_MS);
  const future = { ...createTask('Future', monday), completedAt: end };
  const stats = weeklyStats([earlier, onBoundary, active, expired, future], monday);
  assert.equal(stats.completed, 1);
  assert.equal(stats.removed, 1);
  assert.equal(stats.days.length, 7);
  assert.equal(stats.days[0].label, 'Mon');
  assert.equal(stats.days[0].completed, 1);
  assert.equal(stats.days[0].removed, 1);
  assert.equal(stats.days[6].label, 'Sun');
  assert.equal(stats.start, start);
  assert.equal(stats.end, end);
});

test('weekly report excludes future events even within the current week', () => {
  const task = { ...createTask('Tomorrow', monday), completedAt: monday + 1000 };
  assert.equal(weeklyStats([task], monday).completed, 0);
});

test('Monday boundary advances the week and does not double-count Sunday events', () => {
  const { start, end } = weekBounds(monday);
  const sunday = { ...createTask('Sunday', end - 2000), completedAt: end - 1000 };
  assert.equal(weeklyStats([sunday], end - 1).completed, 1);
  const nextWeek = weeklyStats([sunday], end);
  assert.equal(nextWeek.start, end);
  assert.equal(nextWeek.completed, 0);
  assert.equal(nextWeek.removed, 0);
  assert.equal(new Date(start).getDay(), 1);
  assert.equal(new Date(end).getDay(), 1);
});

test('week boundaries remain at local midnight across daylight saving changes', () => {
  for (const date of [new Date(2026, 2, 8, 12), new Date(2026, 10, 1, 12)]) {
    const { start, end } = weekBounds(date.getTime());
    const from = new Date(start);
    const until = new Date(end);
    assert.equal(from.getDay(), 1);
    assert.equal(until.getDay(), 1);
    assert.equal(from.getHours(), 0);
    assert.equal(until.getHours(), 0);
    assert.equal(from.getMinutes(), 0);
    assert.equal(until.getMinutes(), 0);
    const expectedLength = 7 * DAY_MS + (until.getTimezoneOffset() - from.getTimezoneOffset()) * 60_000;
    assert.equal(end - start, expectedLength);
    assert.ok(start < date.getTime() && end > date.getTime());
  }
});

test('normalization rejects malformed and duplicate storage entries and strips extra fields', () => {
  const task = createTask('  Valid  ', monday);
  const normalized = normalizeTasks([
    null, {}, { ...task, id: '' }, { ...task, createdAt: 'yesterday' },
    { ...task, text: ' \n ' }, { ...task, arbitrary: 'ignored' }, { ...task },
  ]);
  assert.deepEqual(normalized, [task]);
  assert.deepEqual(normalizeTasks({ tasks: [task] }), []);
});

test('normalization preserves legitimate completion and canonicalizes expiration', () => {
  const task = createTask('A task', monday);
  assert.equal(normalizeTasks([{ ...task, completedAt: monday + 1000 }])[0].completedAt, monday + 1000);
  const expired = normalizeTasks([{ ...task, expiredAt: monday + 3 * DAY_MS }])[0];
  assert.equal(expired.expiredAt, monday + DAY_MS);
  const completed = normalizeTasks([{ ...task, completedAt: monday + 1000, expiredAt: monday + DAY_MS }])[0];
  assert.equal(completed.expiredAt, null);
  assert.equal(completed.completedAt, monday + 1000);
});
