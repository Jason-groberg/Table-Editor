import { domain, text } from './processor.js';
const PERSONAL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','ymail.com','rocketmail.com','hotmail.com',
  'outlook.com','live.com','msn.com','aol.com','icloud.com','me.com','mac.com',
  'proton.me','protonmail.com','pm.me','tuta.com','tutanota.com','mail.com','gmx.com',
  'gmx.net','fastmail.com','hey.com','zoho.com','zohomail.com','yahoo.co.uk',
  'hotmail.co.uk','outlook.co.uk','cox.net','comcast.net','verizon.net','att.net',
  'sbcglobal.net','bellsouth.net','earthlink.net','centurylink.net','q.com','juno.com',
]);
export function emailBusinessDomain(email) {
  const value = text(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '';
  const host = domain(value.split('@')[1]);
  if (!host || [...PERSONAL_DOMAINS].some(provider => host===provider || host.endsWith(`.${provider}`))) return '';
  return host;
}
export function searchDomain(values) {
  return emailBusinessDomain(values.email) || domain(values['Company domain']);
}
export function buildSearchQuery(input) {
  const identifier = domain(input.domain) || text(input.company);
  if (!identifier) return '';
  const location = [text(input.address),text(input.city),text(input.zip)].filter(Boolean);
  return location.length ? [identifier,...location,'Arizona'].join(' ') : `${identifier} in Arizona`;
}
export function isArizona(candidate) {
  return ['az','arizona'].includes(text(candidate.values?.State).toLowerCase());
}
