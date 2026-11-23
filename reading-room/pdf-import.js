// Read position and spacing from the page rather than the PDF content-stream order.
function rowsOf(items, viewport, boldFonts) {
  const rows = [];
  let unsupported = false;
  const tokens = items.flatMap(item => {
    if (!item.str?.trim()) return [];
    const [a, b, , , tx, ty] = item.transform;
    const [x, y] = viewport.convertToViewportPoint(tx, ty);
    const [endX, endY] = viewport.convertToViewportPoint(tx + a, ty + b);
    if (item.dir === 'ttb' || Math.abs(endY - y) > Math.abs(endX - x) * .2 || endX < x) unsupported = true;
    return [{ text: item.str, x, y, right: x + item.width, size: item.height || Math.hypot(a, b), bold: boldFonts.has(item.fontName) }];
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const token of tokens) {
    const row = rows.at(-1);
    if (row && token.y - row.y < 2.2) row.tokens.push(token);
    else rows.push({ y: token.y, tokens: [token] });
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row.tokens.every(t => t.size < 8 && /^[+−\d]+$/.test(t.text.trim()))) continue;
    const base = [rows[i + 1], rows[i - 1]].find(other => other && Math.abs(other.y - row.y) <= 5 &&
      row.tokens.every(t => other.tokens.some(o => o.size > t.size * 1.25 && Math.abs(o.right - t.x) < 3)));
    if (!base) continue;
    for (const token of row.tokens) {
      const script = row.y < base.y ? '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻' : '₀₁₂₃₄₅₆₇₈₉₊₋';
      token.text = token.text.replace(/[+−\d]/g, c => script[c === '+' ? 10 : c === '−' ? 11 : Number(c)]);
      base.tokens.push(token);
    }
    rows.splice(i, 1);
  }
  return { rows, unsupported };
}

function fragment(tokens, y) {
  const text = tokens.reduce((str, token, i) => {
    const previous = tokens[i - 1];
    const space = previous && token.x - previous.right > token.size * .13 &&
      !/^\s/.test(token.text) && !/\s$/.test(str);
    return str + (space ? ' ' : '') + token.text;
  }, '').replace(/\s+/g, ' ').trim();
  const sizes = tokens.map(t => t.size).sort((a, b) => b - a);
  return { x: tokens[0].x, right: Math.max(...tokens.map(t => t.right)), y, text, size: sizes[0],
    bold: tokens.filter(t => t.bold).map(t => t.text).join('').length > text.length * .67 };
}

function splitRows(rows) {
  return rows.map(({y, tokens}) => {
    const groups = [];
    for (const token of [...tokens].sort((a, b) => a.x - b.x)) {
      const group = groups.at(-1);
      if (group && token.x - group.at(-1).right < Math.max(9, token.size * 1.35)) group.push(token);
      else groups.push([token]);
    }
    return {y, parts: groups.map(group => fragment(group, y))};
  });
}

const unrenderable = /[\x00-\x08\x0B\x0C\x0E-\x1F\uE000-\uF8FF\uFFFD]/;
const referenceHeading = /^(references|bibliography|works cited)$/i;
const caption = /^(?:(figure|fig\.?|table|exhibit|plate)\s+[A-Z]?\d+(?:\.\d+)*[a-z]?)(?:\s*[:.—–]|\s*$)/i;
const numberedHeading = /^\d+(?:\.\d+)*\.?\s+[\p{L}]/u;

function typicalSize(parts) {
  const weight = new Map();
  for (const part of parts) {
    const size = Math.round(part.size * 2) / 2;
    weight.set(size, (weight.get(size) || 0) + part.text.length);
  }
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
}

