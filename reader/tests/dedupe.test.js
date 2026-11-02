import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSlides, summarizeSlides } from '../dedupe.js';

const page = (number, ...lines) => ({ number, lines, text: lines.join('\n') });

test('a progressive MIS 544 slide narrates only each new revealed bullet', () => {
  const pages = [
    page(1, 'Data warehouses', 'Store integrated historical data.'),
    page(2, 'Data warehouses', 'Store integrated historical data.', 'Support analytical decision making.'),
    page(3, 'Data warehouses', 'Store integrated historical data.', 'Support analytical decision making.', 'Are separate from operational systems.'),
  ];
  const slides = analyzeSlides(pages);
  assert.deepEqual(slides[0].spokenLines, pages[0].lines);
  assert.deepEqual(slides[1].spokenLines, ['Support analytical decision making.']);
  assert.deepEqual(slides[2].spokenLines, ['Are separate from operational systems.']);
  assert.equal(slides[1].transition, true);
  assert.equal(slides[2].omittedLines, 3);
  assert.deepEqual(slides[1].lines, pages[1].lines);
  assert.equal(slides[1].text, pages[1].text);
});

test('exact and reordered duplicate slides have no repeated narration', () => {
  const original = page(1, 'Database models', 'Relational tables organize records.', 'Keys identify individual rows.');
  const slides = analyzeSlides([
    original,
    { ...original, number: 2 },
    page(3, 'Database models', 'Keys identify individual rows.', 'Relational tables organize records.'),
  ]);
  assert.equal(slides[1].duplicate, true);
  assert.equal(slides[2].duplicate, true);
  assert.equal(slides[2].narration, '');
  assert.equal(slides[2].estimatedSeconds, 0);
});

test('bullets, punctuation, whitespace, and case normalize without losing the source', () => {
  const slides = analyzeSlides([
    page(1, 'Database Models', '• Relational tables organize records.'),
    page(2, 'DATABASE MODELS', '  -  relational   tables organize records!  ', 'A key identifies a row.'),
  ]);
  assert.deepEqual(slides[1].spokenLines, ['A key identifies a row.']);
  assert.match(slides[1].text, /DATABASE MODELS/);
});

test('a reused title with new body content starts a new reading, not a transition', () => {
  const slides = analyzeSlides([
    page(1, 'Discussion', 'A transaction must be atomic.'),
    page(2, 'Discussion', 'Indexes improve the speed of selected queries.'),
  ]);
  assert.equal(slides[1].transition, false);
  assert.deepEqual(slides[1].spokenLines, ['Discussion', 'Indexes improve the speed of selected queries.']);
});

test('genuine topic changes reset history so a later recap is read again', () => {
  const slides = analyzeSlides([
    page(1, 'Warehouses', 'Integrate historical operational data.'),
    page(2, 'Security', 'Restrict access to confidential data.'),
    page(3, 'Warehouses', 'Integrate historical operational data.'),
  ]);
  assert.equal(slides[2].duplicate, false);
  assert.equal(slides[2].omittedLines, 0);
});

test('clearly extended lines speak their newly added clause', () => {
  const slides = analyzeSlides([
    page(1, 'Availability', 'A distributed database stores data'),
    page(2, 'Availability', 'A distributed database stores data across multiple locations.'),
  ]);
  assert.deepEqual(slides[1].spokenLines, ['across multiple locations.']);
});

test('changed signs, quantities, and negation are never suppressed as duplicates', () => {
  const slides = analyzeSlides([
    page(1, 'Results', 'The annual change is 10%.', 'The result is statistically significant.'),
    page(2, 'Results', 'The annual change is -10%.', 'The result is not statistically significant.'),
  ]);
  assert.equal(slides[1].duplicate, false);
  assert.match(slides[1].narration, /-10%/);
  assert.match(slides[1].narration, /not statistically significant/);
  const negativeAtStart = analyzeSlides([page(1, 'Change', '10% annual growth.'), page(2, 'Change', '- 10% annual growth.')]);
  assert.equal(negativeAtStart[1].duplicate, false, 'A leading spaced minus sign is not a decorative bullet');
  assert.match(negativeAtStart[1].narration, /- 10%/);
});

