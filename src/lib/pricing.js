'use strict';
const { PRICES } = require('../config');

// Meta bills per *delivered* template message, priced by category. An unknown
// category falls back to MARKETING because that is the most expensive of the
// three — an estimate that is too high is a much cheaper mistake than one that
// is too low.
function rateFor(category) {
  const r = PRICES[String(category || '').toUpperCase()];
  return Number.isFinite(r) && r >= 0 ? r : PRICES.MARKETING;
}

// Opted-out contacts are skipped before a send is attempted, so they never cost
// anything and must not appear in the estimate.
function billableCount(contacts, optOuts) {
  if (!Array.isArray(contacts)) return 0;
  if (!optOuts || typeof optOuts.has !== 'function') return contacts.length;
  return contacts.reduce((n, c) => n + (optOuts.has(c.dialStr) ? 0 : 1), 0);
}

// Rounded to paise. Floating-point money is fine here because this is a display
// estimate, never a ledger — Meta's invoice is the source of truth.
const round2 = n => Math.round(n * 100) / 100;

function estimateCost(billable, rate) {
  return round2(Math.max(0, billable || 0) * Math.max(0, rate || 0));
}

// The honest figure once sending starts: failed and skipped messages cost
// nothing, so only `delivered` is charged.
function spentCost(delivered, rate) {
  return estimateCost(delivered, rate);
}

// "₹770.64" — grouped the Indian way when the currency is the rupee, since that
// is who this app is for; anything else falls back to plain grouping.
function formatMoney(amount, currency = PRICES.currency) {
  const locale = currency === '₹' ? 'en-IN' : 'en-US';
  return currency + (Number(amount) || 0).toLocaleString(locale, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

module.exports = { rateFor, billableCount, estimateCost, spentCost, formatMoney };
