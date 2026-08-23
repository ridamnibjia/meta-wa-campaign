'use strict';
const express = require('express');
const multer  = require('multer');
const { S, log, todayKey } = require('../state');
const { parseCSV, normalizePhone, csvField } = require('../lib/phone');
const contacts = require('../services/contacts');
const { recipientsForRun, progressForRun } = require('../services/messages');
const { saveCampaignNow, stageRun, campaignBlocker } = require('../services/campaign');
const { broadcast } = require('../services/status');
const { rateFor, billableCount, estimateCost } = require('../lib/pricing');

const router = express.Router();
// memoryStorage with no ceiling is an unbounded allocation on a 2 GB VM that
// also holds the message store. 25 MB is roughly a 400k-row contact export —
// far past any list this app is built for, and small enough that a mistyped
// upload cannot take SQLite down with it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Same shape as routes/media.js: multer's own errors are translated here rather
// than left to Express's default handler, which answers a rejected upload with
// an HTML 500 the browser cannot turn into a sentence.
router.post('/upload-csv', (req, res, next) => {
  upload.single('csv')(req, res, err => {
    if (err) {
      return res.json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE'
        ? 'That CSV is over 25 MB. Split it, or remove the columns this app does not read.'
        : err.message });
    }
    next();
  });
}, (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'No file received' });
    // stageRun replaces the queue for a new run, so uploading over a live
    // campaign would orphan whoever it had not reached yet — including everyone
    // parked on the retry ladder. Writing a new template is fine; swapping the
    // list out from under a running send is not.
    const blocked = campaignBlocker();
    if (blocked) return res.json({ ok: false, error: blocked });
    const { contacts: parsed, skipped, duplicates } = parseCSV(req.file.buffer);
    // Refused BEFORE stageRun: staging replaces the queue and opens a new run,
    // and an empty file must not swap a real campaign's queue for nothing.
    if (!parsed.length) {
      return res.json({ ok: false, error: skipped.length
        ? `No usable contacts — all ${skipped.length} row(s) lacked a phone number this app can read. Check the column headers and country codes.`
        : 'That CSV is empty — nothing was loaded.' });
    }
    // The durable list is updated before the send queue, and the upsert
    // deliberately does not touch `enabled`: re-uploading a CSV must never
    // resurrect someone who opted out.
    const upload = contacts.upsertFromCsv(parsed, {
      filename: req.file.originalname || null, skippedCount: skipped.length,
    });
    S.phase = 'idle'; S.failLog = [];
    // The queue is staged now, not at /start: it is then durable from the moment
    // the operator has one, so a restart before sending begins loses nothing.
    stageRun(parsed);
    saveCampaignNow();
    log('info', `CSV loaded — ${parsed.length} contacts (${upload.newCount} new to this server)`);
    // Loudly, and at warn level. A row the parser could not read is a customer
    // who will not be messaged, and the operator is the only one who can tell
    // whether that is a blank line at the end of the file or a broken export.
    if (skipped.length) {
      log('warn', `CSV — ${skipped.length} row(s) had no usable phone number and were not loaded (rows ${skipped.slice(0, 10).map(s => s.row).join(', ')}${skipped.length > 10 ? '…' : ''})`);
    }
    // Said out loud for the same reason, and at the same level. Collapsing a
    // repeated number is right — messaging one person twice in one campaign is
    // the worst outcome available — but a file that lost rows to a broken export
    // and a file that simply lists a dealer twice are indistinguishable from the
    // count alone, and only one of them is fine.
    if (duplicates.length) {
      log('warn', `CSV — ${duplicates.length} row(s) repeated a number already in the file and were merged, so ${parsed.length} contacts will be messaged once each (rows ${duplicates.slice(0, 10).map(d => d.row).join(', ')}${duplicates.length > 10 ? '…' : ''})`);
    }
    broadcast();

    const rate     = rateFor(S.config.templateCategory);
    const billable = billableCount(parsed, contacts.isDisabled);
    res.json({
      ok: true, count: parsed.length, sample: parsed.slice(0, 5),
      skipped: skipped.length, skippedRows: skipped.slice(0, 20),
      duplicates: duplicates.length, duplicateRows: duplicates.slice(0, 20),
      newCount: upload.newCount,
      billable, estimate: estimateCost(billable, rate), rate,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Stage a run from the contacts already on this server, no CSV in hand. The
// directory is every number every upload has ever introduced, so "run it again
// on the same 830" stops requiring a file the operator may no longer have.
// Same guard, same staging and same shape of answer as /upload-csv — disabled
// contacts are staged as skipped rows exactly as a CSV stages them, so the
// funnel still reports who was left out and why.
router.post('/stage-contacts', (req, res) => {
  try {
    const blocked = campaignBlocker();
    if (blocked) return res.json({ ok: false, error: blocked });
    const parsed = contacts.list().map(r => ({ name: r.name, dialStr: r.phone }));
    if (!parsed.length) return res.json({ ok: false, error: 'No contacts on this server yet — upload a CSV first.' });
    S.phase = 'idle'; S.failLog = [];
    stageRun(parsed, `${S.config.templateName || 'campaign'} (server list)`);
    saveCampaignNow();
    log('info', `Campaign staged from the server's contact list — ${parsed.length} contacts`);
    broadcast();
    const rate     = rateFor(S.config.templateCategory);
    const billable = billableCount(parsed, contacts.isDisabled);
    res.json({
      ok: true, count: parsed.length, sample: parsed.slice(0, 5),
      billable, estimate: estimateCost(billable, rate), rate,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// The list back out, in the exact shape it went in — Name, Mobile Phone with
// the country code — so it can be re-uploaded as-is when the original file is
// gone. Disabled contacts are included on purpose: re-uploading never
// re-enables anyone (the upsert cannot touch `enabled`), and an export that
// silently dropped them would not be the list.
// UTF-8 BOM for the same reason the browser-built CSVs carry one: Excel on
// Windows decodes a BOM-less file as the system codepage and mangles names.
// csvField (lib/phone.js) defuses formula injection and strips control chars —
// the name is a customer-controlled string and this file opens in Excel.
router.get('/contacts/directory/export.csv', (req, res) => {
  const rows = contacts.list();
  const csv = '\ufeff' + ['Name,Mobile Phone',
    ...rows.map(r => `${csvField(r.name || r.phone)},+${r.phone}`)].join('\r\n') + '\r\n';
  res.setHeader('Content-Disposition', `attachment; filename="contacts-${todayKey()}.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

// The SEND QUEUE — the current run, in the order the loop walks it. Read from
// run_recipients rather than from memory, so it survives a restart and says
// exactly what happened to each person rather than only where the cursor got to.
// ponytail: whole list in one response; paginate if a CSV ever gets past ~50k.
router.get('/contacts', (req, res) => {
  const rows = recipientsForRun(S.currentRunId);
  res.json({
    count: rows.length,
    progress: progressForRun(S.currentRunId),
    contacts: rows.map(r => ({
      name: r.name, dialStr: r.phone, phone: r.phone,
      sent: !!r.wamid,
      disabled: r.skipped_reason === 'disabled',
      disabledReason: r.skipped_reason === 'disabled'
        ? (contacts.getRow(r.phone)?.disabled_reason || 'disabled') : null,
      skippedReason: r.skipped_reason,
      errorCode: r.error_code,
    })),
  });
});

// The DIRECTORY — every contact this server has ever seen, whether or not they
// are in the current CSV. This is the list that survives an upload.
//
// Searched and paged in SQL. It used to answer with every row: fine for the
// disabled list, and a several-megabyte response for a business with a real
// customer list. `disabled=1` still means the disabled page, because that is
// what the older Settings screen asks for.
const shape = r => ({
  phone: r.phone, name: r.name,
  enabled: !!r.enabled, disabledReason: r.disabled_reason, disabledAt: r.disabled_at,
  firstSeen: r.first_seen, lastMessaged: r.last_messaged,
});

router.get('/contacts/directory', (req, res) => {
  const size   = Math.min(200, Math.max(1, parseInt(req.query.size, 10) || 50));
  const pageNo = Math.max(1, parseInt(req.query.page, 10) || 1);
  const status = req.query.disabled === '1' ? 'disabled' : (req.query.status || 'all');
  const p = contacts.page({ q: req.query.q || '', status, limit: size, offset: (pageNo - 1) * size });
  res.json({
    counts: contacts.counts(),
    contacts: p.rows.map(shape),
    total: p.total, page: pageNo, size: p.limit, q: p.q, status: p.status,
    pages: Math.max(1, Math.ceil(p.total / p.limit)),
  });
});

// One row at a time. The name only — phone is the primary key every message,
// queue row and thread joins on, so a wrong number is a delete and a re-add.
router.patch('/contacts/directory/:phone', (req, res) => {
  const r = contacts.rename(req.params.phone, req.body?.name);
  if (!r.ok) return res.status(400).json(r);
  log('info', `Contacts — renamed +${r.contact.phone} to "${r.contact.name}"`);
  res.json({ ok: true, contact: shape(r.contact) });
});

// Removing a contact removes them from the customer list and from nothing else.
// An opt-out outlives the row it was recorded against — that is what the
// suppressed table is for — so a later CSV brings them back disabled.
router.delete('/contacts/directory/:phone', (req, res) => {
  const r = contacts.remove(req.params.phone);
  if (!r.ok) return res.status(400).json(r);
  log('info', `Contacts — deleted +${r.phone}${r.stillSuppressed ? ' (their opt-out is kept)' : ''}`);
  broadcast();
  res.json({ ok: true, counts: contacts.counts(), stillSuppressed: r.stillSuppressed });
});

// Manual edits. People phone up and ask to be put back on the list, and numbers
// arrive from outside WhatsApp (a reply, a shop visit) that must never be sent
// to. Re-enabling is always manual and always explicit — every automatic path
// into `disabled` is a reason to stay there.
router.post('/contacts/directory', (req, res) => {
  const off = [].concat(req.body.disable || []);
  const on  = [].concat(req.body.enable  || []);
  const disabled = off.filter(p => contacts.disable(p, 'manual'));
  const enabled  = on.filter(p => contacts.enable(p));
  const invalid  = [...off, ...on].filter(p => !normalizePhone(p));
  if (disabled.length) log('info', `Contacts — disabled ${disabled.length} by hand`);
  if (enabled.length)  log('warn', `Contacts — re-enabled ${enabled.join(', ')} by hand`);
  broadcast();
  res.json({ ok: true, counts: contacts.counts(), disabled: disabled.length, enabled: enabled.length, invalid });
});

// Still the disabled list, and still JSON: this is the file an operator hands to
// whoever asks "prove you stopped messaging them".
router.get('/contacts/directory/download', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="disabled-contacts-${todayKey()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(contacts.disabledRows().map(r => ({
    phone: r.phone, name: r.name, reason: r.disabled_reason,
    disabledAt: r.disabled_at ? new Date(r.disabled_at).toISOString() : null,
  })), null, 2));
});

module.exports = router;
