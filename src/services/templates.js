'use strict';
const { CFG, LIMITS, OPT_OUT_LABEL } = require('../config');
const { db } = require('../lib/db');
const { S, log } = require('../state');
const { graphHeaders, graphUrl, graphSend, resolveWabaId } = require('./graph');
const { explainError } = require('../lib/errors');
const { broadcast } = require('./status');

// ── Template composition ───────────────────────────────────────────────────────
// Meta template names: lowercase, [a-z0-9_] only. Anything else is rejected.
function slugify(s) {
  const out = String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, LIMITS.templateName);
  return out || 'template';
}

// Returns the sorted, de-duplicated variable numbers found in a body: "Hi {{1}}" → [1]
function templateVars(text) {
  const nums = [...String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b);
}

// Meta rejects parameter values containing newlines, tabs, or 4+ consecutive
// spaces. Collapse all whitespace runs to a single space.
function sanitizeParam(v) {
  const out = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.paramValue);
  return out || 'there';
}

// Substitutes {{1}}, {{2}}… from the same parameter array the send uses, so the
// text stored in the thread cannot drift from the text the recipient saw. An
// unsupplied slot stays as its literal {{n}} rather than becoming "undefined" —
// a placeholder is honest about not knowing; fabricated text is not.
//
// Returns null when there is no body at all, which is the signal the callers
// use to fall back to the [template: name] placeholder.
function renderBody(bodyText, params = []) {
  if (!bodyText) return null;
  return String(bodyText).replace(/\{\{\s*(\d+)\s*\}\}/g,
    (whole, n) => params[Number(n) - 1]?.text ?? whole);
}

// Meta's ceilings, per button type and overall. The opt-out quick reply counts
// toward the quick-reply allowance like any other.
const BUTTON_LIMITS  = { QUICK_REPLY: 3, URL: 2, PHONE_NUMBER: 1 };
const MAX_BUTTONS    = 10;
const HEADER_FORMATS = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'];
const BUTTON_LABEL   = { QUICK_REPLY: 'quick-reply', URL: 'URL', PHONE_NUMBER: 'call' };

