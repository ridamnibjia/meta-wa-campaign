'use strict';
// Run: node test.js
// ponytail: no framework, no fixtures. Pure functions only — nothing here
// touches the network or the campaign loop.

const assert = require('node:assert/strict');
const {
  slugify, templateVars, sanitizeParam, validateTemplateInput,
  buildTemplatePayload, normalizePhone, parseCSV, buildParams, verifySignature, explainError, tierToCap, META_ERRORS, S,
  warmupStep, warmupCap, effectiveCap, todayKey, WARMUP_PLAN, W,
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
test('returns nothing when the template has no variables', () => {
  S.config.paramCount = 0;
  assert.deepEqual(buildParams({ name: 'Rahul' }), []);
});
test('maps {{1}} to the contact name', () => {
  S.config.paramCount = 1;
  assert.deepEqual(buildParams({ name: 'Rahul' }), [{ type: 'text', text: 'Rahul' }]);
});
test('sanitizes a multi-line name', () => {
  S.config.paramCount = 1;
  assert.deepEqual(buildParams({ name: 'Ra\nhul' }), [{ type: 'text', text: 'Ra hul' }]);
});
test('falls back when the name is blank', () => {
  S.config.paramCount = 1;
  assert.deepEqual(buildParams({ name: '' }), [{ type: 'text', text: 'there' }]);
});

console.log('\nnormalizePhone');
test('prefixes a 10-digit Indian number', () => assert.equal(normalizePhone('9000000001'), '919000000001'));
test('strips a leading zero', () => assert.equal(normalizePhone('09000000001'), '919000000001'));
test('strips formatting characters', () => assert.equal(normalizePhone('+91 99801-73311'), '919000000001'));
test('rejects toll-free numbers', () => assert.equal(normalizePhone('18001234567'), null));
test('rejects numbers that are too short', () => assert.equal(normalizePhone('12345'), null));
test('rejects empty input', () => assert.equal(normalizePhone(''), null));

console.log('\nparseCSV');
test('reads name and mobile, and dedupes', () => {
  const csv = 'First Name,Mobile Phone\nRahul,9000000001\nPriya,9000000002\nDupe,+91 99801 73311\n';
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
