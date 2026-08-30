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

// Excel's "Unicode CSV" and several CRM exports are UTF-16 with a BOM. Decoded
// as UTF-8 every character grows a NUL neighbour, no header check can match,
// and a thousand-row file loads zero contacts with nothing saying why. The BOM
// is the one reliable signal, so it picks the decoder; a plain UTF-8 BOM is
// stripped because it otherwise glues itself to the first header.
function decodeCsv(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Excel writes ";" between fields on every locale where "," is the decimal
// mark, and some tools emit tabs. Splitting a ";" file on "," yielded one field
// per line — and the digits of the WHOLE line, the name's included, then
// normalized into a plausible-looking wrong number, which is a message to a
// stranger rather than a dropped row. Counted on the header line only, outside
// quotes; comma wins ties because it is the format's own default.
function sniffDelimiter(text) {
  const eol  = text.indexOf('\n');
  const line = eol < 0 ? text : text.slice(0, eol);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c in counts) counts[c]++;
  }
  let best = ',';
  if (counts[';']  > counts[best]) best = ';';
  if (counts['\t'] > counts[best]) best = '\t';
  return best;
}

// The whole file in one pass, RFC 4180: a quoted field may contain the
// delimiter, doubled quotes, and NEWLINES. The old per-line splitter handled
// the first two and not the third — and the third is routine, because Google
// Contacts and most CRMs export Notes and Address columns with embedded
// newlines. A thousand-row file quietly parsed to two thirds of itself, the
// broken rows reported as "no usable phone number" when the real fault was the
// split, and the rows AFTER a broken one could shift a stray digit column into
// the phone slot.
function tokenizeCsv(text, delim) {
  const rows = [];
  let row = [], field = '', quoted = false, any = false;
  const endField = () => { row.push(field.trim()); field = ''; };
  const endRow = () => {
    if (any || field.trim()) { endField(); rows.push(row); }
    row = []; field = ''; any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === delim) { endField(); any = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  endRow();
  return rows;
}

// Google Contacts has emitted "Phone 1 - Value" for years; older exports said
// "Mobile Phone"; WhatsApp-first lists say "WhatsApp Number"; plenty of
// hand-made sheets say "Contact No". Take every column whose header names a
// phone, in the order they appear. `seen` in parseCSV keeps the same person
// from being messaged twice when two of those columns hold the same number.
//
// Deliberately NOT matched: a bare "Number". An account or membership number is
// often 11 digits, which normalizePhone would accept — and the failure mode is
// messaging a stranger, not dropping a row. A file whose only numbers live
// under such a header still loads, but through the value sniff in parseCSV,
// which runs only when NO header names a phone and is reported out loud.
const isPhoneHeader = h => /phone|mobile|whatsapp/i.test(h) || /contact\s*(no\b|num|#)/i.test(h);

// Returns the skipped rows as well as the contacts. A row that yields no usable
// number is the operator's problem to see, not ours to swallow: uploading 500
// rows and being told "480 contacts" with no mention of the other 20 is how a
// broken export goes unnoticed for a whole campaign.
//
// Also returned: `headers` (what the file actually called its columns, so a
// refusal can name them instead of shrugging) and `guessedPhone` (non-null when
// no header named a phone and the numbers were found by their VALUES — a guess
// the operator is told about, because the preview is where they can check it).
function parseCSV(buffer) {
  const text = decodeCsv(buffer);
  const rows = tokenizeCsv(text, sniffDelimiter(text));
  // The same keys as the normal return: the route destructures all of them, and
  // an empty file that omits `duplicates` threw a TypeError AFTER a fresh empty
  // run had already been staged and made current.
  if (!rows.length) return { contacts: [], skipped: [], duplicates: [], headers: [], guessedPhone: null };

  let hdr = rows[0];
  let start = 1;
  let guessedPhone = null;
  let phoneCols = hdr.map((h, i) => (isPhoneHeader(h) ? i : -1)).filter(i => i >= 0);

  if (!phoneCols.length) {
    // A "header" that itself dials is not a header. A bare list of numbers with
    // no header row is a file real people upload, and eating its first contact
    // as a header meant the whole file loaded nothing.
    if (hdr.some(c => normalizePhone(c))) { start = 0; hdr = []; }
    // No header names a phone, so find the column(s) that hold dialable VALUES:
    // ≥90% of the first fifty non-empty cells normalize. This is a guess about
    // which digits are phone numbers — hence `guessedPhone`, which the upload
    // route says out loud, because only the operator can check the preview.
    const sample = rows.slice(start, start + 50);
    const width  = Math.max(0, ...sample.map(r => r.length));
    for (let col = 0; col < width; col++) {
      let seen = 0, dials = 0;
      for (const r of sample) {
        const v = r[col];
        if (!v) continue;
        seen++;
        if (normalizePhone(v)) dials++;
      }
      if (seen > 0 && dials / seen >= 0.9) phoneCols.push(col);
    }
    if (phoneCols.length) {
      guessedPhone = start === 0
        ? 'their values — the file has no header row'
        : 'their values under ' + phoneCols.map(i => `"${hdr[i] || `column ${i + 1}`}"`).join(', ');
    }
  }

  const firstI = hdr.findIndex(h => /^first.?name/i.test(h));
  const lastI  = hdr.findIndex(h => /^last.?name/i.test(h));
  let   nameI  = hdr.findIndex(h => /name/i.test(h));
  // Headerless file: the first non-phone column with anything in it is the best
  // guess at a name, so a two-column "Asha,+91…" list reads naturally.
  if (start === 0 && nameI < 0 && rows[0]) {
    nameI = rows[0].findIndex((v, i) => v && !phoneCols.includes(i));
  }

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
  for (let i = start; i < rows.length; i++) {
    const p = rows[i];
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
  return { contacts, skipped, duplicates, headers: hdr, guessedPhone };
}

// One CSV field on the way OUT, for the directory export. The name column is a
// trust boundary — a WhatsApp profile name arrives over the webhook unsanitised
// and can be anything a customer types — so two defences run before the
// ordinary RFC 4180 quoting:
//   · control characters (incl. CR/LF) become spaces: a newline in a name
//     would otherwise turn one exported row into two on the way back in;
//   · a leading = + - or @ gets Excel's apostrophe defusal — quoting alone does
//     not stop Excel evaluating '=HYPERLINK(...)' typed as a profile name and
//     exported onto the operator's machine.
function csvField(v) {
  const clean = String(v).replace(/[\u0000-\u001f]/g, ' ');
  const safe  = /^[=+\-@]/.test(clean) ? `'${clean}` : clean;
  return /[",]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

module.exports = { normalizePhone, parseCSV, splitCsvLine, csvField };
