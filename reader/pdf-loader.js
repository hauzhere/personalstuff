import { getDocument, GlobalWorkerOptions } from './vendor/pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;

export const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_PDF_PAGES = 2000;
const MAX_CANVAS_PIXELS = 4_000_000;
const vendorUrl = path => new URL(`./vendor/${path}`, import.meta.url).href;

function abortError() {
  return new DOMException('Opening this PDF was cancelled.', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function report(callback, progress) {
  if (typeof callback === 'function') callback(progress);
}

function joinFragments(items) {
  let text = '';
  let previous = null;
  for (const item of items) {
    const value = item.str.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\u00ad/g, '');
    const gap = previous ? item.x - previous.right : 0;
    const font = Math.max(1, Math.min(item.font, previous?.font || item.font));
    const needsSpace = text && !/\s$/.test(text) && !/^\s/.test(value)
      && !/^[,.;:!?%)\]}]/.test(value) && !/[({\[]$/.test(text)
      && gap > font * 0.13;
    text += `${needsSpace ? ' ' : ''}${value}`;
    previous = item;
  }
  return text.replace(/[\t ]+/g, ' ').trim();
}

/** Reconstruct reading lines from positioned PDF text without inventing content. */
function extractLines(content, pageWidth) {
  const items = content.items.filter(item => typeof item.str === 'string' && item.str.trim())
    .map(item => {
      const [a, b, c, d, x, y] = item.transform;
      const font = Math.max(1, Math.hypot(c, d) || item.height || Math.hypot(a, b));
      return { str: item.str, x, y, font, right: x + Math.max(0, item.width || 0), dir: item.dir };
    });
  if (!items.length) return [];
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const item of items) {
    let row = rows.find(candidate => Math.abs(candidate.y - item.y) <= Math.max(1.5, Math.min(candidate.font, item.font) * 0.28));
    if (!row) {
      row = { y: item.y, font: item.font, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  rows.sort((a, b) => b.y - a.y);
  const segments = [];
  let multiSegmentRows = 0;
  let tableRows = 0;
  for (const [rowIndex, row] of rows.entries()) {
    row.items.sort((a, b) => a.x - b.x);
    const groups = [];
    let group = [];
    for (const item of row.items) {
      const prior = group.at(-1);
      if (prior && item.x - prior.right > Math.max(pageWidth * 0.07, row.font * 2.8)) {
        groups.push(group);
        group = [];
      }
      group.push(item);
    }
    if (group.length) groups.push(group);
    if (groups.length > 1) multiSegmentRows += 1;
    if (groups.length > 2) tableRows += 1;
    for (const parts of groups) {
      const isRtl = parts.every(item => item.dir === 'rtl');
      const ordered = isRtl ? [...parts].reverse() : parts;
      const text = joinFragments(ordered);
      if (text) segments.push({
        text, row: rowIndex, y: row.y, font: row.font,
        x: Math.min(...parts.map(item => item.x)),
        right: Math.max(...parts.map(item => item.right)),
      });
    }
  }

  // A clear two-column slide reads down the left column, then down the right.
  // Dense tables keep row order; shared headings/full-width lines split bands.
  const middle = pageWidth * 0.5;
  const left = segments.filter(segment => segment.x < pageWidth * 0.42 && segment.right < pageWidth * 0.57);
  const right = segments.filter(segment => segment.x >= pageWidth * 0.48);
  const overlap = left.length && right.length
    ? Math.min(Math.max(...left.map(line => line.y)), Math.max(...right.map(line => line.y)))
      - Math.max(Math.min(...left.map(line => line.y)), Math.min(...right.map(line => line.y))) : 0;
  const typicalFont = items.map(item => item.font).sort((a, b) => a - b)[Math.floor(items.length / 2)];
  const twoColumns = left.length >= 2 && right.length >= 2 && overlap > typicalFont
    && multiSegmentRows >= 2 && tableRows < Math.max(2, multiSegmentRows / 2);
  if (!twoColumns) return segments.map(segment => segment.text);

  const result = [];
  let band = [];
  const flush = () => {
    if (!band.length) return;
    result.push(...band.filter(line => line.x < middle).map(line => line.text));
    result.push(...band.filter(line => line.x >= middle).map(line => line.text));
    band = [];
  };
  for (const segment of segments) {
    if (segment.x < middle && segment.right > middle + pageWidth * 0.06) {
      flush();
      result.push(segment.text);
    } else band.push(segment);
  }
  flush();
  return result;
}

function readableError(error, needsPassword) {
  if (needsPassword || error?.name === 'PasswordException') {
    return new Error('This PDF is password-protected. Export an unlocked copy and add it again.');
  }
  if (error?.name === 'InvalidPDFException') {
    return new Error('This file is not a readable PDF. Try downloading or exporting it again.');
  }
  return new Error(error?.message ? `Could not open this PDF: ${error.message}` : 'Could not open this PDF. Try exporting it again.');
}

/** Open and extract a PDF locally. File contents are never uploaded. */
export async function loadPdf(file, { onProgress, signal } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new TypeError('Choose a PDF file.');
  if (file.size === 0) throw new Error('This PDF is empty. Choose another file.');
  if (file.size > MAX_PDF_BYTES) throw new Error('This PDF is larger than 80 MB. Split it into smaller files first.');
  checkAbort(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkAbort(signal);
  if (!bytes.length) throw new Error('This PDF is empty. Choose another file.');
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error('This PDF is larger than 80 MB. Split it into smaller files first.');

  let pdf = null;
  let destroyed = false;
  let needsPassword = false;
  let activeRender = null;
  let renderGeneration = 0;
  const loading = getDocument({
    data: bytes,
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
    wasmUrl: vendorUrl('wasm/'),
    useSystemFonts: true,
    isEvalSupported: false,
  });

  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    renderGeneration += 1;
    activeRender?.cancel();
    signal?.removeEventListener('abort', onAbort);
    try { await loading.destroy(); } catch { /* Cleanup must also work after a failed load. */ }
  };
  const onAbort = () => { void destroy(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  loading.onPassword = () => { needsPassword = true; void destroy(); };
  loading.onProgress = ({ loaded, total }) => report(onProgress, {
    phase: 'loading', loaded, total,
    progress: total ? Math.min(0.15, loaded / total * 0.15) : 0,
  });

  try {
    pdf = await loading.promise;
    checkAbort(signal);
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error('This PDF has more than 2,000 pages. Split it into smaller files first.');
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      checkAbort(signal);
      if (destroyed) throw abortError();
      const page = await pdf.getPage(number);
      let lines = [];
      let warning;
      try {
        const content = await page.getTextContent({ includeMarkedContent: false });
        lines = extractLines(content, page.getViewport({ scale: 1 }).width);
      } catch (error) {
        checkAbort(signal);
        if (destroyed) throw abortError();
        warning = 'Text could not be extracted from this slide. Its preview may still be available.';
      }
      const text = lines.join('\n');
      pages.push({ number, lines, text, textless: !text.trim(), ...(warning ? { warning } : {}) });
      report(onProgress, { phase: 'extracting', page: number, totalPages: pdf.numPages, progress: 0.15 + number / pdf.numPages * 0.85 });
    }
    checkAbort(signal);

    return {
      name: file.name || 'Untitled PDF',
      pageCount: pdf.numPages,
      pages,
      destroy,
      async renderPage(number, canvas, { maxWidth } = {}) {
        if (destroyed || signal?.aborted) throw abortError();
        if (!Number.isInteger(number) || number < 1 || number > pdf.numPages) throw new RangeError('Choose an existing slide.');
        if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('A preview canvas is required.');
        const generation = ++renderGeneration;
        const previous = activeRender;
        if (previous) {
          previous.cancel();
          try { await previous.promise; } catch { /* Cancellation is expected when selecting another slide. */ }
        }
        const page = await pdf.getPage(number);
        if (destroyed || generation !== renderGeneration) return null;
        const natural = page.getViewport({ scale: 1 });
        const available = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : canvas.parentElement?.clientWidth || 960;
        const cssWidth = Math.min(1600, available);
        const cssScale = cssWidth / natural.width;
        const cssViewport = page.getViewport({ scale: cssScale });
        let scale = cssScale * Math.min(2, globalThis.devicePixelRatio || 1);
        const pixels = natural.width * natural.height * scale * scale;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Your browser could not create a PDF preview.');
        const rendering = page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255,255,255)' });
        activeRender = rendering;
        try {
          await rendering.promise;
          if (generation !== renderGeneration || destroyed) return null;
          return { width: cssViewport.width, height: cssViewport.height };
        } catch (error) {
          if (error?.name === 'RenderingCancelledException' || generation !== renderGeneration || destroyed) return null;
          throw new Error('This slide could not be previewed. Its extracted text is still available.');
        } finally {
          if (activeRender === rendering) activeRender = null;
        }
      },
    };
  } catch (error) {
    await destroy();
    if (signal?.aborted) throw abortError();
    if (error?.name === 'AbortError' && !needsPassword) throw error;
    throw readableError(error, needsPassword);
  }
}
