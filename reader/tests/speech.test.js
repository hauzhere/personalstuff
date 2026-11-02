import test from 'node:test';
import assert from 'node:assert/strict';
import { Narrator, preferredVoice, splitSpeechText } from '../speech.js';

class Utterance {
  constructor(text) { this.text = text; }
}

function fixture(slides) {
  const events = { states: [], slides: [], progress: [], errors: [] };
  const synthesis = {
    spoken: [], paused: false, cancellations: 0,
    speak(utterance) { this.spoken.push(utterance); },
    cancel() { this.cancellations++; },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    getVoices() { return [{ voiceURI: 'local', name: 'Samantha Enhanced', lang: 'en-US', localService: true }]; },
    addEventListener() {}, removeEventListener() {},
  };
  const narrator = new Narrator({ synthesis, Utterance,
    onStateChange: state => events.states.push(state),
    onSlideChange: index => events.slides.push(index),
    onProgress: progress => events.progress.push(progress),
    onError: error => events.errors.push(error),
  });
  narrator.setSlides(slides);
  return { narrator, synthesis, events, last: () => synthesis.spoken.at(-1) };
}

test('sentence-aware chunks retain text and bound long uninterrupted lines', () => {
  const text = 'Read the first sentence. Then read the next sentence, with its supporting detail. Finish this thought!';
  const chunks = splitSpeechText(text, 60);
  assert.equal(chunks.join(' '), text);
  assert.ok(chunks.every(chunk => chunk.length <= 60));
  assert.deepEqual(splitSpeechText(' \n '), []);
  const unbroken = 'x'.repeat(10000);
  const longChunks = splitSpeechText(unbroken, 180);
  assert.equal(longChunks.join(''), unbroken);
  assert.ok(longChunks.every(chunk => chunk.length <= 180));
});

test('preferred voice favors English enhanced voices and handles no installed voices', () => {
  const english = { voiceURI: 'english', lang: 'en-US', name: 'Samantha Enhanced', localService: true };
  const other = { voiceURI: 'other', lang: 'fr-FR', name: 'French Natural', default: true };
  assert.equal(preferredVoice([other, english]), english);
  assert.equal(preferredVoice([]), null);
});

test('the fallback splitter preserves decimal numbers and every sentence', () => {
  const Segmenter = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    const text = 'Version 1.2 stays. Use 3.14 units. Last line';
    assert.equal(splitSpeechText(text, 40).join(' '), text);
  } finally { Intl.Segmenter = Segmenter; }
});

test('narration speaks new text in order and skips duplicate and textless slides', () => {
  const { narrator, synthesis, events, last } = fixture([
    { narration: 'First idea.' }, { narration: '' }, { narration: 'One newly revealed line.' }, { narration: '' },
  ]);
  assert.equal(narrator.play(), true);
  assert.equal(last().text, 'First idea.');
  last().onend();
  assert.equal(last().text, 'One newly revealed line.');
  assert.equal(narrator.index, 2);
  last().onend();
  assert.equal(narrator.state, 'ended');
  assert.equal(synthesis.spoken.length, 2);
  assert.deepEqual(events.slides, [0, 2]);
  assert.equal(events.errors.length, 0);
});

test('cancelled utterance callbacks cannot restart a stopped or replaced deck', () => {
  const { narrator, synthesis, events, last } = fixture([{ narration: 'Old first.' }, { narration: 'Old next.' }]);
  narrator.play();
  const old = last();
  narrator.setSlides([{ narration: 'New deck.' }]);
  old.onend();
  old.onerror({ error: 'canceled' });
  assert.equal(synthesis.spoken.length, 1);
  assert.equal(narrator.state, 'idle');
  assert.equal(events.errors.length, 0);
  narrator.play();
  assert.equal(last().text, 'New deck.');
});

test('pause/resume and seeking preserve state and reject stale callbacks', () => {
  const { narrator, synthesis, last } = fixture([{ narration: 'First.' }, { narration: '' }, { narration: 'Last.' }]);
  narrator.play();
  const first = last();
  narrator.pause();
  assert.equal(narrator.state, 'paused');
  assert.equal(synthesis.paused, true);
  narrator.next();
  assert.equal(narrator.index, 2);
  assert.equal(narrator.state, 'paused');
  first.onend();
  assert.equal(synthesis.spoken.length, 1);
  narrator.resume();
  assert.equal(last().text, 'Last.');
  assert.equal(narrator.state, 'playing');
  narrator.previous();
  assert.equal(last().text, 'First.');
});

test('changing settings restarts only the current chunk and retains the remaining text', () => {
  const text = 'Start here. '.repeat(60).trim();
  const { narrator, synthesis, last } = fixture([{ narration: text }]);
  narrator.play();
  const old = last();
  narrator.setRate(0.65);
  assert.equal(last().rate, 0.65);
  assert.ok(last().text.length <= 117);
  old.onend();
  assert.equal(synthesis.spoken.length, 2, 'A canceled chunk cannot enqueue more speech');
  const read = [];
  let guard = 0;
  while (narrator.state === 'playing' && guard++ < 100) {
    read.push(last().text);
    last().onend();
  }
  assert.equal(read.join(' '), text);
  assert.equal(narrator.state, 'ended');
  assert.equal(narrator.setRate(99), 1.6);
  assert.equal(narrator.setRate(-1), 0.65);
});

test('a genuine speech failure pauses and can retry the same chunk', () => {
  const { narrator, events, last } = fixture([{ narration: 'Try this part.' }]);
  narrator.play();
  last().onerror({ error: 'network' });
  assert.equal(narrator.state, 'paused');
  assert.match(events.errors[0], /connection|Reconnect/);
  narrator.resume();
  assert.equal(last().text, 'Try this part.');
});

test('unsupported speech reports a useful error without throwing', () => {
  const errors = [];
  const narrator = new Narrator({ synthesis: null, Utterance: undefined, onError: message => errors.push(message) });
  narrator.setSlides([{ narration: 'Some text.' }]);
  assert.equal(narrator.play(), false);
  assert.equal(narrator.supported, false);
  assert.match(errors[0], /does not support/);
  narrator.destroy();
});
