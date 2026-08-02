'use strict';
const { CFG, LIMITS, OPT_OUT_LABEL } = require('../config');
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

// Server-side pre-flight. Catches the documented rejection causes before we
// spend a Graph call and a review cycle on them.
function validateTemplateInput({ displayName, bodyText, footerText, sampleValues = [], category }) {
  const errors = [];
  const body   = String(bodyText || '').trim();

  if (!String(displayName || '').trim()) errors.push('Template name is required');
  if (!body) errors.push('Message body is required');
  if (body.length > LIMITS.templateBody) errors.push(`Body is ${body.length} chars — max ${LIMITS.templateBody}`);

  const vars = templateVars(body);
  vars.forEach((n, i) => {
    if (n !== i + 1) errors.push(`Variables must run {{1}}, {{2}}… with no gaps — found {{${n}}} at position ${i + 1}`);
  });
  if (vars.length && sampleValues.filter(v => String(v || '').trim()).length !== vars.length) {
    errors.push(`Provide a sample value for each of the ${vars.length} variable(s) — Meta requires them`);
  }
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(body)) errors.push('Body cannot start with a variable');
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(body)) errors.push('Body cannot end with a variable');

  const footer = String(footerText || '').trim();
  if (footer.length > LIMITS.templateFooter) errors.push(`Footer is ${footer.length} chars — max ${LIMITS.templateFooter}`);
  if (templateVars(footer).length) errors.push('Footer cannot contain variables');

  if (category && !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
    errors.push(`Unknown category "${category}"`);
  }
  return errors;
}

function buildTemplatePayload({ displayName, bodyText, footerText, sampleValues = [], addOptOut, category, language }) {
  const body   = String(bodyText || '').trim();
  const footer = String(footerText || '').trim();
  const vars   = templateVars(body);

  const bodyComponent = { type: 'BODY', text: body };
  // The example block is mandatory when the body has variables (error 2388023).
  if (vars.length) {
    bodyComponent.example = { body_text: [vars.map((_, i) => sanitizeParam(sampleValues[i]))] };
  }

  const components = [bodyComponent];
  if (footer) components.push({ type: 'FOOTER', text: footer });
  if (addOptOut) {
    components.push({
      type: 'BUTTONS',
      buttons: [{ type: 'QUICK_REPLY', text: OPT_OUT_LABEL.slice(0, LIMITS.templateButton) }],
    });
  }

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
  S.config.templateName     = name;
  S.config.templateStatus   = t.status;
  S.config.templateCategory = t.category;
  S.config.templateLanguage = t.language;
  resizeParamValues(templateVars(t.bodyText).length);
  CFG.templateName          = name;
  broadcast();
}

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
  slugify, templateVars, sanitizeParam, validateTemplateInput, buildTemplatePayload,
  shapeTemplate, fetchTemplates, validateTemplate, resizeParamValues, adoptTemplate,
  deleteTemplate, graphSend,
};
