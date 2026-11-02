import { loadPdf, MAX_PDF_BYTES } from './pdf-loader.js?v=1';
import { analyzeSlides, summarizeSlides } from './dedupe.js?v=1';
import { Narrator } from './speech.js?v=1';

const $ = id => document.getElementById(id);
const decks = [];
const fileRows = new Map();
let selectedId = null;
let processing = false;
let renderToken = 0;
let renderChain = Promise.resolve();
let slideListKey = '';
let bindingSlides = false;
let waitingAfterId = null;
let saved = {};
try { saved = JSON.parse(localStorage.getItem('slidecast.preferences.v1') || '{}'); } catch { /* Defaults work without storage. */ }
if (!saved || typeof saved !== 'object') saved = {};
$('dedupe-toggle').checked = saved.skipRepeated !== false;
$('auto-next').checked = saved.autoNext !== false;
if ([0.75, 1, 1.15, 1.25, 1.5].includes(saved.rate)) $('speed-select').value = String(saved.rate);

const current = () => decks.find(deck => deck.id === selectedId);
function status(message) { $('app-status').textContent = message; }
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function preferences() {
  try {
    localStorage.setItem('slidecast.preferences.v1', JSON.stringify({
      skipRepeated: $('dedupe-toggle').checked,
      autoNext: $('auto-next').checked,
      rate: Number($('speed-select').value),
      voice: $('voice-select').value,
    }));
  } catch { /* Reading remains available when preferences cannot be saved. */ }
}

const narrator = new Narrator({
  onStateChange(state) {
    renderPlayer();
    if (state !== 'ended') return;
    continueQueue(selectedId);
  },
  onSlideChange(index) {
    if (bindingSlides) return;
    const deck = current();
    if (!deck || deck.state !== 'ready') return;
    deck.index = index;
    renderSlide();
  },
  onProgress({ slideIndex, chunkIndex, totalChunks }) {
    $('playback-status').textContent = `Slide ${slideIndex + 1} · part ${chunkIndex + 1} of ${totalChunks}`;
  },
  onError(message) { notice(message); renderPlayer(); },
  onVoicesChange(voices) { renderVoices(voices); },
});
narrator.setRate(Number($('speed-select').value));

function renderVoices(voices) {
  const picker = $('voice-select');
  const preferred = picker.value || saved.voice || narrator.voiceURI;
  picker.replaceChildren(new Option('Default device voice', ''));
  const sorted = [...voices].sort((a, b) => Number(b.lang?.startsWith('en')) - Number(a.lang?.startsWith('en')) || a.name.localeCompare(b.name));
  for (const voice of sorted) picker.add(new Option(`${voice.name} · ${voice.lang}${voice.localService ? '' : ' · online'}`, voice.voiceURI));
  if (sorted.some(voice => voice.voiceURI === preferred)) picker.value = preferred;
  narrator.setVoice(picker.value);
  if (!narrator.supported) notice('Your browser cannot play device narration. You can still view slides and the extracted reading text.');
}

function duration(seconds) {
  if (seconds < 60) return 'less than a minute';
  return `about ${Math.ceil(seconds / 60)} min`;
}

function analyze(deck) {
  deck.slides = analyzeSlides(deck.pdf.pages, { skipRepeated: $('dedupe-toggle').checked });
  deck.summary = summarizeSlides(deck.slides);
  deck.revision = (deck.revision || 0) + 1;
}

function renderLibrary() {
  const visible = new Set(decks.map(deck => deck.id));
  for (const [id, row] of fileRows) if (!visible.has(id)) { row.remove(); fileRows.delete(id); }
  for (const deck of decks) {
    let row = fileRows.get(deck.id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'deck-item';
      row.dataset.deckId = deck.id;
      const button = document.createElement('button');
      button.className = 'deck-button';
      button.dataset.deckId = deck.id;
      button.type = 'button';
      const name = document.createElement('span');
      name.className = 'deck-name';
      name.textContent = deck.name;
      const meta = document.createElement('span');
      meta.className = 'deck-meta';
      button.append(name, meta);
      button.addEventListener('click', () => selectDeck(deck.id));
      const remove = document.createElement('button');
      remove.className = 'deck-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${deck.name}`);
      remove.addEventListener('click', () => removeDeck(deck.id));
      row.append(button, remove);
      fileRows.set(deck.id, row);
      $('file-list').append(row);
    }
    row.dataset.state = deck.state;
    row.classList.toggle('selected', deck.id === selectedId);
    row.querySelector('.deck-button').setAttribute('aria-current', String(deck.id === selectedId));
    const text = deck.state === 'ready'
      ? `${deck.pdf.pageCount} slides · ${deck.summary.duplicateSlides} repeated`
      : deck.state === 'error' ? deck.error : deck.progress || 'Waiting to open…';
    row.querySelector('.deck-meta').textContent = text;
  }
  $('file-count').textContent = `${decks.length} PDF${decks.length === 1 ? '' : 's'}`;
  $('file-list').setAttribute('aria-busy', String(decks.some(deck => deck.state === 'loading')));
  $('clear-files').disabled = decks.length === 0;
}

