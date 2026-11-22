import {extractText, extractUrl, extractFiles} from './extract.js?v=3';
import {generatePdf} from './pdf.js?v=3';
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
  e.preventDefault(); $('source-status').textContent = '';
  const url = $('source-url').value.trim(), text = $('source-text').value;
  if ([!!url, !!text.trim(), !!files.length].filter(Boolean).length !== 1) { $('source-status').textContent = 'Choose one source.'; return; }
  $('prepare').disabled = true;
  try {
    documentData = url ? await extractUrl(url, p => $('source-status').textContent = p) : files.length ? await extractFiles(files, p => $('source-status').textContent = p) : extractText(text);
    for (const field of ['title','author','date','publisher']) $('meta-'+field).value = documentData[field] || '';
    $('review-text').value = documentData.text; $('review-flags').textContent = documentData.warnings.join(' ');
    $('source-preview').replaceChildren();
    for (const page of documentData.pages) { if (page.image) { const img=document.createElement('img'); img.src=page.image; img.alt='Page '+page.number; $('source-preview').append(img); } else { const p=document.createElement('p'); p.textContent=page.text; $('source-preview').append(p); } }
    $('review-images').replaceChildren(); $('images-section').hidden=!documentData.images.length;
    documentData.images.forEach((image,index) => { const row=document.createElement('div'); const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=true; checkbox.dataset.index=index; const caption=document.createElement('input'); caption.value=image.caption; caption.placeholder='Caption'; row.append(checkbox,caption); $('review-images').append(row); });
    show('review');
  } catch (error) { $('source-status').textContent = error.message; } finally { $('prepare').disabled=false; }
});
$('back').onclick=()=>show('start'); $('edit').onclick=()=>show('review');
$('generate').onclick=async()=>{ $('generate').disabled=true; $('review-status').textContent='Generating PDF…'; try {
  const blocks=$('review-text').value.split(/\n\s*\n/).filter(Boolean).map(text=>({type:'paragraph',text}));
  for (const row of $('review-images').children) { const input=row.querySelector('input[type=checkbox]'); if(input.checked) blocks.push({type:'image',url:documentData.images[Number(input.dataset.index)].src,caption:row.querySelector('input:not([type=checkbox])').value}); }
  const bytes=await generatePdf({title:$('meta-title').value,author:$('meta-author').value,date:$('meta-date').value,publisher:$('meta-publisher').value,sourceUrl:documentData.source,blocks});
  if(pdfUrl) URL.revokeObjectURL(pdfUrl); pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})); $('pdf-preview').src=pdfUrl; $('download').href=pdfUrl; show('result');
} catch(error) { $('review-status').textContent=error.message; } finally { $('generate').disabled=false; } };