// Server-side pre-flight. Catches the documented rejection causes before we
// spend a Graph call and a review cycle on them.
function validateTemplateInput({ displayName, bodyText, footerText, sampleValues = [], category,
                                 headerFormat, headerText, headerSample, headerAssetId,
                                 buttons = [], addOptOut = true }) {
  const errors = [];
  const body   = String(bodyText || '').trim();

  if (!String(displayName || '').trim()) errors.push('Template name is required');
  if (!body) errors.push('Message body is required');
  if (body.length > LIMITS.templateBody) errors.push(`Body is ${body.length} chars — max ${LIMITS.templateBody}`);

  const vars = templateVars(body);
  vars.forEach((n, i) => {
    if (n !== i + 1) errors.push(`Variables must run {{1}}, {{2}}… with no gaps — found {{${n}}} at position ${i + 1}`);
  });
  // Positional, because buildTemplatePayload reads sampleValues by index: a
  // count of non-empty values ANYWHERE let ['', 'Asha'] pass for one variable,
  // and Meta then reviewed the 'there' fallback instead of the operator's word.
  vars.forEach((n, i) => {
    if (!String(sampleValues[i] || '').trim()) {
      errors.push(`Provide a sample value for {{${n}}} — Meta requires one to review the template`);
    }
  });
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(body)) errors.push('Body cannot start with a variable');
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(body)) errors.push('Body cannot end with a variable');

  const footer = String(footerText || '').trim();
  if (footer.length > LIMITS.templateFooter) errors.push(`Footer is ${footer.length} chars — max ${LIMITS.templateFooter}`);
  if (templateVars(footer).length) errors.push('Footer cannot contain variables');

  if (category && !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
    errors.push(`Unknown category "${category}"`);
  }

  // ── Header ───────────────────────────────────────────────────────────────
  if (headerFormat) {
    if (!HEADER_FORMATS.includes(headerFormat)) {
      errors.push(`Unknown header format "${headerFormat}" — use TEXT, IMAGE, VIDEO or DOCUMENT`);
    } else if (headerFormat === 'TEXT') {
      const h = String(headerText || '').trim();
      if (!h) errors.push('Header text is required for a TEXT header');
      if (h.length > LIMITS.templateHeader) errors.push(`Header is ${h.length} chars — max ${LIMITS.templateHeader}`);
      const hv = templateVars(h);
      if (hv.length > 1) errors.push('A header can hold at most one variable, and it must be {{1}}');
      if (hv.length === 1 && hv[0] !== 1) errors.push('A header variable must be {{1}}');
      if (hv.length && !String(headerSample || '').trim()) {
        errors.push('Provide a sample value for the header variable — Meta requires one to review it');
      }
    } else if (!headerAssetId) {
      errors.push(`A ${headerFormat.toLowerCase()} header needs a file — choose a file or upload one`);
    }
  }

  // ── Buttons ──────────────────────────────────────────────────────────────
  // Meta returns a generic rejection for a bad mix, sometimes hours later. The
  // rules are documented and cheap to check here, where the operator can still
  // do something about it.
  const all = (addOptOut ? [{ type: 'QUICK_REPLY', text: OPT_OUT_LABEL }] : []).concat(buttons || []);
  if (all.length > MAX_BUTTONS) errors.push(`A template can have at most ${MAX_BUTTONS} buttons — this has ${all.length}`);
  const counts = {};
  for (const b of all) {
    const type = b?.type;
    if (!BUTTON_LIMITS[type]) { errors.push(`Unknown button type "${type || ''}"`); continue; }
    counts[type] = (counts[type] || 0) + 1;
    if (!String(b.text || '').trim()) errors.push(`Every button needs a label — one ${BUTTON_LABEL[type]} button has none`);
    if (String(b.text || '').length > LIMITS.templateButton) {
      errors.push(`Button label "${b.text}" is over ${LIMITS.templateButton} chars`);
    }
    if (type === 'URL') {
      const u = String(b.url || '').trim();
      if (!u) errors.push(`Button "${b.text || ''}" needs a URL`);
      else if (!/^https?:\/\//i.test(u)) errors.push(`Button URL "${u}" must start with http:// or https://`);
    }
    if (type === 'PHONE_NUMBER' && !String(b.phone_number || '').trim()) {
      errors.push(`Button "${b.text || ''}" needs a phone number`);
    }
  }
  for (const [type, n] of Object.entries(counts)) {
    if (n > BUTTON_LIMITS[type]) {
      errors.push(`Meta allows at most ${BUTTON_LIMITS[type]} ${BUTTON_LABEL[type]} button${BUTTON_LIMITS[type] > 1 ? 's' : ''} — this has ${n}`);
    }
  }

  return errors;
}

// Pure and synchronous on purpose: the h:… handle is resolved by the route
// (ensureHandle does I/O) and arrives here as a string, so this stays a
// function every test can call directly with no network and no database.
function buildTemplatePayload({ displayName, bodyText, footerText, sampleValues = [], addOptOut,
                                category, language,
                                headerFormat, headerText, headerSample, headerHandle,
                                buttons = [] }) {
  const body   = String(bodyText || '').trim();
  const footer = String(footerText || '').trim();
  const vars   = templateVars(body);

  const bodyComponent = { type: 'BODY', text: body };
  // The example block is mandatory when the body has variables (error 2388023).
  if (vars.length) {
    bodyComponent.example = { body_text: [vars.map((_, i) => sanitizeParam(sampleValues[i]))] };
  }

  const components = [];

  // Meta requires HEADER first. A TEXT header carries text (and an example when
  // it has a variable); a media header carries no text at all — only the
  // single-use upload handle Meta reviews the template against.
  if (headerFormat === 'TEXT' && String(headerText || '').trim()) {
    const h = { type: 'HEADER', format: 'TEXT', text: String(headerText).trim() };
    if (templateVars(h.text).length) h.example = { header_text: [sanitizeParam(headerSample)] };
    components.push(h);
  } else if (headerFormat && headerFormat !== 'TEXT' && headerHandle) {
    components.push({ type: 'HEADER', format: headerFormat, example: { header_handle: [headerHandle] } });
  }

  components.push(bodyComponent);
  if (footer) components.push({ type: 'FOOTER', text: footer });

  // The opt-out goes first so it is the button a recipient reaches for. Meta
  // renders them in the order they are submitted.
  const allButtons = (addOptOut ? [{ type: 'QUICK_REPLY', text: OPT_OUT_LABEL.slice(0, LIMITS.templateButton) }] : [])
    .concat((buttons || []).map(b => {
      const out = { type: b.type, text: String(b.text || '').slice(0, LIMITS.templateButton) };
      if (b.type === 'URL')          out.url          = String(b.url || '').trim();
      if (b.type === 'PHONE_NUMBER') out.phone_number = String(b.phone_number || '').trim();
      return out;
    }));
  if (allButtons.length) components.push({ type: 'BUTTONS', buttons: allButtons });

  return {
    name:     slugify(displayName),
    language: language || 'en',
    category: category || 'MARKETING',
    components,
  };
}

