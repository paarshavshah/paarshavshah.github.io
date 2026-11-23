import {layOutPdfPage, pdfDisplayTitle, pdfMarginKeys} from './pdf-import.js?v=19';

const URL_ERROR = "Error! Your text isn't legible. Please check it again, or paste the text directly. Cheers.";

function blank() {
  return { text: '', title: '', author: '', date: '', publisher: '', source: '', pages: [], images: [] };
}

function imageData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
}

export function extractText(text) {
  if (!text.trim()) throw new Error('Enter text to continue.');
  return { ...blank(), text, pages: [{ number: 1, text, image: '', lowConfidence: false }] };
}

function metadata(doc, selector, attribute = 'content') {
  return doc.querySelector(selector)?.getAttribute(attribute)?.trim() || '';
}

export async function extractUrl(input, onProgress = () => {}) {
  let url;
  try {
    url = new URL(input.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch { throw new Error(URL_ERROR); }
  if (/^en(?:\.m)?\.wikipedia\.org$/.test(url.hostname) && (url.pathname.startsWith('/wiki/') || url.pathname === '/w/index.php')) {
    return extractWikipedia(url);
  }
  let response;
  try { response = await fetch(url.href, { credentials: 'omit', cache: 'no-store' }); }
  catch { throw new Error(URL_ERROR); }
  if (!response.ok) throw new Error(URL_ERROR);
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/pdf') || url.pathname.toLowerCase().endsWith('.pdf')) {
    const result = await extractFiles([new File([await response.blob()], 'source.pdf', { type: 'application/pdf' })], onProgress);
    result.source = url.href;
    return result;
  }
  if (!type.includes('text/html') && !type.includes('text/plain')) throw new Error(URL_ERROR);
  if (type.includes('text/plain')) return { ...extractText(await response.text()), source: url.href };
  return extractHtml(await response.text(), url, new URL(response.url || url.href));
}

async function extractWikipedia(url) {
  try {
    const revision = url.searchParams.get('oldid');
    const title = url.pathname.startsWith('/wiki/') ? decodeURIComponent(url.pathname.slice(6)) : url.searchParams.get('title');
    if (revision ? !/^\d+$/.test(revision) : !title) throw new Error();
    const endpoint = new URL('https://en.wikipedia.org/w/api.php');
    endpoint.search = new URLSearchParams({
      action: 'parse', format: 'json', formatversion: '2', origin: '*',
      prop: 'text', redirects: '1', disableeditsection: '1', disabletoc: '1',
      ...(revision ? { oldid: revision } : { page: title })
    });
    const response = await fetch(endpoint, { credentials: 'omit', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error();
    const { parse } = await response.json();
    if (typeof parse?.text !== 'string') throw new Error();
    return { ...extractHtml(parse.text, url, new URL('https://en.wikipedia.org/')), title: parse.title, publisher: 'Wikipedia' };
  } catch {
    throw new Error(URL_ERROR);
  }
}

function extractHtml(html, url, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const result = blank();
  result.source = url.href;
  result.title = metadata(doc, 'meta[property="og:title"]') || doc.querySelector('h1')?.textContent?.trim() || doc.title;
  result.author = metadata(doc, 'meta[name="author"]');
  result.date = metadata(doc, 'meta[property="article:published_time"]') || doc.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  result.publisher = metadata(doc, 'meta[property="og:site_name"]');
  const root = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('.mw-parser-output') || doc.body;
  root.querySelectorAll('script,style,nav,footer,header,aside,form,button,iframe,[role="navigation"], [aria-label*="advert" i], [class*="advert" i], [id*="advert" i]').forEach(el => el.remove());
  const isWikipedia = root.matches('.mw-parser-output');
  if (isWikipedia) {
    root.querySelectorAll('.ambox,.hatnote,.mw-editsection,.navbox,.shortdescription,.sistersitebox,.infobox,.sidebar,.metadata,.mw-indicators,.mw-jump-link,.noprint,.toc,.portalbox,.authority-control').forEach(element => element.remove());
  }
  root.querySelectorAll('sup.reference,sup[typeof~="mw:Extension/ref"],[role="doc-noteref"],.mw-cite-backlink,sup.Template-Fact,sup.noprint').forEach(marker => marker.remove());
  const figureSelector = isWikipedia ? 'figure, .thumb, .gallerybox, .tsingle' : 'figure';
  const sourceBlocks = [];
  let inReferences = false;
  let skipSection = false;
  result.blocks = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,pre,li,table')]
    .filter(element => !element.closest(figureSelector) && !element.parentElement?.closest('li,blockquote,table'))
    .map(element => {
      const text = element.textContent.trim();
      if (!text) return null;
      if (/^H[1-6]$/.test(element.tagName)) {
        const level = Number(element.tagName[1]);
        if (level <= 2) skipSection = isWikipedia && /^(see also|external links|further reading)$/i.test(text);
        if (skipSection) return null;
        if (level <= 2) inReferences = /^(references|bibliography|sources|works cited|notes|citations)$/i.test(text);
        sourceBlocks.push(element);
        return { type: 'heading', level, text, inReferences };
      }
      if (skipSection) return null;
      sourceBlocks.push(element);
      if (element.tagName === 'TABLE') {
        const rows = [...element.rows].map(row => [...row.cells].map(cell => ({
          text: cell.innerText?.trim() || cell.textContent.trim(),
          header: cell.tagName === 'TH',
          columns: cell.colSpan,
          rows: cell.rowSpan || row.parentElement.rows.length - row.sectionRowIndex
        })));
        return { type: 'table', rows, caption: element.caption?.textContent.trim() || '', text, inReferences };
      }
      const type = inReferences ? 'bibliography' : element.tagName === 'BLOCKQUOTE' ? 'quote' : 'paragraph';
      return { type, text };
    }).filter(block => block?.text);
  result.text = result.blocks.map(block => block.text).join('\n\n');
  if (!result.text.trim()) throw new Error(URL_ERROR);
  const firstParagraph = result.blocks.findIndex(block => block.type === 'paragraph');
  const seenImages = new Set();
  for (const figure of root.querySelectorAll(figureSelector)) {
    const caption = figure.querySelector('figcaption,.thumbcaption,.gallerytext')?.textContent?.trim() || '';
    let after = sourceBlocks.findLastIndex(element => element.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (after < firstParagraph) after = firstParagraph;
    if (after < 0) after = 0;
    for (const image of figure.querySelectorAll('img[src]')) {
      try {
        const url = new URL(image.getAttribute('src'), base);
        if (!['https:', 'http:'].includes(url.protocol) || seenImages.has(url.href)) continue;
        if (isWikipedia && !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname)) continue;
        seenImages.add(url.href);
        result.images.push({
          src: url.href,
          alt: image.getAttribute('alt') || '',
          caption,
          after,
          flag: caption ? '' : 'Missing caption'
        });
      } catch { /* Skip invalid image URLs. */ }
    }
  }
  result.pages = [{ number: 1, text: result.text, image: '', lowConfidence: true }];
  return result;
}

export async function readScreenshot(source, regions) {
  const image = new Image();
  image.src = source;
  await image.decode();
  const { createWorker } = await ocrLibrary();
  const worker = await createWorker('eng');
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const results = [];
    for (const { x, y, width, height } of regions) {
      const cropWidth = image.naturalWidth * width;
      const cropHeight = image.naturalHeight * height;
      const scale = Math.min(4, 1800 / cropWidth, 3600 / cropHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(cropWidth * scale));
      canvas.height = Math.max(1, Math.round(cropHeight * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.filter = 'grayscale(1) contrast(1.25)';
      context.drawImage(image, image.naturalWidth * x, image.naturalHeight * y,
        cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
      const { data } = await worker.recognize(canvas);
      results.push(data);
    }
    return {
      text: results.map(group => group.text.trim()).filter(Boolean).join('\n\n'),
      unreliable: results.some(group => !group.text.trim() || group.confidence < 65)
    };
  } finally {
    await worker.terminate();
  }
}

async function pdfLibrary() {
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
  return pdfjs;
}

async function ocrLibrary() {
  return import('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm');
}

function pdfLines(items) {
  const rows = [];
  const tokens = items.filter(item => item.str?.trim()).map(item => ({
    text: item.str, x: item.transform[4], y: item.transform[5],
    width: item.width, size: Math.abs(item.transform[3]) || item.height
  })).sort((a, b) => b.y - a.y || a.x - b.x);
  for (const token of tokens) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - token.y) <= 2.4) row.tokens.push(token);
    else rows.push({ y: token.y, tokens: [token] });
  }
  const scripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  for (let index = rows.length - 2; index >= 0; index--) {
    const row = rows[index];
    const base = rows[index + 1];
    if (row.y - base.y > 5 || !row.tokens.every(token => token.size < 8 &&
        /^[−+\d]+$/.test(token.text.trim())) || !base.tokens.some(token => token.size >= 9.7)) continue;
    const right = Math.max(...base.tokens.map(token => token.x + token.width));
    if (!row.tokens.every(token => token.x < right &&
        base.tokens.some(part => Math.abs(part.x + part.width - token.x) < 10))) continue;
    for (const token of row.tokens) {
      token.text = token.text.replace(/[−+\d]/g, character =>
        character === '−' ? '⁻' : character === '+' ? '⁺' : scripts[Number(character)]);
      base.tokens.push(token);
    }
    rows.splice(index, 1);
  }
  return rows.map(row => {
    const parts = row.tokens.sort((a, b) => a.x - b.x);
    const text = parts.reduce((line, part, index) => {
      const previous = parts[index - 1];
      const gap = previous ? part.x - previous.x - previous.width : 0;
      return line + (previous && gap > Math.min(part.size, previous.size) * 0.14 && !/^[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/.test(part.text) &&
        !/\s$/.test(line) && !/^\s/.test(part.text) ? ' ' : '') + part.text;
    }, '').trim();
    return { y: row.y, x: parts[0].x, right: Math.max(...parts.map(p => p.x + p.width)),
      size: Math.max(...parts.map(p => p.size)), text, parts };
  });
}

function appendWrapped(previous, next) {
  return /[\p{L}]-$/u.test(previous) && /^\p{Ll}/u.test(next)
    ? previous.slice(0, -1) + next : previous + ' ' + next;
}

function journalBlocks(lines, canvas, viewport, state, pageNumber) {
  const pageHeight = viewport.height / viewport.scale;
  const pageWidth = viewport.width / viewport.scale;
  const visible = lines.filter(row => row.y > 47 && row.y < pageHeight - 54);
  const onFirstPage = pageNumber === 1;
  const abstract = visible.find(row => /^Abstract$/i.test(row.text));
  const body = onFirstPage ? visible.filter(row => row.y <= abstract.y && row.x >= abstract.x - 6) : visible;
  const bodyX = state.bodyX;
  const captionPattern = /^(Figure|Table)\s+\d+[a-z]?\.\s+/i;
  const captionAt = row => row.size < 9.7 && Math.abs(row.x - bodyX) < 8 && captionPattern.test(row.text);
  const isProse = row => row.size >= 9.7 &&
    (Math.abs(row.x - bodyX) < 4 || Math.abs(row.x - bodyX - 22) < 4);
  const blocks = [];
  const excluded = new Set();
  const anchors = new Map();

  function makeImage(top, bottom, caption, isTable) {
    if (top <= bottom + 8) return null;
    const crop = document.createElement('canvas');
    const scale = viewport.scale;
    const inset = 34 * scale;
    crop.width = Math.round((pageWidth - 68) * scale);
    crop.height = Math.round((top - bottom) * scale);
    crop.getContext('2d').drawImage(canvas, inset, (pageHeight - top) * scale,
      crop.width, crop.height, 0, 0, crop.width, crop.height);
    const image = { src: crop.toDataURL('image/png'), caption, alt: caption };
    if (isTable) image.flag = 'Table kept as a source image. Review the values and labels.';
    return { type: 'pdf-figure', image };
  }

  for (let i = 0; i < body.length && !state.inReferences; i++) {
    const row = body[i];
    if (!captionAt(row)) continue;
    let end = i + 1;
    let caption = row.text;
    while (end < body.length && body[end].size < 9.7 && body[end - 1].y - body[end].y < 16 &&
      Math.abs(body[end].x - bodyX) < 8 && !captionAt(body[end])) {
      caption = appendWrapped(caption, body[end].text);
      end++;
    }
    const isTable = /^Table\b/i.test(caption);
    let top;
    let bottom;
    if (isTable) {
      let after = end;
      while (after < body.length && !captionAt(body[after])) {
        const candidate = body[after];
        const gap = (body[after - 1] || row).y - candidate.y;
        if (after > end && gap > 17 && isProse(candidate)) break;
        after++;
      }
      if (after === end) continue;
      top = body[end - 1].y - 3;
      bottom = body[after - 1].y - 8;
      for (let k = i; k < after; k++) excluded.add(k);
    } else {
      let before = i - 1;
      while (before >= 0 && !(isProse(body[before]) && body[before].text.length > 36) && !excluded.has(before)) before--;
      top = before >= 0 ? body[before].y - 6 : pageHeight - 61;
      bottom = row.y + row.size + 2;
      for (let k = before + 1; k < end; k++) excluded.add(k);
    }
    const figure = makeImage(top, bottom, caption, isTable);
    if (figure) anchors.set(i, figure);
  }

  let current;
  let previous;
  for (const [index, row] of body.entries()) {
    if (anchors.has(index)) { blocks.push(anchors.get(index)); current = null; }
    if (excluded.has(index)) continue;
    if (state.inAbbreviations && row.size < 9.7 && Math.abs(row.x - bodyX) < 4) {
      const column = row.parts.findIndex((part, k) => k > 0 &&
        part.x - row.parts[k - 1].x - row.parts[k - 1].width > 16);
      if (column > 0) {
        if (current?.type !== 'table') {
          current = { type: 'table', rows: [] };
          blocks.push(current);
        }
        current.rows.push([row.parts.slice(0, column), row.parts.slice(column)].map(parts => ({
          text: parts.map(part => part.text).join(' ').replace(/\s+/g, ' ').trim(),
          header: false, rows: 1, columns: 1
        })));
        previous = row;
        continue;
      }
    }
    const text = state.inReferences ? row.text.replace(/\s*\[(?:CrossRef|PubMed)\]/g, '') :
      row.text.replace(/\s*\[\d+(?:\s*[,;–-]\s*\d+)*\]/g, '');
    if (!text.trim()) continue;
    if (state.inReferences && /^Disclaimer\/Publisher[’']s Note:/i.test(text)) break;
    if (/^Abbreviations$/i.test(text)) state.inAbbreviations = true;
    if (/^References$/i.test(text)) { state.inReferences = true; state.inAbbreviations = false; }
    const numbered = /^(\d+(?:\.\d+)*\.)\s+\p{L}/u.exec(text);
    const heading = /^(Abstract|Abbreviations|References)$/i.test(text) ||
      (Math.abs(row.x - bodyX) < 8 && numbered && text.length < 115 && !state.inReferences);
    const headingLevel = numbered?.[1].replace(/\.$/, '').includes('.') ? 3 : 2;
    const type = heading ? 'heading' : state.inReferences ? 'bibliography' : 'paragraph';
    const newParagraph = !current || current.type !== type || heading ||
      (state.inReferences ? /^\d+\.\s/.test(text) :
        (row.x > bodyX + 14 && row.x < bodyX + 28) ||
        (previous && previous.y - row.y > 17));
    if (newParagraph) {
      current = { type, text, level: headingLevel, inReferences: state.inReferences };
      if (blocks.length === 0 && type === 'paragraph' && Math.abs(row.x - bodyX) < 4) current.continues = true;
      blocks.push(current);
    } else current.text = appendWrapped(current.text, text);
    previous = row;
  }
  return blocks;
}

export async function extractFiles(fileList, onProgress = () => {}) {
  const files = [...fileList];
  if (!files.length) throw new Error('Choose a PDF or images to continue.');
  const result = blank();
  let worker;
  async function recognize(source, number) {
    if (!worker) {
      const tesseract = await ocrLibrary();
      worker = await tesseract.createWorker('eng');
    }
    onProgress(`Reading page ${number}`);
    const { data } = await worker.recognize(source);
    return { text: data.text || '', lowConfidence: (data.confidence ?? 0) < 85 };
  }
  try {
    for (const file of files) {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        if (files.length !== 1) throw new Error('Choose one PDF or a sequence of images.');
        const pdfjs = await pdfLibrary();
        const sourceBytes = new Uint8Array(await file.arrayBuffer());
        const pdf = await pdfjs.getDocument({ data: sourceBytes.slice() }).promise;
        try {
          const { info, metadata } = await pdf.getMetadata().catch(() => ({}));
          result.title = info?.Title || metadata?.get('dc:title') || '';
          result.author = info?.Author || '';
          result.publisher = metadata?.get('dc:publisher') || '';
          result.blocks = [];

          // Count repeated margin text across pages before deciding what is furniture.
          const margins = new Map();
          const pageItems = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            onProgress(`Reading layout ${i} of ${pdf.numPages}`);
            const page = await pdf.getPage(i);
            const {items} = await page.getTextContent();
            const viewport = page.getViewport({scale: 1});
            if (i === 1 && !result.title) result.title = pdfDisplayTitle(items, viewport);
            for (const key of pdfMarginKeys(items, viewport)) margins.set(key, (margins.get(key) || 0) + 1);
            pageItems.push(items);
          }

          const state = { running: new Set([...margins].filter(([, count]) =>
            pdf.numPages >= 3 && count >= Math.max(2, Math.ceil(pdf.numPages * .5))).map(([key]) => key)) };
          let journal;
          for (let i = 1; i <= pdf.numPages; i++) {
            onProgress(`Reading page ${i} of ${pdf.numPages}`);
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({scale: 1});
            const renderViewport = page.getViewport({scale: Math.min(1.5, 2200 / Math.max(viewport.width, viewport.height))});
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(renderViewport.width);
            canvas.height = Math.ceil(renderViewport.height);
            await page.render({canvasContext: canvas.getContext('2d'), viewport: renderViewport}).promise;

            const items = pageItems[i - 1];
            pageItems[i - 1] = null;
            let lines = pdfLines(items);
            if (i === 1 && page.rotate === 0) {
              const abstract = lines.find(row => /^Abstract$/i.test(row.text));
              const published = lines.find(row => /Published:\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}/.test(row.text));
              if (abstract && abstract.x > 95 && /10\.3390\//.test(lines.map(row => row.text).join(' ')) && published) {
                journal = {bodyX: abstract.x, inReferences: false};
                lines = pdfLines(items.filter(item => item.transform?.[4] >= abstract.x - 6));
                result.date = published.text.match(/Published:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/)[1];
                result.publisher ||= 'MDPI';
              }
            }

            if (journal && items.some(item => item.str?.trim()) && page.rotate === 0) {
              for (const block of journalBlocks(lines, canvas, renderViewport, journal, i)) {
                if (block.type === 'pdf-figure') {
                  result.images.push({...block.image, after: result.blocks.length - 1});
                } else {
                  const last = result.blocks.at(-1);
                  if (block.continues && last?.type === 'paragraph' &&
                      (!/[.!?][”’)]?$/.test(last.text) || /^[a-z]/.test(block.text)) &&
                      result.images.at(-1)?.after !== result.blocks.length - 1) {
                    last.text = appendWrapped(last.text, block.text);
                  } else result.blocks.push(block);
                }
              }
            } else {
              const boldFonts = new Set();
              for (const name of new Set(items.map(item => item.fontName).filter(Boolean))) {
                if (!page.commonObjs.has(name)) continue;
                const font = page.commonObjs.get(name);
                if (font.bold || /bold|demi|semibold|black/i.test(font.name || '')) boldFonts.add(name);
              }
              state.page = i;
              state.title = result.title;
              const layout = layOutPdfPage(items, viewport, boldFonts, canvas, state);
              const snapshot = () => canvas.toDataURL('image/jpeg', .9);
              let {text, reason} = layout;
              if (!layout.hasText && reason) {
                try { ({text} = await recognize(snapshot(), i)); }
                catch { reason = 'The scan could not be transcribed.'; }
              }
              if (reason) {
                const review = {number:i, text, image:snapshot(), lowConfidence:true,
                  reason, keepOriginal:true, rotated:page.rotate !== 0};
                result.pages.push(review);
                result.blocks.push({type:'review-page', review});
                result.sourceBytes = sourceBytes;
              } else result.blocks.push(...layout.blocks);
            }
            page.cleanup();
            canvas.width = canvas.height = 0;
          }
        } finally {
          await pdf.destroy();
        }
      } else if (file.type.startsWith('image/')) {
        const image = await imageData(file);
        const preview = new Image();
        preview.src = image;
        await preview.decode();
        const needsCrop = preview.naturalHeight > preview.naturalWidth * 2.4;
        const { text, lowConfidence } = needsCrop
          ? { text: '', lowConfidence: true }
          : await recognize(image, result.pages.length + 1);
        result.pages.push({ number: result.pages.length + 1, text, image, lowConfidence, needsCrop });
      } else throw new Error('Choose a PDF or image files.');
    }
  } finally { if (worker) await worker.terminate(); }
  result.text = (result.blocks ?? result.pages).map(item => item.text || item.review?.text || '').join('\n\n');
  return result;
}
