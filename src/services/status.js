'use strict';
const { CFG, LIMITS, OPT_OUT_LABEL, PRICES } = require('../config');
const { S, emit, todayKey } = require('../state');
const { W, WARMUP_PLAN, warmupStep, warmupCap, effectiveCap } = require('./warmup');
const { counts: contactCounts } = require('./contacts');
const { countsForRun, progressForRun, nextPending, billableForRun } = require('./messages');
const { rateFor, estimateCost, spentCost } = require('../lib/pricing');
const inbox = require('./inbox');

// The single snapshot every client renders from. The counters are a GROUP BY
// over the current run rather than four integers kept in step by hand — which
// is what removes the drift class of bug: there is no number here that can
// disagree with the messages it counts.
function buildState() {
  const rate     = rateFor(S.config.templateCategory);
  const known    = contactCounts();
  const c        = countsForRun(S.currentRunId);
  // The queue is the source of truth for every progress number now. `billable`
  // is asked against the CURRENT enabled flags rather than the snapshot taken
  // when the queue was staged, so disabling someone moves the estimate straight
  // away instead of only once the loop reaches them.
  const p        = progressForRun(S.currentRunId);
  const billable = billableForRun(S.currentRunId);
  const next     = nextPending(S.currentRunId);
  return {
    phase:          S.phase,
    currentIdx:     p.sent + p.skipped,
    total:          p.total,
    accepted:       c.accepted,
    delivered:      c.delivered,
    read:           c.read,
    // Two kinds of failure: the Graph API refusing the send (no wamid, so no
    // row — S.failed) and a delivery failure webhook (a row — c.failed).
    // The operator wants "did not arrive", which is both.
    failed:         S.failed + c.failed,
    skipped:        p.skipped,
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
    currentContact: next ? { name: next.name, dialStr: next.phone } : null,
    limits:         LIMITS,
    // OPT_OUT_LABEL stays: it builds the quick-reply button and matches the
    // inbound reply. The COUNT is now every disabled contact, whatever turned
    // them off — an opt-out, an operator, or an undeliverable number.
    contacts:       known,
    disabledCount:  known.disabled,
    optOutLabel:    OPT_OUT_LABEL,
  };
}

function broadcast() { emit('state', buildState()); }

module.exports = { buildState, broadcast };
