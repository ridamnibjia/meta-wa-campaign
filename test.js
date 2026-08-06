'use strict';
// Every DB-backed test runs against a private in-memory database. This must be
// set before ./server is required, because src/lib/db.js opens on import.
process.env.WA_DB_PATH = ':memory:';

// Uploads go to a throwaway directory for the same reason the database does:
// a test run must never write into the repo.
process.env.WA_UPLOAD_DIR = require('path').join(
  require('os').tmpdir(), `wa-uploads-${process.pid}-${Date.now()}`);

// Run: node test.js
// ponytail: no framework, no fixtures. Pure functions only — nothing here
// touches the network or the campaign loop.

const assert = require('node:assert/strict');
const {
  slugify, templateVars, sanitizeParam, validateTemplateInput,
  buildTemplatePayload, renderBody, normalizePhone, parseCSV, buildParams, verifySignature, explainError, tierToCap, META_ERRORS, S,
  warmupStep, warmupCap, effectiveCap, todayKey, WARMUP_PLAN, W,
  applyStatus, countsForRun, missingParams, resizeParamValues,
  rateFor, billableCount, estimateCost, spentCost, formatMoney,
  isWindowOpen, recordInbound, describeInbound, inboxSummary,
  markRead, inboxThread, sendReply,
  checkPassword, createSession, validSession, destroySession,
  PRICES,
  nodeVersionOk, openDb, SCHEMA,
  recordEnvelope, markEnvelopeProcessed, unprocessedWebhookCount,
  startRun, recordOutbound,
  buildState,
  migrateJsonToSql, db,
  MEDIA_KINDS, kindFor, saveUpload, listAssets, getAsset, assetPath,
  ensureHandle, ensureMediaId, MEDIA_ID_TTL_MS,
  saveCampaignNow, loadCampaign, resumeIfInterrupted, clearCampaignFile,
} = require('./server');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// The existing `test` helper is synchronous; an async assertion would resolve
// after the summary line printed and its failure would never be counted.
const pending = [];

// Async tests run one at a time. They mutate shared state — CFG fields, the
// single :memory: database, global.fetch — so a concurrent runner lets one
// test's cleanup land in the middle of another's request. Each fn() waits for
// the previous test's assertions AND cleanup to settle.
let chain = Promise.resolve();
const testAsync = (name, fn) => {
  const p = chain.then(() => fn())
    .then(() => { passed++; console.log(`  ok   ${name}`); })
    .catch(e => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; });
  chain = p;
  pending.push(p);
};

console.log('\nslugify');
test('lowercases and underscores spaces', () => assert.equal(slugify('Diwali Offer 2026'), 'diwali_offer_2026'));
test('strips illegal characters', () => assert.equal(slugify('50% off — now!'), '50_off_now'));
test('trims leading/trailing underscores', () => assert.equal(slugify('  hi  '), 'hi'));
test('never returns empty', () => assert.equal(slugify('!!!'), 'template'));
test('caps at 512 chars', () => assert.equal(slugify('a'.repeat(600)).length, 512));

console.log('\ntemplateVars');
test('finds a single variable', () => assert.deepEqual(templateVars('Hi {{1}}, welcome'), [1]));
test('finds and sorts multiple', () => assert.deepEqual(templateVars('{{2}} then {{1}}'), [1, 2]));
test('de-duplicates repeats', () => assert.deepEqual(templateVars('{{1}} and {{1}}'), [1]));
test('tolerates inner spaces', () => assert.deepEqual(templateVars('Hi {{ 1 }}'), [1]));
test('returns empty for plain text', () => assert.deepEqual(templateVars('no vars here'), []));

console.log('\nsanitizeParam');
test('collapses newlines', () => assert.equal(sanitizeParam('a\nb'), 'a b'));
test('collapses tabs', () => assert.equal(sanitizeParam('a\tb'), 'a b'));
test('collapses 4+ spaces', () => assert.equal(sanitizeParam('a     b'), 'a b'));
test('falls back on empty', () => assert.equal(sanitizeParam('   '), 'there'));
test('falls back on null', () => assert.equal(sanitizeParam(null), 'there'));
test('caps at 1024 chars', () => assert.equal(sanitizeParam('x'.repeat(2000)).length, 1024));

console.log('\nvalidateTemplateInput');
const ok = { displayName: 'Test', bodyText: 'Hi {{1}}, our range is live.', sampleValues: ['Rahul'] };
test('accepts a valid input', () => assert.deepEqual(validateTemplateInput(ok), []));
test('requires a name', () => assert.match(validateTemplateInput({ ...ok, displayName: '' })[0], /name is required/));
test('requires a body', () => assert.match(validateTemplateInput({ ...ok, bodyText: '' }).join(), /body is required/));
test('rejects a body over 1024 chars', () =>
  assert.match(validateTemplateInput({ ...ok, bodyText: 'x'.repeat(1100), sampleValues: [] }).join(), /max 1024/));
test('rejects gaps in variable numbering', () =>
  assert.match(validateTemplateInput({ ...ok, bodyText: 'Hi {{1}} and {{3}} here', sampleValues: ['a', 'b'] }).join(), /no gaps/));
test('rejects a body starting with a variable', () =>
  assert.match(validateTemplateInput({ ...ok, bodyText: '{{1}} welcome aboard' }).join(), /cannot start with a variable/));
test('rejects a body ending with a variable', () =>
  assert.match(validateTemplateInput({ ...ok, bodyText: 'Welcome aboard {{1}}' }).join(), /cannot end with a variable/));
test('requires a sample per variable', () =>
  assert.match(validateTemplateInput({ ...ok, sampleValues: [] }).join(), /sample value/));
test('rejects an over-length footer', () =>
  assert.match(validateTemplateInput({ ...ok, footerText: 'x'.repeat(70) }).join(), /max 60/));
test('rejects variables in the footer', () =>
  assert.match(validateTemplateInput({ ...ok, footerText: 'From {{1}}' }).join(), /Footer cannot contain variables/));
test('rejects an unknown category', () =>
  assert.match(validateTemplateInput({ ...ok, category: 'PROMO' }).join(), /Unknown category/));

console.log('\nbuildTemplatePayload');
test('includes the example block when variables exist', () => {
  const p = buildTemplatePayload(ok);
  assert.deepEqual(p.components[0].example, { body_text: [['Rahul']] });
});
test('omits the example block when there are none', () => {
  const p = buildTemplatePayload({ displayName: 'Flat', bodyText: 'Same text for all.' });
  assert.equal(p.components[0].example, undefined);
});
test('slugifies the name', () => assert.equal(buildTemplatePayload({ ...ok, displayName: 'My Promo!' }).name, 'my_promo'));
test('appends the footer when given', () => {
  const p = buildTemplatePayload({ ...ok, footerText: 'Mirror PVC' });
  assert.deepEqual(p.components[1], { type: 'FOOTER', text: 'Mirror PVC' });
});
test('appends the opt-out button when enabled', () => {
  const p = buildTemplatePayload({ ...ok, addOptOut: true });
  assert.equal(p.components.at(-1).buttons[0].text, 'Stop promotions');
});
test('omits buttons when opt-out is off', () => {
  const p = buildTemplatePayload({ ...ok, addOptOut: false });
  assert.equal(p.components.some(c => c.type === 'BUTTONS'), false);
});
test('defaults to MARKETING/en', () => {
  const p = buildTemplatePayload(ok);
  assert.equal(p.category, 'MARKETING');
  assert.equal(p.language, 'en');
});

console.log('\nbuildParams');
const slots = (...v) => { resizeParamValues(v.length); S.config.paramValues = v; };
test('returns nothing when the template has no variables', () => {
  slots();
  assert.deepEqual(buildParams({ name: 'Rahul' }), []);
});
test('maps a name slot to the contact name', () => {
  slots({ source: 'name', value: '' });
  assert.deepEqual(buildParams({ name: 'Rahul' }), [{ type: 'text', text: 'Rahul' }]);
});
test('sanitizes a multi-line name', () => {
  slots({ source: 'name', value: '' });
  assert.deepEqual(buildParams({ name: 'Ra\nhul' }), [{ type: 'text', text: 'Ra hul' }]);
});
test('falls back when the name is blank', () => {
  slots({ source: 'name', value: '' });
  assert.deepEqual(buildParams({ name: '' }), [{ type: 'text', text: 'there' }]);
});
test('a fixed slot sends the same value to everyone', () => {
  slots({ source: 'fixed', value: '12' });
  assert.deepEqual(buildParams({ name: 'Rahul' }), [{ type: 'text', text: '12' }]);
  assert.deepEqual(buildParams({ name: 'Priya' }), [{ type: 'text', text: '12' }]);
});
test('mixes a per-contact slot with fixed ones', () => {
  slots({ source: 'name', value: '' }, { source: 'fixed', value: '12' }, { source: 'fixed', value: '1 March' });
  assert.deepEqual(buildParams({ name: 'Rahul' }).map(p => p.text), ['Rahul', '12', '1 March']);
});
test('an unfilled fixed slot is reported, not silently sent', () => {
  slots({ source: 'name', value: '' }, { source: 'fixed', value: '  ' });
  assert.deepEqual(missingParams(), [2]);
});
test('a fully filled template reports nothing missing', () => {
  slots({ source: 'name', value: '' }, { source: 'fixed', value: '12' });
  assert.deepEqual(missingParams(), []);
});
test('resizing keeps values for slots that still exist', () => {
  slots({ source: 'fixed', value: '12' }, { source: 'fixed', value: '1 March' });
  resizeParamValues(1);
  assert.deepEqual(S.config.paramValues, [{ source: 'fixed', value: '12' }]);
});
test('growing adds fixed slots, defaulting only {{1}} to the contact name', () => {
  resizeParamValues(0); resizeParamValues(2);
  assert.deepEqual(S.config.paramValues.map(p => p.source), ['name', 'fixed']);
});
resizeParamValues(0);