// Graph's template shape → the flat one both the validator and the picker use.
function shapeTemplate(t) {
  const part = (type, extra = () => true) => (t.components || []).find(c => c.type === type && extra(c));
  return {
    name:           t.name,
    status:         t.status,
    category:       t.category,
    language:       t.language,
    qualityScore:   t.quality_score?.score || null,
    // Graph returns the string "NONE" — not null — when a template was never
    // rejected, so passing it through lit up a red "Rejected: NONE" banner on
    // perfectly healthy APPROVED templates.
    rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    bodyText:       part('BODY')?.text || null,
    headerText:     part('HEADER', c => c.format === 'TEXT')?.text || null,
    headerFormat:   part('HEADER')?.format || null,
    buttons:        part('BUTTONS')?.buttons || [],
  };
}

// One Graph call for message_templates. `name` filters to a single template;
// omitting it lists the whole WABA, which is what the UI's picker needs.
async function fetchTemplates(name) {
  if (!CFG.accessToken) return { error: 'Access Token not set' };
  const wabaId = await resolveWabaId();
  if (!wabaId) {
    return { error: 'WABA_ID is not set. Copy it from Meta for Developers → your app → WhatsApp → API Setup ("WhatsApp Business Account ID"), put it in .env, and restart.' };
  }
  const url = `https://graph.facebook.com/${CFG.apiVersion}/${wabaId}/message_templates`
    + `?limit=200&fields=name,status,category,language,quality_score,rejected_reason,components`
    + (name ? `&name=${encodeURIComponent(name)}` : '');
  const data = await (await fetch(url, { headers: graphHeaders() })).json();
  if (data.error) return { error: data.error.message };
  return { found: !!data.data?.length, templates: (data.data || []).map(shapeTemplate) };
}

// Validate template — fetches status, category, language, body text from Meta
async function validateTemplate(templateName) {
  // An empty name would make fetchTemplates omit the &name= filter, list the
  // whole WABA, and adoptTemplate would then adopt the FIRST template's status
  // and body under a name nobody chose — enough to launch a run whose every
  // send posts template.name '' and fails with 132001.
  if (!String(templateName || '').trim()) return { found: false, name: templateName };
  const r = await fetchTemplates(templateName);
  if (r.error) return r;
  if (!r.found) return { found: false, name: templateName };
  return r;
}

// Called whenever the active template changes. Keeps any values already typed
// for slots that still exist, so re-picking a template does not wipe your input.
function resizeParamValues(count) {
  const prev = S.config.paramValues || [];
  S.config.paramCount  = count;
  S.config.paramValues = Array.from({ length: count }, (_, i) =>
    prev[i] || { source: i === 0 ? 'name' : 'fixed', value: '' });
}

// When a template lookup succeeds, make it the active one: remember its status
// (gates Start) and how many variables its body needs (drives buildParams).
function adoptTemplate(name, result) {
  const t = result?.templates?.[0];
  if (!t) {
    if (result && result.found === false) S.config.templateStatus = 'NOT_FOUND';
    return;
  }
  // Read BEFORE templateName is overwritten: re-adopting the template that is
  // already active must not clobber the attachment the operator picked this
  // session. This function runs on every validate-template call and on the
  // 15-second status poll, and each of those used to reset headerAssetId to
  // the row's approval-time asset — null for a template created outside this
  // app — so the file chosen in the Attachment picker vanished within seconds
  // and the screen went back to "choose the file to send".
  const samePick = S.config.templateName === name;
  S.config.templateName     = name;
  // adoptTemplate is the single funnel through which Meta's shaped template
  // reaches S.config, which is what lets startRun keep its one-argument
  // signature: the body arrives here or not at all.
  S.config.templateBody     = t.bodyText || null;
  // Meta knows the template has a document header; only our own row knows WHICH
  // document, because Graph never saw our disk. Fall back to Meta's shape so an
  // externally created template is still recognisably a media template.
  const row = getTemplateRow(name);
  S.config.headerFormat     = row?.header_format ?? t.headerFormat ?? null;
  // The row is a fallback, never an override: switching templates (or a cleared
  // selection — /api/config sets null on purpose) restores the approval-time
  // asset, but the operator's live choice for the active template wins.
  S.config.headerAssetId    = samePick && S.config.headerAssetId != null
    ? S.config.headerAssetId
    : row?.header_asset ?? null;
  S.config.templateStatus   = t.status;
  S.config.templateCategory = t.category;
  S.config.templateLanguage = t.language;
  resizeParamValues(templateVars(t.bodyText).length);
  CFG.templateName          = name;
  broadcast();
}

