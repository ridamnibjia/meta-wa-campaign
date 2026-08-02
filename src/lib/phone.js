'use strict';

// Meta requires numbers without a + prefix, e.g. 919000000001 for Indian numbers.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).trim().replace(/\D/g, '');
  if (!d || d.length < 7) return null;
  if (/^1(800|860|900)/.test(d)) return null;   // toll-free numbers
  if (d.length === 10)                  d = '91' + d;        // 10-digit Indian
  if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1); // 0xxxxxxxxxx
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

// Google Contacts exports work as-is: the header names vary but always contain
// "name" and "mobile"/"home". One contact can yield two rows (mobile + home);
// `seen` keeps the same person from being messaged twice on one number.
function parseCSV(buffer) {
  const lines = buffer.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const hdr   = lines[0].split(',');
  const nameI = hdr.findIndex(h => /first.?name|^name/i.test(h));
  const mobI  = hdr.findIndex(h => /mobile.?phone|mobile/i.test(h));
  const homeI = hdr.findIndex(h => /home.?phone|home/i.test(h));
  const out = [], seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const p    = lines[i].split(',');
    const name = (nameI >= 0 ? p[nameI] : '').replace(/"/g, '').trim() || 'Contact';
    for (const raw of [mobI >= 0 ? p[mobI] : '', homeI >= 0 ? p[homeI] : ''].filter(Boolean)) {
      const d = normalizePhone(raw.replace(/"/g, '').trim());
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push({ name, phone: raw.trim(), dialStr: d });
    }
  }
  return out;
}

module.exports = { normalizePhone, parseCSV };