console.log('\nrenderBody');
const p = t => ({ type: 'text', text: t });
test('substitutes positionally', () =>
  assert.equal(renderBody('Hi {{1}}, order {{2}}', [p('Sam'), p('A12')]), 'Hi Sam, order A12'));
test('tolerates inner spaces', () =>
  assert.equal(renderBody('Hi {{ 1 }}', [p('Sam')]), 'Hi Sam'));
test('repeats a variable used twice', () =>
  assert.equal(renderBody('{{1}} and {{1}}', [p('Sam')]), 'Sam and Sam'));
test('returns the body unchanged when it has no variables', () =>
  assert.equal(renderBody('Plain text', []), 'Plain text'));
// A missing param must stay visibly unresolved. Writing "undefined" into a
// customer thread would read as text we actually sent.
test('leaves an unsupplied slot as its literal placeholder', () =>
  assert.equal(renderBody('Hi {{1}}, order {{2}}', [p('Sam')]), 'Hi Sam, order {{2}}'));
test('returns null for a missing body so the caller can fall back', () => {
  assert.equal(renderBody(null, [p('Sam')]), null);
  assert.equal(renderBody('', [p('Sam')]), null);
  assert.equal(renderBody(undefined), null);
});

console.log('\ntemplate body capture');
test('startRun snapshots the active body and language onto the run', () => {
  const saved = { ...S.config };
  Object.assign(S.config, { templateBody: 'Hi {{1}}', templateLanguage: 'en_GB', headerAssetId: null });
  const id = startRun('promo_run');
  const row = db.prepare('SELECT label, template_body, template_lang FROM campaign_runs WHERE id = ?').get(id);
  Object.assign(S.config, saved);
  assert.equal(row.label,         'promo_run');
  assert.equal(row.template_body, 'Hi {{1}}');
  assert.equal(row.template_lang, 'en_GB');
});

test('a recorded send stores the rendered text, not the template name', () => {
  const wamid = `wamid.test.render.${Date.now()}`;
  const body  = renderBody('Hi {{1}}, our sale is live', [p('Asha')]);
  // A number no other test asserts on: recordOutbound stamps `at` with
  // Date.now(), so this row would otherwise become the preview of a shared
  // thread and break the inbox summary assertions further down.
  recordOutbound({ wamid, waId: '910000000009', name: 'Asha', body, runId: null });
  const row = db.prepare('SELECT body FROM messages WHERE wamid = ?').get(wamid);
  assert.equal(row.body, 'Hi Asha, our sale is live');
});

test('a run with no captured body falls back to the placeholder', () => {
  const saved = S.config.templateBody;
  S.config.templateBody = null;
  const text = renderBody(S.config.templateBody, [p('Asha')]) ?? `[template: ${S.config.templateName}]`;
  S.config.templateBody = saved;
  assert.match(text, /^\[template: /);
});

console.log('\nnormalizePhone');
test('prefixes a 10-digit Indian number', () => assert.equal(normalizePhone('9000000001'), '919000000001'));
test('strips a leading zero', () => assert.equal(normalizePhone('09000000001'), '919000000001'));
test('strips formatting characters', () => assert.equal(normalizePhone('+91 90000-00001'), '919000000001'));
test('rejects toll-free numbers', () => assert.equal(normalizePhone('18001234567'), null));
test('rejects numbers that are too short', () => assert.equal(normalizePhone('12345'), null));
test('rejects empty input', () => assert.equal(normalizePhone(''), null));

console.log('\nparseCSV');
test('reads name and mobile, and dedupes', () => {
  const csv = 'First Name,Mobile Phone\nRahul,9000000001\nPriya,9000000002\nDupe,+91 90000 00001\n';
  const out = parseCSV(Buffer.from(csv));
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Rahul');
  assert.equal(out[0].dialStr, '919000000001');
});
test('defaults a missing name to Contact', () => {
  const out = parseCSV(Buffer.from('First Name,Mobile Phone\n,9000000001\n'));
  assert.equal(out[0].name, 'Contact');
});

console.log('\nverifySignature');
{
  const secret = 'test_app_secret';
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
  const good = 'sha256=' + require('node:crypto').createHmac('sha256', secret).update(body).digest('hex');
  test('accepts a correctly signed body', () => assert.equal(verifySignature(body, good, secret), true));
  test('rejects a tampered body', () => assert.equal(verifySignature(Buffer.from('{"object":"evil"}'), good, secret), false));
  test('rejects a wrong secret', () => assert.equal(verifySignature(body, good, 'other_secret'), false));
  test('rejects a missing header', () => assert.equal(verifySignature(body, undefined, secret), false));
  test('rejects when no secret is configured', () => assert.equal(verifySignature(body, good, ''), false));
  test('rejects a short header without throwing', () => assert.equal(verifySignature(body, 'sha256=abc', secret), false));
}

console.log('\nexplainError');
test('explains a known send failure', () => assert.match(explainError(131042), /Billing not set up/));
test('includes an action, not just a label', () => assert.match(explainError(190), /Generate a fresh System User token/));
test('returns null for an unknown code', () => assert.equal(explainError(999999), null));
test('returns null for a missing code', () => assert.equal(explainError(undefined), null));
test('every entry has both a cause and an action', () => {
  for (const [code, v] of Object.entries(META_ERRORS)) {
    assert.equal(v.length, 2, `code ${code} is malformed`);
    assert.ok(v[0].length && v[1].length, `code ${code} has an empty field`);
  }
});

console.log('\ntierToCap');
test('expands the K suffix', () => assert.equal(tierToCap('TIER_1K'), 1000));
test('expands a larger K tier', () => assert.equal(tierToCap('TIER_100K'), 100000));
test('reads a plain numeric tier', () => assert.equal(tierToCap('TIER_250'), 250));
test('returns null for UNLIMITED so the UI keeps its default', () => assert.equal(tierToCap('TIER_UNLIMITED'), null));
test('returns null for UNKNOWN', () => assert.equal(tierToCap('UNKNOWN'), null));
test('returns null for undefined', () => assert.equal(tierToCap(undefined), null));

console.log('\nwarm-up ladder');
{
  const restore = { days: [...W.days], enabled: W.enabled, quality: S.quality, cap: S.config.dailyCap };
  const setup = (days, quality = 'GREEN') => { W.days = days; S.quality = quality; W.enabled = true; };

  test('day one starts at the bottom rung', () => { setup([]); assert.equal(warmupCap(), WARMUP_PLAN[0]); });
  test('a day already sent on keeps its own rung', () => {
    setup([todayKey()]);
    assert.equal(warmupStep(), 0, 'today is day 1, not day 2');
  });
  test('a fresh day climbs one rung', () => { setup(['2026-01-01']); assert.equal(warmupCap(), WARMUP_PLAN[1]); });
  test('climbs one rung per sending day', () => { setup(['a', 'b', 'c']); assert.equal(warmupCap(), WARMUP_PLAN[3]); });
  test('never climbs past the top rung', () => {
    setup(new Array(50).fill(0).map((_, i) => 'd' + i));
    assert.equal(warmupCap(), WARMUP_PLAN[WARMUP_PLAN.length - 1]);
  });
  test('holds a rung back while quality is RED', () => { setup(['a', 'b'], 'RED'); assert.equal(warmupCap(), WARMUP_PLAN[1]); });
  test('holds a rung back while quality is YELLOW', () => { setup(['a', 'b'], 'YELLOW'); assert.equal(warmupCap(), WARMUP_PLAN[1]); });
  test('cannot be held below the bottom rung', () => { setup([], 'RED'); assert.equal(warmupCap(), WARMUP_PLAN[0]); });
  test('disabling it lifts the ceiling entirely', () => { setup([]); W.enabled = false; assert.equal(warmupCap(), null); });

  test('effective cap takes the lower of warm-up and your own cap', () => {
    setup([]); S.config.dailyCap = 1000;
    assert.equal(effectiveCap(), WARMUP_PLAN[0], 'warm-up is lower on day 1');
  });
  test('your own cap wins when it is the stricter one', () => {
    setup(['a', 'b', 'c', 'd', 'e']); S.config.dailyCap = 300;
    assert.equal(effectiveCap(), 300);
  });
  test('warm-up off falls back to your own cap', () => {
    setup([]); W.enabled = false; S.config.dailyCap = 750;
    assert.equal(effectiveCap(), 750);
  });

  Object.assign(W, { days: restore.days, enabled: restore.enabled });
  S.quality = restore.quality; S.config.dailyCap = restore.cap;
}

console.log('\nstatus');
const { db: testDb } = require('./server');
const ensureRun = (runId) => {
  try {
    testDb.prepare('INSERT INTO campaign_runs (id, started_at) VALUES (?, ?)').run(runId, Date.now());
  } catch (e) {
    // already exists
  }
};
const seedOut = (wamid, waId = '911', runId = null, status = 'accepted') => {
  if (runId !== null) ensureRun(runId);
  testDb.prepare("INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at, status, run_id) VALUES (?,?, 'out','template','hi',1000,?,?)")
        .run(wamid, waId, status, runId);
};
const statusOf = wamid => testDb.prepare('SELECT status, error_code, error_title FROM messages WHERE wamid = ?').get(wamid);

test('status advances sent to delivered to read', () => {
  seedOut('m1');
  applyStatus({ id: 'm1', status: 'sent' });
  assert.equal(statusOf('m1').status, 'sent');
  applyStatus({ id: 'm1', status: 'delivered' });
  assert.equal(statusOf('m1').status, 'delivered');
  applyStatus({ id: 'm1', status: 'read' });
  assert.equal(statusOf('m1').status, 'read');
});
test('a late delivered after read is ignored', () => {
  seedOut('m2');
  applyStatus({ id: 'm2', status: 'read' });
  applyStatus({ id: 'm2', status: 'delivered' });
  assert.equal(statusOf('m2').status, 'read');
});
test('a read with no preceding delivered counts as delivered', () => {
  seedOut('m3', '911', 7);
  applyStatus({ id: 'm3', status: 'read' });
  assert.equal(countsForRun(7).delivered, 1);
});
test('an unknown status value is ignored', () => {
  seedOut('m4', '911', null, 'sent');
  applyStatus({ id: 'm4', status: 'teleported' });
  assert.equal(statusOf('m4').status, 'sent');
});
test('failed records the error code and title', () => {
  seedOut('m5');
  applyStatus({ id: 'm5', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] });
  const r = statusOf('m5');
  assert.equal(r.status, 'failed');
  assert.equal(r.error_code, 131026);
  assert.equal(r.error_title, 'Message undeliverable');
});
test('failed overwrites a prior delivered', () => {
  seedOut('m6');
  applyStatus({ id: 'm6', status: 'delivered' });
  applyStatus({ id: 'm6', status: 'failed', errors: [{ code: 470, title: 'Expired' }] });
  assert.equal(statusOf('m6').status, 'failed');
});
test('failed is terminal — a late delivered or read cannot resurrect it', () => {
  seedOut('m5b');
  applyStatus({ id: 'm5b', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] });
  applyStatus({ id: 'm5b', status: 'delivered' });
  assert.equal(statusOf('m5b').status, 'failed');
  applyStatus({ id: 'm5b', status: 'read' });
  assert.equal(statusOf('m5b').status, 'failed');
});
test('a status for an unknown wamid changes nothing and does not throw', () => {
  assert.doesNotThrow(() => applyStatus({ id: 'never-sent', status: 'read' }));
  assert.equal(statusOf('never-sent'), undefined);
});
test('countsForRun sums per-message statuses', () => {
  seedOut('r1', '911', 9); seedOut('r2', '911', 9); seedOut('r3', '911', 9); seedOut('r4', '911', 9);
  applyStatus({ id: 'r1', status: 'read' });
  applyStatus({ id: 'r2', status: 'delivered' });
  applyStatus({ id: 'r3', status: 'failed', errors: [{ code: 1, title: 'x' }] });
  assert.deepEqual(countsForRun(9), { accepted: 4, delivered: 2, read: 1, failed: 1 });
});
test('countsForRun on an empty run returns zeros, not nulls', () => {
  assert.deepEqual(countsForRun(999), { accepted: 0, delivered: 0, read: 0, failed: 0 });
});


