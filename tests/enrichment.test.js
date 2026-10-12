import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTable, mapHeader, exportCSV, parseCSV, COLUMNS } from '../web/src/processor.js';
import { enrichRows, selectMatch } from '../web/src/enrichment.js';
const makeRows=(table)=>normalizeTable(table,table[0].map(mapHeader),'test');
const match=(name='Acme LLC',city='Phoenix')=>({name,maps:'https://www.google.com/maps/place/example',attributions:[],values:{city,State:'AZ',zip:'85001',address:'123 Main St','Company domain':'acme.example',phone:'602-555-0100'}});
const run=(rows,lookup,options={})=>enrichRows(rows,lookup,{wait:async()=>{},interval:0,...options});
test('combine enrichment fills missing business fields and exports exact schema without changing source values',async()=>{
  const rows=makeRows([['company','city','phone','email'],['Acme','Phoenix','602-555-9999','person@acme.example']]);
  const result=await run(rows,async()=>({candidates:[match()]}));
  assert.equal(result.matched,1);assert.equal(result.filled,3);
  assert.equal(rows[0].values.phone,'602-555-9999');assert.equal(rows[0].values.email,'person@acme.example');
  const csv=parseCSV(exportCSV(rows));assert.deepEqual(csv[0],COLUMNS);assert.equal(csv[1][COLUMNS.indexOf('zip')],'85001');assert.equal(csv[1][12],'true');
});
test('ambiguous candidates and contradictory locations remain blank and exportable',async()=>{
  for(const candidates of [[match(),match()],[match('Different business')],[match('Acme','Tucson')]]){
    const rows=makeRows([['company','city'],['Acme','Phoenix']]);await run(rows,async()=>({candidates}));
    assert.equal(rows[0].values.phone,'');assert.equal(rows[0].enrichment.status,'review');assert.ok(exportCSV(rows));
  }
  const [noLocation]=makeRows([['company'],['Acme']]);assert.equal(selectMatch(noLocation,[match()]).name,'Acme LLC');
});
test('same company and location use one request but each row is enriched',async()=>{
  const rows=makeRows([['company','city'],['Acme','Phoenix'],['Acme','Phoenix']]);let calls=0;
  const result=await run(rows,async()=>{calls++;return {candidates:[match()]};});
  assert.equal(calls,1);assert.equal(result.matched,2);assert.equal(rows[1].values.zip,'85001');
});
test('lookup still runs when domain is present but other business fields are absent',async()=>{
  const rows=makeRows([['company','domain'],['Acme','acme.example']]);let calls=0;
  await run(rows,async()=>{calls++;return {candidates:[match()]};});assert.equal(calls,1);assert.equal(rows[0].values.phone,'602-555-0100');
});
test('missing configuration stops queued requests and retains all rows',async()=>{
  const rows=makeRows([['company','city'],...Array.from({length:10},(_,i)=>[`Business ${i}`,'Phoenix'])]);let calls=0;
  const result=await run(rows,async()=>{calls++;throw Object.assign(new Error('Not configured'),{status:503});});
  // Requests already in flight may finish; no further work is sent after failure.
  assert.ok(calls>=1 && calls<=4);assert.equal(result.failed,10);assert.equal(rows[0].values.phone,'');assert.equal(parseCSV(exportCSV(rows)).length,11);
});
test('temporary failure does not prevent later rows from completing',async()=>{
  const rows=makeRows([['company','city'],['Other','Mesa'],['Acme','Phoenix']]);
  await run(rows,async input=>{if(input.company==='Other')throw Object.assign(new Error('Unavailable'),{status:502});return {candidates:[match()]};});
  assert.equal(rows[0].values.phone,'');assert.equal(rows[1].values.phone,'602-555-0100');
});
test('rate limits retry once; cancellation prevents late results from changing rows',async()=>{
  const rows=makeRows([['company','city'],['Acme','Phoenix']]);let calls=0;const waits=[];
  await run(rows,async()=>{if(++calls===1)throw Object.assign(new Error('Rate limit'),{status:429});return {candidates:[match()]};},{wait:async ms=>waits.push(ms)});
  assert.equal(calls,2);assert.ok(waits.includes(61000));
  const cancelled=makeRows([['company','city'],['Acme','Phoenix']]);const controller=new AbortController();
  const result=await run(cancelled,async()=>{controller.abort();return {candidates:[match()]};},{signal:controller.signal});
  assert.equal(result.cancelled,true);assert.equal(cancelled[0].values.phone,'');
});
test('does not call API for complete rows or rows without a business identifier',async()=>{
  const rows=makeRows([COLUMNS,COLUMNS.map(key=>({'company name':'Acme',...match().values,'is doorpull':'true'}[key] || 'supplied'))]);
  rows.push(...makeRows([['email'],['a@gmail.com']]));let calls=0;
  await run(rows,async()=>{calls++;return {candidates:[]};});assert.equal(calls,0);assert.equal(rows[1].values['company name'],'');
});
test('custom email domain takes precedence over supplied domain and name',async()=>{
  const rows=makeRows([['company','email','domain','address'],['Other Name','owner@acme.example','other.example','123 Main St']]);let calls=0;
  await run(rows,async input=>{calls++;assert.equal(input.domain,'acme.example');assert.equal(input.address,'123 Main St');return {candidates:[match()]};});
  assert.equal(calls,1);assert.equal(rows[0].values.phone,'602-555-0100');assert.equal(rows[0].values['Company domain'],'other.example');
});
test('domain-only rows can find a business and fill its missing name',async()=>{
  const rows=makeRows([['email'],['owner@acme.example']]);let calls=0;
  await run(rows,async input=>{calls++;assert.equal(input.domain,'acme.example');return {candidates:[match()]};});
  assert.equal(calls,1);assert.equal(rows[0].values['company name'],'Acme LLC');assert.equal(rows[0].values['Company domain'],'acme.example');
});
test('missing domain alone triggers one lookup; missing email alone also triggers one lookup',async()=>{
  for(const missing of ['Company domain','email']){
    const values={'company name':'Acme',...match().values,'is doorpull':'true',email:'owner@gmail.com'};
    const rows=makeRows([COLUMNS,COLUMNS.map(key=>key===missing?'':values[key] || 'supplied')]);let calls=0;
    await run(rows,async()=>{calls++;return {candidates:[match()]};});assert.equal(calls,1);
    if(missing==='Company domain')assert.equal(rows[0].values[missing],'acme.example');else assert.equal(rows[0].values.email,'');
  }
});
test('name-only queries fill unique Arizona matches but reject out-of-state or ambiguous matches',async()=>{
  const rows=makeRows([['company'],['Acme']]);await run(rows,async()=>({candidates:[match()]}));assert.equal(rows[0].values.phone,'602-555-0100');
  const [row]=makeRows([['company'],['Acme']]);
  assert.equal(selectMatch(row,[{...match(),values:{...match().values,State:'CO'}}]),null);
  assert.equal(selectMatch(row,[match(),match()]),null);
});

