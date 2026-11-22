const URL_ERROR = "Error! Your text isn't legible. Please check it again, or paste the text directly. Cheers.";

function blank() {
  return { text: '', title: '', author: '', date: '', publisher: '', source: '', pages: [], images: [], warnings: [] };
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
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  const result = blank();
  result.source = url.href;
  result.title = metadata(doc, 'meta[property="og:title"]') || doc.querySelector('h1')?.textContent?.trim() || doc.title;
  result.author = metadata(doc, 'meta[name="author"]');
  result.date = metadata(doc, 'meta[property="article:published_time"]') || doc.querySelector('time[datetime]')?.getAttribute('datetime') || '';
  result.publisher = metadata(doc, 'meta[property="og:site_name"]');
  const root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  root.querySelectorAll('script,style,nav,footer,header,aside,form,button,iframe,[role="navigation"], [aria-label*="advert" i], [class*="advert" i], [id*="advert" i]').forEach(el => el.remove());
  const blocks = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,pre,li,figcaption,table')]
    .filter(el => !el.parentElement?.closest('li,blockquote,table,figure'))
    .map(el => el.textContent.trim()).filter(Boolean);
  result.text = blocks.join('\n\n');
  if (!result.text.trim()) throw new Error(URL_ERROR);
  for (const figure of root.querySelectorAll('figure')) {
    const image = figure.querySelector('img');
    const source = image?.getAttribute('src');
    if (!source || source.startsWith('data:')) continue;
    try { result.images.push({ src: new URL(source, url.href).href, caption: figure.querySelector('figcaption')?.textContent?.trim() || '' }); } catch {}
  }
  result.pages = [{ number: 1, text: result.text, image: '', lowConfidence: true }];
  result.warnings.push('Review the extracted text and images against the source.');
  return result;
}

async function pdfLibrary() {
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
  return pdfjs;
}

async function ocrLibrary() {
  return import('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm');
}

function pdfText(items) {
  let output = '';
  let lastY = null;
  for (const item of items) {
    if (!item.str) continue;
    const y = item.transform?.[5];
    if (lastY != null && y != null && Math.abs(lastY - y) > 3) output += '\n';
    else if (output && !output.endsWith('\n') && !output.endsWith(' ')) output += ' ';
    output += item.str;
    if (item.hasEOL) output += '\n';
    lastY = y;
  }
  return output;
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
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          onProgress(`Reading page ${i} of ${pdf.numPages}`);
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const image = canvas.toDataURL('image/jpeg', 0.8);
          let text = pdfText((await page.getTextContent()).items);
          let lowConfidence = false;
          if (!text.trim()) ({ text, lowConfidence } = await recognize(image, i));
          result.pages.push({ number: i, text, image, lowConfidence });
          page.cleanup();
        }
        await pdf.destroy();
        result.warnings.push('Review reading order, formatting, figures, equations, notes and references against the original PDF.');
      } else if (file.type.startsWith('image/')) {
        const image = await imageData(file);
        const { text, lowConfidence } = await recognize(image, result.pages.length + 1);
        result.pages.push({ number: result.pages.length + 1, text, image, lowConfidence });
      } else throw new Error('Choose a PDF or image files.');
    }
  } finally { if (worker) await worker.terminate(); }
  result.text = result.pages.map(page => page.text).join('\n\n');
  if (result.pages.some(page => page.lowConfidence)) result.warnings.push('Some text may be uncertain. Compare it with the original.');
  return result;
}
