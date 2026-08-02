'use strict';
const { CFG, LIMITS, OPT_OUT_LABEL, PRICES } = require('../config');
const { S, emit, todayKey } = require('../state');
const { W, WARMUP_PLAN, warmupStep, warmupCap, effectiveCap } = require('./warmup');
const { optOuts } = require('./optouts');
const { rateFor, billableCount, estimateCost, spentCost } = require('../lib/pricing');
const inbox = require('./inbox');

// The single snapshot every client renders from. Assembled here rather than in
// state.js so that state.js stays a plain data module — this is the only place
// that needs to know about warm-up, opt-outs, pricing and the inbox at once.
function buildState() {
  const rate     = rateFor(S.config.templateCategory);
  const billable = billableCount(S.contacts, optOuts);
  return {
    phase:          S.phase,
    currentIdx:     S.currentIdx,
    total:          S.contacts.length,
    accepted:       S.accepted,
    delivered:      S.delivered,
    read:           S.read,
    failed:         S.failed,
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
      spent:     spentCost(S.delivered, rate),
      remaining: estimateCost(Math.max(0, billable - S.delivered), rate),
    },
    inboxUnread:    inbox.summary().unread,
    pauseReason:    S.pauseReason,
    config:         S.config,
    configured:     !!(CFG.phoneNumberId && CFG.accessToken),
    currentContact: S.contacts[S.currentIdx] || null,
    limits:         LIMITS,
    optOutCount:    optOuts.size,
    optOutLabel:    OPT_OUT_LABEL,
  };
}

function broadcast() { emit('state', buildState()); }

module.exports = { buildState, broadcast };