console.log('\npricing');
test('marketing rate comes from the configured price', () => {
  PRICES.MARKETING = 0.78;
  assert.equal(rateFor('MARKETING'), 0.78);
});
test('category is case-insensitive', () => assert.equal(rateFor('marketing'), 0.78));
test('an unknown category falls back to the dearest rate, not zero', () => {
  PRICES.MARKETING = 0.78; PRICES.UTILITY = 0.115;
  assert.equal(rateFor('NONSENSE'), 0.78);
  assert.equal(rateFor(null), 0.78);
});
test('billable excludes opted-out numbers', () => {
  const contacts = [{ dialStr: '911' }, { dialStr: '922' }, { dialStr: '933' }];
  assert.equal(billableCount(contacts, new Set(['922'])), 2);
});
test('billable counts everything when nothing has opted out', () => {
  assert.equal(billableCount([{ dialStr: '911' }, { dialStr: '922' }], new Set()), 2);
});
test('billable of an empty list is zero, not NaN', () => assert.equal(billableCount([], new Set()), 0));
test('estimate multiplies and rounds to paise', () => assert.equal(estimateCost(988, 0.78), 770.64));
test('estimate never goes negative', () => assert.equal(estimateCost(-5, 0.78), 0));
test('spend counts delivered only — failures are free', () => assert.equal(spentCost(529, 0.78), 412.62));
test('spend is zero before anything is delivered', () => assert.equal(spentCost(0, 0.78), 0));
test('money is formatted with the currency symbol and two decimals', () => {
  assert.equal(formatMoney(770.6, '₹'), '₹770.60');
});

console.log('\n24-hour reply window');
const HOUR = 3600000;
test('a thread with no inbound message has no open window', () => {
  assert.equal(isWindowOpen({ lastInboundAt: 0 }), false);
  assert.equal(isWindowOpen(null), false);
});
test('a reply one hour ago leaves the window open', () => {
  const now = Date.now();
  assert.equal(isWindowOpen({ lastInboundAt: now - HOUR }, now), true);
});
test('the window is still open at 23h59m', () => {
  const now = Date.now();
  assert.equal(isWindowOpen({ lastInboundAt: now - (24 * HOUR - 60000) }, now), true);
});
test('the window is shut at exactly 24h', () => {
  const now = Date.now();
  assert.equal(isWindowOpen({ lastInboundAt: now - 24 * HOUR }, now), false);
});
test('the window is shut past 24h', () => {
  const now = Date.now();
  assert.equal(isWindowOpen({ lastInboundAt: now - 25 * HOUR }, now), false);
});

// The old S.inbox-backed assertions here (record a reply, redeliver it, count
// unread) moved to the 'inbound' and 'threads' sections below, which exercise
// the same behaviour against SQL instead of the in-memory object recordInbound
// no longer writes to. describeInbound is describe() — a pure function,
// untouched by the storage migration — so those two stay.
console.log('\ninbound messages');
test('a button tap is described by its label, not left blank', () => {
  assert.equal(describeInbound({ type: 'button', button: { text: 'Stop promotions' } }), 'Stop promotions');
});
test('an unsupported type is labelled rather than dropped silently', () => {
  assert.equal(describeInbound({ type: 'image' }), '[image]');
});

console.log('\ninbound');
const inbound = (id, from = '919812345678', extra = {}) =>
  recordInbound({ id, from, type: 'text', timestamp: '1700000000', text: { body: 'hello' }, ...extra }, 'Rahul');
const threadRow = waId => testDb.prepare('SELECT * FROM threads WHERE wa_id = ?').get(waId);

