import './style.css';
import { enrichRows, lookupInput, fillMissing } from './enrichment.js';
import { COLUMNS, FULL_NAME, mapHeader, normalizeTable, validateRows, exportCSV, reviewCSV } from './processor.js';
const $ = id => document.getElementById(id);
let sheets = [], rows = [], page = 0, generation = 0, signedIn = false, busy = false;
let enrichmentController = null;
function setEnriching(active) {
  $('lookup-loading').hidden=!active;
  $('review').setAttribute('aria-busy',String(active));
  if(active){
    $('review').hidden=true;
    $('lookup-progress').max=Math.max(1,rows.length);
    updateLoading({processed:0,filled:0});
  }
  $('cancel-enrichment').hidden=!active;
  $('process').disabled=active || !sheets.length;
  $('add-row').disabled=active;
  $('review-download').disabled=active;
}
function updateLoading(progress) {
  $('lookup-progress').value=progress.processed;
  $('lookup-progress-text').textContent=`${progress.processed} of ${rows.length} rows processed · ${progress.filled} fields filled`;
  $('lookup-loading-note').textContent=progress.waiting
    ? 'The lookup service is busy. Retrying in about a minute; your progress is saved.'
    : 'Finding missing business details may take some time. Keep this page open; your completed table will appear when the lookups finish.';
}

