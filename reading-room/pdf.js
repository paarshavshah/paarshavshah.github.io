// Generate a reading edition in the browser. Blocks contain exact extracted text.
import { PDFDocument, PDFName, PDFString, PDFArray } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
import fontkit from 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/+esm';

const FONT_ROOT = 'https://cdn.jsdelivr.net/npm/@fontsource/eb-garamond@5.2.7/files/';
const FONT_FILES = {
  regular: 'eb-garamond-latin-400-normal.woff',
  bold: 'eb-garamond-latin-700-normal.woff',
  italic: 'eb-garamond-latin-400-italic.woff',
  boldItalic: 'eb-garamond-latin-700-italic.woff'
};
const WIDTH = 612, HEIGHT = 792, MARGIN = 72, TEXT_WIDTH = WIDTH - MARGIN * 2;

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
    fonts[style] = await pdf.embedFont(await fetchBytes(FONT_ROOT + filename), { subset: true });
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
  const pending = [];
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
    page.drawText(number, { x: (WIDTH - fonts.regular.widthOfTextAtSize(number, 8)) / 2, y: 36, size: 8, font: fonts.regular });
  }
  function nextPage() { finishPage(); beginPage(); }
  function room(height, extraNotes = []) {
    if (y - height < MARGIN + noteHeight(extraNotes)) nextPage();
  }
  function textBlock(block) {
    const font = block.bold && block.italic ? fonts.boldItalic : block.bold ? fonts.bold : block.italic ? fonts.italic : fonts.regular;
    const size = block.type === 'heading' ? 18 : block.type === 'bibliography' ? 8 : 12;
    const leading = block.type === 'heading' ? 23 : block.type === 'bibliography' ? 11 : lineHeight;
    const lines = linesOf(block.text || '', font, size, TEXT_WIDTH);
    const footnotes = (block.footnotes || []).map(note => typeof note === 'string' ? note : note.text);
    let firstLine = true;
    for (const line of lines) {
      const attachNotes = firstLine ? footnotes : [];
      if (noteHeight(attachNotes) > HEIGHT - 2 * MARGIN - leading) throw new Error('A footnote is too long to fit on one page. Please shorten it in review.');
      room(leading, attachNotes);
      if (firstLine) notes.push(...attachNotes);
      if (line) page.drawText(line, { x: MARGIN, y: y - size, size, font });
      y -= leading;
      firstLine = false;
    }
    y -= block.type === 'heading' ? 10 : 8;
  }
  async function imageBlock(block) {
    const bytes = block.bytes || await fetchBytes(block.url);
    let embedded;
    try { embedded = await pdf.embedPng(bytes); } catch { embedded = await pdf.embedJpg(bytes); }
    const caption = String(block.caption || '');
    const captionLines = linesOf(caption, fonts.regular, 8, TEXT_WIDTH);
    const capHeight = caption ? captionLines.length * 10 + 8 : 0;
    const scale = Math.min(1, TEXT_WIDTH / embedded.width, (HEIGHT - 2 * MARGIN - capHeight - 20) / embedded.height);
    const w = embedded.width * scale, h = embedded.height * scale;
    room(h + capHeight + 20);
    y -= 10;
    page.drawImage(embedded, { x: MARGIN + (TEXT_WIDTH - w) / 2, y: y - h, width: w, height: h });
    y -= h + 8;
    for (const line of captionLines) { if (line) page.drawText(line, { x: MARGIN, y: y - 8, font: fonts.regular, size: 8 }); y -= 10; }
    y -= 10;
  }
  beginPage();
  for (const block of blocks) {
    if (block.type === 'image') await imageBlock(block);
    else if (block.type === 'bibliography') pending.push(block);
    else textBlock(block);
  }
  if (pending.length) {
    room(30);
    for (const block of pending) textBlock(block);
  }
  finishPage();
  return pdf.save();
}