test('an inbound message creates the thread and the row', () => {
  const e = inbound('in-1');
  assert.equal(e.dir, 'in');
  assert.equal(e.text, 'hello');
  assert.equal(e.at, 1700000000000);
  const t = threadRow('919812345678');
  assert.equal(t.name, 'Rahul');
  assert.equal(t.unread, 1);
  assert.equal(t.last_inbound_at, 1700000000000);
});
test('a redelivered wamid neither duplicates nor double-counts unread', () => {
  const again = inbound('in-1');
  assert.equal(again, null);
  assert.equal(threadRow('919812345678').unread, 1);
  const n = testDb.prepare("SELECT count(*) AS n FROM messages WHERE wamid = 'in-1'").get().n;
  assert.equal(n, 1);
});
test('a second distinct message increments unread', () => {
  inbound('in-2');
  assert.equal(threadRow('919812345678').unread, 2);
});
test('markRead zeroes unread', () => {
  markRead('919812345678');
  assert.equal(threadRow('919812345678').unread, 0);
});
test('markRead on an unknown thread returns null', () => {
  assert.equal(markRead('910000000000'), null);
});
test('the raw envelope is stored for later phases', () => {
  const raw = JSON.parse(testDb.prepare("SELECT raw FROM messages WHERE wamid = 'in-1'").get().raw);
  assert.equal(raw.text.body, 'hello');
});
test('an image records a media row with no bytes fetched', () => {
  const before = global.fetch;
  let called = false;
  global.fetch = () => { called = true; throw new Error('P1 must not call the network'); };
  try {
    recordInbound({ id: 'in-img', from: '919812345678', type: 'image', timestamp: '1700000100',
      image: { id: 'MEDIA-1', mime_type: 'image/jpeg', sha256: 'abc', file_size: 2048 } }, 'Rahul');
  } finally { global.fetch = before; }
  assert.equal(called, false);
  const m = testDb.prepare("SELECT * FROM media WHERE media_id = 'MEDIA-1'").get();
  assert.equal(m.wamid, 'in-img');
  assert.equal(m.mime_type, 'image/jpeg');
  assert.equal(m.file_size, 2048);
  assert.equal(m.path, null);
  assert.equal(m.downloaded_at, null);
});
test('a document records its filename', () => {
  recordInbound({ id: 'in-doc', from: '919812345678', type: 'document', timestamp: '1700000200',
    document: { id: 'MEDIA-2', mime_type: 'application/pdf', filename: 'invoice.pdf' } }, 'Rahul');
  assert.equal(testDb.prepare("SELECT filename FROM media WHERE media_id = 'MEDIA-2'").get().filename, 'invoice.pdf');
});
test('a media message with no id stores the message but no media row', () => {
  recordInbound({ id: 'in-broken', from: '919812345678', type: 'image', timestamp: '1700000300', image: {} }, 'Rahul');
  assert.ok(testDb.prepare("SELECT 1 AS ok FROM messages WHERE wamid = 'in-broken'").get());
  assert.equal(testDb.prepare("SELECT count(*) AS n FROM media WHERE wamid = 'in-broken'").get().n, 0);
});
test('a message with no timestamp falls back to now', () => {
  const before = Date.now();
  const e = recordInbound({ id: 'in-nots', from: '919812345678', type: 'text', text: { body: 'x' } }, 'Rahul');
  assert.ok(e.at >= before);
});
// This section leaves 919812345678 with unread > 0 (four recordInbound calls
// land after the markRead test above). Cleaning that up here — rather than
// leaving it for the next section to blanket-reset away — is what makes this
// section self-contained: any later section that shares the :memory: DB (this
// one included, on a re-run of the suite in one process) sees the thread the
// way an operator who actually read it would, and nobody downstream needs to
// know or care that this section ran first.
markRead('919812345678');

console.log('\nthreads');
// This section owns the 9100000000xx wa_id range and touches nothing outside
// it. A reset scoped to that prefix — rather than a blanket
// `UPDATE threads SET unread = 0` — means a future section inserted anywhere
// before this one keeps whatever thread state it set up; only this section's
// own fixtures get zeroed between runs.
testDb.prepare("UPDATE threads SET unread = 0 WHERE wa_id LIKE '9100000000%'").run();
const seedThread = (waId, name, lastInboundAt, lastAt) =>
  testDb.prepare('INSERT OR REPLACE INTO threads (wa_id, name, unread, last_inbound_at, last_at) VALUES (?,?,0,?,?)')
        .run(waId, name, lastInboundAt, lastAt);

test('summary hides campaign-only threads by default', () => {
  seedThread('910000000001', 'Replied',  1700000000000, 1700000000000);
  seedThread('910000000002', 'BlastOnly', 0,            1700000000000);
  const ids = inboxSummary().threads.map(t => t.waId);
  assert.ok(ids.includes('910000000001'));
  assert.ok(!ids.includes('910000000002'));
});
test('summary all:true shows campaign-only threads', () => {
  const ids = inboxSummary({ all: true }).threads.map(t => t.waId);
  assert.ok(ids.includes('910000000002'));
});
test('summary sorts most recent first', () => {
  seedThread('910000000003', 'Newest', 1700000000000, 1900000000000);
  assert.equal(inboxSummary().threads[0].waId, '910000000003');
});
test('summary carries the last message as the preview', () => {
  testDb.prepare("INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at) VALUES ('p1','910000000001','in','text','first',1)").run();
  testDb.prepare("INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at) VALUES ('p2','910000000001','out','text','latest reply',2)").run();
  const t = inboxSummary().threads.find(x => x.waId === '910000000001');
  assert.equal(t.preview, 'latest reply');
  assert.equal(t.lastDir, 'out');
});
test('summary unread is the sum across visible threads', () => {
  // Two threads, both non-zero, so this actually exercises summation — one
  // thread reading back its own value would still pass if unread() summed
  // wrong (e.g. returned the max, or just the first row).
  testDb.prepare("UPDATE threads SET unread = 3 WHERE wa_id = '910000000001'").run();
  testDb.prepare("UPDATE threads SET unread = 2 WHERE wa_id = '910000000003'").run();
  assert.equal(inboxSummary().unread, 5);
  testDb.prepare("UPDATE threads SET unread = 0 WHERE wa_id IN ('910000000001', '910000000003')").run();
});
test('the window is open inside 24h and closed outside it', () => {
  const now = 1700000000000;
  seedThread('910000000004', 'Fresh', now - 1000, now);
  seedThread('910000000005', 'Stale', now - 25 * 3600 * 1000, now);
  const t = inboxSummary({ now });
  assert.equal(t.threads.find(x => x.waId === '910000000004').windowOpen, true);
  assert.equal(t.threads.find(x => x.waId === '910000000005').windowOpen, false);
});
test('the window boundary holds exactly at WINDOW_MS', () => {
  const now = 1700000000000;
  const WINDOW = 24 * 60 * 60 * 1000;
  seedThread('910000000006', 'Edge', now - WINDOW + 1, now);
  seedThread('910000000007', 'Past', now - WINDOW,     now);
  const t = inboxSummary({ now });
  assert.equal(t.threads.find(x => x.waId === '910000000006').windowOpen, true);
  assert.equal(t.threads.find(x => x.waId === '910000000007').windowOpen, false);
});
test('thread returns messages oldest first in the shape the UI reads', () => {
  const t = inboxThread('910000000001');
  assert.equal(t.name, 'Replied');
  assert.equal(t.messages[0].id, 'p1');
  assert.equal(t.messages[0].text, 'first');
  assert.equal(t.messages[1].id, 'p2');
  assert.equal(t.messages[1].dir, 'out');
  assert.ok('status' in t.messages[1]);
});
test('thread returns null for an unknown number', () => {
  assert.equal(inboxThread('910000009999'), null);
});
test('there is no per-thread message cap', () => {
  for (let i = 0; i < 250; i++) {
    testDb.prepare('INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`bulk-${i}`, '910000000008', 'in', 'text', `m${i}`, 1000 + i);
  }
  seedThread('910000000008', 'Chatty', 1700000000000, 1700000000000);
  assert.equal(inboxThread('910000000008').messages.length, 250);
});

console.log('\nauthentication');
test('the right password is accepted', () => {
  process.env.APP_PASSWORD = 'correct horse';
  require('./src/config').CFG.appPassword = 'correct horse';
  assert.equal(checkPassword('correct horse'), true);
});
test('a wrong password is rejected', () => assert.equal(checkPassword('wrong horse'), false));
test('a password of a different length is rejected without throwing', () => {
  assert.equal(checkPassword('x'), false);
  assert.equal(checkPassword(''), false);
  assert.equal(checkPassword(undefined), false);
});
test('no password configured means nothing authenticates', () => {
  const cfg = require('./src/config').CFG;
  const saved = cfg.appPassword;
  cfg.appPassword = '';
  assert.equal(checkPassword(''), false);
  assert.equal(checkPassword('anything'), false);
  cfg.appPassword = saved;
});
test('a fresh session token validates', () => {
  const t = createSession();
  assert.equal(validSession(t), true);
});
test('an unknown token does not validate', () => assert.equal(validSession('deadbeef'), false));
test('a destroyed session stops validating', () => {
  const t = createSession();
  destroySession(t);
  assert.equal(validSession(t), false);
});

console.log('\ndb');
test('node 22.5 and above is accepted', () => {
  assert.equal(nodeVersionOk('22.5.0'), true);
  assert.equal(nodeVersionOk('23.7.0'), true);
  assert.equal(nodeVersionOk('24.0.1'), true);
});
test('node below 22.5 is rejected', () => {
  assert.equal(nodeVersionOk('22.4.9'), false);
  assert.equal(nodeVersionOk('20.11.0'), false);
  assert.equal(nodeVersionOk('18.20.0'), false);
});
test('the schema creates every table', () => {
  const d = openDb(':memory:');
  const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names, ['campaign_runs', 'media', 'media_assets', 'messages', 'templates', 'threads', 'webhook_events']);
});
test('the schema creates the thread and run indexes', () => {
  const d = openDb(':memory:');
  const names = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names, ['idx_messages_run', 'idx_messages_thread']);
});
test('opening twice does not throw', () => {
  const d = openDb(':memory:');
  assert.doesNotThrow(() => d.exec(SCHEMA));   // every CREATE is IF NOT EXISTS
});
test('busy_timeout is applied', () => {
  const d = openDb(':memory:');
  assert.equal(d.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});
test('dir is constrained to in or out', () => {
  const d = openDb(':memory:');
  assert.throws(() => d.prepare(
    "INSERT INTO messages (wamid, wa_id, dir, type, at) VALUES ('x','1','sideways','text',1)"
  ).run(), /CHECK constraint failed/);
});

console.log('\nschema — media + template tables');
{
  const os    = require('os');
  const fsx   = require('fs');
  const pathx = require('path');
  const cols  = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);

  test('campaign_runs carries the run-time template snapshot columns', () => {
    const d = openDb(':memory:');
    const c = cols(d, 'campaign_runs');
    assert.ok(c.includes('template_body'), 'template_body missing');
    assert.ok(c.includes('template_lang'), 'template_lang missing');
    assert.ok(c.includes('header_asset'),  'header_asset missing');
    d.close();
  });

  test('media_assets and templates exist with their key columns', () => {
    const d = openDb(':memory:');
    assert.ok(cols(d, 'media_assets').includes('sha256'));
    assert.ok(cols(d, 'media_assets').includes('meta_handle'));
    assert.ok(cols(d, 'media_assets').includes('media_id_at'));
    assert.ok(cols(d, 'templates').includes('header_format'));
    assert.ok(cols(d, 'templates').includes('display_name'));
    d.close();
  });

  test('the same sha256 cannot be stored twice', () => {
    const d = openDb(':memory:');
    const ins = d.prepare(`INSERT INTO media_assets
      (sha256, path, filename, mime_type, file_size, kind, uploaded_at)
      VALUES (?,?,?,?,?,?,?)`);
    ins.run('abc', 'abc.pdf', 'a.pdf', 'application/pdf', 10, 'document', 1);
    assert.throws(() => ins.run('abc', 'abc.pdf', 'a.pdf', 'application/pdf', 10, 'document', 1),
      /UNIQUE/i, 'sha256 must be the dedupe key at the schema level, not only in JS');
    d.close();
  });

  // Re-opening an existing file re-runs every ALTER. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so without the addColumn guard this throws
  // "duplicate column name" on the second boot of any real deployment.
  test('re-opening an existing database file does not throw', () => {
    const f = pathx.join(os.tmpdir(), `wa-schema-${process.pid}-${Date.now()}.db`);
    try {
      openDb(f).close();
      const d = openDb(f);
      assert.ok(cols(d, 'campaign_runs').includes('template_body'));
      d.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) { try { fsx.unlinkSync(f + suffix); } catch {} }
    }
  });
}

