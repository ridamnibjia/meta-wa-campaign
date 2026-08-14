'use strict';
// Every DB-backed test runs against a private in-memory database. This must be
// set before ./server is required, because src/lib/db.js opens on import.
process.env.WA_DB_PATH = ':memory:';

// Uploads go to a throwaway directory for the same reason the database does:
// a test run must never write into the repo.
process.env.WA_UPLOAD_DIR = require('path').join(
  require('os').tmpdir(), `wa-uploads-${process.pid}-${Date.now()}`);

// Inbound customer media saved by these tests goes to a throwaway directory
// too. Same reason, different store: MEDIA_DIR holds what customers sent us.
process.env.WA_MEDIA_DIR = require('path').join(
  require('os').tmpdir(), `wa-media-${process.pid}-${Date.now()}`);

// The free-space floor defaults to 2 GB, which makes every media test a
// referendum on how full the developer's laptop is. The floor is exercised
// deliberately, in its own test, by raising it — so the default here is zero.
process.env.WA_MEDIA_MIN_FREE_BYTES = '0';

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
  markRead, inboxThread, inboxSearch, sendReply, sendMedia, CAPTION_LIMIT,
  checkPassword, createSession, validSession, destroySession,
  PRICES,
  nodeVersionOk, openDb, SCHEMA,
  recordEnvelope, markEnvelopeProcessed, unprocessedWebhookCount,
  startRun, recordOutbound,
  buildState, app,
  migrateJsonToSql, db,
  MEDIA_KINDS, kindFor, saveUpload, listAssets, getAsset, assetPath, deleteAsset,
  ensureHandle, ensureMediaId, MEDIA_ID_TTL_MS, headerComponent, sendTemplate,
  saveInbound, inboundPath, getInbound, INBOUND_TTL_MS, rescanIfNeeded, sweepMedia,
  keepInbound, discardInbound, sha256Hex,
  classify, sniff, extOf, worst, TIERS,
  scanBuffer, parseReply, scannerConfigured, EICAR,
  BUTTON_LIMITS, saveTemplateRow, getTemplateRow, OPT_OUT_LABEL,
  saveCampaignNow, loadCampaign, resumeIfInterrupted, clearCampaignFile,
  overview, listStored, renameAsset, removeMany,
  contacts,
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

console.log('\ntemplate headers');
const okBase = { displayName: 'Test', bodyText: 'Hi {{1}}, our range is live.', sampleValues: ['Rahul'] };

test('a TEXT header emits its example block', () => {
  const c = buildTemplatePayload({ ...okBase, headerFormat: 'TEXT', headerText: 'Sale {{1}}', headerSample: 'Diwali' })
    .components.find(x => x.type === 'HEADER');
  assert.equal(c.format, 'TEXT');
  assert.deepEqual(c.example, { header_text: ['Diwali'] });
});

test('a plain TEXT header carries no example block', () => {
  const c = buildTemplatePayload({ ...okBase, headerFormat: 'TEXT', headerText: 'Big news' })
    .components.find(x => x.type === 'HEADER');
  assert.equal(c.text, 'Big news');
  assert.equal(c.example, undefined);
});

test('a document header emits header_handle', () => {
  const c = buildTemplatePayload({ ...okBase, headerFormat: 'DOCUMENT', headerHandle: 'h:TESTHANDLE' })
    .components.find(x => x.type === 'HEADER');
  assert.equal(c.format, 'DOCUMENT');
  assert.deepEqual(c.example, { header_handle: ['h:TESTHANDLE'] });
  assert.equal(c.text, undefined, 'a media header has no text');
});

test('the header is the first component — Meta requires that order', () => {
  const p = buildTemplatePayload({ ...okBase, headerFormat: 'IMAGE', headerHandle: 'h:X' });
  assert.equal(p.components[0].type, 'HEADER');
});

test('rejects a media header with no file chosen', () =>
  assert.match(validateTemplateInput({ ...okBase, headerFormat: 'IMAGE' }).join(), /choose a file/i));
test('rejects a TEXT header with no text', () =>
  assert.match(validateTemplateInput({ ...okBase, headerFormat: 'TEXT' }).join(), /header text/i));
test('rejects an over-length TEXT header', () =>
  assert.match(validateTemplateInput({ ...okBase, headerFormat: 'TEXT', headerText: 'x'.repeat(61) }).join(), /max 60/));
test('rejects more than one variable in a TEXT header', () =>
  assert.match(validateTemplateInput({ ...okBase, headerFormat: 'TEXT', headerText: '{{1}} {{2}}', headerSample: 'a' }).join(), /one variable/i));
test('rejects an unknown header format', () =>
  assert.match(validateTemplateInput({ ...okBase, headerFormat: 'LOCATION' }).join(), /header format/i));

console.log('\ntemplate buttons');
const qr  = n => Array.from({ length: n }, (_, i) => ({ type: 'QUICK_REPLY', text: `Reply ${i}` }));
const url = n => Array.from({ length: n }, (_, i) => ({ type: 'URL', text: `Link ${i}`, url: `https://example.com/${i}` }));
const tel = n => Array.from({ length: n }, (_, i) => ({ type: 'PHONE_NUMBER', text: `Call ${i}`, phone_number: '+910000000000' }));

test('accepts a legal mix', () =>
  assert.deepEqual(validateTemplateInput({ ...okBase, addOptOut: false, buttons: [...qr(2), ...url(2), ...tel(1)] }), []));
test('rejects 3 URL buttons', () =>
  assert.match(validateTemplateInput({ ...okBase, buttons: url(3) }).join(), /at most 2 URL/i));
test('rejects 2 phone buttons', () =>
  assert.match(validateTemplateInput({ ...okBase, buttons: tel(2) }).join(), /at most 1 (phone|call)/i));
test('the opt-out button counts toward the 3 quick-reply ceiling', () =>
  assert.match(validateTemplateInput({ ...okBase, addOptOut: true, buttons: qr(3) }).join(), /at most 3 quick/i));
test('rejects a URL button with no url', () =>
  assert.match(validateTemplateInput({ ...okBase, buttons: [{ type: 'URL', text: 'Shop' }] }).join(), /needs a URL/i));
test('rejects a non-http URL', () =>
  assert.match(validateTemplateInput({ ...okBase, buttons: [{ type: 'URL', text: 'Shop', url: 'javascript:alert(1)' }] }).join(), /https?:/i));
test('rejects a button with no label', () =>
  assert.match(validateTemplateInput({ ...okBase, buttons: [{ type: 'URL', url: 'https://example.com' }] }).join(), /label/i));
test('rejects an unknown button type', () =>
  assert.match(validateTemplateInput({ ...okBase, buttons: [{ type: 'COPY_CODE', text: 'x' }] }).join(), /button type/i));

test('the opt-out button is emitted first, before the operator\'s own', () => {
  const b = buildTemplatePayload({ ...okBase, addOptOut: true, buttons: url(1) })
    .components.find(c => c.type === 'BUTTONS').buttons;
  assert.equal(b.length, 2);
  assert.equal(b[0].type, 'QUICK_REPLY');
  assert.equal(b[0].text, OPT_OUT_LABEL);
  assert.equal(b[1].type, 'URL');
  assert.equal(b[1].url,  'https://example.com/0');
});

console.log('\ntemplate row memory');
test('a saved template row round-trips its header asset link', () => {
  const name = `plan_test_${Date.now()}`;
  saveTemplateRow({ name, displayName: 'Plan Test', language: 'en', category: 'MARKETING',
                    headerFormat: 'DOCUMENT', headerText: null, headerAssetId: null,
                    bodyText: 'Hi {{1}}', footerText: null, buttons: [], varCount: 1, status: 'PENDING' });
  const row = getTemplateRow(name);
  assert.equal(row.display_name,  'Plan Test');
  assert.equal(row.header_format, 'DOCUMENT');
  assert.equal(row.var_count,     1);
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
  const { contacts } = parseCSV(Buffer.from(csv));
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].name, 'Rahul');
  assert.equal(contacts[0].dialStr, '919000000001');
});
test('defaults a missing name to Contact', () => {
  const { contacts } = parseCSV(Buffer.from('First Name,Mobile Phone\n,9000000001\n'));
  assert.equal(contacts[0].name, 'Contact');
});

// Every case below silently produced ZERO contacts before the RFC 4180 split
// and the widened header match. A CSV that half-parses is worse than one that
// fails outright: the operator sees a plausible number and never learns which
// customers were left out.
test('a quoted comma in a name does not shift the phone column', () => {
  const csv = 'Name,Mobile Phone,Notes\n"Doe, John",+919000000001,"member 2024"\n';
  const { contacts, skipped } = parseCSV(Buffer.from(csv));
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, 'Doe, John');
  assert.equal(contacts[0].dialStr, '919000000001');
  assert.equal(skipped.length, 0);
});
test('a doubled quote inside a quoted field is one literal quote', () => {
  const { contacts } = parseCSV(Buffer.from('Name,Phone\n"Ali ""Bo"" Rao",+919000000001\n'));
  assert.equal(contacts[0].name, 'Ali "Bo" Rao');
});
test('reads a modern Google Contacts export', () => {
  const csv = 'First Name,Last Name,Phone 1 - Type,Phone 1 - Value\nAsha,Rao,Mobile,+919000000001\n';
  const { contacts, skipped } = parseCSV(Buffer.from(csv));
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, 'Asha Rao');
  assert.equal(contacts[0].dialStr, '919000000001');
  assert.equal(skipped.length, 0, 'the "- Type" column holds "Mobile", which is not a failed row');
});
test('a row with no usable number is reported, not dropped in silence', () => {
  const csv = 'Name,Mobile Phone\nAsha,+919000000001\nRahul,not-a-number\nPriya,\n';
  const { contacts, skipped } = parseCSV(Buffer.from(csv));
  assert.equal(contacts.length, 1);
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped.map(s => s.row), [3, 4]);
  assert.equal(skipped[0].name, 'Rahul');
});
test('an account number column is never mistaken for a phone number', () => {
  // 11 digits, so normalizePhone would happily accept it. The header match is
  // the only thing standing between a membership id and a message to a stranger.
  const csv = 'Name,Account Number,Mobile Phone\nAsha,12345678901,+919000000001\n';
  const { contacts } = parseCSV(Buffer.from(csv));
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].dialStr, '919000000001');
});
test('two phone columns on one row both count, deduped', () => {
  const csv = 'Name,Mobile Phone,Home Phone\nAsha,+919000000001,+919000000002\nDup,+919000000003,+919000000003\n';
  const { contacts, skipped } = parseCSV(Buffer.from(csv));
  assert.equal(contacts.length, 3);
  assert.equal(skipped.length, 0, 'a duplicate number is not a row that failed to parse');
});
test('a CRLF file does not leave a stray return on the last column', () => {
  const { contacts } = parseCSV(Buffer.from('Name,Mobile Phone\r\nAsha,+919000000001\r\n'));
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].dialStr, '919000000001');
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
// -1 is this app's own code for "fetch threw", not one of Meta's. Without an
// entry the skip report told the operator to look it up in Meta's error
// reference, which does not list it.
test('explains our own network code rather than blaming Meta', () => {
  assert.match(explainError(-1), /Could not reach Meta from this server/);
  assert.doesNotMatch(explainError(-1), /error reference/);
});
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
// A predicate rather than a Set: the answer lives in SQL now, and lib/ must not
// import the database.
const disabled = (...off) => p => off.includes(p);
test('billable excludes disabled numbers', () => {
  const contacts = [{ dialStr: '911' }, { dialStr: '922' }, { dialStr: '933' }];
  assert.equal(billableCount(contacts, disabled('922')), 2);
});
test('billable counts everything when nobody is disabled', () => {
  assert.equal(billableCount([{ dialStr: '911' }, { dialStr: '922' }], disabled()), 2);
});
test('billable of an empty list is zero, not NaN', () => assert.equal(billableCount([], disabled()), 0));
test('billable with no predicate counts the whole list rather than throwing', () =>
  assert.equal(billableCount([{ dialStr: '911' }, { dialStr: '922' }]), 2));
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
test('there is no per-thread message cap — a page is a page, not a ceiling', () => {
  for (let i = 0; i < 250; i++) {
    testDb.prepare('INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`bulk-${i}`, '910000000008', 'in', 'text', `m${i}`, 1000 + i);
  }
  seedThread('910000000008', 'Chatty', 1700000000000, 1700000000000);
  assert.equal(inboxThread('910000000008').total, 250, 'all 250 are still there');
  // Walk the whole transcript a page at a time and confirm nothing is lost
  // between pages — the failure this keyset cursor exists to prevent.
  const seen = [];
  let before = null, guard = 0;
  do {
    const page = inboxThread('910000000008', { before, limit: 30 });
    seen.push(...page.messages.map(m => m.id));
    before = page.nextBefore;
  } while (before && ++guard < 20);
  assert.equal(new Set(seen).size, 250, 'every message is reachable by paging, exactly once');
});

// ── P4: search and pagination ─────────────────────────────────────────────────
console.log('\ninbox — pagination');
{
  // A conversation where several messages share one timestamp. Meta sends whole
  // seconds, so this is the normal case in a busy thread, not a contrived one —
  // and a cursor on `at` alone would silently drop every message that ties with
  // a page boundary.
  seedThread('910000007777', 'Paged', 1700000000000, 1700000000000);
  for (let i = 0; i < 7; i++) {
    testDb.prepare('INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`pg-${i}`, '910000007777', 'in', 'text', `msg ${i}`, 5000 + Math.floor(i / 3) * 1000);
  }

  test('a thread opens on its newest page, oldest first within it', () => {
    const t = inboxThread('910000007777', { limit: 3 });
    assert.equal(t.messages.length, 3);
    assert.deepEqual(t.messages.map(m => m.id), ['pg-4', 'pg-5', 'pg-6'],
      'the three newest, in reading order');
    assert.equal(t.total, 7, 'and it still says how many there are in total');
    assert.equal(t.hasMore, true);
    assert.ok(t.nextBefore);
  });

  test('paging back reaches every message exactly once, across timestamp ties', () => {
    const seen = [];
    let before = null, guard = 0;
    do {
      const page = inboxThread('910000007777', { before, limit: 3 });
      seen.push(...page.messages.map(m => m.id));
      before = page.nextBefore;
    } while (before && ++guard < 10);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7, 'no message is skipped and none is repeated');
  });

  test('the last page reports no more, and hands back no cursor', () => {
    let before = null, page, guard = 0;
    do { page = inboxThread('910000007777', { before, limit: 3 }); before = page.nextBefore; }
    while (before && ++guard < 10);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextBefore, null, 'a cursor that leads nowhere would page forever');
  });

  test('a junk cursor is ignored rather than throwing', () => {
    for (const junk of ['nonsense', '12:', ':45', '-1:-1', 'a:b', '']) {
      const t = inboxThread('910000007777', { before: junk, limit: 3 });
      assert.equal(t.messages.length, 3, `"${junk}" should fall back to the newest page`);
    }
  });

  test('a page size beyond the ceiling is clamped, not honoured', () => {
    // The ceiling is what stops a crafted request pulling a 200k-row thread
    // into memory in one response.
    assert.ok(inboxThread('910000000008', { limit: 99999 }).messages.length <= 200);
  });
}

