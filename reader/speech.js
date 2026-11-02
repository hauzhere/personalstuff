/** Short sentence-aware chunks keep device voices responsive on long decks. */
export function splitSpeechText(text, maxChars = 180) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!clean) return [];
  const limit = Math.max(40, Math.floor(Number(maxChars)) || 180);
  let sentences;
  try {
    sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(clean)].map(item => item.segment.trim());
  } catch {
    const parts = clean.split(/([.!?]+(?:\s+|$))/u);
    sentences = [];
    for (let i = 0; i < parts.length; i += 2) {
      const sentence = `${parts[i]}${parts[i + 1] || ''}`.trim();
      if (sentence) sentences.push(sentence);
    }
  }
  const chunks = [];
  let current = '';
  function append(piece) {
    if (!piece) return;
    if (current && current.length + piece.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current} ${piece}` : piece;
  }
  for (const sentence of sentences) {
    if (sentence.length <= limit) { append(sentence); continue; }
    if (current) { chunks.push(current); current = ''; }
    for (const word of sentence.split(/\s+/u)) {
      if (word.length <= limit) { append(word); continue; }
      if (current) { chunks.push(current); current = ''; }
      // Also bound unusually long URLs or unbroken OCR text, preserving Unicode.
      const letters = [...word];
      while (letters.length > limit) chunks.push(letters.splice(0, limit).join(''));
      append(letters.join(''));
    }
    if (current) { chunks.push(current); current = ''; }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Prefer clear English enhanced/device voices, without assuming a provider. */
export function preferredVoice(voices = []) {
  function score(voice) {
    const name = `${voice.name || ''} ${voice.voiceURI || ''}`;
    return (/^en(?:[-_]|$)/iu.test(voice.lang || '') ? 100 : 0)
      + (/natural|neural|enhanced|premium|siri/iu.test(name) ? 35 : 0)
      + (/aria|ava|samantha|jenny|daniel/iu.test(name) ? 12 : 0)
      + (voice.default ? 5 : 0)
      + (voice.localService ? 2 : 0);
  }
  return [...voices].sort((a, b) => score(b) - score(a))[0] || null;
}

const ERROR_MESSAGES = {
  'not-allowed': 'Your browser blocked narration. Tap Play again to start the voice.',
  'audio-busy': 'Your device audio is busy. Pause other audio and tap Play again.',
  'audio-hardware': 'Your device audio is unavailable. Check the volume and audio output, then tap Play.',
  network: 'This voice needs a connection. Reconnect or choose a local device voice.',
  'voice-unavailable': 'That voice is unavailable. Choose another voice and tap Play.',
  'language-unavailable': 'That language is unavailable on this device. Choose another voice.',
  'synthesis-unavailable': 'Speech is unavailable on this device. Try another browser or a different voice.',
  interrupted: 'Narration was interrupted. Tap Play to continue from this part.',
  canceled: 'Narration stopped. Tap Play to continue from this part.',
};

export class Narrator {
  constructor({
    synthesis = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    onStateChange = () => {},
    onSlideChange = () => {},
    onProgress = () => {},
    onError = () => {},
    onVoicesChange = () => {},
  } = {}) {
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.supported = Boolean(synthesis && typeof synthesis.speak === 'function' && typeof Utterance === 'function');
    this.callbacks = { onStateChange, onSlideChange, onProgress, onError, onVoicesChange };
    this.state = 'idle';
    this.index = 0;
    this.rate = 1;
    this.voiceURI = preferredVoice(this.getVoices())?.voiceURI || '';
    this.slides = [];
    this._chunks = [];
    this._chunkIndex = 0;
    this._generation = 0;
    this._utterance = null;
    this._announcedIndex = null;
    this._destroyed = false;
    this._voicesChanged = () => {
      const voices = this.getVoices();
      if (!voices.some(voice => voice.voiceURI === this.voiceURI)) this.voiceURI = preferredVoice(voices)?.voiceURI || '';
      this.callbacks.onVoicesChange(voices);
    };
    if (this.synthesis?.addEventListener) this.synthesis.addEventListener('voiceschanged', this._voicesChanged);
    else if (this.synthesis) {
      this._previousVoicesChanged = this.synthesis.onvoiceschanged;
      this._legacyVoicesChanged = event => {
        this._previousVoicesChanged?.call(this.synthesis, event);
        this._voicesChanged();
      };
      this.synthesis.onvoiceschanged = this._legacyVoicesChanged;
    }
    queueMicrotask(() => { if (!this._destroyed) this._voicesChanged(); });
  }

  getVoices() {
    try { return [...(this.synthesis?.getVoices() || [])]; } catch { return []; }
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  _chunkLimit() { return Math.round(180 * Math.min(1, this.rate)); }

  _cancel() {
    this._generation += 1;
    this._utterance = null;
    try { this.synthesis?.cancel(); } catch { /* No audio queue may exist yet. */ }
  }

  _findReadable(index, direction = 1) {
    for (let i = index; i >= 0 && i < this.slides.length; i += direction) if (this._chunks[i]?.length) return i;
    return -1;
  }

  _notifySlide() {
    if (this._announcedIndex === this.index) return;
    this._announcedIndex = this.index;
    this.callbacks.onSlideChange(this.index);
  }

  _notifyProgress() {
    this.callbacks.onProgress({ slideIndex: this.index, chunkIndex: this._chunkIndex, totalChunks: this._chunks[this.index]?.length || 0 });
  }

  setSlides(slides = []) {
    this.stop();
    this.slides = Array.isArray(slides) ? [...slides] : [];
    this._chunks = this.slides.map(slide => splitSpeechText(slide.narration || '', this._chunkLimit()));
    this.index = Math.max(0, this._findReadable(0));
    this._chunkIndex = 0;
    this._announcedIndex = null;
    if (this.slides.length) this._notifySlide();
    return this.slides.length;
  }

  play(index) {
    if (this._destroyed) return false;
    if (!this.supported) {
      this.callbacks.onError('This browser does not support device narration. Try Safari, Chrome, or Edge on your phone or computer.');
      return false;
    }
    if (index === undefined && this.state === 'paused') return this.resume();
    if (index === undefined && this.state === 'playing') return true;
    const start = index === undefined ? (this.state === 'ended' ? 0 : this.index) : Number(index);
    const next = this._findReadable(Math.max(0, Math.floor(Number.isFinite(start) ? start : 0)));
    this._cancel();
    if (next < 0) {
      this._setState('ended');
      this.callbacks.onError('There is no readable new text from this slide. Choose an earlier text slide or turn off duplicate skipping.');
      return false;
    }
    this.index = next;
    this._chunkIndex = 0;
    this._setState('playing');
    this._speakCurrent();
    return true;
  }

  _speakCurrent() {
    if (this.state !== 'playing' || this._destroyed) return;
    const text = this._chunks[this.index]?.[this._chunkIndex];
    if (!text) { this._setState('ended'); return; }
    this._notifySlide();
    this._notifyProgress();
    const generation = this._generation;
    try {
      const utterance = new this.Utterance(text);
      const voice = this.getVoices().find(item => item.voiceURI === this.voiceURI) || preferredVoice(this.getVoices());
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || 'en-US';
      utterance.rate = this.rate;
      utterance.pitch = 1;
      utterance.volume = 1;
      this._utterance = utterance;
      utterance.onend = () => {
        if (generation !== this._generation || this._utterance !== utterance) return;
        this._utterance = null;
        this._chunkIndex += 1;
        if (this._chunkIndex >= this._chunks[this.index].length) {
          const next = this._findReadable(this.index + 1);
          if (next < 0) { this._setState('ended'); return; }
          this.index = next;
          this._chunkIndex = 0;
        }
        if (this.state === 'playing') this._speakCurrent();
      };
      utterance.onerror = event => {
        if (generation !== this._generation || this._utterance !== utterance) return;
        this._utterance = null;
        this._setState('paused');
        this.callbacks.onError(ERROR_MESSAGES[event?.error] || 'Your device could not read this part. Choose another voice or tap Play to retry.');
      };
      // A cancelled native queue can remain paused; reset it before speaking.
      if (this.synthesis.paused) this.synthesis.resume();
      this.synthesis.speak(utterance);
    } catch {
      if (generation !== this._generation) return;
      this._utterance = null;
      this._setState('paused');
      this.callbacks.onError('Your device could not start narration. Choose another voice and tap Play again.');
    }
  }

  pause() {
    if (this.state !== 'playing') return false;
    this._setState('paused');
    try { this.synthesis.pause(); } catch { this._cancel(); }
    return true;
  }

  resume() {
    if (this.state !== 'paused' || this._destroyed) return false;
    this._setState('playing');
    if (this._utterance) {
      try { this.synthesis.resume(); } catch { this._cancel(); this._speakCurrent(); }
    } else this._speakCurrent();
    return true;
  }

  stop() {
    this._cancel();
    this._chunkIndex = 0;
    this._setState('idle');
  }

  _seek(direction) {
    const next = this._findReadable(this.index + direction, direction);
    if (next < 0) return false;
    const state = this.state;
    this._cancel();
    this.index = next;
    this._chunkIndex = 0;
    this._notifySlide();
    this._notifyProgress();
    if (state === 'playing') this._speakCurrent();
    else this._setState(state === 'paused' ? 'paused' : 'idle');
    return true;
  }

  next() { return this._seek(1); }
  previous() { return this._seek(-1); }

  _restartForSetting() {
    const state = this.state;
    if (state !== 'playing' && state !== 'paused') return;
    this._cancel();
    if (state === 'playing') this._speakCurrent();
  }

  setVoice(voiceURI = '') {
    const next = String(voiceURI || preferredVoice(this.getVoices())?.voiceURI || '');
    if (this.voiceURI !== next) { this.voiceURI = next; this._restartForSetting(); }
    return this.voiceURI;
  }

  setRate(rate = 1) {
    const parsed = Number(rate);
    const next = Math.min(1.6, Math.max(0.65, Number.isFinite(parsed) ? parsed : 1));
    if (this.rate === next) return next;
    const prefix = this._chunks[this.index]?.slice(0, this._chunkIndex) || [];
    const rest = this._chunks[this.index]?.slice(this._chunkIndex).join(' ') || '';
    this.rate = next;
    this._chunks = this.slides.map(slide => splitSpeechText(slide.narration || '', this._chunkLimit()));
    if (rest) this._chunks[this.index] = [...prefix, ...splitSpeechText(rest, this._chunkLimit())];
    this._restartForSetting();
    return next;
  }

  destroy() {
    this.stop();
    this._destroyed = true;
    if (this.synthesis?.removeEventListener) this.synthesis.removeEventListener('voiceschanged', this._voicesChanged);
    else if (this.synthesis && this.synthesis.onvoiceschanged === this._legacyVoicesChanged) this.synthesis.onvoiceschanged = this._previousVoicesChanged;
  }
}
