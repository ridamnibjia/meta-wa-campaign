'use strict';
const { CFG, LIMITS, OPT_OUT_LABEL, PRICES } = require('../config');
const { S, emit, todayKey } = require('../state');
const { W, WARMUP_PLAN, warmupStep, warmupCap, effectiveCap, graduated, dailyCount } = require('./warmup');
const { counts: contactCounts } = require('./contacts');
const { countsForRun, progressForRun, funnelForRun, nextPending, billableForRun,
        nextRetryForRun, lastRunSummary } = require('./messages');
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
  // Asked once and used twice: the tiles and the breakdown card must not be two
  // different reads of a table that a webhook can change between them.
  const f        = funnelForRun(S.currentRunId);
  const billable = billableForRun(S.currentRunId);
  const next     = nextPending(S.currentRunId);
  return {
    phase:          S.phase,
    currentIdx:     p.sent + p.skipped,
    total:          p.total,
    // The MESSAGE-TABLE view of this run: every outbound row stamped with it,
    // which includes test sends (/api/test-send stamps the current run but
    // stages no recipient). Kept because "what has this number actually sent"
    // is a real question and countsForRun is the only thing that answers it —
    // but no screen renders these. The tiles and the breakdown card both read
    // `funnel` below, so they cannot disagree with each other the way a tile
    // sourced here disagreed with the card under it.
    accepted:       c.accepted,
    delivered:      c.delivered,
    read:           c.read,
    // One source, not two added together. This was `S.failed + c.failed`: an
    // in-memory counter the loop incremented, plus a count over the message
    // rows. The same contact could be inside both — an API refusal is written to
    // the queue AND bumped the counter — so the tile over-reported, and a
    // restart zeroed the counter while the rows still remembered. `f.failed` is
    // the queue's own answer: contacts attempted, given up on, and not
    // undeliverable-by-number. Those are `f.unreachable`, beside it.
    failed:         f.failed,
    unreachable:    f.unreachable,
    skipped:        p.skipped,
    // Contacts a moment-based failure put back on the queue. They are neither
    // sent nor skipped, and a run is not finished while any remain — which is
    // why this is its own number rather than folded into either.
    retrying:       p.retrying,
    // Every contact in the run, in exactly one bucket, summing to `total` — the
    // one number set on this screen that is safe to add up. The counters above
    // come from two different tables and famously are not (see CLAUDE.md), which
    // is why "how many were delivered, failed, retried, never attempted" gets
    // its own derived object rather than being assembled in the browser.
    funnel:         f,
    nextRetry:      nextRetryForRun(S.currentRunId),
    // What the last send actually did, read from campaign_runs rather than from
    // the current run — so it still answers the question after a Reset, which
    // is exactly when it gets asked.
    lastRun:        lastRunSummary(),
    dailyCount:     dailyCount(),
    // null means no ceiling at all — the ladder is finished (or off) and no cap
    // of the operator's own is set. The UI must render that as "no cap", never
    // as 0: `num(null)` is "0", which reads as a number that blocks every send.
    dailyCap:       effectiveCap(),
    quality:        S.quality,
    warmup: {
      enabled: W.enabled,
      plan:    WARMUP_PLAN,
      step:    warmupStep(),
      cap:     warmupCap(),
      daysSent: W.days.length,
      sentToday: W.days.includes(todayKey()),
      // The ladder has been walked and quality held: this number is out of
      // warm-up and Meta's messaging tier is the real limit.
      graduated: graduated(),
    },
    // Estimate is what the whole list would cost; spent counts only delivered
    // messages, because that is what Meta actually charges for.
    //
    // `f.delivered`, not `c.delivered`: both count delivered contacts, but the
    // funnel counts them on the QUEUE and countsForRun counts them in the
    // messages table — which also holds test sends, stamped with the current run
    // by /api/test-send but never staged as recipients. Billing five test sends
    // against the campaign's spend overstated it against an estimate derived
    // from the queue, so the two halves of this object disagreed about which
    // people they were describing.
    pricing: {
      currency:  PRICES.currency,
      rate,
      rates:     { MARKETING: PRICES.MARKETING, UTILITY: PRICES.UTILITY, AUTHENTICATION: PRICES.AUTHENTICATION },
      category:  S.config.templateCategory,
      billable,
      estimate:  estimateCost(billable, rate),
      spent:     spentCost(f.delivered, rate),
      remaining: estimateCost(Math.max(0, billable - f.delivered), rate),
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