console.log('\ninbox — search');
{
  seedThread('910000008881', 'Asha Rao',  1700000000000, 1700000000000);
  seedThread('910000008882', 'Rahul Mehta', 1700000000000, 1700000000000);
  const say = (wamid, waId, body, at) =>
    testDb.prepare('INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(wamid, waId, 'in', 'text', body, at);
  say('s-1', '910000008881', 'my invoice never arrived', 9000);
  say('s-2', '910000008881', 'thanks for the invoice',   9001);
  say('s-3', '910000008882', 'where is the receipt',      9002);
  say('s-4', '910000008882', 'discount was 50% off',      9003);
  say('s-5', '910000008882', 'my_order failed',           9004);

  test('a global search finds the word wherever it was said', () => {
    const r = inboxSearch('invoice');
    assert.equal(r.messages.length, 2);
    assert.ok(r.messages.every(m => m.waId === '910000008881'));
    assert.equal(r.messages[0].name, 'Asha Rao', 'results name the person, not just the number');
  });

  test('search is newest first', () => {
    const r = inboxSearch('invoice');
    assert.ok(r.messages[0].at >= r.messages[1].at);
  });

  test('scoping to a thread excludes every other conversation', () => {
    assert.equal(inboxSearch('the', { waId: '910000008882' }).messages
      .every(m => m.waId === '910000008882'), true);
    assert.equal(inboxSearch('invoice', { waId: '910000008882' }).messages.length, 0);
  });

  // % and _ are LIKE wildcards. Unescaped, "50%" matches every message ever
  // sent — which reads as a broken search rather than a broken query.
  test('a percent sign is a literal, not a wildcard', () => {
    const r = inboxSearch('50%');
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].id, 's-4');
  });

  test('an underscore is a literal, not a single-character wildcard', () => {
    const r = inboxSearch('my_order');
    assert.equal(r.messages.length, 1, 'unescaped, this would also match "my order"');
    assert.equal(r.messages[0].id, 's-5');
  });

  test('a backslash does not corrupt the escape sequence', () => {
    assert.doesNotThrow(() => inboxSearch('back\\slash'));
    assert.doesNotThrow(() => inboxSearch('\\'));
  });

  test('a global search also finds people by name and by number', () => {
    const byName = inboxSearch('Rahul');
    assert.ok(byName.people.some(p => p.waId === '910000008882'));
    const byNumber = inboxSearch('910000008881');
    assert.ok(byNumber.people.some(p => p.waId === '910000008881'));
  });

  test('a thread-scoped search returns no people — you know who it is', () => {
    assert.deepEqual(inboxSearch('Rahul', { waId: '910000008882' }).people, []);
  });

  test('one character is refused rather than matching most of the database', () => {
    const r = inboxSearch('a');
    assert.equal(r.tooShort, true);
    assert.deepEqual(r.messages, []);
  });

  test('an empty or missing query is not an error', () => {
    for (const q of ['', '   ', null, undefined]) {
      assert.equal(inboxSearch(q).tooShort, true);
    }
  });

  test('a term that matches nothing is an empty result, not a failure', () => {
    const r = inboxSearch('zzzznothinghere');
    assert.equal(r.tooShort, false);
    assert.deepEqual(r.messages, []);
    assert.deepEqual(r.people, []);
  });
}

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
  assert.deepEqual(names, ['campaign_runs', 'contacts', 'csv_uploads', 'media', 'media_assets',
                           'messages', 'run_recipients', 'suppressed', 'templates', 'threads',
                           'webhook_events']);
});
test('the schema creates the thread and run indexes', () => {
  const d = openDb(':memory:');
  const names = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names, ['idx_contacts_enabled', 'idx_messages_run', 'idx_messages_thread',
                           'idx_run_recipients_pending', 'idx_run_recipients_retry']);
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
    assert.ok(cols(d, 'messages').includes('asset_id'),
      'outbound media links to media_assets and never to the media table — that one lives in ' +
      'MEDIA_DIR and is swept at 90 days, which would delete the price list');
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

  // The classifier gate. saveUpload used to trust the declared mime type, which
  // was the one path lib/filerisk did not cover — and this path is the one that
  // reaches every dealer on the list.
  test('an executable wearing a PDF name and a PDF mime type is refused', () => {
    const r = saveUpload(file(
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(512)]), 'price-list.pdf', 'application/pdf'));
    assert.equal(r.ok, false,
      'the operator is authenticated, but an authenticated operator can still be handed a file ' +
      'and asked to forward it — the bytes are the only signal that does not lie');
    assert.match(r.error, /refused/i, 'and the refusal has to say what to do next');
  });

  test('a real PDF still uploads — the gate refuses block, not everything', () => {
    const r = saveUpload(file(Buffer.from('%PDF-1.7 a genuine document'), 'real.pdf', 'application/pdf'));
    assert.equal(r.ok, true,
      'a PDF caps at the ok tier by design, and it is the single most common thing this business sends');
  });

  test('a macro-capable document is allowed through, not blocked', () => {
    // 'warn', not 'block'. Refusing every archive and macro-capable document
    // would stop an operator sending a legitimate spreadsheet, and the operator
    // is the one person in this system who is already trusted.
    const r = saveUpload(file(Buffer.from('PK xlsx-ish'), 'prices.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
    assert.equal(r.ok, true, r.error);
  });

  // Storage management. The library only ever grew, which was fine for a few
  // template headers a month and is not fine now that every inbox send writes
  // here. Deletion is the operator's call, never a timer's — and the server
  // refuses any delete that would leave history unable to say what it sent.
  test('an unused file can be deleted and the bytes actually leave the disk', () => {
    const r = saveUpload(file(Buffer.from(`%PDF-1.7 disposable ${Math.random()}`),
                              'old-list.pdf', 'application/pdf'));
    assert.equal(r.ok, true, r.error);
    const p = assetPath(r.asset);
    assert.ok(fsx.existsSync(p));

    const d = deleteAsset(r.asset.id);
    assert.equal(d.ok, true, d.error);
    assert.ok(!fsx.existsSync(p), 'freeing disk is the entire point — a row-only delete leaks it');
    assert.equal(getAsset(r.asset.id), undefined, 'and the library must not list a file that is gone');
  });

  test('a file a sent message points at is refused, naming what uses it', () => {
    const r = saveUpload(file(Buffer.from(`%PDF-1.7 in-use ${Math.random()}`),
                              'sent-list.pdf', 'application/pdf'));
    db.prepare('INSERT OR IGNORE INTO messages (wamid, wa_id, dir, type, body, at, status, asset_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(`del-guard-${r.asset.id}`, '919000000009', 'out', 'document', 'x', Date.now(), 'sent', r.asset.id);

    const d = deleteAsset(r.asset.id);
    assert.equal(d.ok, false,
      'deleting it would leave a thread showing a file nothing can identify');
    assert.match(d.error, /sent message/,
      'and the refusal has to name what is holding it, or the operator just tries again');
    assert.ok(fsx.existsSync(assetPath(r.asset)), 'a refused delete must not have removed the bytes');
  });

  test('a file a campaign used as its header is refused', () => {
    const r = saveUpload(file(Buffer.from(`%PDF-1.7 header ${Math.random()}`),
                              'header.pdf', 'application/pdf'));
    db.prepare('INSERT INTO campaign_runs (started_at, label, header_asset) VALUES (?,?,?)')
      .run(Date.now(), 'used-header', r.asset.id);
    const d = deleteAsset(r.asset.id);
    assert.equal(d.ok, false, 'a campaign report must always be able to say what it sent');
    assert.match(d.error, /campaign/);
  });

  test('deleting a file that is not there is a sentence, not a crash', () => {
    const d = deleteAsset(999999);
    assert.equal(d.ok, false);
    assert.match(d.error, /not in the library/);
  });

  test('a row whose path escapes UPLOAD_DIR is refused, not followed', () => {
    const r = saveUpload(file(Buffer.from(`%PDF-1.7 traversal ${Math.random()}`),
                              'ok.pdf', 'application/pdf'));
    // `path` is a column, and a column is data. A corrupted or crafted row must
    // not be able to unlink something outside the uploads directory.
    db.prepare('UPDATE media_assets SET path = ? WHERE id = ?')
      .run('../../../../etc/passwd', r.asset.id);
    const d = deleteAsset(r.asset.id);
    assert.equal(d.ok, false, 'the guard is the whole reason this delete is safe to expose');
    assert.match(d.error, /outside the uploads directory/);
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

// ── Sending a file into the service window ────────────────────────────────────
// The half of the 131049 answer the retry ladder cannot give: the per-user
// marketing cap does not apply inside the 24-hour window, so a free-form send
// here reaches people no amount of retrying a marketing template will.
console.log('\ninbox — sendMedia');
{
  const openThread = (waId, name) => {
    const now = Date.now();
    testDb.prepare('INSERT OR REPLACE INTO threads (wa_id, name, unread, last_inbound_at, last_at) VALUES (?,?,0,?,?)')
      .run(waId, name, now, now);
  };
  // media_id is stamped fresh so ensureMediaId answers from the row instead of
  // uploading. These tests are about sendMedia; the 29-day refresh has its own.
  const seedAsset = () => {
    const a = saveUpload({
      buffer: Buffer.from(`%PDF-1.7 price list ${Math.random()}`),
      originalname: 'price-list.pdf', mimetype: 'application/pdf' }).asset;
    testDb.prepare('UPDATE media_assets SET media_id = ?, media_id_at = ? WHERE id = ?')
      .run(`mid-${a.id}`, Date.now(), a.id);
    return a;
  };

  // stubGraph swaps global.fetch, so the arguments are (url, opts) — the JSON
  // body Meta receives is opts.body, already serialised.
  const bodyOf = opts => JSON.parse(opts.body);

  const withCreds = async fn => {
    const CFGx = require('./src/config').CFG;
    const savedToken = CFGx.accessToken, savedPhone = CFGx.phoneNumberId;
    CFGx.accessToken = 'test-token'; CFGx.phoneNumberId = '1234567890';
    try { return await fn(); }
    finally { CFGx.accessToken = savedToken; CFGx.phoneNumberId = savedPhone; }
  };

  testAsync('media outside the window is refused without calling the network', async () => {
    let called = false;
    const restore = stubGraph(async () => { called = true; throw new Error('must not send'); });
    try {
      testDb.prepare("INSERT OR REPLACE INTO threads (wa_id, name, unread, last_inbound_at, last_at) VALUES ('919700000010','Closed',0,1,1)").run();
      const r = await sendMedia('919700000010', seedAsset().id, 'Price list');
      assert.equal(r.ok, false,
        'Meta would reject this as 131047 — refusing locally gives the operator a sentence instead of a code');
      assert.match(r.error, /24-hour reply window/);
      assert.equal(called, false, 'and it must not spend a Graph call to find that out');
    } finally { restore(); }
  });

  testAsync('an asset that is no longer in the library fails with a sentence, not a throw', async () => {
    openThread('919700000011', 'Asha');
    const r = await sendMedia('919700000011', 999999, 'here you go');
    assert.equal(r.ok, false, 'a deleted asset must not throw past the route');
    assert.match(r.error, /library/i, 'and must say what to do about it');
  });

  testAsync('an over-long caption is refused before anything else happens', async () => {
    openThread('919700000012', 'Rahul');
    const r = await sendMedia('919700000012', seedAsset().id, 'x'.repeat(CAPTION_LIMIT + 1));
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(String(CAPTION_LIMIT)),
      'Meta rejects an over-long caption with a code that never mentions the caption');
  });

  testAsync('a document send carries the filename and stores asset_id, not a media row', async () => {
    openThread('919700000013', 'Marco');
    const asset = seedAsset();
    let sent = null;
    const restore = stubGraph(async (url, opts) => {
      sent = bodyOf(opts);
      return { ok: true, headers: new Map(), json: async () => ({ messages: [{ id: 'media-out-1' }] }) };
    });
    try {
      await withCreds(async () => {
        const r = await sendMedia('919700000013', asset.id, 'August price list');
        assert.equal(r.ok, true, r.error);
        assert.equal(sent.type, 'document', 'Meta nests the descriptor under a key named after the type');
        assert.equal(sent.document.caption, 'August price list');
        assert.equal(sent.document.filename, 'price-list.pdf',
          'filename is meaningful on a document — without it the dealer sees a random id');

        const row = testDb.prepare("SELECT * FROM messages WHERE wamid = 'media-out-1'").get();
        assert.equal(row.asset_id, asset.id,
          'outbound media points at media_assets; the media table is swept at 90 days and would delete it');
        assert.equal(row.run_id, null, 'an inbox send is not campaign traffic');
        assert.equal(row.type, 'document');
        assert.equal(testDb.prepare("SELECT count(*) AS n FROM media WHERE wamid = 'media-out-1'").get().n, 0,
          'nothing outbound may ever land in the inbound media table');
      });
    } finally { restore(); }
  });

  testAsync('with no caption the filename stands in as the body', async () => {
    openThread('919700000014', 'Sarah');
    const asset = seedAsset();
    const restore = stubGraph(async () => ({
      ok: true, headers: new Map(), json: async () => ({ messages: [{ id: 'media-out-2' }] }) }));
    try {
      await withCreds(async () => {
        await sendMedia('919700000014', asset.id, '');
        const row = testDb.prepare("SELECT body FROM messages WHERE wamid = 'media-out-2'").get();
        assert.match(row.body, /price-list\.pdf/,
          'a NULL body is a blank line in the transcript, the search index and the thread preview');
      });
    } finally { restore(); }
  });

  testAsync('the sent file appears in the transcript as outbound media', async () => {
    openThread('919700000015', 'Asha');
    const asset = seedAsset();
    const restore = stubGraph(async () => ({
      ok: true, headers: new Map(), json: async () => ({ messages: [{ id: 'media-out-3' }] }) }));
    try {
      await withCreds(async () => {
        await sendMedia('919700000015', asset.id, 'list');
        const m = inboxThread('919700000015').messages.find(x => x.id === 'media-out-3');
        assert.ok(m.outMedia, 'without this the operator cannot see what they sent');
        assert.equal(m.outMedia.filename, 'price-list.pdf');
        assert.equal(m.outMedia.kind, 'document');
        assert.equal(m.media, null,
          'outMedia is a separate key: inbound carries a risk verdict, an expiry and a ' +
          'Keep/Discard decision, and none of those mean anything for the operator own file');
      });
    } finally { restore(); }
  });

  test('the inbox never learns about the opt-out list', () => {
    const src = require('fs').readFileSync('./src/services/inbox.js', 'utf8');
    assert.ok(!/require\('\.\/contacts'\)/.test(src),
      'someone who opted out of promotions and then writes in still deserves an answer — ' +
      'and a reply with a file attached is still a reply, not a marketing message');
  });
}

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
                   'config','configured','currentContact','limits','disabledCount','contacts','optOutLabel']) {
    assert.ok(k in st, `buildState lost the "${k}" key`);
  }
});

const fsx   = require('node:fs');
const pathx = require('node:path');
const osx   = require('node:os');

// ── P2a: one list, one switch ─────────────────────────────────────────────────
console.log('\ncontacts — enable / disable');
{
  const C = require('./server').contacts;
  let seq = 0;
  const phone = () => `9199000${String(++seq).padStart(4, '0')}`;
  const csv = rows => Buffer.from('Name,Mobile Phone\n' + rows.map(r => r.join(',')).join('\n') + '\n');

  test('an unknown number is not disabled — the test-send box accepts typed numbers', () => {
    assert.equal(C.isDisabled('919888800001'), false);
    assert.equal(C.isEnabled('919888800001'), true);
  });

  test('disable creates the row when the contact has never been in a CSV', () => {
    const p = phone();
    assert.equal(C.disable(p, 'opt_out'), true);
    assert.equal(C.isDisabled(p), true);
    assert.equal(C.getRow(p).disabled_reason, 'opt_out');
  });

  test('disabling twice for the same reason is not a second event', () => {
    const p = phone();
    assert.equal(C.disable(p, 'opt_out'), true);
    assert.equal(C.disable(p, 'opt_out'), false,
      'a webhook redelivery of one opt-out tap is not two opt-outs');
  });

  test('a later reason overwrites an earlier one', () => {
    const p = phone();
    C.disable(p, 'manual');
    assert.equal(C.disable(p, 'failed_hard'), true);
    assert.equal(C.getRow(p).disabled_reason, 'failed_hard');
  });

  test('an unknown reason is stored as manual rather than written verbatim', () => {
    const p = phone();
    C.disable(p, 'whatever');
    assert.equal(C.getRow(p).disabled_reason, 'manual');
  });

  test('enable clears the reason, and enabling an unknown number is a no-op', () => {
    const p = phone();
    C.disable(p, 'manual');
    assert.equal(C.enable(p), true);
    assert.equal(C.isDisabled(p), false);
    assert.equal(C.getRow(p).disabled_reason, null);
    assert.equal(C.enable('919888800002'), false, 'nothing to enable is not a change');
  });

  // THE test for this phase. `enabled` is absent from the upsert's SET list on
  // purpose, and an absence is exactly what a future contributor "fixes" by
  // helpfully adding `enabled = excluded.enabled`.
  test('re-uploading the same CSV never resurrects someone who opted out', () => {
    const p = phone();
    const file = csv([['Asha', p]]);
    C.upsertFromCsv(parseCSV(file).contacts, { filename: 'list.csv' });
    C.disable(p, 'opt_out');

    C.upsertFromCsv(parseCSV(file).contacts, { filename: 'list.csv' });
    assert.equal(C.isDisabled(p), true, 'a re-upload must not undo an opt-out');
    assert.equal(C.getRow(p).disabled_reason, 'opt_out');
  });

  test('the upsert refreshes the name but never first_seen', () => {
    const p = phone();
    C.upsertFromCsv(parseCSV(csv([['Asha', p]])).contacts, {});
    const first = C.getRow(p).first_seen;
    assert.equal(C.getRow(p).name, 'Asha');

    C.upsertFromCsv(parseCSV(csv([['Asha Rao', p]])).contacts, {});
    assert.equal(C.getRow(p).name, 'Asha Rao', 'a corrected name should stick');
    assert.equal(C.getRow(p).first_seen, first, 'but the contact is not newly seen');
  });

  test('extra CSV columns are stored verbatim for a later phase to read', () => {
    const p = phone();
    const file = Buffer.from(`Name,Mobile Phone,City\nAsha,${p},Pune\n`);
    C.upsertFromCsv(parseCSV(file).contacts, {});
    assert.deepEqual(JSON.parse(C.getRow(p).fields_json), { City: 'Pune' });
  });

  test('the upload is recorded with what happened to the file', () => {
    const p = phone();
    const file = Buffer.from(`Name,Mobile Phone\nAsha,${p}\nGhost,not-a-number\n`);
    const { contacts: parsed, skipped } = parseCSV(file);
    const r = C.upsertFromCsv(parsed, { filename: 'mixed.csv', skippedCount: skipped.length });
    assert.equal(r.rowCount, 1);
    assert.equal(r.newCount, 1);
    assert.equal(r.skippedCount, 1, 'the row the parser could not read is on the record');

    const again = C.upsertFromCsv(parsed, { filename: 'mixed.csv', skippedCount: 0 });
    assert.equal(again.newCount, 0, 'the second upload introduces nobody new');
  });

  test('counts separate enabled from disabled', () => {
    const before = C.counts();
    const p = phone();
    C.upsertFromCsv(parseCSV(csv([['Asha', p]])).contacts, {});
    assert.equal(C.counts().enabled, before.enabled + 1);
    C.disable(p, 'manual');
    assert.equal(C.counts().disabled, before.disabled + 1);
    assert.equal(C.counts().total, before.total + 1);
  });

  test('the disabled list carries the reason, for the operator and for Meta', () => {
    const p = phone();
    C.disable(p, 'opt_out');
    const row = C.disabledRows().find(r => r.phone === p);
    assert.ok(row, 'a disabled contact must appear on the list you can hand over');
    assert.equal(row.disabled_reason, 'opt_out');
    assert.ok(row.disabled_at > 0);
  });

  // The decision that makes this a switch and not a blocklist: disabled stops
  // CAMPAIGNS and nothing else. services/inbox.js does not import this module
  // at all, and that is the enforcement.
  test('nothing in the inbox path consults the enabled column', () => {
    const src = fsx.readFileSync('./src/services/inbox.js', 'utf8');
    assert.ok(!/services\/contacts|isDisabled|isEnabled/.test(src),
      'a disabled contact who writes in still deserves an answer');
  });
}

console.log('\ncontacts — opt-outs.json import');
{
  const C = require('./server').contacts;
  const tmp = () => pathx.join(osx.tmpdir(), `wa-optouts-${process.pid}-${Date.now()}-${Math.random()}.json`);

  test('the old flat file folds into contacts as opt_out, then gets renamed away', () => {
    const f = tmp();
    fsx.writeFileSync(f, JSON.stringify(['919777700001', '919777700002']));
    const r = C.migrateOptOuts({ optOuts: f });
    assert.equal(r.imported, 2);
    assert.equal(C.getRow('919777700001').disabled_reason, 'opt_out');
    assert.ok(!fsx.existsSync(f), 'the source is renamed so a later boot has nothing to find');
    assert.ok(fsx.existsSync(`${f}.migrated`));
    fsx.rmSync(`${f}.migrated`, { force: true });
  });

  test('a missing file is a no-op, not an error', () => {
    assert.deepEqual(C.migrateOptOuts({ optOuts: tmp() }), { imported: 0, skipped: true });
  });

  test('an unreadable file is left in place rather than renamed away', () => {
    const f = tmp();
    fsx.writeFileSync(f, '{ this is not json');
    const r = C.migrateOptOuts({ optOuts: f });
    assert.equal(r.imported, 0);
    assert.ok(fsx.existsSync(f), 'renaming it would declare success on a silent loss of the list');
    fsx.rmSync(f, { force: true });
  });
}

// ── P2b: the queue on disk ────────────────────────────────────────────────────
console.log('\nrun_recipients — the send queue');
{
  const M = require('./server');
  const C = M.contacts;
  const { buildRun, nextPending, recordRecipientSent, recordRecipientSkipped,
          progressForRun, skippedForRun, recipientsForRun } = M;

  let runSeq = 0;
  const newRun = () => Number(db.prepare('INSERT INTO campaign_runs (started_at, label) VALUES (?, ?)')
    .run(Date.now(), `t${++runSeq}`).lastInsertRowid);
  let pseq = 0;
  const people = n => Array.from({ length: n }, (_, i) => ({
    name: `P${i}`, dialStr: `9198800${String(++pseq).padStart(5, '0')}` }));

  test('a run stages every contact in order, and pending starts at the first', () => {
    const run = newRun();
    const p = people(3);
    const prog = buildRun(run, p);
    assert.equal(prog.total, 3);
    assert.equal(prog.pending, 3);
    assert.equal(nextPending(run).phone, p[0].dialStr, 'seq order, not insertion luck');
  });

  test('pending advances only when a row is actually resolved', () => {
    const run = newRun();
    const p = people(3);
    buildRun(run, p);

    recordRecipientSent(run, p[0].dialStr, 'wamid.a');
    assert.equal(nextPending(run).phone, p[1].dialStr);

    recordRecipientSkipped(run, p[1].dialStr, 'failed', 131000);
    assert.equal(nextPending(run).phone, p[2].dialStr);

    recordRecipientSent(run, p[2].dialStr, 'wamid.c');
    assert.equal(nextPending(run), null, 'an exhausted queue is null, not an index past the end');
    assert.deepEqual(progressForRun(run), { total: 3, sent: 2, skipped: 1, disabled: 0, retrying: 0, pending: 0 });
  });

  // The whole reason this table exists. The old design saved an integer, and an
  // integer a crash leaves ahead of reality silently skips people.
  test('resume after a crash re-reads the queue and repeats nobody', () => {
    const run = newRun();
    const p = people(5);
    buildRun(run, p);
    recordRecipientSent(run, p[0].dialStr, 'wamid.0');
    recordRecipientSent(run, p[1].dialStr, 'wamid.1');

    // "Crash": nothing in memory survives. The queue is asked again from zero.
    assert.equal(nextPending(run).phone, p[2].dialStr,
      'resume lands on the first unsent row, derived from what was actually sent');
    const sent = recipientsForRun(run).filter(r => r.wamid).map(r => r.phone);
    assert.deepEqual(sent, [p[0].dialStr, p[1].dialStr], 'and nobody already messaged is queued again');
  });

  test('a disabled contact is staged as a skipped row, not left out', () => {
    const run = newRun();
    const p = people(3);
    C.upsertFromCsv(p, {});
    C.disable(p[1].dialStr, 'opt_out');
    const prog = buildRun(run, p, phone => (C.isDisabled(phone) ? 'disabled' : null));

    assert.equal(prog.total, 3, 'they are still on the list');
    assert.equal(prog.disabled, 1);
    assert.equal(prog.pending, 2, 'but the loop never reaches them');
    assert.equal(nextPending(run).phone, p[0].dialStr);

    const report = skippedForRun(run);
    assert.equal(report.length, 1);
    assert.equal(report[0].phone, p[1].dialStr,
      'a row that was never inserted could not tell the operator anything');
    assert.equal(report[0].skipped_reason, 'disabled');
  });

  test('the skip report carries the Meta code that caused each one', () => {
    const run = newRun();
    const p = people(2);
    buildRun(run, p);
    recordRecipientSkipped(run, p[0].dialStr, 'skipped', 131049);
    recordRecipientSkipped(run, p[1].dialStr, 'failed', 132001);
    const byPhone = Object.fromEntries(skippedForRun(run).map(r => [r.phone, r]));
    assert.equal(byPhone[p[0].dialStr].error_code, 131049);
    assert.equal(byPhone[p[1].dialStr].skipped_reason, 'failed');
    assert.ok(byPhone[p[0].dialStr].attempted_at > 0);
  });

  test('rebuilding a run replaces its queue rather than doubling it', () => {
    const run = newRun();
    const p = people(2);
    buildRun(run, p);
    const again = buildRun(run, p);
    assert.equal(again.total, 2, 'a primary key on (run_id, phone) is not enough on its own');
  });

  test('billable follows a disable made after the queue was staged', () => {
    const run = newRun();
    const p = people(3);
    C.upsertFromCsv(p, {});
    buildRun(run, p, phone => (C.isDisabled(phone) ? 'disabled' : null));
    assert.equal(M.billableForRun(run), 3);

    // The loop re-checks and will skip them, so no money is spent either way —
    // but an operator who has just disabled someone expects the number to move.
    C.disable(p[1].dialStr, 'manual');
    assert.equal(M.billableForRun(run), 2, 'the estimate must not go on counting them');
  });

  test('a message already sent stays billable even if the contact is disabled after', () => {
    const run = newRun();
    const p = people(2);
    C.upsertFromCsv(p, {});
    buildRun(run, p);
    recordRecipientSent(run, p[0].dialStr, 'w-billed');
    C.disable(p[0].dialStr, 'opt_out');
    assert.equal(M.billableForRun(run), 2,
      'that message went out and Meta will bill for it regardless of what happened next');
  });

  test('a skipped row costs nothing and is not billable', () => {
    const run = newRun();
    const p = people(3);
    buildRun(run, p);
    recordRecipientSkipped(run, p[0].dialStr, 'failed', 132001);
    assert.equal(M.billableForRun(run), 2);
  });

  test('billable for no run is zero, never a throw', () => {
    assert.equal(M.billableForRun(null), 0);
  });

  test('progress for no run at all is zeroes, never a throw', () => {
    assert.deepEqual(progressForRun(null), { total: 0, sent: 0, skipped: 0, disabled: 0, retrying: 0, pending: 0 });
    assert.equal(nextPending(null), null);
    assert.deepEqual(skippedForRun(null), []);
  });

  test('the same person twice in one CSV is staged once', () => {
    const run = newRun();
    const p = people(1);
    const prog = buildRun(run, [p[0], { ...p[0], name: 'Duplicate' }]);
    assert.equal(prog.total, 1, 'the primary key is (run_id, phone)');
  });
}

