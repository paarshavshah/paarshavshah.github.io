// Generate a reading edition in the browser. Blocks contain exact extracted text.
import { PDFDocument, PDFName, PDFString, PDFArray, grayscale } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
import fontkit from 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/+esm';

const FONT_ROOT = new URL('./fonts/', import.meta.url);
const FONT_FILES = {
  regular: '400-normal.ttf',
  bold: '700-normal.ttf',
  italic: '400-italic.ttf',
  boldItalic: '700-italic.ttf'
};
const WIDTH = 612, HEIGHT = 792, MARGIN = 108, TEXT_WIDTH = WIDTH - MARGIN * 2;

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('A font or image could not be loaded.');
  return new Uint8Array(await response.arrayBuffer());
}

function linesOf(text, font, size, maxWidth) {
  const result = [];
  for (const paragraph of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { result.push(''); continue; }
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const trial = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) { line = trial; continue; }
      if (line) result.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) { line = word; continue; }
      line = '';
      for (const char of word) {
        if (line && font.widthOfTextAtSize(line + char, size) > maxWidth) { result.push(line); line = ''; }
        line += char;
      }
    }
    result.push(line);
  }
  return result;
}

export async function generatePdf({ title, author, date, publisher, sourceUrl, blocks = [] }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts = {};
  for (const [style, filename] of Object.entries(FONT_FILES)) {
    fonts[style] = await pdf.embedFont(await fetchBytes(new URL(filename, FONT_ROOT)), { subset: false, features: { liga: false, clig: false } });
  }
  pdf.setTitle(title || '');
  if (author) pdf.setAuthor(author);
  const first = pdf.addPage([WIDTH, HEIGHT]);
  const coverLines = [
    ...linesOf(title || '', fonts.bold, 24, TEXT_WIDTH).map(text => ({ text, font: fonts.bold, size: 24, gap: 30 })),
    ...[author, date, publisher, sourceUrl ? 'Source' : ''].filter(Boolean).map(text => ({ text, font: fonts.regular, size: 12, gap: 20 }))
  ];
  let coverY = HEIGHT / 2 + coverLines.reduce((n, l) => n + l.gap, 0) / 2;
  for (const item of coverLines) {
    const width = item.font.widthOfTextAtSize(item.text, item.size);
    const x = (WIDTH - width) / 2;
    first.drawText(item.text, { x, y: coverY, font: item.font, size: item.size });
    if (item.text === 'Source' && sourceUrl) {
      const annotation = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, coverY - 2, x + width, coverY + 14], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(sourceUrl) } });
      const reference = pdf.context.register(annotation);
      let annotations = first.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annotations) { annotations = pdf.context.obj([]); first.node.set(PDFName.of('Annots'), annotations); }
      annotations.push(reference);
    }
    coverY -= item.gap;
  }
  let page, y, notes;
  let pageNumber = 0;
  const lineHeight = 16;
  function beginPage() {
    page = pdf.addPage([WIDTH, HEIGHT]);
    pageNumber++;
    y = HEIGHT - MARGIN;
    notes = [];
  }
  function noteHeight(extra = []) {
    return [...notes, ...extra].reduce((n, note) => n + linesOf(note, fonts.regular, 8, TEXT_WIDTH).length * 10 + 4, 0);
  }
  function finishPage() {
    if (!page) return;
    let noteY = MARGIN + noteHeight() - 10;
    for (const note of notes) {
      for (const line of linesOf(note, fonts.regular, 8, TEXT_WIDTH)) {
        if (line) page.drawText(line, { x: MARGIN, y: noteY, size: 8, font: fonts.regular });
        noteY -= 10;
      }
      noteY -= 4;
    }
    const number = String(pageNumber);
    page.drawText(number, { x: (WIDTH - fonts.regular.widthOfTextAtSize(number, 6)) / 2, y: 36, size: 6, font: fonts.regular });
  }
  function nextPage() { finishPage(); beginPage(); }
  function room(height, extraNotes = []) {
    if (y - height < MARGIN + noteHeight(extraNotes)) nextPage();
  }
  function textLayout(block) {
    const heading = block.type === 'heading';
    const quoteIndent = block.type === 'quote' ? 18 : 0;
    const bold = block.bold || heading;
    const font = bold && block.italic ? fonts.boldItalic : bold ? fonts.bold : block.italic ? fonts.italic : fonts.regular;
    const size = heading ? (block.level > 2 ? 14 : 18) : block.type === 'bibliography' ? 6 : 12;
    const leading = heading ? size + 5 : block.type === 'bibliography' ? 6 : lineHeight;
    const lines = linesOf(block.text || '', font, size, TEXT_WIDTH - 2 * quoteIndent);
    const footnotes = (block.footnotes || []).map(note => typeof note === 'string' ? note : note.text);
    return { heading, quoteIndent, font, size, leading, lines, footnotes };
  }
  function textBlock(block) {
    const { heading, quoteIndent, font, size, leading, lines, footnotes } = textLayout(block);
    if (heading && y < HEIGHT - MARGIN) y -= 6;
    let firstLine = true;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const attachNotes = firstLine ? footnotes : [];
      if (noteHeight(attachNotes) > HEIGHT - 2 * MARGIN - leading) throw new Error('A footnote is too long to fit on one page. Please shorten it in review.');
      const remaining = lines.length - index;
      const slots = Math.floor((y - MARGIN - noteHeight(attachNotes)) / leading);
      if (!heading && y < HEIGHT - MARGIN &&
          ((firstLine && remaining > 1 && slots === 1) ||
           (remaining === 2 && slots === 1 && index > 1))) nextPage();
      room(leading, attachNotes);
      if (firstLine) notes.push(...attachNotes);
      if (line) page.drawText(line, { x: MARGIN + quoteIndent, y: y - size, size, font });
      y -= leading;
      firstLine = false;
    }
    y -= heading ? 10 : block.type === 'bibliography' ? 0 : 8;
  }
  function tableLayout(block) {
    const grid = block.rows.map(() => []);
    const cells = [];
    block.rows.forEach((row, rowIndex) => {
      let column = 0;
      for (const cell of row) {
        while (grid[rowIndex][column]) column++;
        const item = { ...cell, row: rowIndex, column, end: Math.min(grid.length, rowIndex + cell.rows) };
        cells.push(item);
        for (let r = rowIndex; r < item.end; r++) {
          for (let c = column; c < column + cell.columns; c++) grid[r][c] = true;
        }
        column += cell.columns;
      }
    });
    const count = Math.max(0, ...grid.map(row => row.length));
    if (!count) return null;
    const width = TEXT_WIDTH / count;
    const padding = Math.min(4, width / 6);
    const size = count > 7 ? 7 : 9;
    const leading = size + 2;
    const heights = grid.map(() => leading + 2 * padding);
    for (const cell of cells) {
      cell.font = cell.header ? fonts.bold : fonts.regular;
      cell.lines = linesOf(cell.text, cell.font, size, width * cell.columns - 2 * padding);
      const available = heights.slice(cell.row, cell.end).reduce((sum, height) => sum + height, 0);
      heights[cell.end - 1] += Math.max(0, cell.lines.length * leading + 2 * padding - available);
    }
    const offsets = [0];
    for (const height of heights) offsets.push(offsets.at(-1) + height);
    const headerRows = block.rows.findIndex(row => row.some(cell => !cell.header));
    const headerEnd = headerRows > 0 ? headerRows : 0;
    return { cells, width, padding, size, leading, heights, offsets, headerEnd };
  }
  function tableBlock(block, layout) {
    if (!layout) return;
    const { cells, width, padding, size, leading, heights, offsets, headerEnd } = layout;
    function drawRange(top, bottom) {
      for (const cell of cells) {
        const start = offsets[cell.row];
        const end = offsets[cell.end];
        if (start >= bottom || end <= top) continue;
        const visibleTop = Math.max(start, top);
        const visibleBottom = Math.min(end, bottom);
        const x = MARGIN + cell.column * width;
        page.drawRectangle({
          x, y: y - (visibleBottom - top), width: width * cell.columns,
          height: visibleBottom - visibleTop, borderWidth: 0.25, borderColor: grayscale(0.68),
          color: grayscale(1)
        });
        cell.lines.forEach((line, index) => {
          const lineTop = start + padding + index * leading;
          if (line && lineTop >= visibleTop && lineTop + size <= visibleBottom + 0.01) {
            page.drawText(line, { x: x + padding, y: y - (lineTop - top) - size, size, font: cell.font });
          }
        });
      }
      y -= bottom - top;
    }
    const headerHeight = offsets[headerEnd];
    const maxHeight = HEIGHT - 2 * MARGIN;
    room(Math.min(maxHeight, captionHeight(block) + headerHeight + (heights[headerEnd] || 0)));
    if (block.caption) textBlock({ type: 'paragraph', bold: true, text: block.caption });
    let top = 0;
    while (top < offsets.at(-1)) {
      let space = y - MARGIN - noteHeight();
      const rowEnd = offsets.find(offset => offset > top);
      if (rowEnd - top > space && y < HEIGHT - MARGIN) {
        nextPage();
        if (headerHeight && top >= headerHeight && headerHeight < maxHeight / 2) drawRange(0, headerHeight);
        space = y - MARGIN;
      }
      let bottom = offsets.findLast(offset => offset > top && offset <= top + space);
      if (bottom === undefined) {
        bottom = top + space;
        for (const cell of cells) {
          const start = offsets[cell.row] + padding;
          const line = Math.floor((bottom - start) / leading);
          const lineTop = start + line * leading;
          if (line >= 0 && line < cell.lines.length && lineTop < bottom && lineTop + size > bottom) bottom = lineTop;
        }
      }
      if (bottom <= top) { nextPage(); continue; }
      drawRange(top, bottom);
      top = bottom;
      if (top < offsets.at(-1)) {
        nextPage();
        if (headerHeight && top >= headerHeight && headerHeight < maxHeight / 2) drawRange(0, headerHeight);
      }
    }
    y -= 12;
  }
  async function imageLayout(block) {
    const response = block.bytes ? null : await fetch(block.url);
    if (response && !response.ok) throw new Error('An illustration could not be loaded.');
    const blob = response ? await response.blob() : new Blob([block.bytes]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let embedded;
    if (bytes[0] === 137 && bytes[1] === 80) embedded = await pdf.embedPng(bytes);
    else if (bytes[0] === 255 && bytes[1] === 216) embedded = await pdf.embedJpg(bytes);
    else {
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const scale = Math.min(1, 1500 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        embedded = await pdf.embedPng(canvas.toDataURL('image/png'));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const caption = String(block.caption || '');
    const captionLines = linesOf(caption, fonts.regular, 8, TEXT_WIDTH);
    const capHeight = caption ? captionLines.length * 10 + 8 : 0;
    const scale = Math.min(1, TEXT_WIDTH / embedded.width, (HEIGHT - 2 * MARGIN - capHeight - 20) / embedded.height);
    const w = embedded.width * scale, h = embedded.height * scale;
    return { embedded, captionLines: caption ? captionLines : [], w, h, height: h + capHeight + 20 };
  }
  function imageBlock({ embedded, captionLines, w, h, height }) {
    room(height);
    y -= 10;
    page.drawImage(embedded, { x: MARGIN + (TEXT_WIDTH - w) / 2, y: y - h, width: w, height: h });
    y -= h + 8;
    for (const line of captionLines) { if (line) page.drawText(line, { x: MARGIN, y: y - 8, font: fonts.regular, size: 8 }); y -= 10; }
    y -= 10;
  }
  function captionHeight(block) {
    if (!block.caption) return 0;
    const caption = textLayout({ type: 'paragraph', bold: true, text: block.caption });
    return caption.lines.length * caption.leading + 8;
  }
  const layouts = new Map();
  async function measure(block) {
    if (!layouts.has(block)) {
      layouts.set(block, block.type === 'table' ? tableLayout(block) :
        block.type === 'image' ? await imageLayout(block) : textLayout(block));
    }
    return layouts.get(block);
  }
  const references = blocks.filter(block => block.type === 'bibliography' || block.inReferences);
  const ordered = blocks.filter(block => block.type !== 'bibliography' && !block.inReferences);
  beginPage();
  for (let index = 0; index < ordered.length; index++) {
    const block = ordered[index];
    const layout = await measure(block);
    if (block.type === 'heading' && ordered[index - 1]?.type !== 'heading') {
      let needed = 0;
      const extraNotes = [];
      let next = index;
      while (ordered[next]?.type === 'heading') {
        const heading = await measure(ordered[next]);
        needed += heading.lines.length * heading.leading + 16;
        extraNotes.push(...heading.footnotes);
        next++;
      }
      const following = ordered[next];
      if (following) {
        const opening = await measure(following);
        if (following.type === 'image') {
          const maxOpeningHeight = HEIGHT - 2 * MARGIN - needed - noteHeight(extraNotes) + noteHeight();
          if (opening.height > maxOpeningHeight && maxOpeningHeight > opening.height - opening.h) {
            const scale = (maxOpeningHeight - (opening.height - opening.h)) / opening.h;
            opening.w *= scale;
            opening.h *= scale;
            opening.height = maxOpeningHeight;
          }
          needed += opening.height;
        }
        else if (following.type === 'table' && opening) {
          needed += captionHeight(following) + opening.offsets[opening.headerEnd] +
            (opening.heights[opening.headerEnd] || 0);
        } else if (opening) {
          needed += Math.min(3, opening.lines.length) * opening.leading;
          extraNotes.push(...opening.footnotes);
        }
      }
      room(Math.min(needed, HEIGHT - 2 * MARGIN - noteHeight(extraNotes) + noteHeight()), extraNotes);
    }
    if (block.type === 'image') imageBlock(layout);
    else if (block.type === 'table') tableBlock(block, layout);
    else textBlock(block);
  }
  if (references.length) bibliography(references);
  finishPage();
  return pdf.save();

  function bibliography(entries) {
    if (y < HEIGHT - MARGIN) nextPage();
    const gutter = 18;
    const columnWidth = (TEXT_WIDTH - gutter) / 2;
    let index = 0;
    if (entries[0].type === 'heading') textBlock(entries[index++]);
    let column = 0;
    let top = y;
    function advanceColumn() {
      if (column === 0) column = 1;
      else {
        nextPage();
        top = y;
        column = 0;
      }
      y = top;
    }
    for (; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.type === 'table') {
        if (column || y < top) nextPage();
        tableBlock(entry, tableLayout(entry));
        top = y;
        column = 0;
        continue;
      }
      const heading = entry.type === 'heading';
      const font = heading ? fonts.bold : fonts.regular;
      const size = heading ? 14 : 6;
      const leading = heading ? 17 : 6;
      const lines = linesOf(entry.text, font, size, columnWidth);
      const entryHeight = leading * lines.length;
      const opening = heading && index < entries.length - 1 ? 12 : 0;
      if (entryHeight + opening > y - MARGIN && y < top && entryHeight <= HEIGHT - 2 * MARGIN) advanceColumn();
      for (const line of lines) {
        if (y - leading < MARGIN) advanceColumn();
        if (line) page.drawText(line, { x: MARGIN + column * (columnWidth + gutter), y: y - size, size, font });
        y -= leading;
      }
    }
  }
}