function continueQueue(finishedId) {
  if (!$('auto-next').checked) { waitingAfterId = null; status('Finished reading. Choose a slide to listen again.'); renderPlayer(); return; }
  const index = decks.findIndex(deck => deck.id === finishedId);
  if (index < 0) { waitingAfterId = null; return; }
  const following = decks.slice(index + 1).find(deck => deck.state === 'loading' || (deck.state === 'ready' && deck.slides.some(slide => slide.narration.trim())));
  if (following?.state === 'ready') { waitingAfterId = null; selectDeck(following.id, true); }
  else if (following) { waitingAfterId = finishedId; status(`Waiting for ${following.name} to finish processing…`); renderPlayer(); }
  else { waitingAfterId = null; status('Finished reading. Choose a slide to listen again.'); renderPlayer(); }
}

function renderPlayer() {
  const deck = current();
  const readable = deck?.state === 'ready' && deck.slides.some(slide => slide.narration.trim());
  const state = narrator?.state || 'idle';
  const waiting = Boolean(waitingAfterId);
  $('play-button').disabled = waiting || !readable || !narrator?.supported;
  $('play-label').textContent = waiting ? 'Waiting…' : state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Listen';
  $('play-icon').textContent = state === 'playing' ? 'Ⅱ' : '▶︎';
  $('play-button').setAttribute('aria-label', waiting ? 'Waiting for next PDF' : state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Listen');
  $('play-button').setAttribute('aria-pressed', String(state === 'playing'));
  $('stop-button').disabled = !waiting && (!readable || !['playing', 'paused'].includes(state));
  if (waiting) $('playback-status').textContent = 'Processing next PDF…';
  else if (state === 'paused') $('playback-status').textContent = 'Paused';
  else if (state === 'idle') $('playback-status').textContent = readable ? 'Ready when you are' : 'Add a readable PDF';
  else if (state === 'ended') $('playback-status').textContent = 'Reading complete';
}

function renderSlideList(deck) {
  const key = `${deck.id}:${deck.revision}`;
  if (slideListKey !== key) {
    $('slide-list').replaceChildren();
    deck.slides.forEach((slide, index) => {
      const button = document.createElement('button');
      button.className = 'slide-jump';
      button.type = 'button';
      button.setAttribute('aria-label', `Slide ${index + 1}`);
      const title = document.createElement('strong');
      title.textContent = `Slide ${index + 1}`;
      const description = document.createElement('span');
      description.textContent = slide.textless ? 'Image / no text' : slide.duplicate ? 'Repeated · skipped' : `${slide.spokenLines.length} reading lines`;
      button.append(title, description);
      button.addEventListener('click', () => goSlide(index));
      $('slide-list').append(button);
    });
    slideListKey = key;
  }
  [...$('slide-list').children].forEach((button, index) => {
    button.classList.toggle('current', index === deck.index);
    button.setAttribute('aria-current', String(index === deck.index));
  });
}

function renderSlide() {
  const deck = current();
  if (!deck || deck.state !== 'ready') return;
  const slide = deck.slides[deck.index];
  const token = ++renderToken;
  $('page-label').textContent = `Slide ${deck.index + 1} of ${deck.slides.length}`;
  $('previous-slide').disabled = deck.index <= 0;
  $('next-slide').disabled = deck.index >= deck.slides.length - 1;
  $('narration-heading').textContent = $('dedupe-toggle').checked ? 'What’s new on this slide' : 'What you’ll hear';
  $('narration-text').textContent = slide.textless ? 'No selectable text on this slide. It may be an image or a scan.' : slide.narration || 'Nothing new on this slide.';
  $('skipped-note').textContent = slide.duplicate ? 'Repeated slide · skipped' : slide.omittedLines ? `${slide.omittedLines} repeated ${slide.omittedLines === 1 ? 'line' : 'lines'} skipped` : '';
  $('original-text').textContent = slide.text || 'No selectable text found.';
  $('slide-canvas').setAttribute('aria-label', `${deck.name}, slide ${deck.index + 1}`);
  $('canvas-status').hidden = false;
  $('canvas-status').textContent = 'Rendering slide…';
  $('slide-canvas').hidden = true;
  renderSlideList(deck);
  renderPlayer();
  renderChain = renderChain.catch(() => {}).then(async () => {
    if (token !== renderToken) return;
    try {
      await deck.pdf.renderPage(slide.number, $('slide-canvas'), { maxWidth: Math.max(300, document.querySelector('.slide-stage').clientWidth - 40) });
      if (token !== renderToken) return;
      $('slide-canvas').hidden = false;
      $('canvas-status').hidden = true;
    } catch (error) {
      if (token !== renderToken) return;
      $('canvas-status').textContent = `The slide preview could not render. You can still read the extracted text. ${error.message || ''}`;
    }
  });
}

function renderWorkspace() {
  const deck = current();
  $('welcome').hidden = Boolean(deck);
  $('workspace').hidden = !deck;
  if (!deck) { renderToken += 1; renderPlayer(); return; }
  $('deck-title').textContent = deck.name;
  if (deck.state === 'ready') {
    $('deck-summary').textContent = `${deck.slides.length} slides · ${deck.summary.omittedLines} repeated lines skipped · ${duration(deck.summary.estimatedSeconds / narrator.rate)} reading`;
    renderSlide();
  } else {
    renderToken += 1;
    $('deck-summary').textContent = deck.state === 'error' ? 'Could not open this PDF' : deck.progress || 'Opening PDF…';
    $('canvas-status').hidden = false;
    $('canvas-status').textContent = deck.state === 'error' ? deck.error : deck.progress || 'Opening PDF…';
    $('slide-canvas').hidden = true;
    $('narration-text').textContent = '';
    $('skipped-note').textContent = '';
    $('original-text').textContent = '';
    $('slide-list').replaceChildren();
    slideListKey = '';
    $('page-label').textContent = 'Preparing slides';
    $('previous-slide').disabled = true;
    $('next-slide').disabled = true;
    renderPlayer();
  }
}

function selectDeck(id, autoplay = false) {
  waitingAfterId = null;
  if (!decks.some(deck => deck.id === id)) return;
  selectedId = id;
  const deck = current();
  if (autoplay) deck.index = 0;
  bindingSlides = true;
  narrator.setSlides(deck.state === 'ready' ? deck.slides : []);
  bindingSlides = false;
  renderLibrary();
  renderWorkspace();
  if (autoplay && deck.state === 'ready') narrator.play(deck.index);
}

function goSlide(index) {
  waitingAfterId = null;
  const deck = current();
  if (!deck || deck.state !== 'ready') return;
  const wasPlaying = narrator.state === 'playing';
  narrator.stop();
  deck.index = Math.max(0, Math.min(deck.slides.length - 1, index));
  renderSlide();
  if (wasPlaying && deck.slides[deck.index].narration.trim()) narrator.play(deck.index);
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const deck = decks.find(item => item.state === 'loading' && !item.started);
      if (!deck) break;
      deck.started = true;
      deck.controller = new AbortController();
      try {
        deck.pdf = await loadPdf(deck.file, {
          signal: deck.controller.signal,
          onProgress(progress) {
            if (!decks.includes(deck)) return;
            deck.progress = progress.phase === 'extracting' ? `Reading slide ${progress.page} of ${progress.totalPages}…` : 'Opening PDF…';
            renderLibrary();
            if (selectedId === deck.id) $('canvas-status').textContent = deck.progress;
          },
        });
        if (!decks.includes(deck)) { deck.pdf.destroy(); continue; }
        deck.state = 'ready';
        analyze(deck);
        status(`Ready: ${deck.name}. ${deck.summary.duplicateSlides} repeated slides will be skipped.`);
        renderLibrary();
        if (selectedId === deck.id || current()?.state === 'error' || !current()) selectDeck(deck.id);
        if (waitingAfterId) continueQueue(waitingAfterId);
      } catch (error) {
        if (!decks.includes(deck)) continue;
        deck.state = 'error';
        deck.error = error.message || 'Could not read this PDF.';
        renderLibrary();
        if (selectedId === deck.id) renderWorkspace();
        if (waitingAfterId) continueQueue(waitingAfterId);
      }
    }
  } finally { processing = false; renderLibrary(); }
}

