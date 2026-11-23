import {extractText, extractUrl, extractFiles} from './extract.js?v=12';
import {generatePdf} from './pdf.js?v=14';
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
      row.append(original, label);
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
