'use strict';
const express = require('express');
const multer  = require('multer');
const { S, log, todayKey } = require('../state');
const { parseCSV, normalizePhone } = require('../lib/phone');
const contacts = require('../services/contacts');
const { startRun } = require('../services/messages');
const { saveCampaignNow } = require('../services/campaign');
const { broadcast } = require('../services/status');
const { rateFor, billableCount, estimateCost } = require('../lib/pricing');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload-csv', upload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'No file received' });
    const { contacts: parsed, skipped } = parseCSV(req.file.buffer);
    // The durable list is updated before the send queue, and the upsert
    // deliberately does not touch `enabled`: re-uploading a CSV must never
    // resurrect someone who opted out.
    const upload = contacts.upsertFromCsv(parsed, {
      filename: req.file.originalname || null, skippedCount: skipped.length,
    });
    S.contacts = parsed; S.currentIdx = 0; S.phase = 'idle';
    S.failed = S.skipped = 0; S.failLog = [];
    startRun(S.config.templateName);
    saveCampaignNow();
    log('info', `CSV loaded — ${parsed.length} contacts (${upload.newCount} new to this server)`);
    // Loudly, and at warn level. A row the parser could not read is a customer
    // who will not be messaged, and the operator is the only one who can tell
    // whether that is a blank line at the end of the file or a broken export.
    if (skipped.length) {
      log('warn', `CSV — ${skipped.length} row(s) had no usable phone number and were not loaded (rows ${skipped.slice(0, 10).map(s => s.row).join(', ')}${skipped.length > 10 ? '…' : ''})`);
    }
    broadcast();

    const rate     = rateFor(S.config.templateCategory);
    const billable = billableCount(parsed, contacts.isDisabled);
    res.json({
      ok: true, count: parsed.length, sample: parsed.slice(0, 5),
      skipped: skipped.length, skippedRows: skipped.slice(0, 20),
      newCount: upload.newCount,
      billable, estimate: estimateCost(billable, rate), rate,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// The SEND QUEUE — the last CSV, in the order the loop will walk it. `sent`
// marks the ones already past, `disabled` the ones that will be skipped.
// ponytail: whole list in one response; paginate if a CSV ever gets past ~50k.
router.get('/contacts', (req, res) => res.json({
  count: S.contacts.length,
  contacts: S.contacts.map((c, i) => {
    const row = contacts.getRow(c.dialStr);
    return {
      name: c.name, dialStr: c.dialStr, phone: c.phone,
      disabled: !!row && !row.enabled,
      disabledReason: row && !row.enabled ? row.disabled_reason : null,
      sent: i < S.currentIdx,
    };
  }),
}));

// The DIRECTORY — every contact this server has ever seen, whether or not they
// are in the current CSV. This is the list that survives an upload.
router.get('/contacts/directory', (req, res) => {
  const rows = req.query.disabled === '1' ? contacts.disabledRows() : contacts.list();
  res.json({
    counts: contacts.counts(),
    contacts: rows.map(r => ({
      phone: r.phone, name: r.name,
      enabled: !!r.enabled, disabledReason: r.disabled_reason, disabledAt: r.disabled_at,
      firstSeen: r.first_seen, lastMessaged: r.last_messaged,
    })),
  });
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
