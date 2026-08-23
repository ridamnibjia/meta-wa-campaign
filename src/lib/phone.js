'use strict';

// Meta requires numbers without a + prefix, e.g. 919000000001 for Indian numbers.
// Anything already carrying a country code passes through untouched — which is
// why CSV-FORMAT.md tells people to always include one. The bare-10-digit branch
// below has to guess a country, and it guesses India.
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

// RFC 4180 fields. Splitting on a bare comma was wrong in a way that never
// announced itself: a quoted name like "Doe, John" shifted every column to its
// right, the phone index landed on a name fragment, and the row was dropped
// with no error anywhere. A quoted field may contain commas, and a doubled
// quote inside one is a literal quote.
function splitCsvLine(line) {
  const out = [];
  let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (line[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',')   { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out.map(f => f.trim());
}

// Google Contacts has emitted "Phone 1 - Value" for years; older exports said
// "Mobile Phone", and other tools say "Home Phone" or just "Phone". Rather than
// name every variant, take every column whose header mentions a phone at all,
// in the order they appear. `seen` keeps the same person from being messaged
// twice when two of those columns hold the same number.
//
// Deliberately NOT matched: anything merely called a "number". An account or
// membership number is often 11 digits, which normalizePhone would accept — and
// the failure mode is messaging a stranger, not dropping a row.
const isPhoneHeader = h => /phone|mobile/i.test(h);

// Returns the skipped rows as well as the contacts. A row that yields no usable
// number is the operator's problem to see, not ours to swallow: uploading 500
// rows and being told "480 contacts" with no mention of the other 20 is how a
// broken export goes unnoticed for a whole campaign.
//
// ponytail: no multi-line quoted fields. A newline inside a quoted cell is legal
// RFC 4180 and no contact export this app has seen produces one; add a proper
// tokenizer the day one does.
function parseCSV(buffer) {
  const lines = buffer.toString('utf8').split('\n')
    .map(l => l.replace(/\r$/, '')).filter(l => l.trim());
  // The same three keys as the normal return: the route destructures all of
  // them, and an empty file that omits `duplicates` threw a TypeError AFTER a
  // fresh empty run had already been staged and made current.
  if (!lines.length) return { contacts: [], skipped: [], duplicates: [] };

  const hdr    = splitCsvLine(lines[0]);
  const firstI = hdr.findIndex(h => /^first.?name/i.test(h));
  const lastI  = hdr.findIndex(h => /^last.?name/i.test(h));
  const nameI  = hdr.findIndex(h => /name/i.test(h));
  const phoneCols = hdr.map((h, i) => (isPhoneHeader(h) ? i : -1)).filter(i => i >= 0);

  // Every column that is not a name and not a phone, kept verbatim under its own
  // header. Nothing reads these yet — contacts.fields_json just stores them, so
  // a later phase that wants "{{2}} is their city" does not need a re-upload of
  // a file the operator may no longer have.
  const extraCols = hdr.map((h, i) => i)
    .filter(i => i !== firstI && i !== lastI && i !== nameI && !phoneCols.includes(i) && hdr[i]);

  // `seen` maps a normalized number to the row it first appeared on, so a
  // duplicate can be REPORTED rather than only dropped. Collapsing them is
  // right — messaging one person twice in one campaign is the worst outcome
  // here — but doing it in silence meant an operator uploaded 800 rows, was
  // told "775 contacts", and had no way to learn where the other 25 went. A
  // file that lost 25 rows to a broken export and one that lists 25 dealers
  // twice look identical from the outside, and only one of them is fine.
  const contacts = [], skipped = [], duplicates = [], seen = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = splitCsvLine(lines[i]);
    // A modern Google export splits the name across two columns; an older one
    // has a single column. Joining is what keeps "Asha Rao" from becoming "Asha".
    const name = (firstI >= 0
      ? [p[firstI], lastI >= 0 ? p[lastI] : ''].filter(Boolean).join(' ')
      : (nameI >= 0 ? p[nameI] : '')).trim() || 'Contact';

    const fields = {};
    for (const col of extraCols) if (p[col]) fields[hdr[col]] = p[col];

    let usable = false;
    for (const col of phoneCols) {
      const raw = p[col] || '';
      if (!raw) continue;
      const d = normalizePhone(raw);
      if (!d) continue;
      usable = true;                       // the row had a number; a duplicate
      if (seen.has(d)) {                   // is not a row that failed to parse
        duplicates.push({ row: i + 1, name, dialStr: d, firstRow: seen.get(d) });
        continue;
      }
      seen.set(d, i + 1);
      contacts.push({ name, phone: raw, dialStr: d, fields });
    }
    if (!usable) skipped.push({ row: i + 1, name, reason: 'no usable phone number in this row' });
  }
  return { contacts, skipped, duplicates };
}

// One CSV field on the way OUT, for the directory export. The name column is a
// trust boundary — a WhatsApp profile name arrives over the webhook unsanitised
// and can be anything a customer types — so two defences run before the
// ordinary RFC 4180 quoting:
//   · control characters (incl. CR/LF) become spaces: parseCSV above has no
//     multi-line quoted-field support (deliberately), so a newline in a name
//     would break the export's "re-upload as-is" promise for that row and the
//     rows after it;
//   · a leading = + - or @ gets Excel's apostrophe defusal — quoting alone does
//     not stop Excel evaluating '=HYPERLINK(...)' typed as a profile name and
//     exported onto the operator's machine.
function csvField(v) {
  const clean = String(v).replace(/[\u0000-\u001f]/g, ' ');
  const safe  = /^[=+\-@]/.test(clean) ? `'${clean}` : clean;
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

module.exports = { normalizePhone, parseCSV, splitCsvLine, csvField };