console.log('\nskipDisposition — the classifier the report groups by');
{
  const { skipDisposition, SKIP_DISPOSITIONS } = require('./server');
  test('every code it returns is one the report knows how to render', () => {
    for (const code of [131026, 131049, 131047, 130429, 132001, 131042, 0, null, undefined]) {
      assert.ok(SKIP_DISPOSITIONS.includes(skipDisposition(code)),
        `skipDisposition(${code}) returned something the report cannot group`);
    }
  });
  test('it never throws, whatever it is handed', () => {
    for (const junk of ['', 'abc', {}, [], NaN, Infinity, -1]) {
      assert.doesNotThrow(() => skipDisposition(junk));
    }
  });

  // The policy itself, asserted per code. These four are the ones the loop
  // branches on, so a change here changes who gets messaged again.
  test('it sorts by whether another attempt could possibly work', () => {
    assert.equal(skipDisposition(131049), 'retry',
      'the per-person marketing cap is about the moment — nothing on our side caused it');
    assert.equal(skipDisposition(-1), 'retry',
      'a network throw is the blip that used to drop contact #340 from a run forever');
    assert.equal(skipDisposition(131026), 'permanent',
      'undeliverable is a property of the number; retrying it is never right');
    assert.equal(skipDisposition(132015), 'fix',
      'a paused template fails identically on every retry until a human fixes it');
    assert.equal(skipDisposition(131047), 'fix',
      'outside the 24h window is our bug — we sent the wrong kind of message');
  });

  test('a code the table has never seen is unclassified, not guessed', () => {
    assert.equal(skipDisposition(999999), 'unclassified',
      'a new Meta code must not silently cost re-sends, nor silently write someone off');
  });
}

// ── Quiet hours ───────────────────────────────────────────────────────────────
// The retry ladder now runs for up to a day, so a rung can land at 3am. Delivery
// would work; what breaks is the quality rating, because a night notification is
// what a dealer blocks and reports — and the quality rating gates the messaging
// tier. Every assertion below is on a fixed timestamp, so none of them wait.
console.log('\nlib/schedule — retries do not fire in the middle of the night');
{
  const { deferPastQuietHours, IST_OFFSET_MS } = require('./server');

  // IST instants built out of UTC, so these mean the same thing on a laptop in
  // IST and on a server in UTC. 18:30 UTC is 00:00 IST the following day.
  const ist = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 5, min - 30);

  test('a daytime deadline is left exactly where it is', () => {
    const at = ist(2026, 8, 14, 14, 0);
    assert.equal(deferPastQuietHours(at), at,
      'deferring a 2pm retry would delay every rung in the working day for no reason');
  });

  test('a deadline just before the window is left alone', () => {
    const at = ist(2026, 8, 14, 22, 59);
    assert.equal(deferPastQuietHours(at), at,
      '22:59 is outside a 23:00-07:00 window and must fire on time');
  });

  test('a late-evening deadline moves to 8am the NEXT morning', () => {
    assert.equal(deferPastQuietHours(ist(2026, 8, 14, 23, 30)), ist(2026, 8, 15, 8, 0),
      'the next morning after the 14th is the 15th — landing back on the 14th would be in the past');
  });

  test('an after-midnight deadline moves to 8am the SAME morning', () => {
    assert.equal(deferPastQuietHours(ist(2026, 8, 15, 2, 0)), ist(2026, 8, 15, 8, 0),
      '02:00 IST is already the 15th, and pushing it to the 16th would cost the contact a whole day');
  });

  test('the window is closed at its start and open at its end', () => {
    assert.equal(deferPastQuietHours(ist(2026, 8, 14, 23, 0)), ist(2026, 8, 15, 8, 0),
      '23:00:00 exactly is inside the quiet window');
    const seven = ist(2026, 8, 15, 7, 0);
    assert.equal(deferPastQuietHours(seven), seven,
      '07:00:00 exactly is outside it — the window is [23:00, 07:00)');
  });

  test('the hour between 07:00 and 08:00 is grace, not a gap', () => {
    const halfSeven = ist(2026, 8, 15, 7, 30);
    assert.equal(deferPastQuietHours(halfSeven), halfSeven,
      'a deadline that reached 07:30 on its own is a morning deadline; 08:00 is only where a ' +
      "deferred night's worth of retries is released, staggered off the moment people wake");
  });

  test('quiet hours are IST whatever timezone the server runs in', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      assert.equal(deferPastQuietHours(ist(2026, 8, 14, 23, 30)), ist(2026, 8, 15, 8, 0),
        'the deployment host may not run in IST, and the dealers always do');
    } finally { process.env.TZ = saved; }
  });

  test('a non-wrapping window would still be handled correctly', () => {
    // Nothing configures this today. It is asserted because the wrap-aware
    // branch is the kind of code a later reader "simplifies" to a plain range
    // check, and this is the case that would then break silently.
    const noon = ist(2026, 8, 14, 12, 0);
    assert.equal(deferPastQuietHours(noon, { start: 11, end: 14, resumeAt: 14 }),
      ist(2026, 8, 14, 14, 0), 'a window inside one day defers forward within that day');
  });

  test('IST_OFFSET_MS is the whole zone, with no daylight saving to track', () => {
    assert.equal(IST_OFFSET_MS, 5.5 * 3600000,
      'India has one offset year-round, which is why this is a constant and not a lookup');
  });
}

// ── The retry ladder ──────────────────────────────────────────────────────────
// A failure that was about the MOMENT goes back on the queue with a deadline
// instead of being dropped. Everything below asserts that the deadline lives in
// SQL and that a row waiting on one is counted as pending, never as finished.
console.log('\nrun_recipients — retrying a moment-based failure');
{
  const M = require('./server');
  const { buildRun, nextPending, recordRecipientSent, recordRecipientSkipped,
          recordRecipientRetry, nextRetryForRun, progressForRun, billableForRun,
          skippedForRun, lastRunSummary, campaignActive, campaignBlocker,
          scheduleRetry, RETRY_BACKOFF_MS, IST_OFFSET_MS } = M;

  let runSeq = 0;
  const newRun = () => Number(db.prepare('INSERT INTO campaign_runs (started_at, label) VALUES (?, ?)')
    .run(Date.now(), `r${++runSeq}`).lastInsertRowid);
  let pseq = 0;
  const people = n => Array.from({ length: n }, (_, i) => ({
    name: `R${i}`, dialStr: `9198900${String(++pseq).padStart(5, '0')}` }));
  const rowFor = (run, phone) => db
    .prepare('SELECT attempts, retry_after, skipped_reason FROM run_recipients WHERE run_id = ? AND phone = ?')
    .get(run, phone);

  const HOUR_MS = 3600000;

  test('a contact on the ladder is invisible until its deadline, then pending again', () => {
    const run = newRun();
    const p = people(2);
    buildRun(run, p);
    const due = Date.now() + HOUR_MS;
    recordRecipientRetry(run, p[0].dialStr, 131049, due);

    assert.equal(nextPending(run).phone, p[1].dialStr,
      'the run carries on with everyone else rather than stalling on one contact');
    recordRecipientSent(run, p[1].dialStr, 'wamid.r1');
    assert.equal(nextPending(run), null, 'nothing is sendable while the backoff is running');
    assert.equal(nextPending(run, due).phone, p[0].dialStr,
      'and the same query hands them back the moment the deadline passes');
  });

  test('a waiting contact counts as pending, never as skipped or finished', () => {
    const run = newRun();
    const p = people(3);
    buildRun(run, p);
    recordRecipientSent(run, p[0].dialStr, 'wamid.r2');
    recordRecipientRetry(run, p[1].dialStr, -1, Date.now() + HOUR_MS);

    const prog = progressForRun(run);
    assert.equal(prog.retrying, 1);
    assert.equal(prog.skipped, 0, 'nobody has been given up on');
    assert.equal(prog.pending, 2,
      'folding a waiting contact into skipped would report the run finished with people still queued');
  });

  test('a waiting contact is still billable — that message is still going out', () => {
    const run = newRun();
    const p = people(2);
    buildRun(run, p);
    recordRecipientRetry(run, p[0].dialStr, 131049, Date.now() + HOUR_MS);
    assert.equal(billableForRun(run), 2,
      'the estimate must not drop just because one send was deferred');
  });

  test('the earliest deadline is what the loop sleeps to', () => {
    const run = newRun();
    const p = people(3);
    buildRun(run, p);
    const soon = Date.now() + HOUR_MS;
    recordRecipientRetry(run, p[0].dialStr, 131049, soon + 2 * HOUR_MS);
    recordRecipientRetry(run, p[1].dialStr, 131049, soon);

    const next = nextRetryForRun(run);
    assert.equal(next.at, soon, 'min(), so the loop wakes for whoever is due first');
    assert.equal(next.count, 2);
    recordRecipientSent(run, p[2].dialStr, 'wamid.r3');
    assert.equal(progressForRun(run).pending, 2, 'and the run stays open for both of them');
  });

  test('a send that succeeds after waiting is a sent row, not a retrying one', () => {
    const run = newRun();
    const p = people(1);
    buildRun(run, p);
    recordRecipientRetry(run, p[0].dialStr, -1, Date.now() - 1);
    recordRecipientSent(run, p[0].dialStr, 'wamid.r4');

    const prog = progressForRun(run);
    assert.deepEqual([prog.sent, prog.retrying, prog.pending], [1, 0, 0],
      'leaving skipped_reason set would count one person in two buckets at once');
    assert.deepEqual(skippedForRun(run), [], 'and they do not appear in the skip report');
  });

  test('the ladder is five waits, then the failure is reported rather than retried', () => {
    const run = newRun();
    const p = people(1);
    const saved = S.currentRunId;
    S.currentRunId = run;
    try {
      buildRun(run, p);
      const contact = { name: p[0].name, dialStr: p[0].dialStr };
      const fail    = { errorCode: 131049, error: 'cap', hint: null };

      for (let i = 0; i < RETRY_BACKOFF_MS.length; i++) {
        const row = nextPending(run, Date.now() + 99 * HOUR_MS);
        assert.equal(row.attempts, i, 'attempts is read off the row, never off a counter in the loop');
        assert.equal(scheduleRetry(contact, row, fail, '[t]'), true);
        const after = rowFor(run, p[0].dialStr);
        assert.equal(after.attempts, i + 1);
        assert.ok(after.retry_after - Date.now() > RETRY_BACKOFF_MS[i] - 5000,
          `wait ${i + 1} is about ${RETRY_BACKOFF_MS[i] / HOUR_MS}h`);
      }

      const exhausted = nextPending(run, Date.now() + 99 * HOUR_MS);
      assert.equal(scheduleRetry(contact, exhausted, fail, '[t]'), false,
        'six attempts is the whole ladder — a seventh would discover nothing new, and a run ' +
        'that never stops retrying is a run that never closes');
    } finally { S.currentRunId = saved; }
  });

  test('the ladder is five even rungs of three hours', () => {
    assert.equal(RETRY_BACKOFF_MS.length, 5,
      'three rungs over seven hours closed runs with people still owed a message, because ' +
      '131049 is a rolling per-person cap and not a counter that resets');
    assert.ok(RETRY_BACKOFF_MS.every(ms => ms === 3 * HOUR_MS),
      'even spacing is what makes the ladder explainable to an operator');
  });

  test('a stored retry deadline never lands in the middle of the night', () => {
    const run = newRun();
    const p = people(1);
    const saved = S.currentRunId;
    S.currentRunId = run;
    try {
      buildRun(run, p);
      scheduleRetry({ name: p[0].name, dialStr: p[0].dialStr }, { attempts: 0 },
        { errorCode: 131049, error: 'cap' }, '[t]');
      const at = rowFor(run, p[0].dialStr).retry_after;
      const hourIST = new Date(at + IST_OFFSET_MS).getUTCHours();
      assert.ok(hourIST >= 7 && hourIST < 23,
        `a retry was stored for ${hourIST}:00 IST — the deferral has to happen before the ` +
        'row is written, or the queue and the operator disagree about when this contact is due');
    } finally { S.currentRunId = saved; }
  });

  test('a code that is not retryable never goes on the ladder at all', () => {
    const run = newRun();
    const p = people(1);
    const saved = S.currentRunId;
    S.currentRunId = run;
    try {
      buildRun(run, p);
      const row = nextPending(run);
      assert.equal(scheduleRetry({ name: p[0].name, dialStr: p[0].dialStr }, row,
        { errorCode: 131026, error: 'undeliverable' }, '[t]'), false,
        'retrying a number Meta calls undeliverable burns a send slot on every run, forever');
      assert.equal(rowFor(run, p[0].dialStr).attempts, 0);
    } finally { S.currentRunId = saved; }
  });

  // The second half of the ask: one campaign at a time. stageRun REPLACES the
  // queue, so an upload over a live run orphans everyone it had not reached.
  test('an unfinished campaign blocks starting or staging another', () => {
    const savedPhase = S.phase, savedRun = S.currentRunId;
    try {
      const run = newRun();
      buildRun(run, people(4));
      S.currentRunId = run;

      for (const phase of ['running', 'waiting', 'paused']) {
        S.phase = phase;
        assert.equal(campaignActive(), true, `${phase} is an active campaign`);
        assert.match(campaignBlocker(), /before starting another/,
          'and the operator is told what is in the way, not just refused');
      }
      S.phase = 'waiting';
      assert.match(campaignBlocker(), /in progress — retrying/,
        'the ladder now runs for up to a day, and an operator who reads "waiting" assumes the ' +
        'campaign is stuck and presses Stop — abandoning exactly the contacts it exists to recover');

      S.phase = 'idle';
      assert.equal(campaignActive(), false);
      assert.equal(campaignBlocker(), null, 'a stopped run is replaceable — that is the escape hatch');
    } finally { S.phase = savedPhase; S.currentRunId = savedRun; }
  });

  // The duplicate-send hazard the retry ladder made worse. /stop sets the phase
  // to idle at once, but the loop is still inside an await for up to a second
  // after that. If the guard trusted the phase alone, a Start in that window
  // would put a SECOND loop on the same queue.
  test('a campaign that is still stopping blocks a new one, even though the phase says idle', () => {
    const { flags } = M;
    const savedPhase = S.phase, savedRun = S.currentRunId, savedRunning = flags.running;
    try {
      S.currentRunId = null;            // exactly what /api/reset leaves behind
      S.phase = 'idle';                 // what /stop and /reset set immediately
      flags.running = true;             // the loop has not returned yet

      assert.equal(campaignActive(), true,
        'a live loop is an active campaign whatever the phase claims');
      assert.match(campaignBlocker(), /still stopping/,
        'and the refusal says so rather than reporting the zeroes a cleared run would give');

      flags.running = false;            // the loop returned and cleared it itself
      assert.equal(campaignBlocker(), null, 'once the loop is gone, the queue is replaceable');
    } finally { S.phase = savedPhase; S.currentRunId = savedRun; flags.running = savedRunning; }
  });

  // The daily-cap wait is up to a full day, and `flags.running` stays true for
  // every second of it. A bare `await sleep(wait)` here meant a Stop set a flag
  // nothing read until tomorrow — so campaignBlocker() refused every Start and
  // every CSV upload overnight with "still stopping, try again in a second".
  // This drives the real loop into that branch and asserts Stop is answered.
  testAsync('a Stop is answered while the loop is parked on the daily cap', async () => {
    const { flags, startLoop, stageRun } = M;
    const saved = { phase: S.phase, run: S.currentRunId, cap: S.config.dailyCap,
                    count: S.dailyCount, date: S.dailyDate, warmup: W.enabled };
    // The loop calls saveCampaignNow() on its way out, and FILES.campaign is the
    // repo's own campaign.json. Snapshot it so `npm test` leaves it as it found it.
    const fsc = require('node:fs');
    const cfile = require('./src/config').FILES.campaign;
    const hadFile = fsc.existsSync(cfile);
    const fileWas = hadFile ? fsc.readFileSync(cfile, 'utf8') : null;
    try {
      W.enabled = false;                  // effectiveCap() is then S.config.dailyCap
      S.config.dailyCap = 1;
      S.dailyDate  = todayKey();          // so checkDaily() does not reset the count
      S.dailyCount = 5;                   // already over the cap
      stageRun(people(1), 'cap-stop-test');
      S.phase = 'running';
      flags.stopFlag = false; flags.pauseFlag = false;
      startLoop();

      // Long enough for the loop to reach the cap branch and park.
      await new Promise(r => setTimeout(r, 100));
      assert.equal(S.phase, 'paused', 'the loop should be parked on the daily cap');
      assert.equal(flags.running, true, 'and still holding the run');

      flags.stopFlag = true;
      const deadline = Date.now() + 3000;
      while (flags.running && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));

      assert.equal(flags.running, false,
        'the loop must notice a Stop within seconds, not at the next IST midnight — '
        + 'while it is true, campaignBlocker() refuses every Start and CSV upload');
    } finally {
      flags.stopFlag = false;
      Object.assign(S, { phase: saved.phase, currentRunId: saved.run,
                         dailyCount: saved.count, dailyDate: saved.date });
      S.config.dailyCap = saved.cap;
      W.enabled = saved.warmup;
      if (hadFile) fsc.writeFileSync(cfile, fileWas);
      else if (fsc.existsSync(cfile)) fsc.unlinkSync(cfile);
    }
  });

  test('the last campaign is still readable after a reset drops the current run', () => {
    const run = newRun();
    const p = people(2);
    buildRun(run, p);
    recordRecipientSent(run, p[0].dialStr, 'wamid.r5');
    recordRecipientSkipped(run, p[1].dialStr, 'failed', 131047);

    const saved = S.currentRunId;
    S.currentRunId = null;                       // exactly what /api/reset does
    try {
      const last = lastRunSummary();
      assert.equal(last.id, run, 'read from campaign_runs, not from the state a reset just cleared');
      assert.equal(last.progress.sent, 1);
      assert.equal(last.progress.skipped, 1);
      assert.equal(last.unfinished, false, 'every row is resolved, so it really did finish');
    } finally { S.currentRunId = saved; }
  });

  test('a run with contacts still on the ladder reports itself unfinished', () => {
    const run = newRun();
    const p = people(2);
    buildRun(run, p);
    recordRecipientSent(run, p[0].dialStr, 'wamid.r6');
    recordRecipientRetry(run, p[1].dialStr, 131049, Date.now() + HOUR_MS);

    const last = lastRunSummary();
    assert.equal(last.id, run);
    assert.equal(last.unfinished, true,
      'unfinished is derived from the queue, so it survives the process forgetting the run');
    assert.equal(last.nextRetry.count, 1);
  });
}

