import Papa from 'papaparse';
export const COLUMNS = ['Date of last door pull', 'contact owner', 'company name', 'address', 'city', 'State', 'zip', 'First name', 'last name', 'email', 'Company domain', 'phone', 'is doorpull'];
export const FULL_NAME = "Client's Full name";
const aliases = {
  'Date of last door pull': ['date added', 'date of last door pull'],
  'contact owner': ['am sup', 'amsup', 'contact owner', 'owner', 'salesperson'],
  'company name': ['account name', 'company name', 'company', 'business name'],
  address: ['building address', 'address', 'street address'], city: ['building city', 'city'],
  zip: ['building zip code', 'building zip', 'zip', 'zip code', 'postal code'],
  email: ['clients email', 'client email', 'email', 'email address'],
  phone: ['clients phone number', 'client phone number', 'phone', 'phone number'],
  [FULL_NAME]: ['clients full name', 'client full name', 'full name', 'contact name'],
  'First name': ['first name', 'firstname'], 'last name': ['last name', 'lastname', 'surname'],
  'Company domain': ['company domain', 'domain', 'website', 'company website'],
  State: ['state', 'building state'], 'is doorpull': ['is doorpull', 'doorpull'],
};
export const text = value => value == null ? '' : String(value).trim();
export const normalizeHeader = value => text(value).toLowerCase().replace(/[.’']/g, '').replace(/[\s_-]+/g, ' ');
export function mapHeader(header) {
  const normalized = normalizeHeader(header);
  return Object.entries(aliases).find(([, names]) => names.includes(normalized))?.[0] || '';
}
export function domain(value) {
  const raw = text(value);
  if (!raw || /\s/.test(raw)) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : '';
  } catch { return ''; }
}
export function parseCSV(source) {
  const parsed = Papa.parse(source.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy', dynamicTyping: false });
  const errors = parsed.errors.filter(error => error.code !== 'UndetectableDelimiter');
  if (errors.length) throw new Error(`CSV cannot be read: ${errors[0].message}`);
  return parsed.data;
}
export function normalizeTable(table, mapping, source, options = {}) {
  return table.slice(1).flatMap((cells, index) => {
    if (cells.every(value => !text(value))) return [];
    const values = Object.fromEntries(COLUMNS.map(key => [key, '']));
    const conflicts = [];
    let fullName = '';
    cells.forEach((value, col) => {
      const key = mapping[col];
      const incoming = text(value);
      if (!key || !incoming) return;
      if (key === FULL_NAME) {
        if (fullName && fullName !== incoming) conflicts.push({field: key, values: [fullName, incoming]});
        else fullName = incoming;
      } else if (COLUMNS.includes(key)) {
        if (values[key] && values[key] !== incoming) conflicts.push({field: key, values: [values[key], incoming]});
        else values[key] = incoming;
      }
    });
    const [first = '', ...last] = fullName.split(/\s+/);
    values['First name'] ||= first;
    values['last name'] ||= last.join(' ');
    values.State ||= text(options.defaultState);
    values['is doorpull'] ||= 'true';
    const boolean = values['is doorpull'].toLowerCase();
    if (['true', 'yes', '1'].includes(boolean)) values['is doorpull'] = 'true';
    if (['false', 'no', '0'].includes(boolean)) values['is doorpull'] = 'false';
    if (domain(values['Company domain'])) values['Company domain'] = domain(values['Company domain']);
    return [{ values, source: `${source}, row ${index + 2}`, conflicts }];
  });
}
export function isFormula(value) {
  return /^[\s\u0000-\u001f]*[=+@-]/.test(String(value));
}
export function safePhone(value) { return /^\+?[\d ()-]+(?:\s*(?:x|ext\.?)\s*\d+)?$/i.test(value) && (value.match(/\d/g) || []).length >= 7; }
export function validateRows(rows, required = []) {
  const seen = new Map();
  return rows.map((row, index) => {
    const errors = [];
    for (const key of required) if (!text(row.values[key])) errors.push({ field: key, message: `${key} is required` });
    for (const key of COLUMNS) {
      const value = text(row.values[key]);
      if (isFormula(value) && !(key === 'phone' && safePhone(value))) errors.push({ field: key, message: `${key} starts with a spreadsheet formula character; correct it before export` });
    }
    const email = row.values.email;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({field:'email', message:'Email format is invalid'});
    if (row.values['Company domain'] && !domain(row.values['Company domain'])) errors.push({field:'Company domain', message:'Company domain is invalid'});
    if (row.values['is doorpull'] && !['true','false'].includes(row.values['is doorpull'])) errors.push({field:'is doorpull', message:'is doorpull must be true or false'});
    const date = row.values['Date of last door pull'];
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date)) errors.push({field:'Date of last door pull', message:'Use a valid YYYY-MM-DD date'});
    row.conflicts.forEach(conflict => errors.push({field: conflict.field, message: `Conflicting ${conflict.field}: ${conflict.values.join(' / ')}`}));
    const key = email ? `email:${email.toLowerCase()}` : `row:${JSON.stringify(COLUMNS.map(col=>row.values[col]))}`;
    const duplicate = seen.has(key) ? seen.get(key) + 1 : null;
    seen.set(key, index);
    return { errors, duplicate };
  });
}
export function exportCSV(rows, required = []) {
  if (!rows.length) throw new Error('There are no rows to export.');
  if (validateRows(rows, required).some(row => row.errors.length)) throw new Error('Resolve validation errors before exporting.');
  // Formula-like data is blocked above. A leading + in a legitimate telephone is
  // retained for the CRM; use the dedicated spreadsheet-safe review download in Excel.
  return '\uFEFF' + Papa.unparse({ fields: COLUMNS, data: rows.map(row => COLUMNS.map(col => row.values[col])) }, {newline:'\r\n', quotes:true});
}
export function reviewCSV(rows) {
  return '\uFEFF' + Papa.unparse({fields:COLUMNS, data:rows.map(row=>COLUMNS.map(key=>row.values[key]))}, {escapeFormulae:true, quotes:true});
}