console.log('\nmedia — saveUpload');
{
  const fsx = require('fs');
  const file = (buf, name, mime) => ({ buffer: buf, originalname: name, mimetype: mime });
  const pdf  = Buffer.from('%PDF-1.4 fake bytes for a test');

  test('accepts a PDF and writes exactly one row and one file', () => {
    const r = saveUpload(file(pdf, 'price-list.pdf', 'application/pdf'));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.asset.kind, 'document');
    assert.equal(r.asset.filename, 'price-list.pdf');
    assert.equal(r.asset.file_size, pdf.length);
    assert.ok(fsx.existsSync(assetPath(r.asset)), 'bytes were not written to disk');
  });

  test('the same bytes twice is one row and one file', () => {
    const before = listAssets().length;
    const r = saveUpload(file(pdf, 'renamed-but-identical.pdf', 'application/pdf'));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.deduped, true, 'a byte-identical re-upload must reuse the existing row');
    assert.equal(listAssets().length, before, 'dedupe must not add a row');
  });

  test('rejects an image over 5 MB, naming the limit', () => {
    const r = saveUpload(file(Buffer.alloc(6 * 1024 * 1024), 'big.png', 'image/png'));
    assert.equal(r.ok, false);
    assert.match(r.error, /5(\.0)? MB/, 'the operator must be told what the limit is');
  });

  test('rejects a video over 16 MB, naming the limit', () => {
    const r = saveUpload(file(Buffer.alloc(17 * 1024 * 1024), 'clip.mp4', 'video/mp4'));
    assert.equal(r.ok, false);
    assert.match(r.error, /16(\.0)? MB/);
  });

  test('rejects a type WhatsApp does not accept as a header', () => {
    const r = saveUpload(file(Buffer.from('MZ'), 'installer.exe', 'application/x-msdownload'));
    assert.equal(r.ok, false);
    assert.match(r.error, /does not accept/i);
  });

  test('a charset suffix on the mime type does not defeat the type check', () => {
    const r = saveUpload(file(Buffer.from('hello'), 'note.txt', 'text/plain; charset=utf-8'));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.asset.kind, 'document');
  });

  test('kindFor maps each accepted type to its kind', () => {
    assert.equal(kindFor('image/png'), 'image');
    assert.equal(kindFor('video/mp4'), 'video');
    assert.equal(kindFor('application/pdf'), 'document');
    assert.equal(kindFor('image/gif'), null);
  });
}

console.log('\nwebhook durability');
test('an envelope is recorded unprocessed', () => {
  const id = recordEnvelope('{"object":"whatsapp_business_account"}');
  const row = testDb.prepare('SELECT * FROM webhook_events WHERE id = ?').get(id);
  assert.equal(row.body, '{"object":"whatsapp_business_account"}');
  assert.equal(row.processed_at, null);
  assert.ok(row.received_at > 0);
});
test('marking processed stamps the row', () => {
  const id = recordEnvelope('{"a":1}');
  markEnvelopeProcessed(id);
  assert.ok(testDb.prepare('SELECT processed_at FROM webhook_events WHERE id = ?').get(id).processed_at > 0);
});
test('recordEnvelope throws when it cannot write — this is what makes the route 500', () => {
  testDb.exec('ALTER TABLE webhook_events RENAME TO webhook_events_hidden');
  try {
    assert.throws(() => recordEnvelope('{"lost":true}'));
  } finally {
    testDb.exec('ALTER TABLE webhook_events_hidden RENAME TO webhook_events');
  }
});
test('a recorded envelope survives to be replayed', () => {
  const id = recordEnvelope('{"replayable":true}');
  const pending = testDb.prepare('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL').get().n;
  assert.ok(pending >= 1);
  assert.equal(JSON.parse(testDb.prepare('SELECT body FROM webhook_events WHERE id = ?').get(id).body).replayable, true);
});

console.log('\nwebhook route (integration)');
// These mount the real router and go over a real HTTP+HMAC round trip, because
// the durability guarantee is about what the ROUTE does with a throw — a unit
// test on recordEnvelope alone cannot prove the try/catch turns that throw into
// a 500 instead of an accidental 200.
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { CFG } = require('./src/config');

// limit mirrors server.js's real body-parser config (F2). Without it this
// helper would silently test against Express's 100kb default instead of what
// the app actually runs, and the oversized-payload test below would pass or
// fail for the wrong reason.
function startWebhookServer() {
  const app = express();
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/', require('./src/routes/webhook'));
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, () => resolve(server)));
}

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