// ── Progress cannot exceed the list ───────────────────────────────────────────
// The dashboard read "74 of 57 processed, 130%". It was adding numbers that
// come from two different tables: `accepted` counts message ROWS, `skipped`
// counts queue CONTACTS, and a failure appears in both. currentIdx is the only
// honest answer because it asks one table one question.
console.log('\nstate — processed never exceeds the list');
{
  const { buildRun, recordRecipientSent, recordRecipientSkipped, applyStatus } = require('./server');

  test('a webhook failure is not counted twice against the total', () => {
    const run = startRun('progress-webhook-fail');
    const people = Array.from({ length: 3 }, (_, i) => ({ name: `P${i}`, dialStr: `9198700${i}0001` }));
    buildRun(run, people);

    // All three accepted by the API, so all three have a wamid and a row.
    people.forEach((p, i) => {
      recordOutbound({ wamid: `pw-${i}`, waId: p.dialStr, name: p.name, body: 'x', runId: run });
      recordRecipientSent(run, p.dialStr, `pw-${i}`);
    });
    // Meta then reports two of them as undeliverable.
    applyStatus({ id: 'pw-0', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] });
    applyStatus({ id: 'pw-1', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] });

    const s = buildState();
    assert.equal(s.total, 3);
    assert.ok(s.currentIdx <= s.total,
      `processed (${s.currentIdx}) exceeded the list (${s.total}) — a contact was counted more than once`);
    assert.equal(s.currentIdx, 3, 'three contacts were resolved, however their statuses later moved');
    // The old formula, kept here as the thing that must never come back.
    const oldWay = s.accepted + s.failed + s.skipped;
    assert.ok(oldWay > s.total,
      'accepted + failed + skipped is the double count this test exists to prevent regressing to');
  });

  test('an API refusal is not counted twice either', () => {
    const run = startRun('progress-api-fail');
    const people = Array.from({ length: 4 }, (_, i) => ({ name: `Q${i}`, dialStr: `9198700${i}0002` }));
    buildRun(run, people);

    recordOutbound({ wamid: 'qa-0', waId: people[0].dialStr, name: 'Q0', body: 'x', runId: run });
    recordRecipientSent(run, people[0].dialStr, 'qa-0');
    // The Graph API refused these outright: no wamid, no message row, but the
    // queue records them so the skip report can say who was missed.
    recordRecipientSkipped(run, people[1].dialStr, 'failed', 131049);
    recordRecipientSkipped(run, people[2].dialStr, 'skipped', 131026);

    const s = buildState();
    assert.equal(s.total, 4);
    assert.equal(s.currentIdx, 3, 'one sent plus two resolved failures — the fourth is still pending');
    assert.ok(s.currentIdx <= s.total, 'and it can never run past the list');
  });

  test('processed equals the total exactly when a run finishes', () => {
    const run = startRun('progress-complete');
    const people = Array.from({ length: 2 }, (_, i) => ({ name: `R${i}`, dialStr: `9198700${i}0003` }));
    buildRun(run, people);
    recordOutbound({ wamid: 'rc-0', waId: people[0].dialStr, name: 'R0', body: 'x', runId: run });
    recordRecipientSent(run, people[0].dialStr, 'rc-0');
    recordRecipientSkipped(run, people[1].dialStr, 'skipped', 131026);

    const s = buildState();
    assert.equal(s.currentIdx, s.total, 'a finished run must read 100%, not 99% and not 130%');
  });
}

// ── Storage management ────────────────────────────────────────────────────────
// Two stores with two different owners, and the asymmetry between them is the
// whole feature: our uploads can be deleted and renamed, a customer's KEPT file
// cannot be deleted here at all. The UI promised a retention window, and a
// promise an operator can cancel early on a whim is not a retention window.
console.log('\nstorage — overview, listing, rename, bulk removal');
{
  const fsx = require('fs');
  const up = (name = 'lib.pdf') => saveUpload({
    buffer: Buffer.from(`%PDF-1.7 storage ${Math.random()}`),
    originalname: name, mimetype: 'application/pdf' });

  // A local seeder rather than the one in the retention block: that one is
  // defined further down the file and these tests run before it. Only the row
  // matters here — listStored reads the table, and no bytes are ever fetched.
  let sn = 0;
  const seedKept = (bytesLen = 1234) => {
    const id = `mid.storage.${++sn}.${Date.now()}`;
    recordInbound({
      id, from: '910000000007', timestamp: String(Math.floor(Date.now() / 1000)), type: 'image',
      image: { id, mime_type: 'image/jpeg', file_size: bytesLen },
    }, 'Storage Tester');
    db.prepare('UPDATE media SET path = ?, downloaded_at = ?, provisional = 0, file_size = ? WHERE media_id = ?')
      .run(`kept-${id}.jpg`, Date.now(), bytesLen, id);
    return id;
  };

  test('the overview reports the whole volume, not just what this app wrote', () => {
    const o = overview();
    assert.ok(o.volume.total === null || o.volume.total > 0,
      'an operator reading "uploads: 44 MB" cannot tell if that is a problem without the disk size');
    assert.ok(o.volume.free === null || o.volume.free >= 0);
    assert.equal(typeof o.ours, 'number', 'the app total is what the breakdown has to add up to');
    assert.ok(o.breakdown.database.bytes > 0, 'the database is always on this disk');
  });

  test('the breakdown marks which categories can actually be freed', () => {
    const b = overview().breakdown;
    assert.equal(b.uploads.deletable, true,  'our own uploads are ours to remove');
    assert.equal(b.previews.deletable, true, 'a previewed file was never committed to');
    assert.equal(b.kept.deletable, false,
      'a saved customer file goes at the end of its retention window, not when someone wants space');
    assert.equal(b.database.deletable, false, 'and the message history is never a storage lever');
  });

  test('an unreferenced upload is listed as deletable, a referenced one is not', () => {
    const free = up('free-to-go.pdf');
    const used = up('in-use.pdf');
    db.prepare('INSERT INTO campaign_runs (started_at, label, header_asset) VALUES (?,?,?)')
      .run(Date.now(), 'storage-ref', used.asset.id);

    const rows = listStored().uploads;
    const f = rows.find(r => r.id === String(free.asset.id));
    const u = rows.find(r => r.id === String(used.asset.id));
    assert.equal(f.deletable, true);
    assert.equal(u.deletable, false, 'deleting it would leave a campaign unable to say what it sent');
    assert.match(u.why, /campaign/,
      'a disabled checkbox has to say why, or the operator just clicks it again');
  });

  test('a kept customer file is listed but never deletable, and says when it goes', () => {
    const id = seedKept();
    const row = listStored().inbound.find(r => r.id === id);
    assert.ok(row, 'a file taking up disk has to appear on the page that manages disk');
    assert.equal(row.kept, true);
    assert.equal(row.deletable, false,
      'this is the invariant the whole store rests on — retention is not cancellable per file');
    assert.equal(row.renameable, false, "the name is part of what the customer sent");
    assert.ok(row.expiresAt > Date.now(), 'and the operator can plan around the date it frees up');
  });

  test('bulk removal refuses a kept customer file while removing what it can', () => {
    const ok = up('bulk-ok.pdf');
    const keptId = seedKept();

    const r = removeMany([
      { store: 'upload',  id: ok.asset.id },
      { store: 'inbound', id: keptId },
    ]);
    assert.equal(r.ok, true, 'a batch reports per-item outcomes rather than failing whole');
    assert.equal(r.removed, 1, 'the upload goes');
    assert.equal(r.failed, 1, 'the kept customer file does not');
    assert.equal(getAsset(ok.asset.id), undefined);
    assert.ok(db.prepare('SELECT path FROM media WHERE media_id = ?').get(keptId).path,
      'selecting a file in bulk must never be a way past a refusal a single delete would give');
  });

  test('bulk removal rejects an unknown store rather than guessing', () => {
    const r = removeMany([{ store: 'nonsense', id: '1' }]);
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error, /Unknown store/);
  });

  test('an empty or oversized selection is refused', () => {
    assert.equal(removeMany([]).ok, false, 'a no-op delete should say so, not report success');
    assert.equal(removeMany(null).ok, false);
    const huge = Array.from({ length: 501 }, () => ({ store: 'upload', id: '1' }));
    assert.equal(removeMany(huge).ok, false, 'an unbounded batch is a mistake waiting to happen');
  });

  test('renaming changes the display name and nothing about the bytes', () => {
    const a = up('ugly-name-2026.pdf');
    const before = db.prepare('SELECT sha256, path, file_size FROM media_assets WHERE id = ?').get(a.asset.id);

    const r = renameAsset(a.asset.id, 'Karnataka price list Aug 2026.pdf');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.asset.filename, 'Karnataka price list Aug 2026.pdf');

    const after = db.prepare('SELECT sha256, path, file_size FROM media_assets WHERE id = ?').get(a.asset.id);
    assert.deepEqual(after, before,
      'sha256 and path must not move — dedupe depends on them, and so does every campaign ' +
      'that already reported sending this asset');
    assert.ok(fsx.existsSync(assetPath(r.asset)), 'and the bytes are still where they were');
  });

  test('a rename with a path separator or control character is refused', () => {
    const a = up('rename-guard.pdf');
    for (const bad of ['../../etc/passwd', 'a/b.pdf', 'back\\slash.pdf', 'null byte.pdf']) {
      const r = renameAsset(a.asset.id, bad);
      assert.equal(r.ok, false, `"${bad}" must be refused — this string is sent to Meta as a filename`);
    }
    const empty = renameAsset(a.asset.id, '   ');
    assert.equal(empty.ok, false, 'and a blank name leaves the recipient looking at nothing');
  });

  test('an ordinary name with spaces and dashes still renames', () => {
    const a = up('plain.pdf');
    const r = renameAsset(a.asset.id, 'Price list - August 2026 (final).pdf');
    assert.equal(r.ok, true,
      'the guard is about separators and control characters, not about punctuation people use');
  });

  test('renaming something that is not there is a sentence, not a crash', () => {
    const r = renameAsset(999999, 'whatever.pdf');
    assert.equal(r.ok, false);
    assert.match(r.error, /not in the library/);
  });

  // The storage endpoints list every customer who ever sent a file and what it
  // was called. That is exactly the kind of thing that must not be readable
  // without a session, and "/media/storage" must not be parsed as an asset id.
  testAsync('the storage endpoints sit below the password gate and outrank /media/:id', async () => {
    const savedPw = CFG.appPassword;
    CFG.appPassword = 'test-password';
    const s = http.createServer(app);
    await new Promise(r => s.listen(0, r));
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      const cookie = { cookie: `wa_session=${createSession()}` };

      assert.equal((await fetch(`${base}/api/media/storage`)).status, 401,
        'this lists customer names and filenames — it is not public');

      const ok = await fetch(`${base}/api/media/storage`, { headers: cookie });
      assert.equal(ok.status, 200,
        'a 404 here would mean /media/:id swallowed "storage" as an asset id');
      const body = await ok.json();
      assert.ok(Array.isArray(body.uploads) && Array.isArray(body.inbound));
      assert.ok(body.volume && 'total' in body.volume, 'the overview travels with the listing');

      const bulk = await fetch(`${base}/api/media/storage/remove`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...cookie },
        body: JSON.stringify({ items: [] }),
      });
      assert.equal(bulk.status, 400, 'an empty selection is a refusal, not a silent success');
    } finally { s.close(); CFG.appPassword = savedPw; }
  });
}

// ── Campaign history ──────────────────────────────────────────────────────────
// Read-only, and every field derived. The point of these assertions is that
// campaign_runs gains no ended_at and no status column: both are properties of
// the queue, and a stored copy is a number that can disagree with the rows.
console.log('\nhistory — listRuns and runDetail');
{
  const M = require('./server');
  const { listRuns, runDetail, buildRun, recordRecipientSent, recordRecipientSkipped,
          recordRecipientRetry } = M;

  let hseq = 0;
  const person = name => ({ name, dialStr: `9198800${String(++hseq).padStart(5, '0')}` });
  const newRun = (label, body) => Number(db.prepare(
    'INSERT INTO campaign_runs (started_at, label, template_body, template_lang) VALUES (?,?,?,?)')
    .run(Date.now(), label, body ?? null, 'en').lastInsertRowid);

  // Every test here reads a run that is NOT the current one, which is what the
  // History page always does. Pinning currentRunId to null keeps 'in-progress'
  // out of the answer unless a test asks for it.
  const detached = fn => {
    const savedRun = S.currentRunId, savedPhase = S.phase;
    S.currentRunId = null; S.phase = 'idle';
    try { return fn(); } finally { S.currentRunId = savedRun; S.phase = savedPhase; }
  };

  test('a run staged and never started is hidden from history', () => {
    const empty = newRun('staged_never_started');
    const real  = newRun('karnataka_price_list');
    buildRun(real, [person('Asha')]);
    detached(() => {
      const runs = listRuns();
      assert.equal(runs[0].id, real, 'newest first — the campaign just run is the one being looked for');
      assert.ok(!runs.some(r => r.id === empty),
        'a run with no recipients is noise; showing it makes the list untrustworthy');
    });
  });

  test('ended-at is the last attempt on the queue, not a stored column', () => {
    const run = newRun('ended_at');
    const p = person('Rahul');
    buildRun(run, [p]);
    recordRecipientSent(run, p.dialStr, 'w-hist-1');
    const row = db.prepare('SELECT attempted_at FROM run_recipients WHERE run_id = ?').get(run);
    detached(() => {
      assert.equal(runDetail(run).endedAt, row.attempted_at,
        'a stored ended_at needs writing on finish, on Stop, on ladder exhaustion and after a ' +
        'crash — four places to forget, and a forgotten one shows a campaign that never ended');
    });
    const cols = db.prepare('PRAGMA table_info(campaign_runs)').all().map(c => c.name);
    assert.ok(!cols.includes('ended_at') && !cols.includes('status'),
      'neither may ever become a column — that is the whole decision');
  });

  test('a run with everyone resolved reads completed', () => {
    const run = newRun('all_done');
    const a = person('Asha'), b = person('Marco');
    buildRun(run, [a, b]);
    recordRecipientSent(run, a.dialStr, 'w-hist-2');
    recordRecipientSkipped(run, b.dialStr, 'skipped', 131026);
    detached(() => assert.equal(runDetail(run).status, 'completed',
      'sent and skipped are both resolved — nothing is owed'));
  });

  test('a run with pending rows that is not current reads incomplete', () => {
    const run = newRun('stopped_halfway');
    const a = person('Sarah'), b = person('Priya');
    buildRun(run, [a, b]);
    recordRecipientSent(run, a.dialStr, 'w-hist-3');
    detached(() => {
      const d = runDetail(run);
      assert.equal(d.status, 'incomplete',
        'reporting a stopped campaign as complete hides the people it never reached');
      assert.equal(d.progress.pending, 1, 'and the count says how many');
    });
  });

  test('the current run being walked reads in-progress, retry ladder included', () => {
    const run = newRun('live_one');
    const p = person('Asha');
    buildRun(run, [p]);
    recordRecipientRetry(run, p.dialStr, 131049, Date.now() + 3 * 3600000);
    const savedRun = S.currentRunId, savedPhase = S.phase;
    S.currentRunId = run; S.phase = 'waiting';
    try {
      assert.equal(runDetail(run).status, 'in-progress',
        'a campaign still working its retry ladder is not finished, and history must not say it is');
    } finally { S.currentRunId = savedRun; S.phase = savedPhase; }
  });

  test('the body shown is the one that run sent, not the template as it reads now', () => {
    const run = newRun('body_snapshot', 'Old price list for {{1}}');
    buildRun(run, [person('Rahul')]);
    const savedBody = S.config.templateBody;
    S.config.templateBody = 'A completely different message';
    try {
      detached(() => assert.equal(runDetail(run).body, 'Old price list for {{1}}',
        'editing a template must never rewrite what last month\'s campaign said'));
    } finally { S.config.templateBody = savedBody; }
  });

  test('an unknown id is null rather than the current run', () => {
    detached(() => {
      assert.equal(runDetail(999999), null,
        'a stale bookmark that renders a different campaign reads as an answer, which is ' +
        'worse than a 404 because the operator acts on it');
      assert.equal(runDetail('nonsense'), null);
      assert.equal(runDetail(0), null);
      assert.equal(runDetail(null), null);
    });
  });

  test('an inbox reply is never counted against a campaign', () => {
    const run = newRun('no_leak');
    const p = person('Asha');
    buildRun(run, [p]);
    // run_id left NULL, exactly as services/inbox.js writes it.
    db.prepare('INSERT OR IGNORE INTO messages (wamid, wa_id, dir, type, body, at, status) VALUES (?,?,?,?,?,?,?)')
      .run('reply-hist-1', p.dialStr, 'out', 'text', 'a free-form reply', Date.now(), 'delivered');
    detached(() => assert.equal(runDetail(run).counts.delivered, 0,
      'run_id IS NULL is the bucket inbox replies land in — counting it inflates every report ' +
      'and prices free-form replies at the template rate'));
  });

  // Both halves matter, as with every other route test here. The 401 alone
  // would pass even if the routes were never mounted, because requireAuth
  // rejects every /api path before routing; the signed-in answer is what proves
  // they exist AND sit below the gate.
  testAsync('the history routes are mounted below the password gate and are read-only', async () => {
    const run = newRun('routed', 'Body as sent');
    buildRun(run, [person('Asha')]);
    const savedPw = CFG.appPassword;
    CFG.appPassword = 'test-password';
    const s = http.createServer(app);
    await new Promise(r => s.listen(0, r));
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      const cookie = { cookie: `wa_session=${createSession()}` };

      assert.equal((await fetch(`${base}/api/runs`)).status, 401,
        'campaign history names customers and what was sent to them — it is not public');

      const list = await fetch(`${base}/api/runs`, { headers: cookie });
      assert.equal(list.status, 200);
      assert.ok((await list.json()).runs.some(r => r.id === run),
        'a signed-in caller must reach the router, not just the auth gate');

      const detail = await fetch(`${base}/api/runs/${run}`, { headers: cookie });
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).body, 'Body as sent');

      const missing = await fetch(`${base}/api/runs/999999`, { headers: cookie });
      assert.equal(missing.status, 404,
        'an unknown id must 404 rather than render whatever campaign is current');

      // Read-only is the whole contract of this feature: nothing here writes.
      const posted = await fetch(`${base}/api/runs/${run}`, { method: 'POST', headers: cookie });
      assert.ok(posted.status === 404 || posted.status === 405,
        'there is no POST on a history route, and there must never be one');
    } finally { s.close(); CFG.appPassword = savedPw; }
  });

  test('the skip report travels with the run, codes and attempts included', () => {
    const run = newRun('with_skips');
    const a = person('Marco'), b = person('Priya');
    buildRun(run, [a, b]);
    recordRecipientSent(run, a.dialStr, 'w-hist-4');
    recordRecipientSkipped(run, b.dialStr, 'skipped', 131049);
    detached(() => {
      const d = runDetail(run);
      assert.equal(d.skips.length, 1, 'the operator has to be able to see who was not reached');
      assert.equal(d.skips[0].error_code, 131049, 'and why, in Meta\'s own terms');
      assert.equal(d.recipients.length, 2, 'while the full list still shows everyone');
    });
  });
}

// ── Can this box run the scanner it was configured with? ──────────────────────
// The warning exists because the failure it predicts does not look like itself:
// clamd gets OOM-killed during a signature reload, and the app then refuses every
// media save because "configured but unreachable" is fail-closed by design.
console.log('\nclamd memory headroom');
{
  const { memoryWarning } = require('./server');
  const { CLAMAV } = require('./src/config');
  const GB = 1024 ** 3;

  const withScanner = (addr, fn) => {
    const saved = CLAMAV.address;
    CLAMAV.address = addr;
    try { return fn(); } finally { CLAMAV.address = saved; }
  };

  test('a 2 GB box running clamd is warned, and told both ways out', () => {
    const w = withScanner('127.0.0.1:3310', () => memoryWarning(2 * GB));
    assert.ok(w, 'clamd plus this app does not fit in 2 GB once freshclam reloads');
    assert.match(w, /2\.0 GB/, 'the warning states what the machine actually has');
    assert.match(w, /CLAMAV_ADDRESS/,
      'and names the setting to unset, because "buy more RAM" is not always an option');
  });

  test('enough RAM is silence, not a softer warning', () => {
    assert.equal(withScanner('127.0.0.1:3310', () => memoryWarning(8 * GB)), null);
  });

  test('no scanner configured is never warned about', () => {
    assert.equal(withScanner('', () => memoryWarning(512 * 1024 * 1024)), null,
      'running without a scanner is a supported deployment — the RAM is then nobody\'s problem');
  });
}

