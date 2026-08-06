'use strict';
// What kind of trouble is this file? Answered from three signals, because each
// one alone is a lie waiting to happen:
//
//   mime      — a string the sender chose. Free to forge.
//   extension — a string the sender chose. Free to forge.
//   bytes     — what the file actually is. Forging these means actually being
//               the harmless thing, which is the point.
//
// The worst verdict wins. That is what catches invoice.pdf whose first two
// bytes are MZ, and it is why this file exists rather than a longer allowlist.
//
// Pure: no I/O, no requires. Everything here is testable without a database, a
// socket or a temp directory.

const TIERS = ['safe', 'ok', 'warn', 'block'];
const RANK  = Object.fromEntries(TIERS.map((t, i) => [t, i]));
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// WhatsApp voice notes arrive as "audio/ogg; codecs=opus" and browsers send
// "text/plain; charset=utf-8". Every table below holds bare types.
const bareMime = m => String(m || '').split(';')[0].trim().toLowerCase();

// ── Signal 1: the declared mime ────────────────────────────────────────────────
const MIME_TIER = new Map(Object.entries({
  'image/jpeg': 'safe', 'image/png': 'safe', 'image/webp': 'safe', 'image/gif': 'safe',
  'audio/aac': 'safe', 'audio/mpeg': 'safe', 'audio/mp4': 'safe', 'audio/ogg': 'safe',
  'audio/amr': 'safe', 'video/mp4': 'safe', 'video/3gpp': 'safe',

  'application/pdf': 'ok', 'text/plain': 'ok',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'ok',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'ok',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ok',
  'application/vnd.oasis.opendocument.text': 'ok',
  'application/vnd.oasis.opendocument.spreadsheet': 'ok',

  'application/zip': 'warn', 'application/x-zip-compressed': 'warn',
  'application/x-rar-compressed': 'warn', 'application/vnd.rar': 'warn',
  'application/x-7z-compressed': 'warn', 'application/gzip': 'warn',
  'application/x-gzip': 'warn', 'application/x-tar': 'warn',
  'text/csv': 'warn', 'application/rtf': 'warn', 'text/rtf': 'warn',
  'application/xml': 'warn', 'text/xml': 'warn',
  'application/msword': 'warn', 'application/vnd.ms-excel': 'warn',
  'application/vnd.ms-powerpoint': 'warn',
  'application/vnd.ms-word.document.macroenabled.12': 'warn',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'warn',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'warn',

  'text/html': 'block', 'application/xhtml+xml': 'block', 'image/svg+xml': 'block',
  'text/javascript': 'block', 'application/javascript': 'block',
  'application/x-msdownload': 'block', 'application/x-msdos-program': 'block',
  'application/x-executable': 'block', 'application/x-dosexec': 'block',
  'application/vnd.microsoft.portable-executable': 'block',
  'application/vnd.android.package-archive': 'block',
  'application/java-archive': 'block', 'application/x-sh': 'block',
  'application/x-apple-diskimage': 'block', 'application/x-iso9660-image': 'block',
}));

// ── Signal 2: the filename extension ───────────────────────────────────────────
// The `block` line is the one worth arguing about, and it is deliberately short
// on judgement: anything a double-click can execute, mount, or hand to a script
// host. Move an entry between lines to change the policy — nothing else in the
// app hard-codes an extension.
const EXT_TIER = new Map();
const put = (tier, list) => list.split(' ').forEach(e => EXT_TIER.set('.' + e, tier));
put('safe',  'jpg jpeg png webp gif mp3 m4a aac ogg oga opus amr mp4 3gp 3gpp mov wav');
put('ok',    'pdf txt docx xlsx pptx odt ods odp');
put('warn',  'zip rar 7z gz tgz tar bz2 xz csv rtf xml doc xls ppt docm xlsm pptm dotm xltm xlsb');
put('block', 'exe msi bat cmd com scr pif vbs vbe js jse mjs wsf wsh ps1 psm1 jar apk '
           + 'dmg pkg app lnk url iso img hta reg sh bash zsh msc cpl gadget scf '
           + 'html htm xhtml svg svgz mht mhtml chm jnlp');

// The one attacker-controlled string that reaches a filesystem path. Everything
// outside [a-z0-9] is dropped rather than escaped: a real extension has never
// needed a character outside it, so there is nothing to trade away.
function extOf(filename) {
  const s = String(filename == null ? '' : filename);
  const dot = s.lastIndexOf('.');
  if (dot < 0 || dot === s.length - 1) return '';
  const ext = s.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? '.' + ext : '';
}

// ── Signal 3: what the bytes actually are ──────────────────────────────────────
// Hand-rolled because the table is shorter than installing a package to hold
// it, and because every entry is one we can explain.
const at = (buf, off, sig) =>
  buf.length >= off + sig.length && buf.compare(sig, 0, sig.length, off, off + sig.length) === 0;
const B = a => (typeof a === 'string' ? Buffer.from(a, 'binary') : Buffer.from(a));