function element(tag, content, className) { const el=document.createElement(tag); if(content!==undefined) el.textContent=content; if(className) el.className=className; return el; }
function message(text='') { $('message').textContent=text; }
function clearReview() { enrichmentController?.abort();enrichmentController=null;setEnriching(false);rows=[]; page=0; $('review').hidden=true; $('suggestions').hidden=true; $('suggestions').replaceChildren(); $('table').replaceChildren(); }
function reset() { generation++; sheets=[]; clearReview(); $('files').value=''; $('source-preview').replaceChildren(); $('process').disabled=true; }
function authView(value) { signedIn=value; $('login').hidden=value; $('workspace').hidden=!value; $('logout').hidden=!value; if(!value) reset(); }
async function api(path, options={}) {
  const response=await fetch(`/.netlify/functions/${path}`,{credentials:'same-origin',...options});
  let data;
  try { data=await response.json(); } catch {
    const error=new Error(response.status===429?'Too many requests. Waiting before retrying.':'The server is unavailable.');error.status=response.status;throw error;
  }
  if(response.status===401) authView(false);
  if(!response.ok) {const error=new Error(data.error || (response.status===429?'Too many requests. Wait a minute and retry.':'Request failed.'));error.status=response.status;throw error;}
  return data;
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault(); $('login-button').disabled=true; message('');
  try { await api('session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})}); $('password').value=''; authView(true); }
  catch(error){message(error.message);} finally{$('login-button').disabled=false;}
});
$('logout').addEventListener('click',async()=>{
  try {await api('session',{method:'DELETE'});authView(false);message('Signed out. Files have been cleared.');}
  catch(error){authView(false);message(`Files cleared. Sign-out could not be confirmed: ${error.message}`);}
});
function loadFile(file) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./import-worker.js',import.meta.url),{type:'module'});
    const timeout=setTimeout(()=>{worker.terminate();reject(new Error('File parsing took too long. Split the workbook into smaller files.'));},30000);
    const finish=()=>{clearTimeout(timeout);worker.terminate();};
    worker.onmessage=event=>{finish();event.data.error?reject(new Error(event.data.error)):resolve(event.data.sheets);};
    worker.onerror=()=>{finish();reject(new Error('Unable to parse the file. Check the format and size.'));};
    file.arrayBuffer().then(buffer=>worker.postMessage({name:file.name,buffer},[buffer])).catch(error=>{finish();reject(error);});
  });
}
$('files').addEventListener('change',async()=>{
  const current=++generation;clearReview();sheets=[];$('source-preview').replaceChildren();delete $('source-preview').dataset.sheet;$('process').disabled=true;message('Reading files…');
  const files=[...$('files').files];
  if(!files.length){message('');return;}
  if(files.length>20 || files.reduce((n,f)=>n+f.size,0)>20*1024*1024){message('Use at most 20 files and 20 MB per batch.');return;}
  try {
    const loaded=[];
    for(const file of files){loaded.push(...await loadFile(file));if(current!==generation)return;}
    if(loaded.reduce((n,s)=>n+s.table.length-1,0)>10000)throw new Error('Split this batch into 10,000 rows or fewer.');
    sheets=loaded.map(sheet=>({...sheet,selected:true,mapping:sheet.table[0].map(mapHeader)}));
    renderSourcePreview();$('process').disabled=false;message('Files loaded. Review and edit your uploaded tables before combining.');
  } catch(error){if(current===generation)message(error.message);}
});
function renderSourcePreview(){
  const panel=$('source-preview');panel.replaceChildren();
  if(!sheets.length)return;
  const heading=element('h2','Uploaded table · review & edit');panel.append(heading);
  panel.append(element('p','Edit cells directly. You can also rename a header if it needs correction. Your edits will be used when you combine the files.','hint'));
  const controls=element('div',undefined,'toolbar');
  const label=element('label','File or worksheet ');const select=element('select');select.setAttribute('aria-label','Uploaded file or worksheet');
  sheets.forEach((sheet,i)=>{const option=element('option',`${sheet.name} · ${sheet.table.length-1} rows`);option.value=String(i);select.append(option);});
  const selectedIndex=Math.min(Number(panel.dataset.sheet || 0),sheets.length-1);select.value=String(selectedIndex);
  select.addEventListener('change',()=>{panel.dataset.sheet=select.value;renderSourcePreview();});label.append(select);controls.append(label);
  const sheet=sheets[selectedIndex];
  const includeLabel=element('label');const include=element('input');include.type='checkbox';include.checked=sheet.selected;
  include.addEventListener('change',()=>{sheet.selected=include.checked;clearReview();});includeLabel.append(include,document.createTextNode(' Include this sheet when combining'));controls.append(includeLabel);
  const add=element('button','Add row');add.addEventListener('click',()=>{
    if(sheets.reduce((n,item)=>n+item.table.length-1,0)>=10000){message('This batch already has 10,000 rows. Remove a row before adding another.');return;}
    sheet.table.push(Array(sheet.table[0].length).fill(''));sheet.previewPage=Math.floor((sheet.table.length-2)/50);clearReview();renderSourcePreview();
  });controls.append(add);panel.append(controls);
  const warning=element('p',undefined,'hint');
  const updateWarning=()=>{const names=sheet.table[0].filter((_,i)=>!sheet.mapping[i]);warning.textContent=names.length?`These columns are visible here but excluded from the CRM CSV: ${names.map(name=>name || '(blank header)').join(', ')}. Rename a header to a recognized CRM field to include it.`:'All uploaded columns are recognized for the CRM import.';};updateWarning();panel.append(warning);
  const wrap=element('div',undefined,'table-wrap source-table');const table=element('table');table.setAttribute('aria-label',`Uploaded table: ${sheet.name}`);
  const head=element('thead');const hr=element('tr');hr.append(element('th','Row'));
  sheet.table[0].forEach((header,col)=>{
    const th=element('th');const input=element('input');input.value=header;input.setAttribute('aria-label',`${sheet.name}, header ${col+1}`);
    input.addEventListener('input',()=>{sheet.table[0][col]=input.value;sheet.mapping[col]=mapHeader(input.value);clearReview();updateWarning();});th.append(input);hr.append(th);
  });head.append(hr);table.append(head);
  const count=sheet.table.length-1;const pages=Math.max(1,Math.ceil(count/50));sheet.previewPage=Math.min(Math.max(sheet.previewPage || 0,0),pages-1);
  const body=element('tbody');
  const start=sheet.previewPage*50+1;
  for(let index=start;index<Math.min(sheet.table.length,start+50);index++){
    const tr=element('tr');const meta=element('td');meta.append(element('strong',String(index)));
    const remove=element('button','Remove');remove.setAttribute('aria-label',`${sheet.name}, remove row ${index}`);remove.addEventListener('click',()=>{sheet.table.splice(index,1);clearReview();renderSourcePreview();});meta.append(remove);tr.append(meta);
    sheet.table[0].forEach((header,col)=>{
      const td=element('td');const input=element('input');input.value=sheet.table[index][col] ?? '';input.setAttribute('aria-label',`${sheet.name}, row ${index}, column ${col+1}: ${header}`);
      input.addEventListener('input',()=>{sheet.table[index][col]=input.value;clearReview();});td.append(input);tr.append(td);
    });body.append(tr);
  }
  table.append(body);wrap.append(table);panel.append(wrap);
  const pagination=element('div',undefined,'pagination');const prev=element('button','← Previous');const next=element('button','Next →');prev.disabled=sheet.previewPage===0;next.disabled=sheet.previewPage>=pages-1;
  prev.addEventListener('click',()=>{sheet.previewPage--;renderSourcePreview();});next.addEventListener('click',()=>{sheet.previewPage++;renderSourcePreview();});
  pagination.append(prev,element('span',`Page ${sheet.previewPage+1} of ${pages} · ${count} rows`),next);panel.append(pagination);
}
$('cancel-enrichment').addEventListener('click',()=>enrichmentController?.abort());
$('process').addEventListener('click',async()=>{
  if(busy || enrichmentController)return;
  clearReview();
  const selected=sheets.filter(sheet=>sheet.selected);
  if(!selected.length || selected.some(sheet=>!sheet.mapping.some(Boolean))){message('Include at least one sheet and give at least one column a recognized header in each included sheet.');return;}
  rows=selected.flatMap(sheet=>normalizeTable(sheet.table,sheet.mapping,sheet.name));
  const batch=rows;
  const controller=new AbortController();enrichmentController=controller;
  setEnriching(true);page=0;renderRows();message('');
  try {
    const result=await enrichRows(batch,(input,signal)=>api('lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal}),{
      signal:controller.signal,
      onProgress:progress=>{if(enrichmentController===controller)updateLoading(progress);}
    });
    if(enrichmentController!==controller || rows!==batch)return;
    enrichmentController=null;setEnriching(false);renderRows();
    const summary=`${result.cancelled?'Lookup stopped':'Combined'}: ${batch.length} rows · ${result.filled} fields filled · ${result.review} need match review · ${result.failed} lookups unavailable. Missing values remain blank.`;
    if(!result.cancelled && batch.length){
      download(exportCSV(batch),'hubspot_ready_leads.csv');
      message(`${summary} Your CRM CSV is ready. If the download did not start, click Download CRM CSV.`);
    }else message(`${summary} Review the table and use Download CRM CSV when ready.`);
  }catch(error){if(enrichmentController===controller)message(`Could not finish lookups. Your combined rows are available for review. ${error.message}`);}
  finally {if(enrichmentController===controller){enrichmentController=null;setEnriching(false);renderRows();}}
});
function download(content,name){const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));const a=element('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').addEventListener('click',()=>{try{download(exportCSV(rows),'hubspot_ready_leads.csv');}catch(error){message(error.message);}});
$('review-download').addEventListener('click',()=>download(reviewCSV(rows),'lead_review_not_for_crm.csv'));
$('issues-only').addEventListener('change',()=>{page=0;renderRows();});
$('add-row').addEventListener('click',()=>{rows.push({values:Object.fromEntries(COLUMNS.map(key=>[key,key==='is doorpull'?'true':key==='State'?'AZ':''])),source:'Manually added',conflicts:[]});page=Math.floor((rows.length-1)/50);$('issues-only').checked=false;renderRows();});
$('prev').addEventListener('click',()=>{page--;renderRows();});$('next').addEventListener('click',()=>{page++;renderRows();});
function updateStats(validation){
  const errors=validation.filter(v=>v.errors.length).length;const duplicates=validation.filter(v=>v.duplicate).length;
  $('stats').textContent=`${rows.length} rows · ${errors} with review warnings · ${duplicates} possible duplicates`;
  $('download').disabled=!!enrichmentController || !rows.length;
}
function renderRows(){
  $('review').hidden=!!enrichmentController || !rows.length;
  if(enrichmentController || !rows.length)return;
  const validation=validateRows(rows);updateStats(validation);
  const indexes=rows.map((_,i)=>i).filter(i=>!$('issues-only').checked || validation[i].errors.length || validation[i].duplicate || ['review','failed'].includes(rows[i].enrichment?.status));
  page=Math.min(Math.max(page,0),Math.max(0,Math.ceil(indexes.length/50)-1));
  $('page-label').textContent=`Page ${page+1} of ${Math.max(1,Math.ceil(indexes.length/50))} · ${indexes.length} matching rows`;
  $('prev').disabled=page===0;$('next').disabled=(page+1)*50>=indexes.length;
  const table=$('table');table.replaceChildren();const head=element('thead');const hr=element('tr');
  for(const title of ['Row / review',...COLUMNS])hr.append(element('th',title));head.append(hr);table.append(head);const body=element('tbody');
  for(const index of indexes.slice(page*50,(page+1)*50)){
    const row=rows[index];const tr=element('tr');const meta=element('td');meta.append(element('strong',`Row ${index+1}`),element('div',row.source,'source'));
    const issues=element('div',undefined,'issues');
    const showIssues=()=>{const v=validateRows(rows)[index];issues.textContent=[...v.errors.map(e=>e.message),...(v.duplicate?[`Possible duplicate of row ${v.duplicate}. Review before export.`]:[])].join(' · ');};showIssues();meta.append(issues);
    if(row.domainSource)meta.append(element('div',row.domainSource,'source'));
    if(row.enrichment){
      meta.append(element('div',row.enrichment.message,'source'));
      const match=row.enrichment.candidate;
      if(match && /^https:\/\/(?:www\.)?google\.com\//.test(match.maps || '')){const link=element('a','Google Maps source');link.href=match.maps;link.target='_blank';link.rel='noopener noreferrer';meta.append(link);}
      for(const attribution of match?.attributions || [])meta.append(element('div',attribution.provider || '', 'source'));
    }
    const lookup=element('button','Find business details');lookup.disabled=busy || !!enrichmentController;lookup.addEventListener('click',()=>lookupRow(row));
    const remove=element('button','Remove');remove.disabled=!!enrichmentController;remove.addEventListener('click',()=>{rows.splice(index,1);$('suggestions').hidden=true;renderRows();});meta.append(lookup,remove);
    if(row.conflicts.length){const resolve=element('button','Accept displayed values');resolve.disabled=!!enrichmentController;resolve.addEventListener('click',()=>{row.conflicts=[];renderRows();});meta.append(resolve);}
    tr.append(meta);
    for(const column of COLUMNS){const td=element('td');const input=element('input');input.value=row.values[column];input.readOnly=column==='is doorpull' || column==='State' || !!enrichmentController;input.setAttribute('aria-label',`Row ${index+1}, ${column}`);input.setAttribute('aria-invalid',String(validation[index].errors.some(e=>e.field===column)));
      input.addEventListener('input',()=>{row.values[column]=input.value.trim();row.conflicts=row.conflicts.filter(c=>c.field!==column);const current=validateRows(rows);updateStats(current);showIssues();input.setAttribute('aria-invalid',String(current[index].errors.some(e=>e.field===column)));});td.append(input);tr.append(td);}
    body.append(tr);
  }table.append(body);
}
async function lookupRow(row){
  if(busy || enrichmentController)return;if(!lookupInput(row).company && !lookupInput(row).domain){message('Enter a business name or custom business domain before searching.');return;}
  busy=true;const current=generation;const snapshot=JSON.stringify(row.values);renderRows();message('Looking up business details…');$('suggestions').hidden=true;
  try {
    const data=await api('lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(lookupInput(row))});
    if(!signedIn || generation!==current || !rows.includes(row))return;
    const panel=$('suggestions');panel.replaceChildren(element('h2',`Business matches for ${row.values['company name'] || lookupInput(row).domain}`),element('p','Check the business and location carefully. Accepting a match fills empty fields only. The phone is a business number, not a verified personal contact number.'));
    for(const candidate of data.candidates){
      const card=element('div',undefined,'candidate');card.append(element('strong',candidate.name),element('p',candidate.address));
      for(const [key,value] of Object.entries(candidate.values))if(value)card.append(element('p',`${key}: ${value}`));
      if(/^https:\/\/(?:www\.)?google\.com\//.test(candidate.maps)){const link=element('a','View on Google Maps');link.href=candidate.maps;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}
      for(const attribution of candidate.attributions || [])card.append(element('p',attribution.provider || ''));
      const accept=element('button','Use this business · fill empty fields');accept.addEventListener('click',()=>{
        if(!rows.includes(row)||JSON.stringify(row.values)!==snapshot){message('This row changed after the search. Search again to confirm the latest details.');panel.hidden=true;return;}
        fillMissing(row,candidate);row.enrichment={status:'matched',message:`Google Maps: ${candidate.name}; manually confirmed.`,candidate};
        panel.hidden=true;renderRows();message('Business details added. Review the completed row before exporting.');
      });card.append(element('br'),accept);panel.append(card);
    }
    panel.append(element('p','Business results provided by Google Maps.'));panel.hidden=false;
    message(data.candidates.length?'Review the business matches below the table.':'No business matches found. Enter missing information manually.');panel.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){message(error.message);}finally{busy=false;renderRows();}
}
try{const data=await api('session');authView(data.authenticated);}catch(error){authView(false);message(error.message);}
