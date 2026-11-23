import {extractText, extractUrl, extractFiles, readScreenshot} from './extract.js?v=17';
import {generatePdf} from './pdf.js?v=17';
const $ = id => document.getElementById(id);
let documentData, files = [], pdfUrl;
function show(id) { for (const name of ['start','review','result']) $(name).hidden = name !== id; }
function fileOrder() {
  $('file-order').replaceChildren();
  files.forEach((file, index) => {
    const row = document.createElement('div'); row.textContent = file.name + ' ';
    for (const [label, offset] of [['↑',-1],['↓',1]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.disabled = index + offset < 0 || index + offset >= files.length;
      button.addEventListener('click', () => { [files[index], files[index + offset]] = [files[index + offset], files[index]]; fileOrder(); }); row.append(button);
    }
    $('file-order').append(row);
  });
}
function screenshotPicker(page, original, field) {
  const wrapper = document.createElement('div');
  const instruction = document.createElement('p');
  instruction.textContent = 'Drag over the article text. Select separate areas to skip ads and pictures.';
  const preview = document.createElement('div');
  preview.style.position = 'relative';
  original.style.cssText = 'display:block;width:100%;touch-action:none;user-select:none;cursor:crosshair';
  original.draggable = false;
  preview.append(original);
  const regions = [];
  const outlines = [];
  let start;
  function point(event) {
    const bounds = original.getBoundingClientRect();
    const clamp = value => Math.min(1, Math.max(0, value));
    return [clamp((event.clientX - bounds.left) / bounds.width),
      clamp((event.clientY - bounds.top) / bounds.height)];
  }
  original.onpointerdown = event => {
    if (event.button !== 0) return;
    start = point(event);
    original.setPointerCapture(event.pointerId);
  };
  original.onpointercancel = () => { start = null; };
  original.onpointerup = event => {
    if (!start) return;
    const end = point(event);
    const region = { x: Math.min(start[0], end[0]), y: Math.min(start[1], end[1]),
      width: Math.abs(end[0] - start[0]), height: Math.abs(end[1] - start[1]) };
    start = null;
    if (region.width < 0.02 || region.height < 0.005) return;
    regions.push(region);
    page.text = field.value = '';
    const outline = document.createElement('span');
    Object.assign(outline.style, { position: 'absolute', pointerEvents: 'none',
      border: '2px solid #ff0000', background: '#ff000022', boxSizing: 'border-box',
      left: region.x * 100 + '%', top: region.y * 100 + '%',
      width: region.width * 100 + '%', height: region.height * 100 + '%' });
    outlines.push(outline);
    preview.append(outline);
    read.disabled = false;
  };
  const read = document.createElement('button');
  read.type = 'button';
  read.textContent = 'Read selected text';
  read.disabled = true;
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Clear selection';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  clear.onclick = () => {
    regions.length = 0;
    for (const outline of outlines.splice(0)) outline.remove();
    status.textContent = '';
    read.disabled = true;
    page.text = field.value = '';
  };
  read.onclick = async () => {
    read.disabled = clear.disabled = field.disabled = true;
    original.style.pointerEvents = 'none';
    status.className = '';
    status.textContent = 'Reading text…';
    page.text = field.value = '';
    try {
      const sorted = [...regions].sort((a, b) => a.y - b.y || a.x - b.x);
      const result = await readScreenshot(page.image, sorted);
      if (result.unreliable) {
        status.className = 'flags';
        status.textContent = 'This selection is too blurry to read reliably. Upload a sharper screenshot or paste the article text.';
      } else {
        page.text = field.value = result.text;
        status.textContent = '';
      }
    } catch {
      status.className = 'flags';
      status.textContent = 'Could not read the selection. Try again or paste the article text.';
    } finally {
      read.disabled = clear.disabled = field.disabled = false;
      original.style.pointerEvents = '';
    }
  };
  wrapper.append(instruction, read, clear, status, preview);
  return wrapper;
}
$('source-files').addEventListener('change', e => { files = [...e.target.files]; fileOrder(); });
$('source-form').addEventListener('submit', async e => {
  e.preventDefault(); $('source-status').classList.remove('error'); $('source-status').textContent = '';
  const url = $('source-url').value.trim(), text = $('source-text').value;
  if ([!!url, !!text.trim(), !!files.length].filter(Boolean).length !== 1) { $('source-status').classList.add('error'); $('source-status').textContent = 'Choose one source.'; return; }
  $('prepare').disabled = true;
  try {
    documentData = url ? await extractUrl(url, p => $('source-status').textContent = p) : files.length ? await extractFiles(files, p => $('source-status').textContent = p) : extractText(text);
    for (const field of ['title','author','date','publisher']) $('meta-'+field).value = documentData[field] || '';
    $('review-status').textContent = '';
    const flaggedPages = documentData.pages.filter(page => page.lowConfidence && page.image);
    $('flagged-text').replaceChildren();
    for (const page of flaggedPages) {
      const row = document.createElement('div');
      row.className = 'review-columns';
      const original = document.createElement('img');
      original.src = page.image;
      original.alt = 'Original page ' + page.number;
      original.style.maxWidth = '100%';
      const label = document.createElement('label');
      const flag = document.createElement('span');
      flag.className = 'flags';
      flag.textContent = 'Flagged text · Page ' + page.number;
      label.append(flag);
      const field = document.createElement('textarea');
      field.rows = 12;
      field.value = page.text;
      field.addEventListener('input', () => { page.text = field.value; });
      label.append(field);
      if (page.needsCrop) row.append(screenshotPicker(page, original, field), label);
      else row.append(original, label);
      $('flagged-text').append(row);
    }
    const flaggedImages = documentData.images.filter(image => image.flag);
    $('review-flags').textContent = flaggedPages.length || flaggedImages.length
      ? 'Review the flagged text or images against the source.'
      : '';
    const reviewImages = $('review-images');
    reviewImages.replaceChildren();
    $('images-section').hidden = flaggedImages.length === 0;
    for (const image of flaggedImages) {
      const row = document.createElement('div');
      const flag = document.createElement('p');
      flag.className = 'flags';
      flag.textContent = image.flag;
      const preview = document.createElement('img');
      preview.src = image.src;
      preview.alt = image.alt || 'Flagged image';
      preview.loading = 'lazy';
      preview.style.maxWidth = '12rem';
      const label = document.createElement('label');
      const include = document.createElement('input');
      include.type = 'checkbox';
      include.checked = true;
      include.onchange = () => { image.excluded = !include.checked; };
      label.append(include, ' Include image');
      const caption = document.createElement('input');
      caption.value = image.caption;
      caption.setAttribute('aria-label', 'Image caption');
      caption.placeholder = 'Caption';
      caption.oninput = () => { image.caption = caption.value; };
      row.append(flag, preview, label, caption);
      reviewImages.append(row);
    }
    show('review');
  } catch (error) { $('source-status').classList.add('error'); $('source-status').textContent = error.message; } finally { $('prepare').disabled=false; }
});
$('back').onclick=()=>show('start'); $('edit').onclick=()=>show('review');
$('generate-another').onclick=()=>{
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = undefined;
  documentData = undefined;
  files = [];
  $('source-form').reset();
  $('source-status').textContent = '';
  $('source-status').classList.remove('error');
  $('pdf-preview').removeAttribute('src');
  $('download').removeAttribute('href');
  $('flagged-text').replaceChildren();
  $('review-images').replaceChildren();
  fileOrder();
  show('start');
  $('source-url').focus();
};
$('generate').onclick=async()=>{ $('generate').disabled=true; $('review-status').classList.remove('error'); $('review-status').textContent='Generating PDF…'; try {
  if (documentData.pages.some(page => page.needsCrop && !page.text.trim())) {
    throw new Error('Read the selected screenshot text or paste the article before generating a PDF.');
  }
  const blocks = documentData.blocks ? [...documentData.blocks] : documentData.pages.flatMap(page => page.text.split(/\n\s*\n/).filter(text => text.trim()).map(text => ({type:'paragraph', text})));
  const figuresByBlock = new Map();
  for (const image of documentData.images) {
    if (image.excluded) continue;
    const index = image.after ?? blocks.length - 1;
    const figures = figuresByBlock.get(index) || [];
    figures.push({ type: 'image', url: image.src, caption: image.caption });
    figuresByBlock.set(index, figures);
  }
  const orderedBlocks = blocks.flatMap((block, index) => [block, ...(figuresByBlock.get(index) || [])]);
  const bytes=await generatePdf({title:$('meta-title').value,author:$('meta-author').value,date:$('meta-date').value,publisher:$('meta-publisher').value,sourceUrl:documentData.source,blocks:orderedBlocks});
  if(pdfUrl) URL.revokeObjectURL(pdfUrl); pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})); $('pdf-preview').src=pdfUrl; $('download').href=pdfUrl;
  const filename = [$('meta-title').value, $('meta-author').value]
    .map(value => value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, ''));
  const [title, author] = filename;
  $('download').download = ([title || 'Reading Room', author].filter(Boolean).join(' - ').slice(0, 100).trim()) + '.pdf'; $('review-status').textContent = ''; show('result');
} catch(error) { $('review-status').classList.add('error'); $('review-status').textContent=error.message; } finally { $('generate').disabled=false; } };