const MAGIC = [
  // Executables and things that host code
  ['exe',    0, B('MZ')],
  ['elf',    0, B([0x7f, 0x45, 0x4c, 0x46])],
  ['macho',  0, B([0xcf, 0xfa, 0xed, 0xfe])],
  ['macho',  0, B([0xca, 0xfe, 0xba, 0xbe])],
  ['script', 0, B('#!/')],
  // Containers
  ['zip',  0, B([0x50, 0x4b, 0x03, 0x04])],
  ['zip',  0, B([0x50, 0x4b, 0x05, 0x06])],   // empty archive
  ['rar',  0, B('Rar!\x1a\x07')],
  ['7z',   0, B([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ['gzip', 0, B([0x1f, 0x8b])],
  ['ole2', 0, B([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  // Documents
  ['pdf',  0, B('%PDF')],
  ['rtf',  0, B('{\\rtf')],
  // Images
  ['jpeg', 0, B([0xff, 0xd8, 0xff])],
  ['png',  0, B([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['gif',  0, B('GIF8')],
  ['webp', 8, B('WEBP')],
  // Audio / video. AMR is checked before `script` would ever see it because
  // "#!AMR" also starts with "#!", so it sits above nothing — the `script`
  // signature is "#!/" precisely so the two cannot collide.
  ['amr',  0, B('#!AMR')],
  ['ogg',  0, B('OggS')],
  ['mp3',  0, B('ID3')],
  ['mp3',  0, B([0xff, 0xfb])],
  ['wav',  8, B('WAVE')],
  ['mp4',  4, B('ftyp')],
];

// Markup is the reason this whole module exists, so it gets a looser test than
// a fixed signature: leading whitespace, a BOM, or an XML declaration before
// <svg is still markup, and a browser asked to render it will find the script
// tag either way.
const MARKUP = /^[\s﻿]*<\s*(!doctype|\?xml|html|svg|body|script|meta|iframe)\b/i;

function sniff(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  for (const [name, off, sig] of MAGIC) if (at(bytes, off, sig)) return name;
  if (MARKUP.test(bytes.subarray(0, 256).toString('latin1'))) return 'html';
  return null;
}

const SNIFF_TIER = {
  exe: 'block', elf: 'block', macho: 'block', script: 'block', html: 'block',
  rar: 'warn', '7z': 'warn', gzip: 'warn', ole2: 'warn', rtf: 'warn',
  pdf: 'ok',
  jpeg: 'safe', png: 'safe', gif: 'safe', webp: 'safe',
  ogg: 'safe', mp3: 'safe', wav: 'safe', amr: 'safe', mp4: 'safe',
  // zip is decided by the extension — see zipTier below.
};

// PK\x03\x04 is docx, xlsx, apk and jar alike. The bytes genuinely cannot tell
// them apart, so the extension breaks the tie. Neither signal is sufficient on
// its own, which is the entire argument for combining them.
const zipTier = ext => EXT_TIER.get(ext) === 'block' ? 'block'
  : ext === '.docx' || ext === '.xlsx' || ext === '.pptx' ? 'ok'
  : 'warn';

// ── The verdict ────────────────────────────────────────────────────────────────
function classify(input) {
  const src     = (input && typeof input === 'object') ? input : {};
  const mime    = bareMime(src.mime);
  const ext     = extOf(src.filename);
  const bytes   = Buffer.isBuffer(src.bytes) ? src.bytes : null;
  const sniffed = sniff(bytes);

  // A signal that is ABSENT contributes nothing; a signal that is PRESENT but
  // unrecognised votes `ok`. The difference matters more than it looks:
  // WhatsApp sends no filename at all for images, audio and video, so treating
  // "no extension" as a vote for `ok` would quietly stop every photo in the
  // product from ever previewing.
  const signals = [
    mime    ? (MIME_TIER.get(mime) || 'ok') : null,
    ext     ? (EXT_TIER.get(ext)   || 'ok') : null,
    sniffed ? (sniffed === 'zip' ? zipTier(ext) : (SNIFF_TIER[sniffed] || 'ok')) : null,
  ].filter(Boolean);

  let tier = signals.reduce(worst, 'safe');
  if (!signals.length) tier = 'ok';   // nothing known about it at all

  // `safe` is the only tier that renders in the operator's browser, so it is
  // the only one that requires positive evidence from all three signals. A
  // declared image/png whose bytes match nothing demotes to a download. The
  // cost is inline preview on exotic formats (HEIC, TIFF); the purchase is
  // that nothing renders inline on a customer's say-so.
  let reason = '';
  if (tier === 'safe' && SNIFF_TIER[sniffed] !== 'safe') {
    tier = 'ok';
    reason = bytes
      ? `The bytes do not look like ${mime || 'the declared type'}, so it downloads instead of previewing.`
      : 'Nothing was read from the file itself, so it downloads instead of previewing.';
  }

  if (!reason) {
    if (tier === 'block') {
      reason = SNIFF_TIER[sniffed] === 'block'
        ? `The file's own bytes identify it as ${sniffed} — a program, not a document.`
        : `${ext || mime || 'This type'} can run code on a computer that opens it.`;
    } else if (tier === 'warn') {
      reason = 'Archives and macro-capable documents are a common way to deliver malware.';
    } else if (tier === 'ok') {
      reason = 'Downloads as a file. Nothing about it is rendered by the dashboard.';
    } else {
      reason = 'Recognised media. Safe to preview.';
    }
  }

  return { tier, reason, sniffed };
}

module.exports = { TIERS, worst, classify, sniff, extOf, bareMime };