testAsync('a validly signed POST is acknowledged with 200 and recorded', async () => {
  const savedSecret = CFG.appSecret;
  CFG.appSecret = 'test-secret';
  const server = await startWebhookServer();
  let res;
  try {
    const port = server.address().port;
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(payload, 'test-secret') },
      body: payload,
    });
  } finally {
    server.close();
    CFG.appSecret = savedSecret;
  }
  assert.equal(res.status, 200);
  const row = testDb.prepare('SELECT * FROM webhook_events ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.body, '{"object":"whatsapp_business_account","entry":[]}');
});
testAsync('when the write fails the route answers 500, never 200, and stores nothing', async () => {
  const savedSecret = CFG.appSecret;
  CFG.appSecret = 'test-secret';
  const server = await startWebhookServer();
  const before = testDb.prepare('SELECT count(*) AS n FROM webhook_events').get().n;
  testDb.exec('ALTER TABLE webhook_events RENAME TO webhook_events_hidden');
  let res;
  try {
    const port = server.address().port;
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [], marker: 'should-not-be-stored' });
    res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(payload, 'test-secret') },
      body: payload,
    });
  } finally {
    testDb.exec('ALTER TABLE webhook_events_hidden RENAME TO webhook_events');
    server.close();
    CFG.appSecret = savedSecret;
  }
  assert.equal(res.status, 500);
  const after = testDb.prepare('SELECT count(*) AS n FROM webhook_events').get().n;
  assert.equal(after, before, 'the failed write must leave no phantom row');
});

console.log('\nreply');
const stubGraph = (impl) => {
  const before = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = before; };
};

testAsync('a reply outside the window is refused without calling the network', async () => {
  let called = false;
  const restore = stubGraph(async () => { called = true; throw new Error('must not send'); });
  try {
    testDb.prepare("INSERT OR REPLACE INTO threads (wa_id, name, unread, last_inbound_at, last_at) VALUES ('919700000001','Stale',0,1,1)").run();
    const r = await sendReply('919700000001', 'hello?');
    assert.equal(r.ok, false);
    assert.match(r.error, /24-hour reply window/);
    assert.equal(called, false);
  } finally { restore(); }
});
testAsync('a reply to an unknown thread is refused', async () => {
  const r = await sendReply('919700009999', 'hello?');
  assert.equal(r.ok, false);
  assert.match(r.error, /24-hour reply window/);
});
testAsync('an empty reply is refused before anything else', async () => {
  const r = await sendReply('919700000001', '   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/);
});
testAsync('a reply inside the window is stored with no run_id', async () => {
  const now = Date.now();
  testDb.prepare("INSERT OR REPLACE INTO threads (wa_id, name, unread, last_inbound_at, last_at) VALUES ('919700000002','Fresh',0,?,?)").run(now, now);
  const restore = stubGraph(async () => ({
    ok: true,
    headers: new Map(),
    json: async () => ({ messages: [{ id: 'reply-1' }] }),
  }));
  const savedToken = require('./src/config').CFG.accessToken;
  const savedPhone = require('./src/config').CFG.phoneNumberId;
  require('./src/config').CFG.accessToken   = 'test-token';
  require('./src/config').CFG.phoneNumberId = '1234567890';
  try {
    const r = await sendReply('919700000002', 'on my way');
    assert.equal(r.ok, true);
    assert.equal(r.message.id, 'reply-1');
    const row = testDb.prepare("SELECT * FROM messages WHERE wamid = 'reply-1'").get();
    assert.equal(row.dir, 'out');
    assert.equal(row.body, 'on my way');
    assert.equal(row.status, 'sent');
    assert.equal(row.run_id, null, 'an inbox reply must not be counted in a campaign run');
    assert.equal(testDb.prepare("SELECT last_at FROM threads WHERE wa_id = '919700000002'").get().last_at, row.at);
  } finally {
    restore();
    require('./src/config').CFG.accessToken   = savedToken;
    require('./src/config').CFG.phoneNumberId = savedPhone;
  }
});

console.log('\nruns');
test('startRun returns an id and records the label', () => {
  const id = startRun('diwali_offer');
  assert.equal(typeof id, 'number');
  assert.equal(testDb.prepare('SELECT label FROM campaign_runs WHERE id = ?').get(id).label, 'diwali_offer');
  assert.equal(S.currentRunId, id);
});
test('recordOutbound writes the message and the thread in one go', () => {
  const runId = startRun('run-a');
  recordOutbound({ wamid: 'out-1', waId: '919900000001', name: 'Asha', body: 'Hi Asha', at: 5000, runId });
  const m = testDb.prepare("SELECT * FROM messages WHERE wamid = 'out-1'").get();
  assert.equal(m.dir, 'out');
  assert.equal(m.type, 'template');
  assert.equal(m.status, 'accepted');
  assert.equal(m.run_id, runId);
  const t = testDb.prepare("SELECT * FROM threads WHERE wa_id = '919900000001'").get();
  assert.equal(t.name, 'Asha');
  assert.equal(t.last_at, 5000);
  assert.equal(t.last_inbound_at, 0);   // an outbound send does not open the window
});
test('a campaign send does not mark the thread unread', () => {
  assert.equal(testDb.prepare("SELECT unread FROM threads WHERE wa_id = '919900000001'").get().unread, 0);
});
test('a new run zeroes the displayed counters and deletes nothing', () => {
  const runA = startRun('run-b');
  recordOutbound({ wamid: 'out-2', waId: '919900000002', name: 'B', body: 'x', runId: runA });
  applyStatus({ id: 'out-2', status: 'delivered' });
  assert.deepEqual(countsForRun(runA), { accepted: 1, delivered: 1, read: 0, failed: 0 });

  const runB = startRun('run-c');
  assert.deepEqual(countsForRun(runB), { accepted: 0, delivered: 0, read: 0, failed: 0 });
  assert.ok(testDb.prepare("SELECT 1 AS ok FROM messages WHERE wamid = 'out-2'").get(), 'prior run message must survive');
});
test('a status for a previous run updates that message without touching the current run', () => {
  const runA = startRun('run-d');
  recordOutbound({ wamid: 'out-3', waId: '919900000003', name: 'C', body: 'x', runId: runA });
  const runB = startRun('run-e');
  recordOutbound({ wamid: 'out-4', waId: '919900000004', name: 'D', body: 'x', runId: runB });
  applyStatus({ id: 'out-3', status: 'read' });
  assert.equal(countsForRun(runA).read, 1);
  assert.equal(countsForRun(runB).read, 0);
});
test('a redelivered outbound wamid does not duplicate the row', () => {
  const runId = startRun('run-f');
  recordOutbound({ wamid: 'out-5', waId: '919900000005', name: 'E', body: 'x', runId });
  recordOutbound({ wamid: 'out-5', waId: '919900000005', name: 'E', body: 'x', runId });
  assert.equal(testDb.prepare("SELECT count(*) AS n FROM messages WHERE wamid = 'out-5'").get().n, 1);
});
test('an outbound send to a thread that replied leaves the window intact', () => {
  testDb.prepare("INSERT OR REPLACE INTO threads (wa_id, name, unread, last_inbound_at, last_at) VALUES ('919900000006','F',0,4000,4000)").run();
  recordOutbound({ wamid: 'out-6', waId: '919900000006', name: 'F', body: 'x', at: 9000, runId: startRun('run-g') });
  const t = testDb.prepare("SELECT * FROM threads WHERE wa_id = '919900000006'").get();
  assert.equal(t.last_inbound_at, 4000);
  assert.equal(t.last_at, 9000);
});

console.log('\nstate snapshot');
test('displayed counters are derived from the current run', () => {
  const runId = startRun('snapshot-run');
  recordOutbound({ wamid: 'snap-1', waId: '919911000001', name: 'One', body: 'x', runId });
  recordOutbound({ wamid: 'snap-2', waId: '919911000002', name: 'Two', body: 'x', runId });
  applyStatus({ id: 'snap-1', status: 'read' });
  const st = buildState();
  assert.equal(st.accepted, 2);
  assert.equal(st.delivered, 1);
  assert.equal(st.read, 1);
});
test('a webhook failure is counted alongside API failures', () => {
  const runId = S.currentRunId;
  recordOutbound({ wamid: 'snap-3', waId: '919911000003', name: 'Three', body: 'x', runId });
  applyStatus({ id: 'snap-3', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] });
  S.failed = 2;                      // two sends the Graph API rejected outright
  assert.equal(buildState().failed, 3);
  S.failed = 0;
});
test('starting a new run resets the displayed counters to zero', () => {
  startRun('snapshot-run-2');
  const st = buildState();
  assert.equal(st.accepted, 0);
  assert.equal(st.delivered, 0);
  assert.equal(st.read, 0);
});
test('spent is priced on delivered messages in the current run', () => {
  const runId = startRun('snapshot-run-3');
  recordOutbound({ wamid: 'snap-4', waId: '919911000004', name: 'Four', body: 'x', runId });
  applyStatus({ id: 'snap-4', status: 'delivered' });
  const st = buildState();
  assert.equal(st.pricing.spent, spentCost(1, rateFor(S.config.templateCategory)));
});
test('the snapshot still carries every key the frontend reads', () => {
  const st = buildState();
  for (const k of ['phase','currentIdx','total','accepted','delivered','read','failed','skipped',
                   'dailyCount','dailyCap','quality','warmup','pricing','inboxUnread','pauseReason',
                   'config','configured','currentContact','limits','optOutCount','optOutLabel']) {
    assert.ok(k in st, `buildState lost the "${k}" key`);
  }
});

