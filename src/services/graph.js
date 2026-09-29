'use strict';
const { CFG, TIMEOUTS } = require('../config');
const { log }  = require('../state');

const graphHeaders = () => ({
  'Authorization': `Bearer ${CFG.accessToken}`,
  'Content-Type':  'application/json',
});

const graphUrl = endpoint => `https://graph.facebook.com/${CFG.apiVersion}/${endpoint}`;

// Every call through here carries the JSON timeout, read per call so it can be
// changed at runtime. Without a signal fetch waits on undici's own ~5-minute
// timers: a hung account-info read held /start open with no loop running, and a
// hung inbox send held the operator's request. An abort rejects like any other
// network failure, which every caller already catches.
async function graphGet(endpoint, fields) {
  const qs  = fields ? `?fields=${encodeURIComponent(fields)}` : '';
  const res = await fetch(graphUrl(endpoint) + qs,
    { headers: graphHeaders(), signal: AbortSignal.timeout(TIMEOUTS.graphMs) });
  return res.json();
}

async function graphSend(method, endpoint, body) {
  const res  = await fetch(graphUrl(endpoint), {
    method,
    headers: graphHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUTS.graphMs),
  });
  const data = await res.json();
  return { res, data };
}

// "TIER_1K" → 1000, "TIER_250" → 250. Meta's cap on unique users per day; the
// UI prefills Daily Cap with it so nobody has to look the number up.
function tierToCap(tier) {
  const m = /TIER_(\d+)(K?)/i.exec(tier || '');
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
}

// Fetch quality rating and messaging tier for the phone number
async function fetchAccountInfo() {
  if (!CFG.phoneNumberId || !CFG.accessToken) return { error: 'Credentials not configured' };
  const data = await graphGet(
    CFG.phoneNumberId,
    'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status'
  );
  if (data.error) return { error: data.error.message };
  const tier = data.messaging_limit_tier || 'UNKNOWN';
  return {
    displayPhone:  data.display_phone_number,
    verifiedName:  data.verified_name,
    qualityRating: data.quality_rating || 'UNKNOWN',
    tier,
    tierCap:       tierToCap(tier),
    status:        data.status      || 'UNKNOWN',
    nameStatus:    data.name_status || 'UNKNOWN',
    phoneNumberId: CFG.phoneNumberId,
    wabaId:        CFG.wabaId || null,
  };
}

// Resolve WABA ID from Business Portfolio if not set directly
async function resolveWabaId() {
  if (CFG.wabaId) return CFG.wabaId;
  if (!CFG.businessId) return null;
  const data = await graphGet(`${CFG.businessId}/owned_whatsapp_business_accounts`, 'id,name');
  if (data.error || !data.data?.length) return null;
  CFG.wabaId = data.data[0].id;
  log('info', `WABA ID resolved: ${CFG.wabaId}`);
  return CFG.wabaId;
}

module.exports = { graphHeaders, graphUrl, graphGet, graphSend, tierToCap, fetchAccountInfo, resolveWabaId };
