import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { parseCSV, text } from './processor.js';
export const MAX_ROWS = 10000;
export const MAX_CELLS = 150000;
export function checkTable(table) {
  while (table.length && table[0].every(cell=>!text(cell))) table.shift();
  if (!table.length) throw new Error('The file or sheet is empty.');
  if (table.length > MAX_ROWS + 1 || table.some(row=>row.length > 100) || table.reduce((n,row)=>n+row.length,0) > MAX_CELLS) throw new Error('Split this sheet into smaller files (10,000 rows, 100 columns, 150,000 cells maximum).');
  const width = table[0].length;
  if (table.slice(1).some(row=>row.slice(width).some(value=>text(value)))) throw new Error('A data row has values beyond the header columns. Add the missing headers and retry.');
  return table;
}
export async function readFile(name, buffer) {
  if (buffer.byteLength > 10 * 1024 * 1024) throw new Error('Each file must be smaller than 10 MB.');
  if (/\.csv$/i.test(name)) {
    let source;
    try { source = new TextDecoder('utf-8',{fatal:true}).decode(buffer); } catch {throw new Error('Save the CSV as UTF-8 and try again.');}
    return [{name, table:checkTable(parseCSV(source))}];
  }
  if (!/\.xlsx$/i.test(name)) throw new Error('Use .csv or .xlsx files. Save older .xls files as .xlsx first.');
  let expanded = 0; let entries = 0;
  unzipSync(new Uint8Array(buffer), {filter:file=> {
    expanded += file.originalSize; entries++;
    if (expanded > 40 * 1024 * 1024 || entries > 2000) throw new Error('This Excel workbook is too large when expanded. Split it into smaller files.');
    return false;
  }});
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheets = [];
  for (const sheet of book.worksheets) {
    if (!sheet.actualRowCount) continue;
    if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > 100 || sheet.rowCount * sheet.columnCount > MAX_CELLS) throw new Error('This workbook exceeds the sheet size limits. Split it into smaller files.');
    const table = [];
    sheet.eachRow({includeEmpty:true}, row=> {
      const values = [];
      for (let col = 1; col <= sheet.columnCount; col++) {
        const cell = row.getCell(col);
        if (cell.type === ExcelJS.ValueType.Formula) throw new Error(`Formula in ${sheet.name}!${cell.address}. Paste formulas as values before importing.`);
        if (cell.type === ExcelJS.ValueType.Error) throw new Error(`Excel error in ${sheet.name}!${cell.address}. Correct it before importing.`);
        let value = cell.value;
        if (value instanceof Date) value = value.toISOString().slice(0,10);
        else if (typeof value === 'number' && /^0+$/.test(cell.numFmt)) value = String(value).padStart(cell.numFmt.length,'0');
        else if (value && typeof value === 'object') value = cell.text;
        values.push(text(value));
      }
      table.push(values);
    });
    if (table.some(row=>row.some(text))) sheets.push({name:`${name} / ${sheet.name}`,table:checkTable(table)});
  }
  if (!sheets.length) throw new Error('No nonempty worksheets found.');
  return sheets;
}