test('page counters and a repeated copyright footer do not interrupt transition matching', () => {
  const slides = analyzeSlides([
    page(1, 'Data quality', 'Data should be accurate and complete.', '© 2026 University — 1', 'Page 1 of 3'),
    page(2, 'Data quality', 'Data should be accurate and complete.', 'Missing values need explicit treatment.', '© 2026 University — 2', 'Page 2 of 3'),
    page(3, 'Data quality', 'Data should be accurate and complete.', 'Missing values need explicit treatment.', '© 2026 University — 3', 'Page 3 of 3'),
  ]);
  assert.match(slides[1].narration, /Missing values/);
  assert.doesNotMatch(slides[1].narration, /Page 2|University|©/);
  assert.equal(slides[2].duplicate, true);
});

test('sequenced bare slide numbers are removed, while legitimate numeric content is retained', () => {
  const slides = analyzeSlides([
    page(1, 'Heading', 'A useful first bullet.', '1'),
    page(2, 'Heading', 'A useful first bullet.', 'A useful second bullet.', '2'),
    page(3, 'Heading', 'A useful first bullet.', 'A useful second bullet.', '3'),
  ]);
  assert.deepEqual(slides[1].spokenLines, ['A useful second bullet.']);
  assert.equal(analyzeSlides([page(1, '42')])[0].narration, '42.');
});

test('line wrapping changes do not repeat the same paragraph', () => {
  const slides = analyzeSlides([
    page(1, 'Distribution', 'A distributed database stores data', 'across several locations.'),
    page(2, 'Distribution', 'A distributed database stores', 'data across several locations.', 'Replication improves availability.'),
  ]);
  assert.deepEqual(slides[1].spokenLines, ['Replication improves availability.']);
});

test('textless slides are marked explicitly and do not invent narration', () => {
  const slides = analyzeSlides([page(1, 'One topic', 'A useful content line.'), page(2), page(3, 'One topic', 'A useful content line.')]);
  assert.equal(slides[1].textless, true);
  assert.equal(slides[1].duplicate, false);
  assert.equal(slides[1].narration, '');
  assert.equal(slides[2].duplicate, false, 'An image-only break does not silently suppress the following slide');
});

test('turning repeat skipping off reads each slide fully', () => {
  const pages = [page(1, 'Title', 'A useful content line.'), page(2, 'Title', 'A useful content line.')];
  const slides = analyzeSlides(pages, { skipRepeated: false });
  assert.equal(slides[1].duplicate, false);
  assert.deepEqual(slides[1].spokenLines, pages[1].lines);
});

test('long reveal sequences remain incremental and summaries measure actual spoken text', () => {
  const bullets = Array.from({ length: 16 }, (_, index) => `A distinct new example number ${index + 1} explains this concept.`);
  const slides = analyzeSlides(bullets.map((_, index) => page(index + 1, 'A lecture topic', ...bullets.slice(0, index + 1))));
  for (let index = 1; index < slides.length; index++) assert.deepEqual(slides[index].spokenLines, [bullets[index]]);
  const summary = summarizeSlides([...slides, { narration: '', textless: true, duplicate: false, omittedLines: 0 }]);
  assert.equal(summary.totalSlides, 17);
  assert.equal(summary.readableSlides, 16);
  assert.equal(summary.duplicateSlides, 0);
  assert.ok(summary.omittedLines > 100);
  assert.ok(summary.totalWords > 100);
  assert.ok(summary.estimatedSeconds > 0);
  assert.deepEqual(analyzeSlides([]), []);
  assert.equal(summarizeSlides([]).estimatedSeconds, 0);
});
