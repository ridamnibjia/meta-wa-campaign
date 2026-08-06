'use strict';
const express = require('express');
const { CFG } = require('../config');
const { S, log } = require('../state');
const { broadcast } = require('../services/status');
const { explainError } = require('../lib/errors');
const { graphSend, resolveWabaId } = require('../services/graph');
const {
  fetchTemplates, validateTemplate, adoptTemplate, deleteTemplate,
  validateTemplateInput, buildTemplatePayload, templateVars, resizeParamValues,
  saveTemplateRow,
} = require('../services/templates');
const { ensureHandle } = require('../services/media');

const router = express.Router();

// Every template on the WABA, newest-usable first. Lets the UI show a picker
// instead of asking the operator to remember exact template names.
router.get('/templates', async (req, res) => {
  try {
    const r = await fetchTemplates();
    if (r.error) return res.json({ error: r.error, templates: [] });
    const rank = { APPROVED: 0, PENDING: 1, IN_APPEAL: 1 };
    res.json({ templates: r.templates.sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2)) });
  } catch (e) { res.json({ error: e.message, templates: [] }); }
});

router.get('/validate-template', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.json({ error: 'Template name is required' });
  try {
    const r = await validateTemplate(name);
    adoptTemplate(name, r);
    res.json(r);
  } catch (e) { res.json({ error: e.message }); }
});

// ── Compose: submit a new template to Meta for approval ────────────────────────
router.post('/template/create', async (req, res) => {
  const input = {
    displayName:   req.body.displayName,
    bodyText:      req.body.bodyText,
    footerText:    req.body.footerText,
    sampleValues:  req.body.sampleValues || [],
    addOptOut:     req.body.addOptOut !== false,   // default on
    category:      req.body.category || 'MARKETING',
    language:      req.body.language || 'en',
    headerFormat:  req.body.headerFormat  || null,
    headerText:    req.body.headerText    || null,
    headerSample:  req.body.headerSample  || null,
    headerAssetId: req.body.headerAssetId || null,
    buttons:       req.body.buttons       || [],
  };

  const errors = validateTemplateInput(input);
  if (errors.length) return res.json({ ok: false, errors });

  if (!CFG.accessToken) return res.json({ ok: false, errors: ['Access Token not configured'] });
  const wabaId = await resolveWabaId();
  if (!wabaId) return res.json({ ok: false, errors: ['WABA ID unavailable. Set WABA_ID or verify BUSINESS_ID.'] });

  // Resolve the upload handle BEFORE submitting. A failure here is a failure to
  // upload, and saying so is far more useful than Meta's generic rejection for
  // a header component it could not fetch an example for.
  let headerHandle = null;
  if (input.headerFormat && input.headerFormat !== 'TEXT') {
    const h = await ensureHandle(input.headerAssetId);
    if (!h.ok) return res.json({ ok: false, errors: [`Could not upload the header file: ${h.error}`] });
    headerHandle = h.handle;
  }

  const payload = buildTemplatePayload({ ...input, headerHandle });
  try {
    const { data } = await graphSend('POST', `${wabaId}/message_templates`, payload);
    if (data.error) {
      const code = data.error.code || 0;
      const hint = explainError(code) || explainError(data.error.error_subcode);
      log('error', `Template "${payload.name}" rejected on submit [${code}] ${data.error.message}`);
      if (hint) log('error', `   ↳ ${hint}`);
      const errs = [data.error.error_user_msg || data.error.message];
      if (hint) errs.push(hint);
      return res.json({ ok: false, errors: errs });
    }

    S.config.templateName     = payload.name;
    S.config.templateLanguage = payload.language;
    S.config.templateCategory = payload.category;
    S.config.templateStatus   = data.status || 'PENDING';
    S.config.templateBody     = input.bodyText;
    S.config.headerFormat     = input.headerFormat;
    S.config.headerAssetId    = input.headerAssetId;
    // By type, not by index: components[0] is the HEADER whenever there is one.
    const bodyComponent = payload.components.find(c => c.type === 'BODY');
    resizeParamValues(templateVars(bodyComponent.text).length);
    saveTemplateRow({
      name:          payload.name,
      displayName:   input.displayName,
      language:      payload.language,
      category:      payload.category,
      headerFormat:  input.headerFormat,
      headerText:    input.headerText,
      headerAssetId: input.headerAssetId,
      bodyText:      input.bodyText,
      footerText:    input.footerText,
      buttons:       input.buttons,
      varCount:      templateVars(bodyComponent.text).length,
      status:        S.config.templateStatus,
    });
    CFG.templateName          = payload.name;
    broadcast();

    log('info', `Template "${payload.name}" submitted — status ${S.config.templateStatus}`);
    res.json({ ok: true, name: payload.name, id: data.id, status: S.config.templateStatus, payload });
  } catch (e) {
    res.json({ ok: false, errors: [e.message] });
  }
});

// Polled by the UI every 15s while a template is PENDING.
router.get('/template/status', async (req, res) => {
  const name = req.query.name || S.config.templateName;
  if (!name) return res.json({ error: 'Template name is required' });
  try {
    const r = await validateTemplate(name);
    adoptTemplate(name, r);
    const t = r?.templates?.[0];
    res.json({
      name,
      found:          !!t,
      status:         t?.status || (r.error ? null : 'NOT_FOUND'),
      category:       t?.category || null,
      language:       t?.language || null,
      bodyText:       t?.bodyText || null,
      rejectedReason: t?.rejectedReason || null,
      qualityScore:   t?.qualityScore || null,
      paramCount:     S.config.paramCount,
      error:          r.error || null,
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Deletion is permanent on Meta's side and takes every language variant with it.
// Refused mid-campaign: deleting the template a running loop is sending would
// turn every remaining contact into a failure.
router.delete('/template/:name', async (req, res) => {
  const name = req.params.name;
  if (S.phase === 'running' && S.config.templateName === name) {
    return res.status(409).json({
      ok: false,
      error: 'This template is being sent right now. Stop the campaign before deleting it.',
    });
  }
  const r = await deleteTemplate(name);
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = router;
