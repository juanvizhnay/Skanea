import dns from 'dns/promises';

// Minimal set; you can expand with a curated list or pull from a package
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'sharklasers.com',
  'trashmail.com',
  'yopmail.com',
  '10minutemail.com',
  'getnada.com',
  'temp-mail.org',
  'tempmail.com',
]);

export function getEmailDomain(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  return email.slice(at + 1).toLowerCase();
}

export function isDisposableDomain(domain) {
  return DISPOSABLE_DOMAINS.has(domain);
}

export async function hasValidMx(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}