function gutterOf(rows, width, body) {
  const parts = rows.flatMap(row => row.parts);
  const prose = parts.filter(part => part.size > body * .86 && part.size < body * 1.17 && part.text.length > 24);
  if (prose.length < 12) return null;
  let best;
  for (let x = width * .35; x < width * .66; x += 3) {
    const left = prose.filter(part => part.right <= x - 3);
    const right = prose.filter(part => part.x >= x + 3);
    if (left.length < 6 || right.length < 6) continue;
    const y1 = Math.max(left[0].y, right[0].y), y2 = Math.min(left.at(-1).y, right.at(-1).y);
    if (y2 - y1 < body * 7) continue;
    const crossing = prose.filter(part => part.y >= y1 && part.y <= y2 && part.x < x + 3 && part.right > x - 3);
    if (crossing.length > Math.min(left.length, right.length) * .18) continue;
    const score = Math.min(left.length, right.length) - crossing.length * 2;
    const margin = Math.min(...right.map(p => p.x)) - Math.max(...left.map(p => p.right));
    if (!best || score > best.score || (score === best.score && margin > best.margin)) {
      best = {x: (Math.min(...right.map(p => p.x)) + Math.max(...left.map(p => p.right))) / 2, score, margin};
    }
  }
  return best?.x ?? null;
}

function tableAt(rows, start, body) {
  const first = rows[start];
  if (first.parts.length < 3) return null;
  let end = start + 1;
  for (; end < rows.length; end++) {
    const row = rows[end];
    if (row.y - rows[end - 1].y > body * 2.4 || row.parts.length !== first.parts.length ||
        row.parts.some((part, col) => Math.abs(part.x - first.parts[col].x) > body * 1.4 &&
          Math.abs(part.right - first.parts[col].right) > body * 1.4)) break;
  }
  if (end - start < 3) return null;
  return { end, rows: rows.slice(start, end).map(row => row.parts.map(part => ({
    text: part.text, header: row === first && part.bold, columns: 1, rows: 1
  }))) };
}

// Find illustrations outside the extracted text rectangles. Keep the source
// vectors or pixels together even when a PDF represents them as drawing commands.
function illustrations(canvas, raw, viewport) {
  if (!canvas) return [];
  const thumb = document.createElement('canvas');
  thumb.width = 240;
  thumb.height = Math.ceil(viewport.height / viewport.width * thumb.width);
  const ctx = thumb.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const {data} = ctx.getImageData(0, 0, thumb.width, thumb.height);
  const {width, height} = thumb;
  const k = width / viewport.width;
  const mask = new Uint8Array(width * height);
  for (const {tokens} of raw) for (const t of tokens) {
    const x1 = Math.max(0, Math.floor(t.x * k) - 1);
    const x2 = Math.min(width, Math.ceil(t.right * k) + 1);
    const y1 = Math.max(0, Math.floor((t.y - t.size) * k) - 1);
    const y2 = Math.min(height, Math.ceil((t.y + t.size * .26) * k) + 1);
    if (x2 <= x1) continue;
    for (let y = y1; y < y2; y++) mask.fill(1, y * width + x1, y * width + x2);
  }
  const bands = [];
  let band;
  let ink = 0;
  for (let y = 0; y < height; y++) {
    let min = width, max = 0, count = 0;
    for (let x = 7; x < width - 7; x++) {
      const n = y * width + x;
      const i = n * 4;
      if (!mask[n] && data[i + 3] > 180 && Math.min(data[i], data[i + 1], data[i + 2]) < 215) {
        ink++;
        min = Math.min(min, x); max = Math.max(max, x); count++;
      }
    }
    if (count < 3) continue;
    if (!band || y - band.last > 4) {
      band = {min, max, first: y, last: y, count};
      bands.push(band);
    } else {
      band.min = Math.min(min, band.min); band.max = Math.max(max, band.max);
      band.last = y; band.count += count;
    }
  }
  if (!raw.length && ink) return [{x: 0, y: 0, right: viewport.width, bottom: viewport.height}];
  return bands.filter(b => b.last - b.first >= 8 && b.max - b.min >= 19 && b.count >= 110)
    .map(b => ({x: b.min / k, y: b.first / k, right: (b.max + 1) / k, bottom: (b.last + 1) / k}));
}

