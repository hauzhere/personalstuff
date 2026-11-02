// Read slide builds once, without treating every repeated idea in a lecture as a duplicate.
const WORDS_PER_SECOND = 155 / 60;
const HISTORY_LENGTH = 5;

function cleanLine(value) {
  return String(value ?? '').normalize('NFKC').replace(/\u00ad/g, '')
    .replace(/^\s*(?:[•●▪‣◦·]+\s*|[-–—*]\s+(?!\d)|\d{1,2}[.)]\s+)/, '')
    .replace(/\s+/g, ' ').trim();
}

function words(value) {
  // Signs and comparison operators are meaningful: "10%" and "-10%" differ.
  return cleanLine(value).toLocaleLowerCase('en-US')
    .replace(/[−‒–—]/g, '-')
    .replace(/['’](?=\p{L})/gu, '')
    .match(/[\p{L}\p{N}]+(?:[.,]\d+)*|[+-](?=\s*\d)|[%<>=≤≥]/gu) || [];
}

function key(value) { return words(value).join(' '); }
function headingKey(value) {
  return key(value).replace(/\s+(?:continued|cont|contd)$/, '');
}
function wordCount(value) { return words(value).length; }
function containsWords(haystack, needle) { return (` ${haystack} `).includes(` ${needle} `); }
function countLines(lines) {
  const counts = new Map();
  for (const line of lines) counts.set(line.key, (counts.get(line.key) || 0) + 1);
  return counts;
}

function rawLines(page) {
  const source = Array.isArray(page.lines) ? page.lines : String(page.text || '').split(/\r?\n/);
  return source.flatMap(line => String(line ?? '').split(/\r?\n/)).map(line => line.trim()).filter(Boolean);
}

function isPageCounter(line) {
  return /^(?:(?:page|slide)\s+\d+(?:\s*(?:of|\/)\s*\d+)?|\d+\s*(?:\/|of)\s*\d+)\s*$/i.test(line);
}

function copyrightKey(line) {
  return /(?:©|all rights reserved|^copyright\s*(?:\(c\)\s*)?(?:\d{4}|©))/i.test(line)
    ? key(line).replace(/\s+(?:[+-]\s*)?\d+$/, '') : null;
}

function preparePages(pages) {
  const prepared = pages.map((page, index) => ({ page, number: page.number ?? index + 1, raw: rawLines(page) }));
  const copyrights = new Map();
  const bareCounters = new Map();
  for (const item of prepared) {
    const last = item.raw.at(-1);
    if (!last) continue;
    const footerKeys = new Set(item.raw.slice(-3).map(copyrightKey).filter(Boolean));
    for (const copyright of footerKeys) copyrights.set(copyright, (copyrights.get(copyright) || 0) + 1);
    if (item.raw.length > 1 && /^\d+$/.test(last)) {
      const offset = Number(last) - Number(item.number);
      if (Number.isFinite(offset)) bareCounters.set(offset, (bareCounters.get(offset) || 0) + 1);
    }
  }
  return prepared.map(item => {
    const lines = item.raw.filter((line, index) => {
      if (isPageCounter(line)) return false;
      const copyright = copyrightKey(line);
      if (index >= item.raw.length - 3 && copyright && copyrights.get(copyright) >= 2) return false;
      if (index !== item.raw.length - 1) return true;
      if (item.raw.length > 1 && /^\d+$/.test(line)) {
        const offset = Number(line) - Number(item.number);
        if ((bareCounters.get(offset) || 0) >= Math.max(2, Math.ceil(prepared.length * 0.6))) return false;
      }
      return true;
    }).map(cleanLine).filter(Boolean).map(text => ({ text, key: key(text), words: wordCount(text) }));
    return { ...item, content: lines, joined: lines.map(line => line.key).join(' ') };
  });
}

function prefixSource(line, references) {
  return references.filter(old => old.words >= 3 && old.key.length >= 16
    && line.key.startsWith(`${old.key} `))
    .sort((a, b) => b.key.length - a.key.length)[0];
}

function matchWeight(line, references, joined) {
  if (references.some(old => old.key === line.key)) return line.words;
  if (line.words >= 3 && containsWords(joined, line.key)) return line.words;
  return prefixSource(line, references)?.words || 0;
}

function relatedBuild(current, previous) {
  if (!current.content.length || !previous?.content.length) return false;
  if (current.joined === previous.joined) return true;
  const currentCounts = countLines(current.content);
  const previousCounts = countLines(previous.content);
  if (currentCounts.size === previousCounts.size
    && [...currentCounts].every(([line, count]) => previousCounts.get(line) === count)) return true;
  // A genuinely new heading starts a new topic, even if some body text is reused.
  if (headingKey(current.content[0].text) !== headingKey(previous.content[0].text)) return false;
  const currentBody = current.content.slice(1);
  const previousBody = previous.content.slice(1);
  if (!currentBody.length || !previousBody.length) return false;
  const oldWeight = previousBody.reduce((sum, line) => sum + matchWeight(line, currentBody, current.joined), 0);
  const newWeight = currentBody.reduce((sum, line) => sum + matchWeight(line, previousBody, previous.joined), 0);
  const oldTotal = previousBody.reduce((sum, line) => sum + line.words, 0);
  const newTotal = currentBody.reduce((sum, line) => sum + line.words, 0);
  return (oldWeight > 0 || newWeight > 0)
    && (oldWeight / Math.max(1, oldTotal) >= 0.68 || newWeight / Math.max(1, newTotal) >= 0.68);
}

function suffixAfterPrefix(text, prefix) {
  // Find a word boundary in the original string so capitalization and signs survive.
  for (let index = 1; index < text.length; index++) {
    if (!/[\s,;:—–-]/u.test(text[index])) continue;
    if (key(text.slice(0, index)) !== prefix.key) continue;
    const suffix = text.slice(index).replace(/^[\s,;:—–-]+/, '').trim();
    // Do not discard a minus sign when the newly revealed material is a number.
    const rawSuffix = text.slice(index).trim().replace(/^[,;:]+\s*/, '');
    return /^[-−]\s*\d/.test(rawSuffix) ? rawSuffix : suffix;
  }
  return text;
}

function newLines(current, history) {
  const references = history.flatMap(item => item.content);
  const maximumCounts = new Map();
  for (const item of history) {
    for (const [line, count] of countLines(item.content)) maximumCounts.set(line, Math.max(count, maximumCounts.get(line) || 0));
  }
  const seenCounts = new Map();
  const streams = history.map(item => item.joined);
  const result = [];
  for (const line of current.content) {
    const occurrence = (seenCounts.get(line.key) || 0) + 1;
    seenCounts.set(line.key, occurrence);
    if ((maximumCounts.get(line.key) || 0) >= occurrence) continue;
    if (line.words >= 3 && streams.some(stream => containsWords(stream, line.key))) continue;
    const prefix = prefixSource(line, references);
    result.push(prefix ? suffixAfterPrefix(line.text, prefix) : line.text);
  }
  return result.filter(Boolean);
}

function narrationFor(lines) {
  return lines.map(line => /[.!?…]$/.test(line) ? line : `${line}.`).join('\n');
}

/** Analyze only local text. No PDF contents or speech are sent to a server. */
export function analyzeSlides(pages, { skipRepeated = true } = {}) {
  if (!Array.isArray(pages)) throw new TypeError('Slides must be an array.');
  const prepared = preparePages(pages);
  let previous = null;
  let history = [];
  return prepared.map(item => {
    const related = Boolean(skipRepeated && relatedBuild(item, previous));
    if (!related) history = [];
    const spokenLines = related ? newLines(item, history) : item.content.map(line => line.text);
    const narration = narrationFor(spokenLines);
    const duplicate = item.content.length > 0 && spokenLines.length === 0;
    const totalWords = spokenLines.reduce((sum, line) => sum + wordCount(line), 0);
    const result = {
      ...item.page,
      number: item.number,
      lines: Array.isArray(item.page.lines) ? item.page.lines : item.raw,
      text: typeof item.page.text === 'string' ? item.page.text : item.raw.join('\n'),
      narration,
      spokenLines,
      omittedLines: Math.max(0, item.raw.length - spokenLines.length),
      duplicate,
      transition: related && !duplicate,
      textless: item.content.length === 0,
      estimatedSeconds: totalWords ? Math.ceil(totalWords / WORDS_PER_SECOND) : 0,
    };
    if (item.content.length) {
      history.push(item);
      history = history.slice(-HISTORY_LENGTH);
      previous = item;
    } else {
      previous = null;
      history = [];
    }
    return result;
  });
}

export function summarizeSlides(slides) {
  const totalWords = slides.reduce((sum, slide) => sum + wordCount(slide.narration || ''), 0);
  return {
    totalSlides: slides.length,
    readableSlides: slides.filter(slide => !slide.textless).length,
    duplicateSlides: slides.filter(slide => slide.duplicate).length,
    omittedLines: slides.reduce((sum, slide) => sum + (slide.omittedLines || 0), 0),
    totalWords,
    estimatedSeconds: totalWords ? Math.ceil(totalWords / WORDS_PER_SECOND) : 0,
  };
}