function addFiles(files) {
  const errors = [];
  let totalBytes = decks.reduce((sum, deck) => sum + deck.file.size, 0);
  for (const file of files) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { errors.push(`${file.name}: choose a PDF file.`); continue; }
    if (file.size > MAX_PDF_BYTES) { errors.push(`${file.name}: PDFs must be under 80 MB.`); continue; }
    if (decks.length >= 20 || totalBytes + file.size > 200 * 1024 * 1024) { errors.push('The queue holds up to 20 PDFs or 200 MB. Remove a file before adding more.'); break; }
    if (decks.some(deck => deck.name === file.name && deck.file.size === file.size && deck.file.lastModified === file.lastModified)) { errors.push(`${file.name} is already in the queue.`); continue; }
    const id = crypto.randomUUID();
    decks.push({ id, name: file.name, file, state: 'loading', index: 0, slides: [], started: false, revision: 0 });
    totalBytes += file.size;
    if (!selectedId) selectedId = id;
  }
  notice(errors.join('\n'));
  renderLibrary();
  renderWorkspace();
  void processQueue();
}

function removeDeck(id) {
  const index = decks.findIndex(deck => deck.id === id);
  if (index < 0) return;
  const [removed] = decks.splice(index, 1);
  removed.controller?.abort();
  removed.pdf?.destroy();
  fileRows.get(id)?.remove();
  fileRows.delete(id);
  if (id === selectedId) {
    narrator.stop();
    selectedId = null;
    if (decks.length) selectDeck(decks[Math.min(index, decks.length - 1)].id);
    else { renderLibrary(); renderWorkspace(); status('Add a PDF to begin.'); }
  } else { renderLibrary(); if (waitingAfterId) continueQueue(waitingAfterId); }
}

