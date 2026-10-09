import './style.css';
import { COLUMNS, FULL_NAME, mapHeader, normalizeTable, validateRows, exportCSV, reviewCSV } from './processor.js';
const $ = id => document.getElementById(id);
let sheets = [], rows = [], page = 0, generation = 0, signedIn = false, busy = false;
const required = new Set();
function element(tag, content, className) { const el=document.createElement(tag); if(content!==undefined) el.textContent=content; if(className) el.className=className; return el; }
function message(text='') { $('message').textContent=text; }
function clearReview() { rows=[]; page=0; $('review').hidden=true; $('suggestions').hidden=true; $('suggestions').replaceChildren(); $('table').replaceChildren(); }
function reset() { generation++; sheets=[]; clearReview(); $('files').value=''; $('mappings').replaceChildren(); $('process').disabled=true; }
function authView(value) { signedIn=value; $('login').hidden=value; $('workspace').hidden=!value; $('logout').hidden=!value; if(!value) reset(); }
async function api(path, options={}) {
  const response=await fetch(`/.netlify/functions/${path}`,{credentials:'same-origin',...options});
  let data;
  try { data=await response.json(); } catch { throw new Error('The server is unavailable. Run with Netlify Dev locally, or use the deployed Netlify URL.'); }
  if(response.status===401) authView(false);
  if(!response.ok) throw new Error(data.error || (response.status===429?'Too many requests. Wait a minute and retry.':'Request failed.'));
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
for(const column of COLUMNS){
  const label=element('label'); const input=element('input');input.type='checkbox';
  input.addEventListener('change',()=>{input.checked?required.add(column):required.delete(column);renderRows();});
  label.append(input,document.createTextNode(column));$('required').append(label);
}
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
  const current=++generation;clearReview();sheets=[];$('mappings').replaceChildren();$('process').disabled=true;message('Reading files…');
  const files=[...$('files').files];
  if(!files.length){message('');return;}
  if(files.length>20 || files.reduce((n,f)=>n+f.size,0)>20*1024*1024){message('Use at most 20 files and 20 MB per batch.');return;}
  try {
    const loaded=[];
    for(const file of files){loaded.push(...await loadFile(file));if(current!==generation)return;}
    if(loaded.reduce((n,s)=>n+s.table.length-1,0)>10000)throw new Error('Split this batch into 10,000 rows or fewer.');
    sheets=loaded.map(sheet=>({...sheet,selected:true,mapping:sheet.table[0].map(mapHeader)}));
    renderMappings();$('process').disabled=false;message('Files loaded. Check the column mappings before combining. Unmapped columns will be excluded.');
  } catch(error){if(current===generation)message(error.message);}
});
function renderMappings(){
  $('mappings').replaceChildren();
  for(const sheet of sheets){
    const details=element('details',undefined,'mapping');details.open=true;
    const summary=element('summary',`${sheet.name} · ${sheet.table.length-1} rows`);details.append(summary);
    const include=element('label');const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=sheet.selected;
    checkbox.addEventListener('change',()=>{sheet.selected=checkbox.checked;clearReview();});include.append(checkbox,document.createTextNode(' Include this sheet'));details.append(include);
    const grid=element('div',undefined,'mapping-grid');
    sheet.table[0].forEach((header,i)=>{
      const label=element('label',`${i+1}. ${header || '(blank header)'}`);const select=element('select');select.setAttribute('aria-label',`${sheet.name}, column ${i+1}: ${header}`);
      for(const column of ['',...COLUMNS,FULL_NAME]){const option=element('option',column || 'Exclude this column');option.value=column;select.append(option);}
      select.value=sheet.mapping[i];label.classList.toggle('unmapped',!select.value);
      select.addEventListener('change',()=>{sheet.mapping[i]=select.value;label.classList.toggle('unmapped',!select.value);clearReview();});
      label.append(select);grid.append(label);
    });details.append(grid);$('mappings').append(details);
  }
}
$('default-state').addEventListener('input',clearReview);
$('process').addEventListener('click',()=>{
  clearReview();
  const selected=sheets.filter(sheet=>sheet.selected);
  if(!selected.length || selected.some(sheet=>!sheet.mapping.some(Boolean))){message('Select at least one sheet and map at least one column in each selected sheet.');return;}
  rows=selected.flatMap(sheet=>normalizeTable(sheet.table,sheet.mapping,sheet.name,{defaultState:$('default-state').value}));
  page=0;renderRows();message('Combined. Check required fields, review conflicts, and verify any business lookup suggestions.');
});
function download(content,name){const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));const a=element('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').addEventListener('click',()=>{try{download(exportCSV(rows,[...required]),'hubspot_ready_leads.csv');}catch(error){message(error.message);}});
$('review-download').addEventListener('click',()=>download(reviewCSV(rows),'lead_review_not_for_crm.csv'));
$('issues-only').addEventListener('change',()=>{page=0;renderRows();});
$('add-row').addEventListener('click',()=>{rows.push({values:Object.fromEntries(COLUMNS.map(key=>[key,key==='is doorpull'?'true':''])),source:'Manually added',conflicts:[]});page=Math.floor((rows.length-1)/50);$('issues-only').checked=false;renderRows();});
$('prev').addEventListener('click',()=>{page--;renderRows();});$('next').addEventListener('click',()=>{page++;renderRows();});
function updateStats(validation){
  const errors=validation.filter(v=>v.errors.length).length;const duplicates=validation.filter(v=>v.duplicate).length;
  $('stats').textContent=`${rows.length} rows · ${errors} with errors · ${duplicates} possible duplicates · ${required.size} required fields`;
  $('download').disabled=!rows.length || errors>0;
}
function renderRows(){
  $('review').hidden=!rows.length;if(!rows.length)return;
  const validation=validateRows(rows,[...required]);updateStats(validation);
  const indexes=rows.map((_,i)=>i).filter(i=>!$('issues-only').checked || validation[i].errors.length || validation[i].duplicate);
  page=Math.min(Math.max(page,0),Math.max(0,Math.ceil(indexes.length/50)-1));
  $('page-label').textContent=`Page ${page+1} of ${Math.max(1,Math.ceil(indexes.length/50))} · ${indexes.length} matching rows`;
  $('prev').disabled=page===0;$('next').disabled=(page+1)*50>=indexes.length;
  const table=$('table');table.replaceChildren();const head=element('thead');const hr=element('tr');
  for(const title of ['Row / review',...COLUMNS])hr.append(element('th',title));head.append(hr);table.append(head);const body=element('tbody');
  for(const index of indexes.slice(page*50,(page+1)*50)){
    const row=rows[index];const tr=element('tr');const meta=element('td');meta.append(element('strong',`Row ${index+1}`),element('div',row.source,'source'));
    const issues=element('div',undefined,'issues');
    const showIssues=()=>{const v=validateRows(rows,[...required])[index];issues.textContent=[...v.errors.map(e=>e.message),...(v.duplicate?[`Possible duplicate of row ${v.duplicate}. Review before export.`]:[])].join(' · ');};showIssues();meta.append(issues);
    const lookup=element('button','Find business details');lookup.disabled=busy;lookup.addEventListener('click',()=>lookupRow(row));
    const remove=element('button','Remove');remove.addEventListener('click',()=>{rows.splice(index,1);$('suggestions').hidden=true;renderRows();});meta.append(lookup,remove);
    if(row.conflicts.length){const resolve=element('button','Accept displayed values');resolve.addEventListener('click',()=>{row.conflicts=[];renderRows();});meta.append(resolve);}
    tr.append(meta);
    for(const column of COLUMNS){const td=element('td');const input=element('input');input.value=row.values[column];input.setAttribute('aria-label',`Row ${index+1}, ${column}`);input.setAttribute('aria-invalid',String(validation[index].errors.some(e=>e.field===column)));
      input.addEventListener('input',()=>{row.values[column]=input.value.trim();row.conflicts=row.conflicts.filter(c=>c.field!==column);const current=validateRows(rows,[...required]);updateStats(current);showIssues();input.setAttribute('aria-invalid',String(current[index].errors.some(e=>e.field===column)));});td.append(input);tr.append(td);}
    body.append(tr);
  }table.append(body);
}
async function lookupRow(row){
  if(busy)return;if(!row.values['company name']){message('Enter a company name before searching.');return;}
  busy=true;const current=generation;const snapshot=JSON.stringify(row.values);renderRows();message('Looking up business details…');$('suggestions').hidden=true;
  try {
    const data=await api('lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company:row.values['company name'],address:row.values.address,city:row.values.city,state:row.values.State,zip:row.values.zip})});
    if(!signedIn || generation!==current || !rows.includes(row))return;
    const panel=$('suggestions');panel.replaceChildren(element('h2',`Business matches for ${row.values['company name']}`),element('p','Check the business and location carefully. Accepting a match fills empty fields only. The phone is a business number, not a verified personal contact number.'));
    for(const candidate of data.candidates){
      const card=element('div',undefined,'candidate');card.append(element('strong',candidate.name),element('p',candidate.address));
      for(const [key,value] of Object.entries(candidate.values))if(value)card.append(element('p',`${key}: ${value}`));
      if(/^https:\/\/(?:www\.)?google\.com\//.test(candidate.maps)){const link=element('a','View on Google Maps');link.href=candidate.maps;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}
      for(const attribution of candidate.attributions || [])card.append(element('p',attribution.provider || ''));
      const accept=element('button','Use this business · fill empty fields');accept.addEventListener('click',()=>{
        if(!rows.includes(row)||JSON.stringify(row.values)!==snapshot){message('This row changed after the search. Search again to confirm the latest details.');panel.hidden=true;return;}
        for(const [key,value] of Object.entries(candidate.values))if(COLUMNS.includes(key)&&!row.values[key])row.values[key]=value;
        panel.hidden=true;renderRows();message('Business details added. Review the completed row before exporting.');
      });card.append(element('br'),accept);panel.append(card);
    }
    panel.append(element('p','Business results provided by Google Maps.'));panel.hidden=false;
    message(data.candidates.length?'Review the business matches below the table.':'No business matches found. Enter missing information manually.');panel.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){message(error.message);}finally{busy=false;renderRows();}
}
try{const data=await api('session');authView(data.authenticated);}catch(error){authView(false);message(error.message);}