console.log('\nmigration');
const fsx   = require('node:fs');
const pathx = require('node:path');
const osx   = require('node:os');

// Never point these at src/config's real FILES. The migration RENAMES its
// sources when it finishes, so a test using the real paths would overwrite and
// then delete the repo's actual inbox.json and msg-index.json — destroying a
// self-hoster's message history the first time they ran `npm test`.
const migDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'wa-migrate-'));
const F = {
  inbox:    pathx.join(migDir, 'inbox.json'),
  msgIndex: pathx.join(migDir, 'msg-index.json'),
};

test('migration is idempotent and moves both files', () => {
  const fresh = openDb(':memory:');
  const inboxFixture = {
    '919800000001': {
      waId: '919800000001', name: 'Old Friend', unread: 2,
      lastInboundAt: 1600000000000, lastAt: 1600000001000,
      messages: [
        { id: 'old-in-1',  dir: 'in',  type: 'text', text: 'hi',    at: 1600000000000 },
        { id: 'old-out-1', dir: 'out', type: 'text', text: 'hello', at: 1600000001000, status: 'read' },
      ],
    },
  };
  const indexFixture = { msgIndex: { 'old-tmpl-1': { phone: '919800000002', name: 'Blast', status: 'delivered' } } };

  fsx.writeFileSync(F.inbox,    JSON.stringify(inboxFixture));
  fsx.writeFileSync(F.msgIndex, JSON.stringify(indexFixture));
  try {
    const first = migrateJsonToSql(fresh, F);
    // 2, not 1: the inbox.json thread (919800000001) plus the msgIndex-only
    // recipient (919800000002), which used to insert a thread without ever
    // incrementing this counter (F9).
    assert.equal(first.threads, 2);
    assert.equal(first.inboundMessages, 1);
    assert.equal(first.outboundMessages, 2);   // 1 from the thread, 1 from msgIndex

    const rows = fresh.prepare('SELECT count(*) AS n FROM messages').get().n;
    assert.equal(rows, 3);
    assert.equal(fresh.prepare("SELECT status FROM messages WHERE wamid = 'old-out-1'").get().status, 'read');
    assert.equal(fresh.prepare("SELECT status FROM messages WHERE wamid = 'old-tmpl-1'").get().status, 'delivered');
    assert.equal(fresh.prepare("SELECT unread FROM threads WHERE wa_id = '919800000001'").get().unread, 2);

    // The files are renamed, so a second boot has nothing to do.
    assert.equal(fsx.existsSync(F.inbox), false);
    assert.equal(fsx.existsSync(`${F.inbox}.migrated`), true);

    const second = migrateJsonToSql(fresh, F);
    assert.deepEqual(second, { threads: 0, inboundMessages: 0, outboundMessages: 0, skipped: true });
    assert.equal(fresh.prepare('SELECT count(*) AS n FROM messages').get().n, 3, 'a second run must not change the data');
  } finally {
    for (const f of [F.inbox, F.msgIndex, `${F.inbox}.migrated`, `${F.msgIndex}.migrated`]) {
      if (fsx.existsSync(f)) fsx.unlinkSync(f);
    }
  }
});
test('migration with no files present is a no-op', () => {
  const fresh = openDb(':memory:');
  assert.deepEqual(migrateJsonToSql(fresh, F), { threads: 0, inboundMessages: 0, outboundMessages: 0, skipped: false });
});
test('migration skips when messages already exist', () => {
  const fresh = openDb(':memory:');
  fresh.prepare("INSERT INTO messages (wamid, wa_id, dir, type, at) VALUES ('x','1','in','text',1)").run();
  assert.equal(migrateJsonToSql(fresh, F).skipped, true);
});
test('a number that is both an inbox thread and a campaign recipient keeps the inbox row', () => {
  // The inbox loop runs before the msgIndex loop and both insertThread calls
  // use INSERT OR IGNORE, so the first write — the inbox one, with real
  // unread/lastInboundAt — must win. If a future refactor reorders the two
  // loops, this number would silently flatten to unread:0, last_inbound_at:0.
  const overlapDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'wa-migrate-overlap-'));
  const OF = {
    inbox:    pathx.join(overlapDir, 'inbox.json'),
    msgIndex: pathx.join(overlapDir, 'msg-index.json'),
  };
  const waId = '919800000099';
  const inboxFixture = {
    [waId]: {
      waId, name: 'Both Worlds', unread: 5,
      lastInboundAt: 1700000000000, lastAt: 1700000001000,
      messages: [
        { id: 'ov-in-1', dir: 'in', type: 'text', text: 'hey', at: 1700000000000 },
      ],
    },
  };
  const indexFixture = { msgIndex: { 'ov-tmpl-1': { phone: waId, name: 'Blast', status: 'delivered' } } };

  fsx.writeFileSync(OF.inbox,    JSON.stringify(inboxFixture));
  fsx.writeFileSync(OF.msgIndex, JSON.stringify(indexFixture));
  try {
    const fresh = openDb(':memory:');
    migrateJsonToSql(fresh, OF);
    const t = fresh.prepare('SELECT unread, last_inbound_at FROM threads WHERE wa_id = ?').get(waId);
    assert.equal(t.unread, 5, 'the inbox row\'s unread must survive, not be flattened to 0');
    assert.equal(t.last_inbound_at, 1700000000000, 'the inbox row\'s last_inbound_at must survive, not be flattened to 0');
  } finally {
    for (const f of [OF.inbox, OF.msgIndex, `${OF.inbox}.migrated`, `${OF.msgIndex}.migrated`]) {
      if (fsx.existsSync(f)) fsx.unlinkSync(f);
    }
  }
});

console.log('\nF7 — corrupt migration source');
test('a source file that fails to parse is left in place, not renamed, and logged as an error', () => {
  // readJSON (src/lib/store.js) swallows a JSON.parse throw and returns {} —
  // from migrate.js's side that is indistinguishable from a file that was
  // genuinely empty. Either way, nothing must be renamed out from under a
  // false "0 threads, 0 messages" success line.
  const corruptDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'wa-migrate-corrupt-'));
  const CF = { inbox: pathx.join(corruptDir, 'inbox.json'), msgIndex: pathx.join(corruptDir, 'msg-index.json') };
  fsx.writeFileSync(CF.inbox, '{ this is not valid json');
  try {
    const fresh = openDb(':memory:');
    const before = S.logs.length;
    const result = migrateJsonToSql(fresh, CF);
    assert.equal(result.threads, 0);
    assert.equal(result.inboundMessages, 0);
    assert.equal(result.outboundMessages, 0);
    assert.equal(fsx.existsSync(CF.inbox), true, 'a corrupt source must not be renamed away');
    assert.equal(fsx.existsSync(`${CF.inbox}.migrated`), false);
    const logged = S.logs.slice(before).some(l => l.level === 'error' && l.msg.includes(CF.inbox));
    assert.ok(logged, 'a corrupt or empty source must be logged as an error, not silently declared migrated');
  } finally {
    for (const f of [CF.inbox, CF.msgIndex, `${CF.inbox}.migrated`, `${CF.msgIndex}.migrated`]) {
      if (fsx.existsSync(f)) fsx.unlinkSync(f);
    }
  }
});

console.log('\nF6 — idempotent failure handling');
test('a redelivered failed status yields one failLog entry, not one per redelivery', () => {
  seedOut('m-f1');
  const before = S.failLog.length;
  applyStatus({ id: 'm-f1', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] });
  assert.equal(S.failLog.length, before + 1);
  assert.equal(statusOf('m-f1').status, 'failed');
  // Meta redelivers webhooks it did not get a 200 for, so the identical
  // 'failed' status for the same wamid can arrive more than once.
  applyStatus({ id: 'm-f1', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] });
  assert.equal(S.failLog.length, before + 1, 'a redelivered failure must not push a second failLog entry');
  assert.equal(statusOf('m-f1').status, 'failed');
});
test('a later failed webhook still updates the error code and title', () => {
  // Still worth recording the best detail seen, even though only the FIRST
  // transition into 'failed' reaches the operator-visible failLog.
  seedOut('m-f2');
  applyStatus({ id: 'm-f2', status: 'failed', errors: [{ code: 1, title: 'Generic' }] });
  applyStatus({ id: 'm-f2', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] });
  const r = statusOf('m-f2');
  assert.equal(r.error_code, 131026);
  assert.equal(r.error_title, 'Undeliverable');
});