function snapshot(canvas, box, viewport) {
  const crop = document.createElement('canvas');
  const k = canvas.width / viewport.width;
  const x = Math.max(0, Math.floor((box.x - 5) * k));
  const y = Math.max(0, Math.floor((box.y - 5) * k));
  crop.width = Math.min(canvas.width - x, Math.ceil((box.right + 5) * k) - x);
  crop.height = Math.min(canvas.height - y, Math.ceil((box.bottom + 5) * k) - y);
  crop.getContext('2d').drawImage(canvas, x, y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return crop.toDataURL('image/png');
}

export function pdfMarginKeys(items, viewport) {
  const {rows} = rowsOf(items, viewport, new Set());
  const keys = new Set();
  for (const row of splitRows(rows)) for (const part of row.parts) {
    const key = marginKey(part, viewport.height);
    if (key) keys.add(key);
  }
  return keys;
}
function marginKey(part, height) {
  const edge = part.y < height * .075 ? 'top' : part.y > height * .925 ? 'bottom' : '';
  if (!edge) return '';
  const text = part.text.toLowerCase();
  return edge + ':' + (/^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/.test(text)
    ? text.replace(/\d+/g, '#') : text);
}

export function pdfDisplayTitle(items, viewport) {
  const {rows} = rowsOf(items, viewport, new Set());
  const parts = splitRows(rows).flatMap(row => row.parts);
  const body = typicalSize(parts);
  const top = parts.find(part => part.y < viewport.height * .3 && part.size >= body * 1.6 &&
    part.text.length >= 5 && part.text.length < 140 && /\p{L}/u.test(part.text));
  if (!top) return '';
  return parts.slice(parts.indexOf(top)).filter(part => part.y >= top.y &&
    part.y <= top.y + top.size * 1.55 && Math.abs(part.size - top.size) < 1 &&
    (Math.abs(part.x - top.x) < 4 || Math.abs(part.x + part.right - top.x - top.right) < 14))
    .map(part => part.text).join(' ');
}

export function layOutPdfPage(items, viewport, boldFonts, canvas, state) {
  const {rows: raw, unsupported} = rowsOf(items, viewport, boldFonts);
  const rows = splitRows(raw).map(row => ({...row, parts: row.parts.filter(part =>
    !state.running.has(marginKey(part, viewport.height)) &&
    !(part.y > viewport.height * .94 && /^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(part.text))
  )})).filter(row => row.parts.length);
  const all = rows.flatMap(row => row.parts);
  const body = typicalSize(all);
  const titleParts = [];
  if (state.title && state.page === 1) {
    for (const part of all.filter(p => p.y < viewport.height * .3)) {
      const joined = [...titleParts.map(p => p.text), part.text].join(' ');
      if (!state.title.startsWith(joined)) {
        titleParts.length = 0;
        continue;
      }
      titleParts.push(part);
      if (joined === state.title) break;
    }
  }
  const repeatedTitle = titleParts.map(p => p.text).join(' ') === state.title ? new Set(titleParts) : new Set();
  const gutter = gutterOf(rows, viewport.width, body);
  const blocks = [];
  const pictures = illustrations(canvas, raw, viewport);
  const used = new Set();
  const draft = [];
  let reason = unsupported ? 'The page contains rotated or vertical text.' : '';
  if (!all.length && pictures.length) reason = 'This page is a scan. Review the transcription or keep the original.';
  if (gutter && rows.filter(row => row.parts.length > 2).length >= 4) {
    reason ||= 'The page may contain more than two columns or an irregular table.';
  }
  let current, previous;
  function section(lines) {
    current = undefined;
    previous = undefined;
    const left = lines.length ? Math.min(...lines.map(line => line.x)) : 0;
    for (const part of lines) {
      const text = part.text;
      if (repeatedTitle.has(part)) continue;
      const reference = referenceHeading.test(text);
      if (reference) state.references = true;
      const isHeading = reference || /^(abstract|introduction|conclusion[s]?|appendix)$/i.test(text) ||
        (text.length < 150 && (part.size >= body * 1.17 || (part.bold && (text.length < 72 || numberedHeading.test(text)))));
      if (caption.test(text)) {
        const picture = pictures.filter(p => !used.has(p) && p.bottom <= part.y &&
          part.y - p.bottom < body * 7 && p.right > part.x && p.x < part.right)
          .sort((a, b) => b.bottom - a.bottom)[0];
        if (picture && snapshotFits(picture, part)) {
          used.add(picture);
          blocks.push({type:'image', url:snapshot(canvas, picture, viewport), caption:text});
          draft.push(text);
          current = undefined;
          continue;
        }
        if (!/^Table\s/i.test(text) || !blocks.some(block => block.type === 'table' && block.caption === text)) {
          reason ||= 'A figure or table caption could not be matched to its content.';
        }
      }
      const type = isHeading && (!state.references || reference) ? 'heading' :
        state.references ? 'bibliography' : 'paragraph';
      const newBlock = !current || current.type !== type || type === 'heading' ||
        part.y - previous.y > body * 1.85 ||
        (type === 'bibliography' && /^(?:\[\d+\]|\d+\.)\s/.test(text)) ||
        (type === 'paragraph' && part.x > left + body * .9 && part.x < left + body * 3 &&
          /[.!?][”’)]?$/.test(previous.text)) || /^[-•▪]\s/.test(text);
      if (newBlock) {
        const level = !reference && (/^\d+\.\d/.test(text) || part.size < body * 1.26) ? 3 : 2;
        current = {type, text, level, inReferences: state.references, bold: type === 'paragraph' && part.bold};
        blocks.push(current);
      } else {
        current.text += (current.text.endsWith('-') && /^\p{Ll}/u.test(text) ? '' : ' ') + text;
      }
      draft.push(text);
      previous = part;
    }
  }

  function snapshotFits(picture, label) {
    return !all.some(part => part !== label && part.y > picture.y && part.y <= picture.bottom &&
      part.x < picture.right && part.right > picture.x && part.text.length > 80);
  }

  let pending = [];
  function flush() {
    if (gutter) {
      section(pending.flatMap(row => row.parts.filter(part => part.right <= gutter)));
      section(pending.flatMap(row => row.parts.filter(part => part.x >= gutter)));
    } else section(pending.flatMap(row => row.parts));
    pending = [];
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const beginsWithCaption = row.parts.length === 1 && /^Table\s+\d/i.test(row.parts[0].text) &&
      caption.test(row.parts[0].text);
    const start = beginsWithCaption ? i + 1 : i;
    const table = !gutter && start < rows.length && tableAt(rows, start, body);
    if (table) {
      flush();
      blocks.push({type:'table', rows:table.rows, caption:beginsWithCaption ? row.parts[0].text : ''});
      for (const picture of pictures) {
        if (picture.y >= row.y - body * 2 && picture.bottom <= rows[table.end - 1].y + body * 1.5) used.add(picture);
      }
      draft.push(...rows.slice(i, table.end).map(r => r.parts.map(p => p.text).join(' | ')));
      i = table.end - 1;
    } else if (gutter && row.parts.some(part => part.x < gutter && part.right > gutter)) {
      flush();
      section(row.parts);
    } else {
      if (!gutter && row.parts.length >= 3) reason ||= 'The page has text arranged in an uncertain grid.';
      pending.push(row);
    }
  }
  flush();
  if (pictures.some(picture => !used.has(picture))) {
    reason ||= 'The page has graphics or rules that could not be separated reliably from its text.';
  }
  if (all.some(part => unrenderable.test(part.text))) reason ||= 'The PDF contains characters that could not be decoded.';
  if (!blocks.length && all.length) reason ||= 'The page structure could not be reconstructed.';
  return {blocks, text:draft.join('\n'), reason, hasText: all.length > 0};
}
