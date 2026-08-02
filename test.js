'use strict';
// Run: node test.js
// ponytail: no framework, no fixtures. Pure functions only — nothing here
// touches the network or the campaign loop.

const assert = require('node:assert/strict');
const {
  slugify, templateVars, sanitizeParam, validateTemplateInput,
  buildTemplatePayload, normalizePhone, parseCSV, buildParams, verifySignature, explainError, tierToCap, META_ERRORS, S,
  warmupStep, warmupCap, effectiveCap, todayKey, WARMUP_PLAN, W,
  applyStatus, missingParams, resizeParamValues,
  rateFor, billableCount, estimateCost, spentCost, formatMoney,
  isWindowOpen, recordInbound, describeInbound, inboxSummary,
  checkPassword, createSession, validSession, destroySession,
  PRICES,
} = require('./server');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
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

console.log('\nstatus webhook counting');
{
  const seed = () => {
    S.msgIndex = { m1: { phone: '911', name: 'A', status: 'accepted' } };
    S.delivered = 0; S.read = 0; S.failLog = [];
  };
  const feed = (...sts) => sts.forEach(s => applyStatus({ id: 'm1', status: s }));

  test('delivered then read counts each once', () => {
    seed(); feed('delivered', 'read');
    assert.deepEqual([S.delivered, S.read], [1, 1]);
  });
  test('a read with no delivered still counts as delivered', () => {
    seed(); feed('read');
    assert.deepEqual([S.delivered, S.read], [1, 1]);
  });
  test('Meta redelivering the same status does not double count', () => {
    seed(); feed('delivered', 'delivered', 'read', 'read');
    assert.deepEqual([S.delivered, S.read], [1, 1]);
  });
  test('an out-of-order delivered after read does not rewind or recount', () => {
    seed(); feed('read', 'delivered', 'read');
    assert.deepEqual([S.delivered, S.read], [1, 1]);
    assert.equal(S.msgIndex.m1.status, 'read');
  });
  test('failed is recorded without touching the delivered counter', () => {
    seed(); applyStatus({ id: 'm1', status: 'failed', errors: [{ code: 131049, title: 'Blocked' }] });
    assert.equal(S.failLog.length, 1);
    assert.equal(S.delivered, 0);
  });
  test('a status for a message this server never sent is ignored', () => {
    seed(); applyStatus({ id: 'nope', status: 'read' });
    assert.deepEqual([S.delivered, S.read], [0, 0]);
  });
  S.msgIndex = {}; S.delivered = 0; S.read = 0; S.failLog = [];
}


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

console.log('\ninbound messages');
{
  const msg = (id, body) => ({ id, from: '919000000003', type: 'text',
                               timestamp: String(Math.floor(Date.now() / 1000)), text: { body } });
  S.inbox = {};
  test('a text reply is recorded on its thread', () => {
    const e = recordInbound(msg('w1', 'yes please'), 'Asha');
    assert.equal(e.text, 'yes please');
    assert.equal(e.dir, 'in');
    assert.equal(S.inbox['919000000003'].unread, 1);
  });
  test('the profile name from Meta becomes the thread name', () => {
    assert.equal(S.inbox['919000000003'].name, 'Asha');
  });
  test('a redelivered wamid is ignored instead of duplicating the message', () => {
    assert.equal(recordInbound(msg('w1', 'yes please'), 'Asha'), null);
    assert.equal(S.inbox['919000000003'].messages.length, 1);
    assert.equal(S.inbox['919000000003'].unread, 1);
  });
  test('a second distinct message increments unread', () => {
    recordInbound(msg('w2', 'what is the price'), 'Asha');
    assert.equal(S.inbox['919000000003'].messages.length, 2);
    assert.equal(S.inbox['919000000003'].unread, 2);
  });
  test('the unread summary totals every thread', () => {
    assert.equal(inboxSummary().unread, 2);
    assert.equal(inboxSummary().threads.length, 1);
  });
  test('a button tap is described by its label, not left blank', () => {
    assert.equal(describeInbound({ type: 'button', button: { text: 'Stop promotions' } }), 'Stop promotions');
  });
  test('an unsupported type is labelled rather than dropped silently', () => {
    assert.equal(describeInbound({ type: 'image' }), '[image]');
  });
  S.inbox = {};
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