console.log('\nF1 — run attribution');
test('a null current run reports zero counters and zero spend even with unattributed traffic', () => {
  // By this point in the suite the db already holds inbox replies ('reply'
  // section) and migrated legacy rows ('migration' section), both landed
  // with run_id NULL by design. A null current run must report "no campaign
  // running", not surface that unrelated traffic as if it were one (F1).
  const savedRunId = S.currentRunId;
  const savedFailed = S.failed;
  S.currentRunId = null;
  S.failed = 0;
  assert.deepEqual(countsForRun(null), { accepted: 0, delivered: 0, read: 0, failed: 0 });
  const st = buildState();
  assert.equal(st.accepted, 0);
  assert.equal(st.delivered, 0);
  assert.equal(st.read, 0);
  assert.equal(st.failed, 0);
  assert.equal(st.pricing.spent, 0);
  S.currentRunId = savedRunId;
  S.failed = savedFailed;
});

const { FILES: F1_FILES } = require('./src/config');
// campaign.json is real runtime state (not customer data, unlike
// inbox.json/msg-index.json), so unlike the migration tests above these two
// are allowed to touch its real path — but they still save and restore
// whatever was there before, leaving no trace either way.
const withSavedCampaignFile = fn => {
  const savedState = { contacts: S.contacts, currentIdx: S.currentIdx, phase: S.phase,
                        dailyCount: S.dailyCount, dailyDate: S.dailyDate, skipped: S.skipped,
                        currentRunId: S.currentRunId, pauseReason: S.pauseReason };
  const existed = fsx.existsSync(F1_FILES.campaign);
  const contents = existed ? fsx.readFileSync(F1_FILES.campaign, 'utf8') : null;
  try {
    fn();
  } finally {
    Object.assign(S, savedState);
    if (existed) fsx.writeFileSync(F1_FILES.campaign, contents);
    else if (fsx.existsSync(F1_FILES.campaign)) fsx.unlinkSync(F1_FILES.campaign);
  }
};

test('a resumed campaign restores the run id it had before the restart', () => withSavedCampaignFile(() => {
  const runId = startRun('resume-test');
  Object.assign(S, { contacts: [{ name: 'X', dialStr: '910000000000' }], currentIdx: 0, phase: 'running', currentRunId: runId });
  saveCampaignNow();

  // Simulate a fresh process: nothing carries over except what is on disk.
  S.currentRunId = null; S.currentIdx = 0; S.phase = 'idle'; S.contacts = [];
  resumeIfInterrupted();
  assert.equal(S.currentRunId, runId,
    'the persisted run id must survive a restart — a resumed send stamped with a different (or no) run id merges into the wrong bucket');
}));
test('a resumed campaign with no persisted run id opens one rather than resuming unattributed', () => withSavedCampaignFile(() => {
  // What campaign.json looked like before run ids were persisted: no
  // currentRunId field at all.
  const legacy = { contacts: [{ name: 'Y', dialStr: '910000000001' }], currentIdx: 0,
                    phase: 'running', dailyCount: 0, dailyDate: null, skipped: 0, config: {} };
  fsx.writeFileSync(F1_FILES.campaign, JSON.stringify(legacy));
  S.currentRunId = null; S.currentIdx = 0; S.phase = 'idle'; S.contacts = [];
  resumeIfInterrupted();
  assert.ok(S.currentRunId, 'a run id must be opened so resumed sends are attributed instead of landing on run_id NULL');
}));

console.log('\nF2 — webhook body size limit');
testAsync('a signed envelope well over the old 100kb express default is accepted and recorded', async () => {
  const savedSecret = CFG.appSecret;
  CFG.appSecret = 'test-secret';
  const server = await startWebhookServer();
  const before = testDb.prepare('SELECT count(*) AS n FROM webhook_events').get().n;
  let res;
  try {
    const port = server.address().port;
    // 150kb of padding — comfortably past Express's 100kb default, which is
    // roughly 300 batched statuses for this app and the normal shape of a
    // Meta status webhook for a bulk sender, not an edge case.
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [], padding: 'x'.repeat(150 * 1024) });
    res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(payload, 'test-secret') },
      body: payload,
    });
  } finally {
    server.close();
    CFG.appSecret = savedSecret;
  }
  assert.equal(res.status, 200, 'a batched webhook over the 100kb express default must not be rejected with 413');
  const after = testDb.prepare('SELECT count(*) AS n FROM webhook_events').get().n;
  assert.equal(after, before + 1, 'the oversized envelope must actually be recorded, not merely accepted');
});

console.log('\nmedia — Meta identifiers');
{
  const seed = () => {
    const r = saveUpload({ buffer: Buffer.from(`bytes-${Math.random()}`),
                           originalname: 'sheet.pdf', mimetype: 'application/pdf' });
    assert.equal(r.ok, true, r.error);
    return r.asset.id;
  };

  // Every one of these stubs global.fetch. testAsync runs one at a time, so the
  // restore in the finally block always lands before the next test's stub.
  const withFetch = async (impl, fn) => {
    const real = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return impl(String(url), opts, calls); };
    try { return await fn(calls); } finally { global.fetch = real; }
  };
  const json = obj => ({ ok: true, status: 200, json: async () => obj, headers: new Headers() });

  testAsync('ensureHandle runs the two-step resumable upload and caches the handle', async () => {
    const savedToken = CFG.accessToken, savedApp = CFG.appId;
    CFG.accessToken = 'test-token'; CFG.appId = '1234567890';
    const id = seed();
    try {
      await withFetch((url, opts) => {
        if (url.includes('/uploads?')) return json({ id: 'upload:SESSION' });
        assert.equal(opts.headers.Authorization, 'OAuth test-token',
          'step two of the resumable upload uses OAuth, not Bearer — Bearer 400s');
        return json({ h: 'h:TESTHANDLE' });
      }, async calls => {
        const r = await ensureHandle(id);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.handle, 'h:TESTHANDLE');
        assert.equal(calls.length, 2, 'resumable upload is two calls');
      });
      // Cached: a second call must not touch the network.
      await withFetch(() => { throw new Error('must not refetch a cached handle'); },
        async () => assert.equal((await ensureHandle(id)).handle, 'h:TESTHANDLE'));
    } finally { CFG.accessToken = savedToken; CFG.appId = savedApp; }
  });

  testAsync('ensureHandle refuses clearly when APP_ID is not configured', async () => {
    const savedApp = CFG.appId;
    CFG.appId = '';
    const id = seed();
    try {
      const r = await ensureHandle(id);
      assert.equal(r.ok, false);
      assert.match(r.error, /APP_ID/, 'the error must name the missing setting');
    } finally { CFG.appId = savedApp; }
  });

  testAsync('ensureMediaId uploads once and caches', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId;
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = seed();
    try {
      await withFetch(() => json({ id: '9990001' }), async calls => {
        const r = await ensureMediaId(id);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.mediaId, '9990001');
        assert.equal(calls.length, 1);
      });
      await withFetch(() => { throw new Error('must not re-upload a fresh media id'); },
        async () => assert.equal((await ensureMediaId(id)).mediaId, '9990001'));
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; }
  });

  // Meta deletes media at 30 days. Refreshing at 29 means a campaign that
  // starts on day 29 does not fail halfway through when the id expires mid-run.
  testAsync('a media id older than 29 days is re-uploaded', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId;
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = seed();
    try {
      await withFetch(() => json({ id: 'first' }), async () => { await ensureMediaId(id); });
      db.prepare('UPDATE media_assets SET media_id_at = ? WHERE id = ?')
        .run(Date.now() - (MEDIA_ID_TTL_MS + 1000), id);
      await withFetch(() => json({ id: 'second' }), async calls => {
        const r = await ensureMediaId(id);
        assert.equal(r.mediaId, 'second', 'a stale media id must be re-uploaded, not reused');
        assert.equal(calls.length, 1);
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; }
  });

  testAsync('force re-uploads even when the cached id is fresh', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId;
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = seed();
    try {
      await withFetch(() => json({ id: 'aaa' }), async () => { await ensureMediaId(id); });
      await withFetch(() => json({ id: 'bbb' }), async () => {
        assert.equal((await ensureMediaId(id, { force: true })).mediaId, 'bbb');
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; }
  });

  testAsync('a Graph error is returned as a message, not thrown', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId;
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = seed();
    try {
      await withFetch(() => json({ error: { message: 'Upload failed', code: 100 } }), async () => {
        const r = await ensureMediaId(id);
        assert.equal(r.ok, false);
        assert.match(r.error, /Upload failed/);
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; }
  });
}

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
});