test('uses at most four concurrent requests and preserves rows when results finish out of order',async()=>{
  const rows=makeRows([['company'],...Array.from({length:9},(_,i)=>[`Business ${i}`])]);
  let active=0,peak=0,calls=0;const pending=[];
  const work=run(rows,input=>new Promise(resolve=>{active++;calls++;peak=Math.max(peak,active);pending.push(()=>{active--;resolve({candidates:[match(input.company)]});});}));
  await new Promise(setImmediate);assert.equal(active,4);
  while(calls<9 || pending.length){while(pending.length)pending.pop()();await new Promise(setImmediate);}
  const result=await work;
  assert.equal(peak,4);assert.equal(calls,9);assert.equal(result.processed,9);
  rows.forEach((row,i)=>{assert.equal(row.values['company name'],`Business ${i}`);assert.equal(row.values.phone,'602-555-0100');});
});
test('concurrent duplicate queries share the same in-flight promise',async()=>{
  const rows=makeRows([['company'],...Array.from({length:8},()=>['Acme'])]);let calls=0,finish;
  const work=run(rows,()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  await new Promise(setImmediate);assert.equal(calls,1);finish({candidates:[match()]});
  const result=await work;assert.equal(calls,1);assert.equal(result.matched,8);
});
test('cancelling a concurrent batch blocks queued work and late updates',async()=>{
  const rows=makeRows([['company'],...Array.from({length:12},(_,i)=>[`Business ${i}`])]);
  const controller=new AbortController();let calls=0;const pending=[];
  const work=run(rows,input=>new Promise(resolve=>{calls++;pending.push(()=>resolve({candidates:[match(input.company)]}));}),{signal:controller.signal});
  await new Promise(setImmediate);assert.equal(calls,4);controller.abort();pending.forEach(finish=>finish());
  const result=await work;assert.equal(calls,4);assert.equal(result.cancelled,true);assert.equal(result.processed,0);assert.ok(rows.every(row=>!row.values.phone));
});
test('workers share request pacing rather than each sending their own burst',async()=>{
  const rows=makeRows([['company'],...Array.from({length:6},(_,i)=>[`Business ${i}`])]);const waits=[];
  await run(rows,async()=>({candidates:[]}),{interval:600,wait:async ms=>waits.push(ms)});
  assert.equal(waits.length,5);assert.ok(waits.every(ms=>ms>=0 && ms<=600));
});
test('different supplied names share a request when the preferred domain produces the same search',async()=>{
  const rows=makeRows([['company','email'],['Acme','a@acme.example'],['Acme LLC','b@acme.example']]);let calls=0;
  const result=await run(rows,async()=>{calls++;return {candidates:[match()]};});
  assert.equal(calls,1);assert.equal(result.matched,2);
});
test('copies custom email domain even when Google returns nothing or fails',async()=>{
  for(const lookup of [async()=>({candidates:[]}),async()=>{throw Object.assign(new Error('Unavailable'),{status:502});}]){
    const rows=makeRows([['company','email'],['Acme','person@acme.example']]);
    await run(rows,lookup);assert.equal(rows[0].values['Company domain'],'acme.example');assert.equal(rows[0].values.phone,'');assert.ok(rows[0].domainSource);
  }
  const rows=makeRows([['company','email','domain'],['Acme','a@acme.example','supplied.example']]);
  await run(rows,async()=>({candidates:[]}));assert.equal(rows[0].values['Company domain'],'supplied.example');
});
test('matches street abbreviations and source units without accepting a different building',()=>{
  const [row]=makeRows([['company','email','address','city','zip'],['Acme','a@acme.example','123 Main Street Suite 200','Phoenix','85001-1234']]);
  assert.equal(selectMatch(row,[match()]).name,'Acme LLC');
  const wrong={...match(),values:{...match().values,address:'124 Main St'}};
  assert.equal(selectMatch(row,[wrong]),null);
});
test('fills phone when Google omits website but business name and street confirm the branch',async()=>{
  const rows=makeRows([['company','email','address'],['Acme','a@acme.example','123 Main Street #200']]);
  const candidate={...match(),values:{...match().values,'Company domain':''}};
  await run(rows,async()=>({candidates:[candidate]}));assert.equal(rows[0].values.phone,'602-555-0100');assert.equal(rows[0].values['Company domain'],'acme.example');
  const [noAddress]=makeRows([['company','email'],['Acme','a@acme.example']]);assert.equal(selectMatch(noAddress,[candidate]),null);
});
test('accepts website subdomains but rejects unrelated domains at the same street',()=>{
  const [row]=makeRows([['company','email'],['Acme','a@acme.example']]);
  assert.equal(selectMatch(row,[{...match(),values:{...match().values,'Company domain':'locations.acme.example'}}]).name,'Acme LLC');
  assert.equal(selectMatch(row,[{...match('Different Company'),values:{...match().values,'Company domain':'unrelated.example'}}]),null);
});
