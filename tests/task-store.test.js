import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, reconcileTasks, toggleTask, editTask, deleteTask, moveTask, weeklyStats, weekBounds, normalizeTasks, DAY_MS } from '../task-store.js';

const monday = new Date(2026, 10, 2, 12).getTime();

test('creation trims text, creates independent IDs, and rejects empty or oversized input', () => {
  const task = createTask('  Take a walk  ', monday);
  assert.equal(task.text, 'Take a walk');
  assert.equal(task.createdAt, monday);
  assert.equal(task.completedAt, null);
  assert.equal(task.expiredAt, null);
  assert.equal(task.deletedAt, null);
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

test('editing preserves identity, completion, and the original expiration deadline', () => {
  const task = createTask('Call home', monday);
  const edited = editTask([task], task.id, '  Call Dad  ', monday + DAY_MS - 1000)[0];
  assert.deepEqual(edited, { ...task, text: 'Call Dad' });
  assert.equal(task.text, 'Call home', 'Editing does not mutate the caller’s task');
  assert.equal(reconcileTasks([edited], monday + DAY_MS)[0].expiredAt, monday + DAY_MS);
  const completed = toggleTask([task], task.id, monday + 1000);
  const renamedCompletion = editTask(completed, task.id, 'Called home', monday + 2000)[0];
  assert.equal(renamedCompletion.completedAt, monday + 1000);
  assert.equal(renamedCompletion.createdAt, monday);
  assert.equal(renamedCompletion.text, 'Called home');
  assert.throws(() => editTask([task], task.id, '  ', monday), TypeError);
  assert.throws(() => editTask([task], task.id, 'x'.repeat(241), monday), RangeError);
});

test('deleted and expired tasks cannot be edited or toggled back into the list', () => {
  const task = createTask('Read a few pages', monday);
  const deleted = deleteTask([task], task.id, monday + 1000);
  assert.equal(deleted[0].deletedAt, monday + 1000);
  assert.deepEqual(editTask(deleted, task.id, 'Changed', monday + 2000), deleted);
  assert.deepEqual(toggleTask(deleted, task.id, monday + 2000), deleted);
  const expired = reconcileTasks([task], monday + DAY_MS);
  assert.deepEqual(editTask(expired, task.id, 'Changed', monday + DAY_MS), expired);
  assert.deepEqual(deleteTask(expired, task.id, monday + DAY_MS), expired);
});

test('manual deletion counts removal on its own day and does not expire a second time', () => {
  const task = createTask('Tidy up', monday);
  const deletionTime = monday + 2 * 60 * 60 * 1000;
  const deleted = deleteTask([task], task.id, deletionTime);
  assert.equal(task.deletedAt, null, 'Deleting does not mutate the caller’s task');
  assert.equal(deleted[0].expiredAt, null);
  const reconciled = reconcileTasks(deleted, monday + 4 * DAY_MS);
  assert.equal(reconciled[0].expiredAt, null);
  const stats = weeklyStats(reconciled, monday + 4 * DAY_MS);
  assert.equal(stats.removed, 1);
  assert.equal(stats.completed, 0);
  assert.equal(stats.days[0].removed, 1);
  assert.equal(stats.days[1].removed, 0);
  assert.deepEqual(deleteTask(deleted, task.id, deletionTime + 1000), deleted, 'Repeated deletion preserves its original event time');
});

test('deleting a completed task preserves completed totals without also counting a removal', () => {
  const task = createTask('Go for a walk', monday);
  const completed = toggleTask([task], task.id, monday + 1000);
  const deleted = deleteTask(completed, task.id, monday + 2000);
  assert.equal(deleted[0].completedAt, monday + 1000);
  assert.equal(deleted[0].deletedAt, monday + 2000);
  const stats = weeklyStats(deleted, monday + 3 * DAY_MS);
  assert.equal(stats.completed, 1);
  assert.equal(stats.removed, 0);
});

test('edits and deletes after the original deadline cannot change an invisible completed task', () => {
  const task = createTask('Read', monday);
  const completed = toggleTask([task], task.id, monday + 1000);
  assert.deepEqual(editTask(completed, task.id, 'A different task', monday + DAY_MS), completed);
  assert.deepEqual(deleteTask(completed, task.id, monday + DAY_MS), completed);
});

test('legacy saved tasks acquire a null deletion field without changing their other data', () => {
  const task = createTask('A legacy task', monday);
  const { deletedAt, ...legacy } = task;
  assert.deepEqual(normalizeTasks([legacy]), [task]);
  assert.deepEqual(reconcileTasks([legacy], monday), [task]);
  assert.equal(toggleTask([legacy], legacy.id, monday + 1000)[0].completedAt, monday + 1000);
});

test('normalization retains valid completion history and chooses the earliest valid removal', () => {
  const task = createTask('A saved task', monday);
  const manuallyDeleted = normalizeTasks([{ ...task, deletedAt: monday + 1000, expiredAt: monday + DAY_MS }])[0];
  assert.equal(manuallyDeleted.deletedAt, monday + 1000);
  assert.equal(manuallyDeleted.expiredAt, null);
  const lateDeletion = normalizeTasks([{ ...task, deletedAt: monday + DAY_MS + 1000 }])[0];
  assert.equal(lateDeletion.deletedAt, null);
  assert.equal(lateDeletion.expiredAt, monday + DAY_MS);
  const completedThenDeleted = normalizeTasks([{ ...task, completedAt: monday + 1000, deletedAt: monday + 2000, expiredAt: monday + DAY_MS }])[0];
  assert.equal(completedThenDeleted.completedAt, monday + 1000);
  assert.equal(completedThenDeleted.deletedAt, monday + 2000);
  assert.equal(completedThenDeleted.expiredAt, null);
  const conflictingDeletion = normalizeTasks([{ ...task, completedAt: monday + 2000, deletedAt: monday + 1000 }])[0];
  assert.equal(conflictingDeletion.completedAt, monday + 2000);
  assert.equal(conflictingDeletion.deletedAt, null);
  assert.equal(normalizeTasks([{ ...task, deletedAt: monday - 1 }])[0].deletedAt, null);
});

test('moving tasks up, down, and to the end preserves their data without mutating input', () => {
  const a = Object.freeze(createTask('First', monday));
  const b = Object.freeze(createTask('Second', monday + 1000));
  const c = Object.freeze(createTask('Third', monday + 2000));
  const tasks = Object.freeze([a, b, c]);
  const now = monday + 5000;
  assert.deepEqual(moveTask(tasks, c.id, a.id, now), [c, a, b]);
  assert.deepEqual(moveTask(tasks, a.id, c.id, now), [b, a, c]);
  assert.deepEqual(moveTask(tasks, a.id, null, now), [b, c, a]);
  assert.deepEqual(tasks, [a, b, c]);
});

test('moving a task keeps deleted and expired history and completed report totals', () => {
  const expired = reconcileTasks([createTask('Old task', monday - DAY_MS - 1000)], monday)[0];
  const completed = { ...createTask('Finished', monday), completedAt: monday + 1000 };
  const deleted = { ...createTask('Removed', monday), deletedAt: monday + 2000 };
  const pending = createTask('Still to do', monday + 1000);
  const tasks = [expired, completed, deleted, pending];
  const now = monday + 5000;
  const moved = moveTask(tasks, pending.id, completed.id, now);
  assert.deepEqual(moved, [expired, pending, completed, deleted]);
  assert.deepEqual(weeklyStats(moved, now), weeklyStats(tasks, now));
  const completedMoved = moveTask(tasks, completed.id, null, now);
  assert.deepEqual(completedMoved, [expired, deleted, pending, completed]);
});

test('invalid move sources and targets cannot resurrect invisible tasks', () => {
  const active = createTask('Active', monday);
  const deleted = { ...createTask('Deleted', monday), deletedAt: monday + 1000 };
  const expired = createTask('Expired', monday - DAY_MS);
  const oldCompleted = { ...createTask('Old win', monday - DAY_MS), completedAt: monday - DAY_MS + 1000 };
  const tasks = [active, deleted, expired, oldCompleted];
  const now = monday + 5000;
  const expected = reconcileTasks(tasks, now);
  for (const id of ['missing', deleted.id, expired.id, oldCompleted.id]) {
    assert.deepEqual(moveTask(tasks, id, active.id, now), expected);
  }
  for (const beforeId of ['missing', active.id, deleted.id, expired.id, oldCompleted.id]) {
    assert.deepEqual(moveTask(tasks, active.id, beforeId, now), expected);
  }
});

test('saved and legacy task arrays retain their chosen order through normalization and actions', () => {
  const a = createTask('Oldest', monday);
  const b = createTask('Middle', monday + 1000);
  const c = createTask('Newest', monday + 2000);
  const legacy = [c, a, b].map(({ deletedAt, ...task }) => task);
  const normalized = normalizeTasks(legacy);
  assert.deepEqual(normalized, [c, a, b]);
  const moved = moveTask(normalized, a.id, c.id, monday + 5000);
  const edited = editTask(moved, c.id, 'Renamed', monday + 6000);
  const completed = toggleTask(edited, a.id, monday + 7000);
  assert.deepEqual(completed.map(task => task.id), [a.id, c.id, b.id]);
  assert.deepEqual(normalizeTasks(JSON.parse(JSON.stringify(completed))), completed);
});
