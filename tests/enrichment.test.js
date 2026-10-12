import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTable, mapHeader, exportCSV, parseCSV, COLUMNS } from '../web/src/processor.js';
import { enrichRows, selectMatch } from '../web/src/enrichment.js';
const makeRows=(table)=>normalizeTable(table,table[0].map(mapHeader),'test');
const match=(name='Acme LLC',city='Phoenix')=>({name,maps:'https://www.google.com/maps/place/example',attributions:[],values:{city,State:'AZ',zip:'85001',address:'123 Main St','Company domain':'acme.example',phone:'602-555-0100'}});
const run=(rows,lookup,options={})=>enrichRows(rows,lookup,{wait:async()=>{},interval:0,...options});
test('combine enrichment fills missing business fields and exports exact schema without changing source values',async()=>{
  const rows=makeRows([['company','city','phone','email'],['Acme','Phoenix','602-555-9999','person@example.com']]);
  const result=await run(rows,async()=>({candidates:[match()]}));
  assert.equal(result.matched,1);assert.equal(result.filled,4);
  assert.equal(rows[0].values.phone,'602-555-9999');assert.equal(rows[0].values.email,'person@example.com');
  const csv=parseCSV(exportCSV(rows));assert.deepEqual(csv[0],COLUMNS);assert.equal(csv[1][COLUMNS.indexOf('zip')],'85001');assert.equal(csv[1][12],'true');
});
test('ambiguous candidates and contradictory locations remain blank and exportable',async()=>{
  for(const candidates of [[match(),match()],[match('Different business')],[match('Acme','Tucson')]]){
    const rows=makeRows([['company','city'],['Acme','Phoenix']]);await run(rows,async()=>({candidates}));
    assert.equal(rows[0].values.phone,'');assert.equal(rows[0].enrichment.status,'review');assert.ok(exportCSV(rows));
  }
  const [noLocation]=makeRows([['company'],['Acme']]);assert.equal(selectMatch(noLocation,[match()]),null);
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
test('failed lookups retain blanks and rows; missing configuration stops further requests',async()=>{
  const rows=makeRows([['company','city'],['Acme','Phoenix'],['Other','Mesa']]);let calls=0;
  const result=await run(rows,async()=>{calls++;throw Object.assign(new Error('Not configured'),{status:503});});
  assert.equal(calls,1);assert.equal(result.failed,2);assert.equal(rows[0].values.phone,'');assert.equal(parseCSV(exportCSV(rows)).length,3);
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
test('does not call API for complete rows or missing company names',async()=>{
  const rows=makeRows([COLUMNS,COLUMNS.map(key=>({'company name':'Acme',...match().values,'is doorpull':'true'}[key] || ''))]);
  rows.push(...makeRows([['email'],['a@example.com']]));let calls=0;
  await run(rows,async()=>{calls++;return {candidates:[]};});assert.equal(calls,0);assert.equal(rows[1].values['company name'],'');
});