// ── Local template memory ──────────────────────────────────────────────────────
// Meta stays the source of truth for the status column — the approval poller
// keeps reading it from Graph. This row records what WE submitted, which
// GET /message_templates does not return in usable form: no display name, and
// no link back to the file on our disk. Without it, a template approved with an
// attachment cannot find its own attachment.
const upsertTemplate = db.prepare(`
  INSERT INTO templates (name, display_name, language, category, header_format, header_text,
                         header_asset, body_text, footer_text, buttons_json, var_count, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET
    display_name  = excluded.display_name,
    language      = excluded.language,
    category      = excluded.category,
    header_format = excluded.header_format,
    header_text   = excluded.header_text,
    header_asset  = excluded.header_asset,
    body_text     = excluded.body_text,
    footer_text   = excluded.footer_text,
    buttons_json  = excluded.buttons_json,
    var_count     = excluded.var_count,
    status        = excluded.status
`);
const selectTemplate = db.prepare('SELECT * FROM templates WHERE name = ?');

function saveTemplateRow({ name, displayName, language, category, headerFormat, headerText,
                           headerAssetId, bodyText, footerText, buttons = [], varCount = 0, status }) {
  upsertTemplate.run(
    name, displayName ?? null, language || 'en', category || 'MARKETING',
    headerFormat ?? null, headerText ?? null, headerAssetId ?? null,
    bodyText || '', footerText ?? null,
    buttons.length ? JSON.stringify(buttons) : null,
    varCount, status ?? null, Date.now(),
  );
}

const getTemplateRow = name => selectTemplate.get(name);

// ── Delete ─────────────────────────────────────────────────────────────────────
// Meta's DELETE takes a template *name* and removes every language variant of
// it. There is no undo and no way to reuse the name for 30 days, so the caller
// is expected to have confirmed with the operator first.
async function deleteTemplate(name) {
  if (!name) return { ok: false, error: 'Template name is required' };
  if (!CFG.accessToken) return { ok: false, error: 'Access Token not configured' };
  const wabaId = await resolveWabaId();
  if (!wabaId) return { ok: false, error: 'WABA ID unavailable. Set WABA_ID or verify BUSINESS_ID.' };

  const url = `${wabaId}/message_templates?name=${encodeURIComponent(name)}`;
  try {
    const res  = await fetch(graphUrl(url), { method: 'DELETE', headers: graphHeaders() });
    const data = await res.json();
    if (data.error) {
      const code = data.error.code || 0;
      const hint = explainError(code) || explainError(data.error.error_subcode);
      log('error', `Could not delete template "${name}" [${code}] ${data.error.message}`);
      return { ok: false, error: data.error.error_user_msg || data.error.message, hint };
    }
    log('warn', `Template "${name}" deleted from Meta — every language variant is gone`);
    // The deleted template cannot be the active one any more; clearing the
    // status is what stops /api/start from launching against a ghost.
    if (S.config.templateName === name) S.config.templateStatus = 'NOT_FOUND';
    broadcast();
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  slugify, templateVars, sanitizeParam, renderBody, validateTemplateInput, buildTemplatePayload,
  shapeTemplate, fetchTemplates, validateTemplate, resizeParamValues, adoptTemplate,
  deleteTemplate, graphSend,
  BUTTON_LIMITS, MAX_BUTTONS, saveTemplateRow, getTemplateRow,
};