// ── P5: diagnostics and replay ────────────────────────────────────────────────
console.log('\nwebhook replay');
{
  const { replayUnprocessed } = require('./src/services/ingest');
  const store = (body, processed = null) => Number(testDb
    .prepare('INSERT INTO webhook_events (received_at, body, processed_at) VALUES (?, ?, ?)')
    .run(Date.now(), typeof body === 'string' ? body : JSON.stringify(body), processed).lastInsertRowid);
  const isProcessed = id =>
    testDb.prepare('SELECT processed_at FROM webhook_events WHERE id = ?').get(id).processed_at !== null;

  const envelope = (waId, wamid, text) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: 'Replay Tester' } }],
      messages: [{ id: wamid, from: waId, timestamp: '1700000000', type: 'text', text: { body: text } }],
    } }] }],
  });

  test('a stored envelope that never processed can be replayed into the inbox', () => {
    const id = store(envelope('910000005551', 'replay-1', 'hello from replay'));
    const r = replayUnprocessed();
    assert.ok(r.replayed >= 1);
    assert.equal(isProcessed(id), true);
    assert.ok(inboxThread('910000005551').messages.some(m => m.text === 'hello from replay'),
      'the message must actually land, not just get stamped done');
  });

  // The property that makes the button safe to put in front of a human.
  test('replaying the same envelope twice does not duplicate anything', () => {
    const id = store(envelope('910000005552', 'replay-2', 'only once'));
    replayUnprocessed();
    const after = inboxThread('910000005552').messages.length;
    const unreadAfter = inboxSummary({ all: true }).threads
      .find(t => t.waId === '910000005552').unread;

    // Force it back to unprocessed and run it again, as a double-click would.
    testDb.prepare('UPDATE webhook_events SET processed_at = NULL WHERE id = ?').run(id);
    replayUnprocessed();

    assert.equal(inboxThread('910000005552').messages.length, after,
      'messages dedupes on the wamid primary key');
    assert.equal(inboxSummary({ all: true }).threads.find(t => t.waId === '910000005552').unread,
      unreadAfter, 'and the unread badge must not climb on a redelivery');
  });

  test('an envelope that still cannot be parsed stays unprocessed', () => {
    const id = store('{ not json at all');
    const r = replayUnprocessed();
    assert.ok(r.failed >= 1);
    assert.equal(isProcessed(id), false,
      'marking it done would throw away the only copy of what Meta sent');
    assert.ok(r.errors.some(e => e.id === id));
    testDb.prepare('DELETE FROM webhook_events WHERE id = ?').run(id);
  });

  test('one bad envelope does not stop the good ones after it', () => {
    const bad  = store('{ broken');
    const good = store(envelope('910000005553', 'replay-3', 'after the bad one'));
    const r = replayUnprocessed();
    assert.ok(r.replayed >= 1 && r.failed >= 1);
    assert.equal(isProcessed(good), true);
    assert.equal(isProcessed(bad), false);
    testDb.prepare('DELETE FROM webhook_events WHERE id = ?').run(bad);
  });

  test('replaying with nothing pending is a no-op, not an error', () => {
    const r = replayUnprocessed();
    assert.equal(r.attempted, 0);
    assert.equal(r.replayed, 0);
    assert.equal(r.failed, 0);
  });

  test('an already-processed envelope is never picked up again', () => {
    const id = store(envelope('910000005554', 'replay-4', 'done already'), Date.now());
    replayUnprocessed();
    assert.equal(inboxThread('910000005554'), null,
      'a processed row must not be reprocessed just because it is still on disk');
    testDb.prepare('DELETE FROM webhook_events WHERE id = ?').run(id);
  });
}

console.log('\ndiagnostics');
{
  const diag = require('./src/services/diagnostics');

  test('the snapshot renders without reaching Meta or the network', () => {
    const saved = global.fetch;
    global.fetch = () => { throw new Error('diagnostics must not call out'); };
    try { assert.ok(diag.snapshot().at > 0); } finally { global.fetch = saved; }
  });

  test('it reports every table this app has, so a missing one is visible', () => {
    const rows = diag.snapshot().rows;
    for (const t of ['messages', 'threads', 'contacts', 'media', 'media_assets',
                     'templates', 'campaign_runs', 'run_recipients', 'webhook_events']) {
      assert.equal(typeof rows[t], 'number', `row count missing for ${t}`);
    }
  });

  test('it counts unprocessed webhooks and samples what is stuck', () => {
    const id = Number(testDb.prepare('INSERT INTO webhook_events (received_at, body) VALUES (?, ?)')
      .run(Date.now(), '{ unparseable').lastInsertRowid);
    const d = diag.snapshot();
    assert.ok(d.webhooks.unprocessed >= 1);
    assert.ok(d.webhooks.stuck.some(s => s.id === id), 'a count alone does not say WHAT is stuck');
    assert.ok(d.webhooks.stuck[0].preview.length > 0);
    testDb.prepare('DELETE FROM webhook_events WHERE id = ?').run(id);
  });

  test('it reports credential presence but never a credential', () => {
    const json = JSON.stringify(diag.snapshot());
    for (const secret of [CFG.accessToken, CFG.appSecret, CFG.appPassword, CFG.webhookVerifyToken]) {
      if (secret) assert.ok(!json.includes(secret), 'a diagnostics page must not leak what it is diagnosing');
    }
    assert.equal(typeof diag.snapshot().account.accessToken, 'boolean');
  });

  test('the scanner address is reported as set or not, never as a path', () => {
    const { CLAMAV } = require('./src/config');
    const saved = CLAMAV.address;
    CLAMAV.address = '/var/run/clamav/clamd.ctl';
    try {
      const d = diag.snapshot();
      assert.equal(d.scanner.configured, true);
      assert.equal(d.scanner.address, 'set');
      assert.ok(!JSON.stringify(d).includes('clamd.ctl'));
    } finally { CLAMAV.address = saved; }
  });

  test('it flags the free-space floor that would silently refuse every save', () => {
    const { MEDIA_LIMITS } = require('./src/config');
    const saved = MEDIA_LIMITS.minFreeBytes;
    MEDIA_LIMITS.minFreeBytes = Number.MAX_SAFE_INTEGER;
    try { assert.equal(diag.snapshot().storage.belowFloor, true); }
    finally { MEDIA_LIMITS.minFreeBytes = saved; }
  });

  test('a media directory that does not exist yet is zero, not a throw', () => {
    const s = diag.snapshot().storage;
    assert.equal(typeof s.mediaDir.bytes, 'number');
    assert.equal(typeof s.uploadDir.files, 'number');
  });
}

console.log('\ninline error badges');
{
  test('a failed outbound message carries its code, title and what to do', () => {
    seedThread('910000006661', 'Failed Send', 0, 1700000000000);
    testDb.prepare(`INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at, status, error_code, error_title)
                    VALUES (?, ?, 'out', 'template', ?, ?, 'failed', ?, ?)`)
      .run('fail-1', '910000006661', 'the message', 1700000000000, 131047, 'Re-engagement message');
    const m = inboxThread('910000006661').messages.find(x => x.id === 'fail-1');
    assert.equal(m.status, 'failed');
    assert.equal(m.error.code, 131047);
    assert.equal(m.error.title, 'Re-engagement message');
    assert.match(m.error.hint, /24-hour/, 'the number alone tells an operator nothing');
  });

  test('a delivered message carries no error object at all', () => {
    testDb.prepare(`INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at, status)
                    VALUES (?, ?, 'out', 'template', ?, ?, 'delivered')`)
      .run('fine-1', '910000006661', 'fine', 1700000000001);
    const m = inboxThread('910000006661').messages.find(x => x.id === 'fine-1');
    assert.equal(m.error, null, 'an empty error object would render an empty badge');
  });

  test('a failure Meta sent no code for still renders rather than breaking', () => {
    testDb.prepare(`INSERT OR REPLACE INTO messages (wamid, wa_id, dir, type, body, at, status)
                    VALUES (?, ?, 'out', 'template', ?, ?, 'failed')`)
      .run('fail-2', '910000006661', 'no code', 1700000000002);
    const m = inboxThread('910000006661').messages.find(x => x.id === 'fail-2');
    assert.equal(m.error.code, null);
    assert.equal(m.error.hint, null);
  });
}

console.log('\nmigration');

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
// The original F1 fix opened a run so resumed sends were not attributed to
// run_id NULL. run_recipients supersedes it: a campaign.json with no run id has
// no queue, and there is nothing to attribute. Re-sending to the whole array —
// with no record of who was already messaged — is the one outcome that must not
// happen, so this now refuses to resume and says why.
test('a pre-queue campaign.json is refused rather than resumed against no queue', () => withSavedCampaignFile(() => {
  const legacy = { contacts: [{ name: 'Y', dialStr: '910000000001' }], currentIdx: 0,
                    phase: 'running', dailyCount: 0, dailyDate: null, skipped: 0, config: {} };
  fsx.writeFileSync(F1_FILES.campaign, JSON.stringify(legacy));
  S.currentRunId = null; S.phase = 'idle';
  const before = S.logs.length;
  resumeIfInterrupted();
  assert.equal(S.currentRunId, null, 'no run is opened for a queue that does not exist');
  assert.equal(S.phase, 'idle', 'and nothing starts sending');
  assert.ok(S.logs.slice(before).some(l => /NOT resumed/.test(l.msg)),
    'the operator must be told their interrupted run did not come back');
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

console.log('\nmedia routes');
{
  // Mirrors startWebhookServer: mount the real router on a bare app so the
  // handlers are exercised without session plumbing. The auth gate itself is
  // asserted separately below, against the real app.
  function startMediaServer() {
    const a = express();
    a.use(express.json());
    a.use('/api', require('./src/routes/media'));
    const s = http.createServer(a);
    return new Promise(r => s.listen(0, () => r(s)));
  }

  testAsync('upload → list → download returns the same bytes', async () => {
    const server = await startMediaServer();
    try {
      const port = server.address().port;
      const bytes = Buffer.from(`%PDF route test ${Date.now()}`);
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'catalogue.pdf');

      const up = await (await fetch(`http://127.0.0.1:${port}/api/media/upload`,
        { method: 'POST', body: form })).json();
      assert.equal(up.ok, true, up.error);
      assert.equal(up.asset.filename, 'catalogue.pdf');

      const list = await (await fetch(`http://127.0.0.1:${port}/api/media`)).json();
      assert.ok(list.assets.some(a => a.id === up.asset.id), 'the new asset must appear in the library');

      const dl = await fetch(`http://127.0.0.1:${port}/api/media/asset/${up.asset.id}`);
      assert.equal(dl.status, 200);
      assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), bytes.toString());
    } finally { server.close(); }
  });

  testAsync('an unknown asset id is a 404, not a crash', async () => {
    const server = await startMediaServer();
    try {
      const port = server.address().port;
      const r = await fetch(`http://127.0.0.1:${port}/api/media/asset/99999999`);
      assert.equal(r.status, 404);
    } finally { server.close(); }
  });

  // uploads/ is never served statically. Anyone who could guess a hash would
  // otherwise be able to read customer-facing business documents.
  //
  // Both halves matter. The 401 alone would pass even if the router were never
  // mounted — requireAuth rejects every /api path before routing — so the
  // signed-in 200 is what proves the route exists AND sits below the gate.
  testAsync('the media library is mounted below the password gate', async () => {
    const savedPw = CFG.appPassword;
    CFG.appPassword = 'test-password';
    const s = http.createServer(app);
    await new Promise(r => s.listen(0, r));
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      const anon = await fetch(`${base}/api/media`);
      assert.equal(anon.status, 401, 'GET /api/media must require a session');

      const signedIn = await fetch(`${base}/api/media`,
        { headers: { cookie: `wa_session=${createSession()}` } });
      assert.equal(signedIn.status, 200, 'a signed-in caller must reach the media router');
      assert.ok(Array.isArray((await signedIn.json()).assets));
    } finally { s.close(); CFG.appPassword = savedPw; }
  });

  // Same two halves as above. The 400 proves the route exists and reached the
  // service; the 401 proves an anonymous caller cannot send a file to a customer.
  testAsync('the media reply route is mounted below the password gate', async () => {
    const savedPw = CFG.appPassword;
    CFG.appPassword = 'test-password';
    const s = http.createServer(app);
    await new Promise(r => s.listen(0, r));
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      const post = (headers) => fetch(`${base}/api/inbox/919700000099/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ assetId: 1, caption: 'hi' }),
      });

      assert.equal((await post()).status, 401,
        'an anonymous caller must not be able to send a file to a customer');

      const signedIn = await post({ cookie: `wa_session=${createSession()}` });
      assert.equal(signedIn.status, 400,
        'a signed-in caller reaches the service, which refuses because that thread has no open window');
      assert.equal((await signedIn.json()).ok, false);

      const noAsset = await fetch(`${base}/api/inbox/919700000099/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `wa_session=${createSession()}` },
        body: JSON.stringify({ caption: 'no file' }),
      });
      assert.equal(noAsset.status, 400, 'a post with no assetId is refused before the service is called');
      assert.match((await noAsset.json()).error, /Pick a file/);
    } finally { s.close(); CFG.appPassword = savedPw; }
  });
}

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

