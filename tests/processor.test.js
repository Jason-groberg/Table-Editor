import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {COLUMNS,mapHeader,normalizeTable,parseCSV,validateRows,exportCSV,reviewCSV,domain} from '../web/src/processor.js';
import {readFile} from '../web/src/files.js';
const process = (table,options) => normalizeTable(table,table[0].map(mapHeader),'test',options);
test('preserves exact CRM schema and leading zeros from CSV',()=>{
  const rows=process(parseCSV('Account Name,Building zip code,Client\'s Phone number.\nAcme,02108,0123456789\n'));
  assert.equal(rows[0].values.zip,'02108'); assert.equal(rows[0].values.phone,'0123456789');
  assert.deepEqual(Object.keys(rows[0].values),COLUMNS);
});
test('keeps last name when no first name or full name is supplied',()=>assert.equal(process([['last name'],['Smith']])[0].values['last name'],'Smith'));
test('duplicate headers coalesce blanks and flag conflicting values',()=>{
  const rows=process([['company name','company name'],['','Acme'],['Alpha','Beta']]);
  assert.equal(rows[0].values['company name'],'Acme'); assert.equal(rows[1].conflicts.length,1);
  assert.equal(parseCSV(exportCSV(rows))[2][COLUMNS.indexOf('company name')],'Alpha');
});
test('full name fills only empty name fields; always sets State AZ and doorpull true',()=>{
  const [row]=process([["Client's Full name",'First name','State','is doorpull'],[' Jane   Smith ','Janet','CO','no']],{defaultState:'AZ'});
  assert.equal(row.values['First name'],'Janet'); assert.equal(row.values['last name'],'Smith');assert.equal(row.values.State,'AZ');assert.equal(row.values['is doorpull'],'true');
  assert.equal(process([['company'],['Acme']],{defaultState:'AZ'})[0].values.State,'AZ');
});
test('only doorpull is required; all missing contact and location values export blank',()=>{
  const rows=process([['company'],['Acme']]);
  assert.equal(validateRows(rows)[0].errors.length,0);
  const output=parseCSV(exportCSV(rows));
  for(const key of ['email','phone','address','city','zip','Company domain']) assert.equal(output[1][COLUMNS.indexOf(key)],'');
  assert.equal(output[1][COLUMNS.indexOf('is doorpull')],'true');
  rows[0].values['is doorpull']='';assert.equal(parseCSV(exportCSV(rows))[1][12],'true');assert.equal(output[1][5],'AZ');
});
test('conflicting imported doorpull values are replaced with the fixed true value',()=>{
  const rows=process([['company','is doorpull','doorpull'],['Acme','false','yes']]);
  assert.equal(rows[0].values['is doorpull'],'true');assert.deepEqual(rows[0].conflicts,[]);
});
test('formula-like values export blank while legitimate international phone survives',()=>{
  for(const value of ['=1+1',' +cmd','@SUM(A1)','-1+2','\t=cmd'])assert.equal(parseCSV(exportCSV(process([['company'],[value]])))[1][2],'');
  const rows=process([['company','phone'],['Acme','+1 (602) 555-0100']]);assert.ok(exportCSV(rows).includes('"+1 (602) 555-0100"'));assert.ok(reviewCSV(rows).includes("'+1"));
});
test('validates email, dates and domain; duplicate contact warning retains rows',()=>{
  const rows=process([['email','date added'],['a@example.com','2026-02-30'],['A@example.com','2026-10-09']]);
  const result=validateRows(rows);assert.ok(result[0].errors.length);assert.equal(result[1].duplicate,1);
  assert.equal(domain('https://www.Example.com/a'),'example.com');assert.equal(domain('javascript:alert(1)'),'');
});
test('CSV commas and newlines round trip without corrupting row boundaries',()=>{
  const rows=process([['company','address'],['A, Inc.','Line 1\nLine 2']]);const table=parseCSV(exportCSV(rows));assert.equal(table[1][2],'A, Inc.');assert.equal(table[1][3],'Line 1\nLine 2');
});
test('reads all worksheets and preserves formatted ZIPs and Excel dates',async()=>{
  const book=new ExcelJS.Workbook();const first=book.addWorksheet('First');first.addRow(['zip','date added']);first.addRow([2108,new Date('2026-10-09T00:00:00Z')]);first.getCell('A2').numFmt='00000';
  const second=book.addWorksheet('Second');second.addRow(['company']);second.addRow(['Other']);
  const buffer=await book.xlsx.writeBuffer();const sheets=await readFile('FILE.XLSX',buffer);
  assert.equal(sheets.length,2);assert.equal(sheets[0].table[1][0],'02108');assert.equal(sheets[0].table[1][1],'2026-10-09');
});
test('rejects formulas and data beyond CSV headers',async()=>{
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Leads');sheet.addRow(['company']);sheet.getCell('A2').value={formula:'1+1',result:2};
  await assert.rejects(readFile('leads.xlsx',await book.xlsx.writeBuffer()),/Formula/);
  await assert.rejects(readFile('leads.csv',Buffer.from('company\nAcme,hidden\n')),/beyond/);
});
test('converts US CSV dates without silently repairing invalid dates',()=>{
  const rows=process([['company','date added'],['Acme','8/18/2026'],['Other','2/30/2026'],['Third','2026-10-12']]);
  assert.equal(rows[0].values['Date of last door pull'],'2026-08-18');
  assert.equal(rows[1].values['Date of last door pull'],'2/30/2026');
  assert.equal(rows[2].values['Date of last door pull'],'2026-10-12');
  assert.equal(validateRows(rows)[0].errors.length,0);assert.ok(validateRows(rows)[1].errors.length);
});

test('export is available without edits and blanks invalid cells without changing the table',()=>{
  const rows=process([['company','email','date added','domain'],['Acme','invalid-email','2/30/2026','not a domain']]);
  const csv=parseCSV(exportCSV(rows));assert.equal(csv[1][9],'');assert.equal(csv[1][0],'');assert.equal(csv[1][10],'');assert.equal(csv[1][5],'AZ');
  assert.equal(rows[0].values.email,'invalid-email');assert.equal(rows[0].values['Date of last door pull'],'2/30/2026');
});