$('file-input').addEventListener('change', event => { addFiles([...event.target.files]); event.target.value = ''; });
$('add-files-button').addEventListener('click', event => { event.stopPropagation(); $('file-input').click(); });
$('drop-zone').addEventListener('click', () => $('file-input').click());
$('drop-zone').addEventListener('keydown', event => {
  if (event.target === $('drop-zone') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); $('file-input').click(); }
});
window.addEventListener('dragover', event => {
  if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $('drop-zone').classList.add('drag-over'); }
});
window.addEventListener('dragleave', event => { if (!event.relatedTarget) $('drop-zone').classList.remove('drag-over'); });
window.addEventListener('drop', event => {
  event.preventDefault();
  $('drop-zone').classList.remove('drag-over');
  addFiles([...event.dataTransfer.files]);
});
$('clear-files').addEventListener('click', () => {
  waitingAfterId = null;
  narrator.stop();
  for (const deck of decks) { deck.controller?.abort(); deck.pdf?.destroy(); }
  decks.length = 0;
  selectedId = null;
  renderLibrary(); renderWorkspace(); notice(); status('Add a PDF to begin.');
});
$('dedupe-toggle').addEventListener('change', () => {
  for (const deck of decks) if (deck.state === 'ready') analyze(deck);
  preferences();
  if (selectedId) selectDeck(selectedId);
});
$('previous-slide').addEventListener('click', () => goSlide((current()?.index || 0) - 1));
$('next-slide').addEventListener('click', () => goSlide((current()?.index || 0) + 1));
$('play-button').addEventListener('click', () => {
  notice();
  if (narrator.state === 'playing') narrator.pause();
  else if (narrator.state === 'paused') narrator.resume();
  else {
    const deck = current();
    if (deck && !deck.slides.slice(deck.index).some(slide => slide.narration.trim())) continueQueue(deck.id);
    else narrator.play(deck?.index || 0);
  }
});
$('stop-button').addEventListener('click', () => { waitingAfterId = null; narrator.stop(); status('Stopped. Press Listen to read from this slide.'); });
$('voice-select').addEventListener('change', () => { narrator.setVoice($('voice-select').value); preferences(); });
$('speed-select').addEventListener('change', () => {
  narrator.setRate(Number($('speed-select').value)); preferences();
  const deck = current();
  if (deck?.state === 'ready') $('deck-summary').textContent = `${deck.slides.length} slides · ${deck.summary.omittedLines} repeated lines skipped · ${duration(deck.summary.estimatedSeconds / narrator.rate)} reading`;
});
$('auto-next').addEventListener('change', () => { preferences(); if (!$('auto-next').checked) { waitingAfterId = null; renderPlayer(); } });
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
window.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,button,summary') || $('help-dialog').open) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); goSlide((current()?.index || 0) + 1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); goSlide((current()?.index || 0) - 1); }
  else if (event.key === ' ' && !$('play-button').disabled) { event.preventDefault(); $('play-button').click(); }
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (current()?.state === 'ready') renderSlide(); }, 180); });
window.addEventListener('pagehide', () => { waitingAfterId = null; narrator.stop(); });
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.type === 'identify-slidecast') event.ports[0]?.postMessage({ app: 'slidecast' });
});
renderLibrary(); renderWorkspace();