console.log('\nsend path — header component');
{
  const withFetch = async (impl, fn) => {
    const real = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return impl(String(url), opts, calls); };
    try { return await fn(calls); } finally { global.fetch = real; }
  };
  const json = obj => ({ ok: true, status: 200, json: async () => obj, headers: new Headers() });
  const seedDoc = () => saveUpload({ buffer: Buffer.from(`doc-${Math.random()}`),
                                     originalname: 'price-list.pdf', mimetype: 'application/pdf' }).asset.id;

  testAsync('a document header carries the original filename, not the hash path', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId;
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = seedDoc();
    try {
      await withFetch(() => json({ id: '555' }), async () => {
        const r = await headerComponent(id);
        assert.equal(r.ok, true, r.error);
        assert.deepEqual(r.component, {
          type: 'header',
          parameters: [{ type: 'document', document: { id: '555', filename: 'price-list.pdf' } }],
        });
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; }
  });

  testAsync('an image header carries no filename — WhatsApp does not show one', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId;
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = saveUpload({ buffer: Buffer.from(`img-${Math.random()}`),
                            originalname: 'banner.png', mimetype: 'image/png' }).asset.id;
    try {
      await withFetch(() => json({ id: '777' }), async () => {
        const r = await headerComponent(id);
        assert.deepEqual(r.component.parameters[0], { type: 'image', image: { id: '777' } });
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; }
  });

  testAsync('sendTemplate prepends the header before the body component', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId, savedCfg = { ...S.config };
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = seedDoc();
    Object.assign(S.config, { headerAssetId: id, templateName: 'plan_test', templateLanguage: 'en',
                              paramCount: 1, paramValues: [{ source: 'name', value: '' }] });
    try {
      await withFetch(url => url.includes('/media')
        ? json({ id: '888' })
        : json({ messages: [{ id: 'wamid.plan.header' }] }), async calls => {
        const r = await sendTemplate({ name: 'Asha', dialStr: '910000000000' });
        assert.equal(r.ok, true, r.error);
        const sent = JSON.parse(calls.find(c => c.url.endsWith('/messages')).opts.body);
        assert.equal(sent.template.components[0].type, 'header');
        assert.equal(sent.template.components[1].type, 'body');
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; Object.assign(S.config, savedCfg); }
  });

  // Meta deletes media at 30 days and our clock is not their clock. A send that
  // comes back complaining about the media must not fail the whole campaign
  // when re-uploading the file fixes it.
  testAsync('a media failure re-uploads once and retries the send', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId, savedCfg = { ...S.config };
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    const id = seedDoc();
    Object.assign(S.config, { headerAssetId: id, templateName: 'plan_test', templateLanguage: 'en',
                              paramCount: 0, paramValues: [] });
    let sends = 0;
    try {
      await withFetch(url => {
        if (url.includes('/media')) return json({ id: `media-${Date.now()}` });
        sends += 1;
        return sends === 1
          ? json({ error: { message: 'Media upload error: media not found', code: 131053 } })
          : json({ messages: [{ id: 'wamid.plan.retry' }] });
      }, async () => {
        const r = await sendTemplate({ name: 'Asha', dialStr: '910000000000' });
        assert.equal(r.ok, true, 'the retry after a media refresh must succeed');
        assert.equal(sends, 2, 'exactly one retry, not a loop');
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; Object.assign(S.config, savedCfg); }
  });

  testAsync('a send with no header asset is unchanged', async () => {
    const savedToken = CFG.accessToken, savedPhone = CFG.phoneNumberId, savedCfg = { ...S.config };
    CFG.accessToken = 'test-token'; CFG.phoneNumberId = '100000000000000';
    Object.assign(S.config, { headerAssetId: null, templateName: 'plan_test', templateLanguage: 'en',
                              paramCount: 1, paramValues: [{ source: 'name', value: '' }] });
    try {
      await withFetch(() => json({ messages: [{ id: 'wamid.plan.plain' }] }), async calls => {
        await sendTemplate({ name: 'Asha', dialStr: '910000000000' });
        const sent = JSON.parse(calls[0].opts.body);
        assert.equal(sent.template.components.length, 1);
        assert.equal(sent.template.components[0].type, 'body');
      });
    } finally { CFG.accessToken = savedToken; CFG.phoneNumberId = savedPhone; Object.assign(S.config, savedCfg); }
  });
}

// A fake clamd, shared by every section below that needs one. It speaks the
// INSTREAM half of the protocol only, which is the entire surface this app
// uses: read zINSTREAM\0, read length-prefixed chunks until a zero length,
// answer one line. A null reply leaves the socket open on purpose, which is how
// the timeout path gets exercised.
const withClamd = async (reply, fn, { drop = false } = {}) => {
  const net = require('node:net');
  const { CLAMAV } = require('./src/config');
  const chunks = [];
  const srv = net.createServer(sock => {
    if (drop) return sock.destroy();
    // The header is consumed exactly once. Re-scanning for the NUL on every
    // data event would find one inside the payload instead and reframe the
    // whole stream.
    let buf = Buffer.alloc(0), gotHeader = false;
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!gotHeader) {
        const head = buf.indexOf(0);
        if (head < 0) return;
        buf = buf.subarray(head + 1);
        gotHeader = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) { if (reply !== null) sock.end(reply); return; }
        if (buf.length < 4 + len) return;
        chunks.push(Buffer.from(buf.subarray(4, 4 + len)));
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const saved = CLAMAV.address;
  CLAMAV.address = `127.0.0.1:${srv.address().port}`;
  try { return await fn(chunks); }
  finally { CLAMAV.address = saved; await new Promise(r => srv.close(r)); }
};

// Most sections want a save to succeed without a scanner in the way. Scanning
// is exercised deliberately, in the section that is about scanning.
const withoutScanner = async fn => {
  const { CLAMAV } = require('./src/config');
  const saved = CLAMAV.address; CLAMAV.address = '';
  try { return await fn(); } finally { CLAMAV.address = saved; }
};

console.log('\ninbound media — save, serve, expire');
{
  const fsm    = require('fs');
  const crypto = require('node:crypto');

  // Meta's media download is two hops and both need the token: GET /{media_id}
  // hands back a short-lived CDN url, and that url still rejects an
  // unauthenticated GET. The stub answers both, and passes local requests
  // through so a route test can still reach its own server.
  const withMeta = async (impl, fn) => {
    const real = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('http://127.0.0.1')) return real(url, opts);
      calls.push({ url: String(url), opts });
      return impl(String(url), opts, calls);
    };
    try { return await fn(calls); } finally { global.fetch = real; }
  };

  const sha = b => crypto.createHash('sha256').update(b).digest('hex');

  // A real inbound image webhook, recorded through the real ingest path so the
  // media row is created the way production creates it.
  let n = 0;
  const seedInbound = ({ bytes, sha256, ageMs = 0, mime = 'image/jpeg', type = 'image', filename } = {}) => {
    const i  = ++n;
    const id = `mid.test.${i}.${Date.now()}`;
    const at = Date.now() - ageMs;
    recordInbound({
      id, from: '910000000001', timestamp: String(Math.floor(at / 1000)), type,
      [type]: {
        id, mime_type: mime, sha256: sha256 ?? (bytes ? sha(bytes) : undefined),
        file_size: bytes ? bytes.length : 0, ...(filename ? { filename } : {}),
      },
    }, 'Media Tester');
    return id;
  };

  const metaOk = (bytes, mime = 'image/jpeg') => (url) => url.includes('lookaside')
    ? { ok: true, status: 200, arrayBuffer: async () => bytes, headers: new Headers() }
    : { ok: true, status: 200, headers: new Headers(),
        json: async () => ({ url: 'https://lookaside.fbsbx.com/whatsapp/1', mime_type: mime, file_size: bytes.length, sha256: sha(bytes) }) };

  const withToken = async fn => {
    const t = CFG.accessToken; CFG.accessToken = 'test-token';
    try { return await fn(); } finally { CFG.accessToken = t; }
  };

  testAsync('saveInbound fetches the bytes and fills path and downloaded_at', async () => {
    const bytes = Buffer.from(`jpeg-bytes-${Date.now()}`);
    const id = seedInbound({ bytes });
    await withToken(() => withMeta(metaOk(bytes), async calls => {
      const r = await saveInbound(id);
      assert.equal(r.ok, true, r.error);
      assert.equal(calls.length, 2, 'resolve then download — two hops, both authenticated');
      assert.match(calls[1].opts.headers.Authorization, /^Bearer /,
        'the CDN url rejects an unauthenticated GET');
      const row = getInbound(id);
      assert.ok(row.path, 'path must be set once the bytes are on disk');
      assert.ok(row.downloaded_at > 0);
      assert.equal(fsm.readFileSync(inboundPath(row)).toString(), bytes.toString());
    }));
  });

  testAsync('saving twice never refetches and never rewrites', async () => {
    const bytes = Buffer.from(`once-${Date.now()}`);
    const id = seedInbound({ bytes });
    await withToken(() => withMeta(metaOk(bytes), () => saveInbound(id)));
    const first = getInbound(id).downloaded_at;
    await withToken(() => withMeta(() => { throw new Error('must not refetch saved media'); }, async () => {
      const r = await saveInbound(id);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.already, true, 'a saved row reports itself, it does not re-download');
      assert.equal(getInbound(id).downloaded_at, first, 'downloaded_at must not move');
    }));
  });

  // A truncated CDN response otherwise gets written as a valid file forever,
  // and nothing downstream would ever notice.
  testAsync('a sha256 mismatch refuses the write and leaves path NULL', async () => {
    const bytes = Buffer.from(`truncated-${Date.now()}`);
    const id = seedInbound({ bytes, sha256: 'f'.repeat(64) });
    await withToken(() => withMeta(metaOk(bytes), async () => {
      const r = await saveInbound(id);
      assert.equal(r.ok, false);
      assert.match(r.error, /checksum|sha256/i, 'the error must name what failed');
      assert.equal(getInbound(id).path, null, 'a corrupt download must not be recorded as saved');
    }));
  });

  // The bug this suite could not see. Every fixture above seeds a HEX digest,
  // but a real webhook envelope carries base64 — so the comparison the code
  // actually performs in production was never the one being tested, and a check
  // that refused 100% of real saves passed every test here.
  const shaB64 = b => crypto.createHash('sha256').update(b).digest('base64');

  testAsync('a base64 webhook sha256 verifies against the download', async () => {
    const bytes = Buffer.from(`b64-checksum-${Date.now()}`);
    const id = seedInbound({ bytes, sha256: shaB64(bytes) });
    await withToken(() => withMeta(metaOk(bytes), async () => {
      const r = await saveInbound(id);
      assert.equal(r.ok, true,
        'Meta states one digest in two encodings; refusing one of them refuses every real file');
      assert.ok(getInbound(id).path);
    }));
  });

  testAsync('a base64 sha256 that genuinely differs is still refused', async () => {
    const bytes = Buffer.from(`b64-wrong-${Date.now()}`);
    const id = seedInbound({ bytes, sha256: shaB64(Buffer.from('entirely other bytes')) });
    await withToken(() => withMeta(metaOk(bytes), async () => {
      const r = await saveInbound(id);
      assert.equal(r.ok, false, 'normalising encodings must not turn the guard off');
      assert.equal(getInbound(id).path, null);
    }));
  });

  testAsync('an unreadable webhook digest falls back to the Graph value, not to nothing', async () => {
    const bytes = Buffer.from(`unreadable-${Date.now()}`);
    // metaOk reports the correct hex digest, so the fallback should succeed.
    const id = seedInbound({ bytes, sha256: 'not-a-digest-at-all!!' });
    await withToken(() => withMeta(metaOk(bytes), async () => {
      assert.equal((await saveInbound(id)).ok, true);
    }));
  });

  test('sha256Hex normalises every encoding Meta uses, and nothing else', () => {
    const bytes = Buffer.from('hash me');
    const hex   = crypto.createHash('sha256').update(bytes).digest('hex');

    assert.equal(sha256Hex(hex), hex, 'hex passes through');
    assert.equal(sha256Hex(hex.toUpperCase()), hex, 'and case does not matter');
    assert.equal(sha256Hex(shaB64(bytes)), hex, 'base64 decodes to the same 32 bytes');
    assert.equal(sha256Hex(shaB64(bytes).replace(/\+/g, '-').replace(/\//g, '_')), hex,
      'base64url too — the padding and alphabet vary, the digest does not');

    // Anything that is not 32 bytes however it was written is unrecognised, and
    // unrecognised must not read as a match.
    assert.equal(sha256Hex('deadbeef'), null, 'too short to be a sha256');
    assert.equal(sha256Hex('z'.repeat(64)), null, 'right length, not hex');
    assert.equal(sha256Hex(''), null);
    assert.equal(sha256Hex(null), null);
    assert.equal(sha256Hex(undefined), null);
  });

  testAsync('an unknown media id is an error, not a throw', async () => {
    const r = await saveInbound('mid.does.not.exist');
    assert.equal(r.ok, false);
    assert.match(r.error, /no inbound media found/i);
  });

  testAsync('media past 30 days reports expired and is refused before any fetch', async () => {
    const bytes = Buffer.from('too-old');
    const id = seedInbound({ bytes, ageMs: INBOUND_TTL_MS + 60_000 });
    await withToken(() => withMeta(() => { throw new Error('expired media must not be fetched'); }, async () => {
      const r = await saveInbound(id);
      assert.equal(r.ok, false);
      assert.match(r.error, /30|expired|no longer/i);
    }));
  });

  testAsync('the thread carries the media descriptor, and text messages carry none', async () => {
    const bytes = Buffer.from(`thread-${Date.now()}`);
    const mediaId = seedInbound({ bytes, mime: 'application/pdf', type: 'document', filename: 'invoice.pdf' });
    recordInbound({ id: `mid.text.${Date.now()}`, from: '910000000001',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text', text: { body: 'plain words' } }, 'Media Tester');

    const t = inboxThread('910000000001');
    const withMedia = t.messages.find(m => m.id === mediaId);
    assert.equal(withMedia.media.mediaId, mediaId);
    assert.equal(withMedia.media.filename, 'invoice.pdf');
    assert.equal(withMedia.media.mime, 'application/pdf');
    assert.equal(withMedia.media.saved, false);
    assert.equal(withMedia.media.expired, false);
    assert.equal(t.messages.find(m => m.text === 'plain words').media, null,
      'a text message must not carry a media object');
  });

  testAsync('an expired attachment is flagged expired in the thread', async () => {
    const id = seedInbound({ bytes: Buffer.from('old'), ageMs: INBOUND_TTL_MS + 60_000 });
    const m = inboxThread('910000000001').messages.find(x => x.id === id);
    assert.equal(m.media.expired, true, 'the UI needs this to render expired instead of a Save button');
  });

  const serve = async () => {
    const s = http.createServer(app);
    await new Promise(r => s.listen(0, r));
    return s;
  };
  // The whole /api surface sits behind the password gate, and a developer .env
  // usually has APP_PASSWORD set — so these requests carry a real session
  // rather than assuming the gate is open.
  const asOperator = { headers: { cookie: `wa_session=${createSession()}` } };

  // 409, not 404: "you have not downloaded this yet" and "no such media" are
  // different problems with different fixes, and the UI acts on the difference.
  testAsync('GET before save is a 409, after save streams the bytes', async () => {
    // Real JPEG magic, not a made-up string: `safe` now requires the bytes to
    // agree with the declared type, so a fixture that only claims to be an
    // image would (correctly) come back as a download.
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`route-${Date.now()}`)]);
    const id = seedInbound({ bytes });
    const s = await serve();
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      const early = await fetch(`${base}/api/media/inbound/${id}`, asOperator);
      assert.equal(early.status, 409, 'not downloaded yet is not the same as not found');

      const missing = await fetch(`${base}/api/media/inbound/mid.nope`, asOperator);
      assert.equal(missing.status, 404);

      const anon = await fetch(`${base}/api/media/inbound/${id}`, { headers: { cookie: 'wa_session=nope' } });
      assert.ok(anon.status === 401 || CFG.appPassword === '',
        'customer media must never be readable without a session');

      await withToken(() => withMeta(metaOk(bytes), async () => {
        const saved = await fetch(`${base}/api/media/inbound/${id}`, { method: 'POST', ...asOperator });
        assert.equal((await saved.json()).ok, true);
      }));

      const dl = await fetch(`${base}/api/media/inbound/${id}`, asOperator);
      assert.equal(dl.status, 200);
      assert.match(dl.headers.get('content-type'), /image\/jpeg/);
      assert.match(dl.headers.get('content-disposition'), /^inline/);
      assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), bytes.toString());

      const att = await fetch(`${base}/api/media/inbound/${id}?download=1`, asOperator);
      assert.match(att.headers.get('content-disposition'), /^attachment/);
      assert.equal(Buffer.from(await att.arrayBuffer()).toString(), bytes.toString());
    } finally { s.close(); }
  });

  // The mime type on a media row is whatever the customer's file carried —
  // Meta relays it, it is not ours. Reflecting a script-capable type back with
  // `inline` would run that script on the same origin as the dashboard, with
  // the operator's session cookie attached.
  //
  // These types are now `block`, so the default answer is a refusal rather than
  // a hardened download. The original guarantee still has to hold on the far
  // side of an explicit risk=accept, which is what the second half asserts:
  // accepting the risk buys the bytes, never the rendering.
  for (const hostile of ['text/html', 'image/svg+xml', 'application/xhtml+xml']) {
    testAsync(`a customer-supplied ${hostile} attachment is never served inline`, async () => {
      const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/config")</script></svg>');
      const id = seedInbound({ bytes, mime: hostile, type: 'document', filename: 'invoice.svg' });
      const s = await serve();
      try {
        const base = `http://127.0.0.1:${s.address().port}`;
        await withoutScanner(() => withToken(() => withMeta(metaOk(bytes, hostile), async () => {
          await fetch(`${base}/api/media/inbound/${id}`, { method: 'POST', ...asOperator });
        })));

        const refused = await fetch(`${base}/api/media/inbound/${id}`, asOperator);
        assert.equal(refused.status, 403, 'a script-capable type is not served at all by default');
        assert.equal((await refused.json()).risk, 'block');

        const r = await fetch(`${base}/api/media/inbound/${id}?risk=accept`, asOperator);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-disposition'), /^attachment/,
          'a script-capable type must download, never render');
        assert.match(r.headers.get('content-type'), /application\/octet-stream/,
          'the browser must not be told this is renderable');
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff',
          'without nosniff the browser sniffs the bytes and renders it anyway');
        assert.match(r.headers.get('content-security-policy'), /sandbox/,
          'sandbox is the backstop if the type ever slips through');
      } finally { s.close(); }
    });
  }

  testAsync('a real image is still served inline, and still hardened', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`safe-${Date.now()}`)]);
    const id = seedInbound({ bytes, mime: 'image/jpeg' });
    const s = await serve();
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      await withToken(() => withMeta(metaOk(bytes), async () => {
        await fetch(`${base}/api/media/inbound/${id}`, { method: 'POST', ...asOperator });
      }));
      const r = await fetch(`${base}/api/media/inbound/${id}`, asOperator);
      assert.match(r.headers.get('content-type'), /image\/jpeg/, 'the inbox renders this in an <img>');
      assert.match(r.headers.get('content-disposition'), /^inline/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    } finally { s.close(); }
  });

  // WhatsApp voice notes arrive as "audio/ogg; codecs=opus". Matching the
  // allowlist on the full string would push every voice note down the
  // attachment path and silently break the audio player.
  testAsync('a mime type with parameters still matches the allowlist', async () => {
    const bytes = Buffer.concat([Buffer.from('OggS\x00\x02'), Buffer.from(`voice-${Date.now()}`)]);
    const id = seedInbound({ bytes, mime: 'audio/ogg; codecs=opus', type: 'audio' });
    const s = await serve();
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      await withToken(() => withMeta(metaOk(bytes, 'audio/ogg; codecs=opus'), async () => {
        await fetch(`${base}/api/media/inbound/${id}`, { method: 'POST', ...asOperator });
      }));
      const r = await fetch(`${base}/api/media/inbound/${id}`, asOperator);
      assert.match(r.headers.get('content-disposition'), /^inline/,
        'a voice note must still play in the thread');
    } finally { s.close(); }
  });

  // ── Hardening: what has to be true before customer bytes reach this disk ─────
  console.log('\ninbound media — save hardening');
  {
    const { CLAMAV, MEDIA_LIMITS } = require('./src/config');

    testAsync('a saved file records its risk tier and what the bytes looked like', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`p${Date.now()}`)]);
      const id = seedInbound({ bytes, filename: 'holiday.jpg' });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      const row = getInbound(id);
      assert.equal(row.risk, 'safe');
      assert.equal(row.sniffed_mime, 'jpeg');
      assert.ok(row.risk_reason);
    });

    testAsync('an executable claiming to be a pdf is stored as block, not ok', async () => {
      const bytes = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.from(`x${Date.now()}`)]);
      const id = seedInbound({ bytes, mime: 'application/pdf', type: 'document', filename: 'invoice.pdf' });
      const r = await withoutScanner(() => withToken(() =>
        withMeta(metaOk(bytes, 'application/pdf'), () => saveInbound(id))));
      assert.equal(r.ok, true, 'the operator asked for it, so it is fetched and stored');
      const row = getInbound(id);
      assert.equal(row.risk, 'block');
      assert.equal(row.sniffed_mime, 'exe');
      assert.ok(row.path, 'stored — the refusal happens at serve time, not save time');
    });

    testAsync('the sanitized extension is what reaches the filesystem path', async () => {
      const bytes = Buffer.from(`t${Date.now()}`);
      const id = seedInbound({ bytes, mime: 'text/plain', type: 'document', filename: 'notes.../../../etc/passwd' });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes, 'text/plain'), () => saveInbound(id))));
      const row = getInbound(id);
      assert.ok(!row.path.includes('/'), `stored filename must be a bare name, got ${row.path}`);
      assert.ok(!row.path.includes('..'));
      assert.ok(fsm.existsSync(inboundPath(row)));
    });

    testAsync('a saved file is readable only by this process', async () => {
      const bytes = Buffer.from(`m${Date.now()}`);
      const id = seedInbound({ bytes });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      const mode = fsm.statSync(inboundPath(getInbound(id))).mode & 0o777;
      assert.equal(mode, 0o600, 'customer media must not be world-readable on a shared host');
    });

    testAsync('a response bigger than the cap is refused before it is written', async () => {
      const saved = MEDIA_LIMITS.maxBytes;
      MEDIA_LIMITS.maxBytes = 16;
      try {
        const bytes = Buffer.alloc(64, 7);
        const id = seedInbound({ bytes });
        const r = await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
        assert.equal(r.ok, false);
        assert.match(r.error, /limit/i);
        assert.equal(getInbound(id).path, null);
      } finally { MEDIA_LIMITS.maxBytes = saved; }
    });

    testAsync('a save is refused when the disk is nearly full', async () => {
      const saved = MEDIA_LIMITS.minFreeBytes;
      MEDIA_LIMITS.minFreeBytes = Number.MAX_SAFE_INTEGER;
      try {
        const bytes = Buffer.from(`d${Date.now()}`);
        const id = seedInbound({ bytes });
        const r = await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
        assert.equal(r.ok, false);
        assert.match(r.error, /disk space/i);
        assert.equal(getInbound(id).path, null);
      } finally { MEDIA_LIMITS.minFreeBytes = saved; }
    });

    testAsync('with no scanner configured a save succeeds and says so', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`n${Date.now()}`)]);
      const id = seedInbound({ bytes });
      const r = await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      assert.equal(r.ok, true);
      assert.equal(getInbound(id).scan_status, 'skipped');
    });

    testAsync('a clean scan is recorded on the row', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`c${Date.now()}`)]);
      const id = seedInbound({ bytes });
      await withClamd('stream: OK\x00', () =>
        withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      const row = getInbound(id);
      assert.equal(row.scan_status, 'clean');
      assert.ok(row.scan_at > 0);
      assert.ok(row.path);
    });

    testAsync('an infected file is refused and its bytes never touch disk', async () => {
      const bytes = Buffer.from(`${EICAR}`);
      const id = seedInbound({ bytes, mime: 'text/plain', type: 'document', filename: 'eicar.txt' });
      const r = await withClamd('stream: Eicar-Test-Signature FOUND\x00', () =>
        withToken(() => withMeta(metaOk(bytes, 'text/plain'), () => saveInbound(id))));
      assert.equal(r.ok, false);
      assert.match(r.error, /malware/i);
      assert.match(r.error, /Eicar-Test-Signature/);
      const row = getInbound(id);
      assert.equal(row.path, null, 'nothing must be written for a signature hit');
      assert.equal(row.scan_status, 'infected');
      assert.equal(row.scan_signature, 'Eicar-Test-Signature');
    });

    testAsync('an infected row is never re-fetched, however often Save is clicked', async () => {
      const bytes = Buffer.from(`${EICAR}-again`);
      const id = seedInbound({ bytes, mime: 'text/plain', type: 'document', filename: 'eicar2.txt' });
      await withClamd('stream: Eicar-Test-Signature FOUND\x00', () =>
        withToken(() => withMeta(metaOk(bytes, 'text/plain'), () => saveInbound(id))));

      // No fetch stub at all: if saveInbound tried to reach Meta this would
      // throw or hang rather than returning the recorded refusal.
      const again = await saveInbound(id);
      assert.equal(again.ok, false);
      assert.equal(again.scan, 'infected');
    });

    testAsync('a configured scanner that is down refuses the save — it never reads as clean', async () => {
      const savedAddr = CLAMAV.address;
      CLAMAV.address = '127.0.0.1:1';
      try {
        const bytes = Buffer.from(`u${Date.now()}`);
        const id = seedInbound({ bytes });
        const r = await withToken(() => withMeta(metaOk(bytes), () => saveInbound(id)));
        assert.equal(r.ok, false);
        assert.match(r.error, /scanner/i);
        assert.equal(getInbound(id).path, null);
      } finally { CLAMAV.address = savedAddr; }
    });

    testAsync('a file past clamd size limit still saves, marked oversize', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`o${Date.now()}`)]);
      const id = seedInbound({ bytes });
      const r = await withClamd('INSTREAM size limit exceeded. ERROR\x00', () =>
        withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      assert.equal(r.ok, true, 'a legitimate large video must not be unsavable');
      assert.equal(getInbound(id).scan_status, 'oversize');
    });

    testAsync('rescanIfNeeded scans a skipped row once a scanner appears', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`r${Date.now()}`)]);
      const id = seedInbound({ bytes });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      assert.equal(getInbound(id).scan_status, 'skipped');

      const after = await withClamd('stream: OK\x00', () => rescanIfNeeded(getInbound(id)));
      assert.equal(after.scan_status, 'clean');
      assert.equal(getInbound(id).scan_status, 'clean');
    });

    testAsync('rescanIfNeeded deletes the file when a late scan finds malware', async () => {
      const bytes = Buffer.from(`${EICAR}-late`);
      const id = seedInbound({ bytes, mime: 'text/plain', type: 'document', filename: 'late.txt' });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes, 'text/plain'), () => saveInbound(id))));
      const file = inboundPath(getInbound(id));
      assert.ok(fsm.existsSync(file));

      const after = await withClamd('stream: Eicar-Test-Signature FOUND\x00', () => rescanIfNeeded(getInbound(id)));
      assert.equal(after.scan_status, 'infected');
      assert.equal(after.path, null);
      assert.ok(!fsm.existsSync(file), 'a late signature hit must remove the bytes, not just relabel them');
    });

    testAsync('a transient rescan failure leaves the row retryable', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`f${Date.now()}`)]);
      const id = seedInbound({ bytes });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));

      // The daemon is configured but refuses the connection this once.
      const savedAddr = CLAMAV.address; CLAMAV.address = '127.0.0.1:1';
      let after;
      try { after = await rescanIfNeeded(getInbound(id)); }
      finally { CLAMAV.address = savedAddr; }
      assert.equal(after.scan_status, 'skipped',
        'persisting the error would make one restarting daemon mark the file permanently unscannable');

      // And the retry this function exists to provide still fires.
      const retried = await withClamd('stream: OK\x00', () => rescanIfNeeded(getInbound(id)));
      assert.equal(retried.scan_status, 'clean');
    });

    testAsync('rescanIfNeeded leaves an already-clean row alone', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`q${Date.now()}`)]);
      const id = seedInbound({ bytes });
      await withClamd('stream: OK\x00', () =>
        withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      const before = getInbound(id).scan_at;

      // A daemon that would report malware — but the row is already clean, so
      // it must never be asked.
      const after = await withClamd('stream: Would-Have-Failed FOUND\x00', () => rescanIfNeeded(getInbound(id)));
      assert.equal(after.scan_status, 'clean');
      assert.equal(after.scan_at, before, 'a clean row is not rescanned on every request');
    });
  }

  // ── Serving: the verdict is what decides inline / attachment / refusal ───────
  console.log('\ninbound media — serving by risk');
  {
    // The section above already proved saveInbound stores the verdict. These
    // set it directly so each test names exactly the tier it is about, rather
    // than hiding it behind a magic-byte fixture.
    const setRisk = (id, risk, scan = 'clean') =>
      db.prepare('UPDATE media SET risk = ?, scan_status = ? WHERE media_id = ?').run(risk, scan, id);

    const savedFile = async (opts = {}) => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]),
                                   Buffer.from(`s${Date.now()}${Math.random()}`)]);
      const id = seedInbound({ bytes, ...opts });
      await withoutScanner(() => withToken(() =>
        withMeta(metaOk(bytes, opts.mime || 'image/jpeg'), () => saveInbound(id))));
      return id;
    };

    const get = async (id, qs = '') => {
      const s = await serve();
      try {
        return await fetch(`http://127.0.0.1:${s.address().port}/api/media/inbound/${id}${qs}`, asOperator);
      } finally { s.close(); }
    };

    testAsync('a safe file still renders inline', async () => {
      const id = await savedFile();
      setRisk(id, 'safe');
      const r = await get(id);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /^inline/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('content-security-policy'), /sandbox/);
    });

    testAsync('an ok file downloads as an attachment', async () => {
      const id = await savedFile({ mime: 'text/plain', type: 'document', filename: 'notes.txt' });
      setRisk(id, 'ok');
      const r = await get(id);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /^attachment/);
    });

    // PDF is the single exception to "only tier safe renders inline". It is
    // narrow by construction, and each of these asserts one edge of it.
    testAsync('a classified ok PDF previews inline, sandboxed', async () => {
      const id = await savedFile({ mime: 'application/pdf', type: 'document', filename: 'invoice.pdf' });
      setRisk(id, 'ok');
      const r = await get(id);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /^inline/,
        'an operator should not have to download an invoice to find out whether it is the invoice');
      assert.match(r.headers.get('content-type'), /application\/pdf/);
      assert.match(r.headers.get('content-security-policy'), /sandbox/,
        'the sandbox is the whole reason this exception is affordable');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    });

    testAsync('the PDF exception does not extend to an unclassified row', async () => {
      const id = await savedFile({ mime: 'application/pdf', type: 'document', filename: 'legacy.pdf' });
      db.prepare('UPDATE media SET risk = NULL WHERE media_id = ?').run(id);
      const r = await get(id);
      assert.match(r.headers.get('content-disposition'), /^attachment/,
        'NULL reads as ok, but nothing ever looked at these bytes — that is a default, not evidence');
    });

    testAsync('an oversize scan takes the PDF preview away too', async () => {
      const id = await savedFile({ mime: 'application/pdf', type: 'document', filename: 'big.pdf' });
      setRisk(id, 'ok', 'oversize');
      const r = await get(id);
      assert.match(r.headers.get('content-disposition'), /^attachment/,
        'a file too big for the scanner is a file nobody vouched for, PDF or not');
    });

    testAsync('the PDF exception is keyed on the mime, not on the tier alone', async () => {
      const id = await savedFile({ mime: 'application/msword', type: 'document', filename: 'memo.doc' });
      setRisk(id, 'ok');
      const r = await get(id);
      assert.match(r.headers.get('content-disposition'), /^attachment/,
        'opening tier ok for PDF must not open it for every other document format');
    });

    testAsync('a warn file is always opaque bytes, never its declared type', async () => {
      const id = await savedFile({ mime: 'image/jpeg', filename: 'archive.zip' });
      setRisk(id, 'warn');
      const r = await get(id);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /^attachment/);
      assert.match(r.headers.get('content-type'), /application\/octet-stream/);
    });

    testAsync('a block file is refused, and the refusal says why', async () => {
      const id = await savedFile({ mime: 'text/html', type: 'document', filename: 'page.html' });
      setRisk(id, 'block');
      const r = await get(id);
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.equal(body.risk, 'block');
      assert.ok(body.reason, 'the operator has to be told what they would be accepting');
    });

    testAsync('risk=accept releases a block file as an attachment, never inline', async () => {
      const id = await savedFile({ mime: 'text/html', type: 'document', filename: 'page.html' });
      setRisk(id, 'block');
      const r = await get(id, '?risk=accept');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /^attachment/);
      assert.match(r.headers.get('content-type'), /application\/octet-stream/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('content-security-policy'), /sandbox/);
    });

    testAsync('risk=accept is not a general override — it cannot force inline', async () => {
      const id = await savedFile({ mime: 'image/jpeg' });
      setRisk(id, 'block');
      const r = await get(id, '?risk=accept');
      assert.match(r.headers.get('content-disposition'), /^attachment/,
        'an image mime on a blocked row must not buy back inline rendering');
      assert.match(r.headers.get('content-type'), /application\/octet-stream/);
    });

    testAsync('an oversize scan floors the tier at warn — a safe image stops rendering inline', async () => {
      const id = await savedFile();
      setRisk(id, 'safe', 'oversize');
      const r = await get(id);
      assert.match(r.headers.get('content-disposition'), /^attachment/,
        'a file too big for the scanner is a file nobody vouched for');
    });

    testAsync('?download=1 forces an attachment even for a safe file', async () => {
      const id = await savedFile();
      setRisk(id, 'safe');
      const r = await get(id, '?download=1');
      assert.match(r.headers.get('content-disposition'), /^attachment/);
    });

    testAsync('a row with no verdict at all is treated as ok, not safe', async () => {
      const id = await savedFile();
      db.prepare('UPDATE media SET risk = NULL WHERE media_id = ?').run(id);
      const r = await get(id);
      assert.match(r.headers.get('content-disposition'), /^attachment/,
        'a row saved before this feature existed must not inherit inline rendering');
    });

    testAsync('an infected row is refused at serve time too', async () => {
      const id = await savedFile();
      db.prepare("UPDATE media SET scan_status = 'infected', scan_signature = 'Test-Sig' WHERE media_id = ?").run(id);
      const r = await get(id);
      assert.equal(r.status, 403);
      assert.equal((await r.json()).scan, 'infected');
    });

    testAsync('the filename is sent RFC5987-encoded so a unicode name survives', async () => {
      const id = await savedFile({ mime: 'application/pdf', type: 'document', filename: 'फ़ाइल.pdf' });
      setRisk(id, 'ok');
      const r = await get(id);
      assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''/);
    });

    testAsync('a quote in a customer filename cannot break out of the header', async () => {
      const id = await savedFile({ mime: 'application/pdf', type: 'document', filename: 'a";x=1;b="c.pdf' });
      setRisk(id, 'ok');
      const r = await get(id);
      const cd = r.headers.get('content-disposition');
      assert.ok(cd, 'the header must still be parseable at all');
      assert.equal((cd.match(/"/g) || []).length, 2, 'exactly one quoted filename, no injected parameters');
    });

    testAsync("an apostrophe cannot split the RFC5987 filename*", async () => {
      // The apostrophe is ext-value's own delimiter, and encodeURIComponent
      // leaves it alone — so an unencoded one turns filename*=UTF-8''x into a
      // header a parser reads differently than intended.
      const id = await savedFile({ mime: 'application/pdf', type: 'document', filename: "o'brien's (final)!.pdf" });
      setRisk(id, 'ok');
      const r = await get(id);
      const star = r.headers.get('content-disposition').split("filename*=")[1];
      assert.equal(star.split("'").length - 1, 2, "exactly the two delimiters of UTF-8''<value>");
      assert.equal(decodeURIComponent(star.split("''")[1]), "o'brien's (final)!.pdf",
        'and it must still round-trip to the real name');
    });
  }

  // ── Retention: our 90-day clock, not Meta's 30-day one ──────────────────────
  console.log('\ninbound media — retention');
  {
    const { MEDIA_LIMITS } = require('./src/config');
    const DAY = 24 * 60 * 60 * 1000;
    const age = (id, ms) => db.prepare('UPDATE media SET downloaded_at = ? WHERE media_id = ?')
      .run(Date.now() - ms, id);

    const saveOne = async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]),
                                   Buffer.from(`k${Date.now()}${Math.random()}`)]);
      const id = seedInbound({ bytes });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      return id;
    };

    testAsync('a file older than the window is unlinked and the row keeps its history', async () => {
      const id = await saveOne();
      const file = inboundPath(getInbound(id));
      age(id, 91 * DAY);

      const r = sweepMedia();
      assert.ok(r.swept >= 1);
      assert.ok(!fsm.existsSync(file), 'the bytes must actually leave the disk');

      const row = getInbound(id);
      assert.equal(row.path, null, 'path clears so the bubble reverts to a Save button');
      assert.ok(row.media_id, 'the row itself survives — message history is not media');
      assert.equal(row.risk, 'safe', 'the verdict survives too, so a re-save need not re-derive it');
    });

    // The two stores have two lifetimes and must never be confused. `media` is
    // what customers sent us, lives in MEDIA_DIR and is on a 90-day clock;
    // `media_assets` is what the operator uploaded, lives in UPLOAD_DIR and is
    // never swept. This guards a property that already holds — it exists so a
    // later change to retention.js cannot quietly break it, because deleting an
    // operator's price list is silent and unrecoverable.
    testAsync('the sweep never touches an operator upload', async () => {
      const up = saveUpload({ buffer: Buffer.from(`%PDF-1.7 keep me ${Math.random()}`),
                              originalname: 'price-list.pdf', mimetype: 'application/pdf' });
      assert.equal(up.ok, true, up.error);
      const file = assetPath(up.asset);
      assert.ok(fsm.existsSync(file), 'the fixture has to exist before the sweep to prove anything');

      // An inbound file old enough to actually make the sweep do work, so this
      // is not passing merely because nothing was swept at all.
      const id = await saveOne();
      age(id, 400 * DAY);
      const r = sweepMedia();
      assert.ok(r.swept >= 1, 'the sweep must have run for real');

      assert.ok(fsm.existsSync(file),
        'UPLOAD_DIR holds files the operator owns and is still sending — only MEDIA_DIR is on a clock');
      assert.ok(getAsset(up.asset.id),
        'and the row survives too, or the library would lose a file whose bytes are still there');
    });

    testAsync('a file inside the window is left alone', async () => {
      const id = await saveOne();
      const file = inboundPath(getInbound(id));
      age(id, 89 * DAY);

      sweepMedia();
      assert.ok(fsm.existsSync(file));
      assert.ok(getInbound(id).path);
    });

    testAsync('the window is configurable', async () => {
      const saved = MEDIA_LIMITS.retentionDays;
      MEDIA_LIMITS.retentionDays = 1;
      try {
        const id = await saveOne();
        age(id, 2 * DAY);
        sweepMedia();
        assert.equal(getInbound(id).path, null);
      } finally { MEDIA_LIMITS.retentionDays = saved; }
    });

    // ── Preview: fetched to be looked at, not to be kept ──────────────────────
    // The whole point of the flag is that it changes the CLOCK and nothing else.
    // Each of these pins one half of that sentence.
    const HOUR = 60 * 60 * 1000;

    const previewOne = async (opts = {}) => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]),
                                   Buffer.from(`p${Date.now()}${Math.random()}`)]);
      const id = seedInbound({ bytes, ...opts });
      await withoutScanner(() => withToken(() =>
        withMeta(metaOk(bytes, opts.mime), () => saveInbound(id, { provisional: true }))));
      return id;
    };

    testAsync('a previewed file is still scanned and classified like any other', async () => {
      const id = await previewOne();
      const row = getInbound(id);
      assert.equal(row.provisional, 1, 'it is on the short clock');
      assert.equal(row.risk, 'safe', 'but it went through classify() all the same');
      assert.ok(row.risk_reason, 'and carries the sentence the UI renders');
      assert.ok(row.path, 'the bytes are genuinely here — a preview cannot render what was not fetched');
    });

    testAsync('a preview nobody keeps is swept in hours, not days', async () => {
      const id = await previewOne();
      const file = inboundPath(getInbound(id));
      age(id, MEDIA_LIMITS.previewHours * HOUR + HOUR);

      sweepMedia();
      assert.ok(!fsm.existsSync(file), 'browsing a thread must not quietly build a permanent archive');
      assert.equal(getInbound(id).path, null);
    });

    testAsync('a preview inside its window survives the 90-day sweep', async () => {
      const id = await previewOne();
      age(id, 1 * HOUR);
      sweepMedia();
      assert.ok(getInbound(id).path, 'an operator who looked an hour ago is still looking');
    });

    testAsync('Keep moves a preview onto the 90-day clock', async () => {
      const id = await previewOne();
      assert.equal(keepInbound(id).ok, true);
      assert.equal(getInbound(id).provisional, 0);

      age(id, MEDIA_LIMITS.previewHours * HOUR + HOUR);
      sweepMedia();
      assert.ok(getInbound(id).path, 'the short clock must not still apply to a file someone kept');
    });

    testAsync('Discard removes the bytes and reverts the bubble', async () => {
      const id = await previewOne();
      const file = inboundPath(getInbound(id));
      assert.equal(discardInbound(id).ok, true);
      assert.ok(!fsm.existsSync(file));

      const row = getInbound(id);
      assert.equal(row.path, null);
      assert.equal(row.provisional, 0, 'a row with no bytes is not "provisionally saved", it is unsaved');
    });

    testAsync('Discard refuses a file that was kept on purpose', async () => {
      const id = await previewOne();
      keepInbound(id);
      const file = inboundPath(getInbound(id));

      const r = discardInbound(id);
      assert.equal(r.ok, false);
      assert.match(r.error, /kept on purpose/);
      assert.ok(fsm.existsSync(file), 'the one thing this must never do is delete a kept file');
    });

    testAsync('Discard leaves bytes a second message still points at', async () => {
      // Same bytes, two media rows — a forwarded photo. Files are named for
      // their own sha256, so both rows are one file on disk.
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('shared-preview')]);
      const a = seedInbound({ bytes });
      const b = seedInbound({ bytes });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(a))));
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () =>
        saveInbound(b, { provisional: true }))));

      const file = inboundPath(getInbound(a));
      assert.equal(discardInbound(b).ok, true);
      assert.equal(getInbound(b).path, null, 'the discarded row lets go');
      assert.ok(fsm.existsSync(file), 'but the kept row must not be left 404ing on click');
      assert.ok(getInbound(a).path, 'and must still claim the file');
    });

    testAsync('Preview on an already-kept file does not demote it', async () => {
      const id = await saveOne();
      const r = await withoutScanner(() => withToken(() =>
        withMeta(metaOk(Buffer.from('x')), () => saveInbound(id, { provisional: true }))));
      assert.equal(r.ok, true);
      assert.equal(getInbound(id).provisional, 0,
        'a Preview click must not put a 24-hour clock on something kept on purpose');
    });

    testAsync('Keep refuses a row with nothing on disk', () => {
      const id = seedInbound({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0x01]) });
      const r = keepInbound(id);
      assert.equal(r.ok, false);
      assert.match(r.error, /preview or save it first/);
    });

    testAsync('a swept file can be saved again from Meta', async () => {
      // Same bytes on the second fetch, because the row still carries the
      // sha256 the webhook recorded — a sweep clears the file, never the
      // receipt, so a re-download that does not match is still refused.
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`again${Date.now()}`)]);
      const id = seedInbound({ bytes });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));

      age(id, 91 * DAY);
      sweepMedia();
      assert.equal(getInbound(id).path, null);

      // The message itself is recent here, so Meta still has it. The point is
      // that a swept row is savable at all rather than permanently blank.
      const again = await withoutScanner(() => withToken(() =>
        withMeta(metaOk(bytes), () => saveInbound(id))));
      assert.equal(again.ok, true);
      assert.ok(getInbound(id).path);
    });

    test('a row whose file is already gone is cleaned up without an error', () => {
      db.prepare(`INSERT OR REPLACE INTO media (media_id, wamid, mime_type, path, downloaded_at)
                  VALUES ('mid.ghost', 'wamid.ghost', 'image/jpeg', 'not-on-disk.jpg', 1)`).run();
      const r = sweepMedia();
      assert.equal(r.errors, 0, 'a missing file is the expected end state, not a failure');
      assert.equal(db.prepare("SELECT path FROM media WHERE media_id = 'mid.ghost'").get().path, null);
    });

    test('a path that escapes the media directory is refused, not unlinked', () => {
      db.prepare(`INSERT OR REPLACE INTO media (media_id, wamid, mime_type, path, downloaded_at)
                  VALUES ('mid.escape', 'wamid.escape', 'image/jpeg', '../../../etc/hosts', 1)`).run();
      const r = sweepMedia();
      assert.ok(r.errors >= 1, 'a tampered path must be reported, never followed');
      assert.equal(db.prepare("SELECT path FROM media WHERE media_id = 'mid.escape'").get().path,
        '../../../etc/hosts', 'and it must not be quietly cleared either');
      db.prepare("DELETE FROM media WHERE media_id = 'mid.escape'").run();
    });

    test('sweeping twice is a no-op the second time', () => {
      sweepMedia();
      const second = sweepMedia();
      assert.equal(second.swept, 0);
      assert.equal(second.errors, 0);
    });

    test('a never-downloaded row is not swept', () => {
      db.prepare(`INSERT OR REPLACE INTO media (media_id, wamid, mime_type, path, downloaded_at)
                  VALUES ('mid.neversaved', 'wamid.neversaved', 'image/jpeg', NULL, NULL)`).run();
      sweepMedia();
      assert.equal(db.prepare("SELECT path FROM media WHERE media_id = 'mid.neversaved'").get().path, null);
    });

    // Saved files are named for their own sha256, so identical bytes arriving
    // twice — a forwarded photo, one price list sent to two customers — are two
    // rows over one file with two independent 90-day clocks. The sweep used to
    // unlink on behalf of whichever row expired first, leaving the other one
    // still reporting `saved`, still rendering a preview, and 404ing on click.
    testAsync('an expiring row does not unlink a file another row still points at', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]),
                                   Buffer.from(`shared${Date.now()}`)]);
      const first  = seedInbound({ bytes });
      const second = seedInbound({ bytes });
      const save = id => withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      await save(first);
      await save(second);

      const file = inboundPath(getInbound(first));
      assert.equal(getInbound(second).path, getInbound(first).path,
        'identical bytes must dedupe onto one file — that is the premise of this test');

      age(first, 91 * DAY);
      sweepMedia();

      assert.equal(getInbound(first).path, null, 'the expired row still retires');
      assert.ok(getInbound(second).path, 'the row inside its own window keeps its claim');
      assert.ok(fsm.existsSync(file), 'and the bytes it claims are still there');

      // Last row out turns off the lights.
      age(second, 91 * DAY);
      sweepMedia();
      assert.equal(getInbound(second).path, null);
      assert.ok(!fsm.existsSync(file), 'once nobody points at it, the file goes');
    });

    testAsync('a later infection verdict condemns every row over the same bytes', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]),
                                   Buffer.from(`twins${Date.now()}`)]);
      const first  = seedInbound({ bytes });
      const second = seedInbound({ bytes });
      const save = id => withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      await save(first);
      await save(second);
      const file = inboundPath(getInbound(first));

      // Both rows are `skipped` — saved before a scanner existed. Installing one
      // and asking for the first row is what triggers the rescan.
      await withClamd('stream: Twin-Test-Signature FOUND\x00',
        () => rescanIfNeeded(getInbound(first)));

      assert.equal(getInbound(first).scan_status,  'infected');
      assert.equal(getInbound(second).scan_status, 'infected',
        'the sibling is the same malware — leaving it `skipped` over deleted bytes is a lie');
      assert.equal(getInbound(second).path, null);
      assert.ok(!fsm.existsSync(file));
    });
  }

  // ── What the thread hands the UI ────────────────────────────────────────────
  console.log('\ninbound media — what the thread hands the UI');
  {
    const entryFor = id => inboxThread('910000000001').messages
      .find(m => m.media && m.media.mediaId === id);

    testAsync('a thread entry carries the risk verdict the UI renders from', async () => {
      const bytes = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.from(`w${Date.now()}`)]);
      const id = seedInbound({ bytes, mime: 'application/pdf', type: 'document', filename: 'invoice.pdf' });
      await withoutScanner(() => withToken(() =>
        withMeta(metaOk(bytes, 'application/pdf'), () => saveInbound(id))));

      const e = entryFor(id);
      assert.ok(e, 'the message with this media must be in the thread');
      assert.equal(e.media.risk, 'block');
      assert.equal(e.media.scanStatus, 'skipped');
      assert.ok(e.media.riskReason, 'the UI needs a sentence, not just a tier name');
    });

    testAsync('a scanned safe photo reports clean', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`g${Date.now()}`)]);
      const id = seedInbound({ bytes, filename: 'photo.jpg' });
      await withClamd('stream: OK\x00', () =>
        withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));

      const e = entryFor(id);
      assert.equal(e.media.risk, 'safe');
      assert.equal(e.media.scanStatus, 'clean');
    });

    test('an unsaved media entry reports no verdict rather than a wrong one', () => {
      const id = seedInbound({ bytes: Buffer.from(`v${Date.now()}`) });
      const e = entryFor(id);
      assert.equal(e.media.saved, false);
      assert.equal(e.media.risk, null, 'a red warning on a file nothing has looked at would be a lie');
      assert.equal(e.media.scanStatus, null);
    });

    // The bug this catches: the oversize floor lived only in the serve route,
    // so the UI still saw `safe`, rendered an <img>, and the server answered
    // with an attachment. The visible symptom is a broken image icon.
    testAsync('an oversize row reads as warn in the thread, matching what the route serves', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`z${Date.now()}`)]);
      const id = seedInbound({ bytes });
      await withClamd('INSTREAM size limit exceeded. ERROR\x00', () =>
        withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      assert.equal(getInbound(id).risk, 'safe', 'the stored tier is still what the bytes said');

      const e = entryFor(id);
      assert.equal(e.media.risk, 'warn', 'but the UI must see what the route will actually do');
      assert.equal(e.media.scanStatus, 'oversize');

      const s = await serve();
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/api/media/inbound/${id}`, asOperator);
        assert.match(r.headers.get('content-disposition'), /^attachment/,
          'route and thread must agree, or the inbox renders a broken image');
      } finally { s.close(); }
    });

    testAsync('a saved row from before this feature reads as ok, never safe', async () => {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`h${Date.now()}`)]);
      const id = seedInbound({ bytes });
      await withoutScanner(() => withToken(() => withMeta(metaOk(bytes), () => saveInbound(id))));
      db.prepare('UPDATE media SET risk = NULL, scan_status = NULL WHERE media_id = ?').run(id);

      const e = entryFor(id);
      assert.equal(e.media.risk, 'ok');
      assert.equal(e.media.scanStatus, 'skipped');
    });
  }
}

console.log('\nfile risk classification');
{
  const { classify, sniff, extOf, worst, TIERS } = require('./server');
  const TIERSET = new Set(TIERS);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const png  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pdf  = Buffer.from('%PDF-1.7\n');
  const mz   = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
  const elf  = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]);
  const zip  = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const html = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');
  const mp4  = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42')]);

  test('worst() orders the tiers by severity', () => {
    assert.equal(worst('safe', 'ok'), 'ok');
    assert.equal(worst('block', 'safe'), 'block');
    assert.equal(worst('warn', 'ok'), 'warn');
    assert.equal(worst('safe', 'safe'), 'safe');
  });

  test('sniff() recognises the formats the table claims to', () => {
    assert.equal(sniff(jpeg), 'jpeg');
    assert.equal(sniff(png),  'png');
    assert.equal(sniff(pdf),  'pdf');
    assert.equal(sniff(mz),   'exe');
    assert.equal(sniff(elf),  'elf');
    assert.equal(sniff(zip),  'zip');
    assert.equal(sniff(ole2), 'ole2');
    assert.equal(sniff(html), 'html');
    assert.equal(sniff(mp4),  'mp4');
    assert.equal(sniff(Buffer.from('OggS\x00\x02\x00\x00')), 'ogg');
    assert.equal(sniff(Buffer.from('#!AMR\n')), 'amr');
    assert.equal(sniff(Buffer.from('#!/bin/sh\nrm -rf /')), 'script');
    assert.equal(sniff(Buffer.from('nothing recognisable at all')), null);
    assert.equal(sniff(Buffer.alloc(0)), null);
    assert.equal(sniff(null), null);
  });

  test('extOf() strips anything that could reach a filesystem path', () => {
    assert.equal(extOf('holiday.JPG'), '.jpg');
    assert.equal(extOf('report.pdf'), '.pdf');
    assert.equal(extOf('no-extension'), '');
    assert.equal(extOf('../../../etc/passwd'), '');
    assert.equal(extOf('evil.'), '');
    assert.equal(extOf('evil..'), '');
    assert.equal(extOf('a.' + 'x'.repeat(50)), '');   // over 10 chars is not an extension
    assert.equal(extOf('shell.sh; rm -rf /'), '');
    assert.equal(extOf('x.tar/../../y'), '');
    assert.equal(extOf(null), '');
  });

  test('a genuine photo classifies safe', () => {
    const v = classify({ mime: 'image/jpeg', filename: 'holiday.jpg', bytes: jpeg });
    assert.equal(v.tier, 'safe');
    assert.equal(v.sniffed, 'jpeg');
  });

  test('a voice note with codec parameters still classifies safe', () => {
    const ogg = Buffer.from('OggS\x00\x02\x00\x00');
    assert.equal(classify({ mime: 'audio/ogg; codecs=opus', filename: undefined, bytes: ogg }).tier, 'safe');
  });

  // A video shared as a document keeps the container it was recorded in. Both
  // of these mimes were missing from the table, so they voted `ok` as
  // unrecognised — and a video that can never reach `safe` can never preview,
  // however clean its bytes are.
  test('a quicktime video from an iPhone classifies safe', () => {
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')]);
    const v = classify({ mime: 'video/quicktime', filename: 'IMG_4021.mov', bytes: mov });
    assert.equal(v.tier, 'safe', 'a .mov that sniffs as an ISO container has evidence from all three signals');
    assert.equal(v.sniffed, 'mp4');
  });

  test('a webm video classifies safe on its EBML header', () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('\x01\x00\x00\x00')]);
    const v = classify({ mime: 'video/webm', filename: 'clip.webm', bytes: webm });
    assert.equal(v.tier, 'safe');
    assert.equal(v.sniffed, 'ebml');
  });

  test('a webm name over executable bytes is still blocked', () => {
    assert.equal(classify({ mime: 'video/webm', filename: 'clip.webm', bytes: mz }).tier, 'block',
      'adding a container to the safe list must not buy anything past the byte check');
  });

  test('safe needs all three signals — unrecognised bytes demote to ok', () => {
    const v = classify({ mime: 'image/png', filename: 'x.png', bytes: Buffer.from('not a png at all') });
    assert.equal(v.tier, 'ok', 'nothing renders inline on the strength of a declared mime alone');
    assert.match(v.reason, /bytes/i);
  });

  test('an executable wearing a pdf name and mime is blocked by its bytes', () => {
    const v = classify({ mime: 'application/pdf', filename: 'invoice.pdf', bytes: mz });
    assert.equal(v.tier, 'block');
    assert.equal(v.sniffed, 'exe');
  });

  test('an executable extension blocks even with innocent bytes', () => {
    assert.equal(classify({ mime: 'application/octet-stream', filename: 'setup.exe', bytes: jpeg }).tier, 'block');
  });

  test('html and svg are blocked — they are the XSS vector this feature exists for', () => {
    assert.equal(classify({ mime: 'text/html', filename: 'a.html', bytes: html }).tier, 'block');
    assert.equal(classify({ mime: 'image/svg+xml', filename: 'logo.svg', bytes: Buffer.from('<svg onload=alert(1)>') }).tier, 'block');
    // The bytes alone are enough: a customer who declares image/png and names
    // it .png but sends markup must not slip through on two forged signals.
    assert.equal(classify({ mime: 'image/png', filename: 'logo.png', bytes: Buffer.from('  <svg onload=alert(1)>') }).tier, 'block');
  });

  test('zip resolves by extension because the magic bytes cannot', () => {
    assert.equal(classify({ mime: 'application/zip', filename: 'app.apk',  bytes: zip }).tier, 'block');
    assert.equal(classify({ mime: 'application/zip', filename: 'lib.jar',  bytes: zip }).tier, 'block');
    assert.equal(classify({ mime: 'application/zip', filename: 'q3.docm',  bytes: zip }).tier, 'warn');
    assert.equal(classify({ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'q3.docx', bytes: zip }).tier, 'ok');
    assert.equal(classify({ mime: 'application/zip', filename: 'stuff.zip', bytes: zip }).tier, 'warn');
    assert.equal(classify({ mime: 'application/zip', filename: undefined,   bytes: zip }).tier, 'warn');
  });

  test('legacy OLE2 Office is warn — it can carry a macro', () => {
    assert.equal(classify({ mime: 'application/msword', filename: 'old.doc', bytes: ole2 }).tier, 'warn');
  });

  test('a csv is warn — spreadsheet formula injection is a real delivery route', () => {
    assert.equal(classify({ mime: 'text/csv', filename: 'contacts.csv', bytes: Buffer.from('=cmd|calc') }).tier, 'warn');
  });

  test('a plain pdf is ok — downloads, never renders inline', () => {
    assert.equal(classify({ mime: 'application/pdf', filename: 'invoice.pdf', bytes: pdf }).tier, 'ok');
  });

  test('an unknown mime with no filename and no bytes is ok, not safe', () => {
    assert.equal(classify({}).tier, 'ok');
  });

  test('effectiveRisk floors an unscannable file at warn', () => {
    const { effectiveRisk } = require('./server');
    assert.equal(effectiveRisk('safe', 'clean'), 'safe');
    assert.equal(effectiveRisk('safe', 'oversize'), 'warn', 'nobody vouched for a file the scanner could not read');
    assert.equal(effectiveRisk('block', 'oversize'), 'block', 'the floor raises, it never lowers');
    assert.equal(effectiveRisk(null, 'clean'), 'ok', 'a row from before classification is not safe');
    assert.equal(effectiveRisk('nonsense', 'clean'), 'ok', 'an unrecognised tier is not safe either');
  });

  test('classify() never throws on hostile input', () => {
    for (const bad of [undefined, null, {}, { mime: 123 }, { filename: {} }, { bytes: 'not a buffer' }]) {
      assert.ok(TIERSET.has(classify(bad).tier));
    }
  });
}

console.log('\nclamav scanning');
{
  const net = require('node:net');
  const { scanBuffer, parseReply, scannerConfigured, EICAR } = require('./server');
  const { CLAMAV } = require('./src/config');

  test('parseReply reads the answers clamd actually gives', () => {
    assert.deepEqual(parseReply('stream: OK\x00'), { status: 'clean', signature: null });
    assert.deepEqual(parseReply('stream: Eicar-Test-Signature FOUND\x00'),
      { status: 'infected', signature: 'Eicar-Test-Signature' });
    assert.equal(parseReply('INSTREAM size limit exceeded. ERROR\x00').status, 'oversize');
    assert.equal(parseReply('stream: Broken pipe ERROR\x00').status, 'error');
    assert.equal(parseReply('').status, 'error');
    assert.equal(parseReply('something clamd has never said').status, 'error');
  });

  test('no CLAMAV_ADDRESS means no scanner', () => {
    const saved = CLAMAV.address;
    CLAMAV.address = '';
    try { assert.equal(scannerConfigured(), false); }
    finally { CLAMAV.address = saved; }
  });

  testAsync('a clean file comes back clean', async () => {
    await withClamd('stream: OK\x00', async () => {
      assert.deepEqual(await scanBuffer(Buffer.from('harmless')), { status: 'clean', signature: null });
    });
  });

  testAsync('the bytes actually reach the daemon', async () => {
    await withClamd('stream: OK\x00', async chunks => {
      await scanBuffer(Buffer.from('the payload'));
      assert.equal(Buffer.concat(chunks).toString(), 'the payload');
    });
  });

  testAsync('a file bigger than one chunk is framed correctly', async () => {
    const big = Buffer.alloc(200_000, 0x41);
    await withClamd('stream: OK\x00', async chunks => {
      await scanBuffer(big);
      assert.equal(Buffer.concat(chunks).length, big.length,
        'a 100 MB video must not lose bytes to the 64 KiB chunk loop');
    });
  });

  testAsync('a signature hit comes back infected, with the signature name', async () => {
    await withClamd('stream: Eicar-Test-Signature FOUND\x00', async () => {
      const r = await scanBuffer(Buffer.from(EICAR));
      assert.equal(r.status, 'infected');
      assert.equal(r.signature, 'Eicar-Test-Signature');
    });
  });

  testAsync('a file past clamd StreamMaxLength comes back oversize, not clean', async () => {
    await withClamd('INSTREAM size limit exceeded. ERROR\x00', async () => {
      assert.equal((await scanBuffer(Buffer.from('big'))).status, 'oversize');
    });
  });

  testAsync('a configured but unreachable daemon is an error, never a clean', async () => {
    const saved = CLAMAV.address;
    CLAMAV.address = '127.0.0.1:1';   // nothing listens on port 1
    try {
      const r = await scanBuffer(Buffer.from('x'));
      assert.equal(r.status, 'error', 'a broken scanner must never read as clean');
      assert.ok(r.signature, 'the failure text is what the operator gets shown');
    } finally { CLAMAV.address = saved; }
  });

  testAsync('a daemon that hangs up mid-scan is an error', async () => {
    await withClamd('', async () => {
      assert.equal((await scanBuffer(Buffer.from('x'))).status, 'error');
    }, { drop: true });
  });

  testAsync('no scanner configured means skipped, not error', async () => {
    const saved = CLAMAV.address;
    CLAMAV.address = '';
    try { assert.deepEqual(await scanBuffer(Buffer.from('x')), { status: 'skipped', signature: null }); }
    finally { CLAMAV.address = saved; }
  });

  testAsync('a daemon that never answers times out as an error', async () => {
    const saved = CLAMAV.timeoutMs; CLAMAV.timeoutMs = 150;
    try {
      await withClamd(null, async () => {
        const r = await scanBuffer(Buffer.from('x'));
        assert.equal(r.status, 'error');
        assert.match(r.signature, /timed out/i);
      });
    } finally { CLAMAV.timeoutMs = saved; }
  });
}

// ── The contact directory: search, paging, and an opt-out that outlives the row ─
// The suppression table exists because "delete this contact" and "forget they
// opted out" used to be the same action, and the next CSV upload then re-created
// them as enabled and messaged them again. Every test here is about that gap.
console.log('\ncontacts — directory paging, rename, delete, suppression');
{
  const seed = (phone, name) => contacts.upsertFromCsv([{ dialStr: phone, name }]);
  let n = 0;
  const nextPhone = () => `9199000${String(++n).padStart(5, '0')}`;

  test('an opt-out survives deleting the contact, and a later CSV brings them back disabled', () => {
    const p = nextPhone();
    seed(p, 'Asha');
    contacts.disable(p, 'opt_out');
    assert.equal(contacts.remove(p).ok, true);
    assert.equal(contacts.getRow(p), undefined, 'the customer-list row really is gone');
    assert.equal(contacts.isDisabled(p), true,
      'the compliance record is not the customer list — deleting one must not clear the other');

    seed(p, 'Asha');
    const back = contacts.getRow(p);
    assert.equal(back.enabled, 0,
      're-uploading a CSV must never message someone who opted out, row or no row');
    assert.equal(back.disabled_reason, 'opt_out', 'and it says why, not just that');
  });

  test('an explicit re-enable is not undone by the next CSV upload', () => {
    const p = nextPhone();
    seed(p, 'Rahul');
    contacts.disable(p, 'manual');
    assert.equal(contacts.enable(p), true);
    seed(p, 'Rahul');
    assert.equal(contacts.isDisabled(p), false,
      'an operator who deliberately re-enabled someone must not be overruled by an upload');
  });

  test('a number suppressed with no contacts row at all is still disabled', () => {
    const p = nextPhone();
    contacts.disable(p, 'opt_out');       // creates the row
    contacts.remove(p);                    // operator deletes it
    assert.equal(contacts.isEnabled(p), false,
      'the campaign gate reads both tables, and fails closed when either says stop');
  });

  test('search escapes LIKE wildcards instead of matching everything', () => {
    const p = nextPhone();
    seed(p, '50% off shop');
    seed(nextPhone(), 'Somebody Else');
    const hit = contacts.page({ q: '50%' });
    assert.equal(hit.total, 1, 'unescaped, "50%" is a wildcard and matches the whole table');
    assert.equal(hit.rows[0].name, '50% off shop');
    assert.equal(contacts.page({ q: '_' }).total, 0, 'and _ is a single-character wildcard');
  });

  test('paging returns a window and the total it came from', () => {
    const marker = `Pager${Date.now()}`;
    for (let i = 0; i < 5; i++) seed(nextPhone(), `${marker} ${i}`);
    const first = contacts.page({ q: marker, limit: 2, offset: 0 });
    const last  = contacts.page({ q: marker, limit: 2, offset: 4 });
    assert.equal(first.total, 5, 'the pager needs the count, not the size of the page it got');
    assert.equal(first.rows.length, 2);
    assert.equal(last.rows.length, 1, 'the final page is short, not empty');
    assert.equal(contacts.page({ q: marker, limit: 2, offset: 99 }).rows.length, 0,
      'and paging past the end is empty rather than an error');
  });

  test('a hand-edited limit cannot ask for the whole table', () => {
    assert.equal(contacts.page({ limit: 1000000 }).limit, 200, 'the ceiling is the server\'s, not the query string\'s');
    assert.equal(contacts.page({ limit: 0 }).limit, 50);
  });

  test('the status filter is a whitelist', () => {
    assert.equal(contacts.page({ status: 'nonsense' }).status, 'all',
      'an unknown filter shows everything rather than silently hiding rows');
    const off = contacts.page({ status: 'disabled' });
    assert.ok(off.rows.every(r => r.enabled === 0));
  });

  test('renaming a contact touches the name and nothing else', () => {
    const p = nextPhone();
    seed(p, 'Typo Naem');
    const r = contacts.rename(p, 'Priya Nair');
    assert.equal(r.ok, true, r.error);
    assert.equal(contacts.getRow(p).name, 'Priya Nair');
    assert.equal(contacts.getRow(p).phone, p, 'the phone number is the key every message joins on');
  });

  test('a blank or control-character name is refused', () => {
    const p = nextPhone();
    seed(p, 'Fine');
    assert.equal(contacts.rename(p, '   ').ok, false);
    assert.equal(contacts.rename(p, 'bad\u0000name').ok, false,
      'this string is interpolated into a template and sent to Meta');
    assert.equal(contacts.rename(p, 'x'.repeat(200)).ok, false);
    assert.equal(contacts.getRow(p).name, 'Fine', 'and a refusal changes nothing');
  });

  test('editing someone who is not there is a sentence, not a crash', () => {
    assert.match(contacts.rename('919999999999', 'Ghost').error, /No contact/);
    assert.match(contacts.remove('919999999999').error, /No contact/);
    assert.equal(contacts.rename('not a number', 'x').ok, false);
  });
}

// ── Force delete and the tombstone ────────────────────────────────────────────
// SQLite does not enforce the REFERENCES on messages.asset_id or
// templates.header_asset — foreign_keys is off — so deleting a referenced asset
// row would silently orphan history. The tombstone is the answer: bytes gone,
// row kept, history can still say what it sent.
console.log('\nstorage — force delete keeps the record, re-upload restores the file');
{
  const fsy = require('fs');
  const upload = name => saveUpload({
    buffer: Buffer.from(`%PDF-1.7 tombstone ${name}`),
    originalname: name, mimetype: 'application/pdf' });

  const reference = assetId => db
    .prepare('INSERT INTO campaign_runs (started_at, label, header_asset) VALUES (?,?,?)')
    .run(Date.now(), 'tombstone-ref', assetId);

  test('a referenced asset is still refused without an explicit force', () => {
    const a = upload('kes-series.pdf');
    reference(a.asset.id);
    const r = deleteAsset(a.asset.id);
    assert.equal(r.ok, false, 'a plain delete must never be able to break history');
    assert.ok(fsy.existsSync(assetPath(a.asset)), 'and the bytes are untouched');
  });

  test('force delete removes the bytes and keeps the record', () => {
    const a = upload('force-me.pdf');
    reference(a.asset.id);
    const r = deleteAsset(a.asset.id, { force: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.tombstoned, true);
    assert.equal(fsy.existsSync(assetPath(a.asset)), false, 'the file really is gone');

    const row = getAsset(a.asset.id);
    assert.ok(row, 'the row stays, or the campaign that sent it can no longer name it');
    assert.ok(row.deleted_at > 0);
    assert.equal(row.filename, 'force-me.pdf', 'and it still says what was sent');
  });

  test('a tombstoned file is not offered in the library or counted as disk', () => {
    const a = upload('hidden-after-delete.pdf');
    reference(a.asset.id);
    const bytes = overview().breakdown.uploads.bytes;
    deleteAsset(a.asset.id, { force: true });

    assert.equal(listAssets().some(x => x.id === a.asset.id), false,
      'picking it would build a send that fails at Meta instead of failing here');
    assert.equal(overview().breakdown.uploads.bytes, bytes - a.asset.file_size,
      'a record with no bytes is not disk usage');

    const listed = listStored().uploads.find(x => x.id === String(a.asset.id));
    assert.ok(listed, 'it stays visible on the page that explains where files went');
    assert.ok(listed.deletedAt > 0);
    assert.equal(listed.deletable, false, 'there is nothing left to delete');
    assert.match(listed.why, /deleted/);
  });

  test('deleting an already-deleted file, or renaming one, is refused', () => {
    const a = upload('twice.pdf');
    reference(a.asset.id);
    deleteAsset(a.asset.id, { force: true });
    assert.equal(deleteAsset(a.asset.id, { force: true }).ok, false);
    assert.equal(renameAsset(a.asset.id, 'new-name.pdf').ok, false,
      'the record is what history reads — renaming it would make it say something that never went out');
  });

  test('re-uploading the same bytes restores the tombstoned row rather than making a second one', () => {
    const bytes = Buffer.from('%PDF-1.7 revive me');
    const first  = saveUpload({ buffer: bytes, originalname: 'revive.pdf', mimetype: 'application/pdf' });
    reference(first.asset.id);
    deleteAsset(first.asset.id, { force: true });

    const again = saveUpload({ buffer: bytes, originalname: 'revive-renamed.pdf', mimetype: 'application/pdf' });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.revived, true);
    assert.equal(again.asset.id, first.asset.id,
      'sha256 is UNIQUE and the tombstone is what history points at — a second row would orphan it');
    assert.equal(again.asset.deleted_at, null);
    assert.equal(again.asset.filename, 'revive.pdf',
      'the stored name stays: history already reported sending that name');
    assert.ok(fsy.existsSync(assetPath(again.asset)), 'and the bytes are back on disk');
  });

  test('the root reserve is its own line, not part of "everything else"', () => {
    const v = overview().volume;
    if (v.total === null) return;             // a filesystem that cannot answer
    assert.ok(v.reserved === null || v.reserved >= 0);
    const ours = overview().ours;
    assert.equal(v.other, Math.max(0, v.total - v.free - (v.reserved || 0) - ours),
      'ext4 keeps 5% for root — counting it as OS usage overstated the OS by about a gigabyte');
  });
}

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
});
