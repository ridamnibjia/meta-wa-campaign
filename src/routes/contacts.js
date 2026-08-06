'use strict';
const express = require('express');
const multer  = require('multer');
const { S, log, todayKey } = require('../state');
const { parseCSV, normalizePhone } = require('../lib/phone');
const { optOuts, addOptOut, removeOptOut } = require('../services/optouts');
const { startRun } = require('../services/messages');
const { saveCampaignNow } = require('../services/campaign');
const { broadcast } = require('../services/status');
const { rateFor, billableCount, estimateCost } = require('../lib/pricing');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload-csv', upload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: 'No file received' });
    const contacts = parseCSV(req.file.buffer);
    S.contacts = contacts; S.currentIdx = 0; S.phase = 'idle';
    S.failed = S.skipped = 0; S.failLog = [];
    startRun(S.config.templateName);
    saveCampaignNow();
    log('info', `CSV loaded — ${contacts.length} contacts`);
    broadcast();

    const rate     = rateFor(S.config.templateCategory);
    const billable = billableCount(contacts, optOuts);
    res.json({
      ok: true, count: contacts.length, sample: contacts.slice(0, 5),
      billable, estimate: estimateCost(billable, rate), rate,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Full parsed contact list, exactly as the sender will walk it. `sent` marks the
// ones already past, `optedOut` the ones that will be skipped.
// ponytail: whole list in one response; paginate if a CSV ever gets past ~50k.
router.get('/contacts', (req, res) => res.json({
  count: S.contacts.length,
  contacts: S.contacts.map((c, i) => ({
    name: c.name, dialStr: c.dialStr, phone: c.phone,
    optedOut: optOuts.has(c.dialStr),
    sent: i < S.currentIdx,
  })),
}));

router.get('/optouts', (req, res) => res.json({ count: optOuts.size, numbers: [...optOuts] }));

// Manual edits. People phone up and ask to be put back on the list, and numbers
// arrive from outside WhatsApp (a reply, a shop visit) that must never be sent to.
router.post('/optouts', (req, res) => {
  const add    = [].concat(req.body.add    || []);
  const remove = [].concat(req.body.remove || []);
  const added   = add.filter(addOptOut);
  const removed = remove.filter(removeOptOut);
  const bad     = add.filter(p => !normalizePhone(p));
  if (added.length)   log('info', `Opt-out list — added ${added.length} by hand`);
  if (removed.length) log('warn', `Opt-out list — removed ${removed.join(', ')} by hand`);
  broadcast();
  res.json({ ok: true, count: optOuts.size, numbers: [...optOuts], added: added.length, removed: removed.length, invalid: bad });
});

router.get('/optouts/download', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="opt-outs-${todayKey()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify([...optOuts], null, 2));
});

module.exports = router;
