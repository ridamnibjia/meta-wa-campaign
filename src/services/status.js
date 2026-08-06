'use strict';
const { CFG, LIMITS, OPT_OUT_LABEL, PRICES } = require('../config');
const { S, emit, todayKey } = require('../state');
const { W, WARMUP_PLAN, warmupStep, warmupCap, effectiveCap } = require('./warmup');
const { optOuts } = require('./optouts');
const { countsForRun } = require('./messages');
const { rateFor, billableCount, estimateCost, spentCost } = require('../lib/pricing');
const inbox = require('./inbox');

// The single snapshot every client renders from. The counters are a GROUP BY
// over the current run rather than four integers kept in step by hand — which
// is what removes the drift class of bug: there is no number here that can
// disagree with the messages it counts.
function buildState() {
  const rate     = rateFor(S.config.templateCategory);
  const billable = billableCount(S.contacts, optOuts);
  const c        = countsForRun(S.currentRunId);
  return {
    phase:          S.phase,
    currentIdx:     S.currentIdx,
    total:          S.contacts.length,
    accepted:       c.accepted,
    delivered:      c.delivered,
    read:           c.read,
    // Two kinds of failure: the Graph API refusing the send (no wamid, so no
    // row — S.failed) and a delivery failure webhook (a row — c.failed).
    // The operator wants "did not arrive", which is both.
    failed:         S.failed + c.failed,
    skipped:        S.skipped,
    dailyCount:     S.dailyCount,
    dailyCap:       effectiveCap(),
    quality:        S.quality,
    warmup: {
      enabled: W.enabled,
      plan:    WARMUP_PLAN,
      step:    warmupStep(),
      cap:     warmupCap(),
      daysSent: W.days.length,
      sentToday: W.days.includes(todayKey()),
    },
    // Estimate is what the whole list would cost; spent counts only delivered
    // messages, because that is what Meta actually charges for.
    pricing: {
      currency:  PRICES.currency,
      rate,
      rates:     { MARKETING: PRICES.MARKETING, UTILITY: PRICES.UTILITY, AUTHENTICATION: PRICES.AUTHENTICATION },
      category:  S.config.templateCategory,
      billable,
      estimate:  estimateCost(billable, rate),
      spent:     spentCost(c.delivered, rate),
      remaining: estimateCost(Math.max(0, billable - c.delivered), rate),
    },
    inboxUnread:    inbox.summary().unread,
    pauseReason:    S.pauseReason,
    config:         S.config,
    configured:     !!(CFG.phoneNumberId && CFG.accessToken),
    // Media headers need Meta's Resumable Upload API, which keys on the app id.
    // Surfacing it here is what lets the composer grey the option out rather
    // than accepting an upload and failing at submit time.
    mediaHeadersAvailable: !!CFG.appId,
    currentContact: S.contacts[S.currentIdx] || null,
    limits:         LIMITS,
    optOutCount:    optOuts.size,
    optOutLabel:    OPT_OUT_LABEL,
  };
}

function broadcast() { emit('state', buildState()); }

module.exports = { buildState, broadcast };
