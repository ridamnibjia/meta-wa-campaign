'use strict';
const { FILES } = require('../config');
const { readJSON, writeJSON } = require('../lib/store');
const { S, log, todayKey } = require('../state');
const { startOfIstDay } = require('../lib/schedule');
const { sentSince, sendingDays } = require('./messages');

// A number that has never sent bulk traffic gets throttled — or its quality
// rating tanked — if it blasts its full tier on day one. The ladder below is the
// volume Meta's own guidance tolerates: one rung per *sending* day, and only
// while quality holds. Persisted because the whole point is spanning days.
const WARMUP_PLAN = [20, 50, 100, 250, 500, 1000];
const W = Object.assign(
  { enabled: true, days: [] },              // ISO dates on which at least one message was accepted
  readJSON(FILES.warmup, {})
);

const saveWarmup = () => writeJSON(FILES.warmup, W);

// Which rung today sits on, UNCLAMPED. A day already sent on keeps its rung; a
// fresh day climbs one — unless quality has slipped, in which case it holds
// where it was.
//
// Unclamped because the value past the last rung is the only thing that can tell
// "the top rung, today" from "the ladder is behind us" — graduated() below reads
// it, and clamping first is what made those two indistinguishable.
function rawStep() {
  const i = W.days.indexOf(todayKey());
  let step = i >= 0 ? i : W.days.length;
  if (step > 0 && ['RED', 'YELLOW'].includes(S.quality)) step -= 1;
  return step;
}

const warmupStep = () => Math.min(rawStep(), WARMUP_PLAN.length - 1);

// ── The end of the ladder ──────────────────────────────────────────────────────
// The plan is a warm-UP, not a permanent ceiling. Its job is to prove a new
// number can send steadily without collecting blocks and reports; once every
// rung has had a sending day and quality is still holding, that is proved, and
// the real limit is Meta's own messaging tier — which this app does not get to
// second-guess. Leaving a homemade 1000 on top of it stops campaigns the account
// is entitled to send, and the operator has no way to tell which of the two
// numbers refused them.
//
// Quality is still the gate, and it is checked live rather than stamped once: a
// slip to RED or YELLOW puts the ladder back, because a falling quality rating
// is exactly when volume should come down. That is also why nothing is written
// to warmup.json here — graduation is a fact about today, not a flag to set.
//
// New accounts and every open-source install still walk the full ladder from
// rung one. Nothing about it is per-account, and there is no number in this file
// that belongs to any particular business.
// Asked of the RUNG, not of the day count, and that is the whole correction.
// It used to be `W.days.length >= WARMUP_PLAN.length`, and markWarmupDay()
// pushes today onto W.days after the FIRST send of the day — so on the top
// rung's own day the length reached WARMUP_PLAN.length one message in, and the
// ceiling lifted for the rest of that day. The 1000 rung was applied to exactly
// one message and the real ladder was 20 → 50 → 100 → 250 → 500 → uncapped.
//
// rawStep() answers "which rung is today" and is unchanged by whether today's
// first message has gone out yet, because a day already sent on keeps its own
// index. So the top rung holds for its whole day, and only the day AFTER it is
// off the ladder.
function graduated() {
  return rawStep() >= WARMUP_PLAN.length && !['RED', 'YELLOW'].includes(S.quality);
}

// null means "no warm-up ceiling" — switched off, or the ladder is finished.
function warmupCap() {
  if (!W.enabled || graduated()) return null;
  return WARMUP_PLAN[warmupStep()];
}

// The cap actually enforced: the warm-up rung, or your own number, whichever is
// lower — and null when neither applies, which the loop reads as no cap at all.
// A dailyCap of 0 is the operator saying "no limit of mine"; how much this
// number may send is then Meta's business alone.
function effectiveCap() {
  const own = S.config.dailyCap > 0 ? S.config.dailyCap : null;
  const w   = warmupCap();
  if (w === null)   return own;
  if (own === null) return w;
  return Math.min(own, w);
}

// How many people this number has messaged today — the figure the cap is
// compared against. Derived from the message rows, so a send Meta accepted and
// later refused stops counting the moment the failure webhook lands. See
// sentSince in services/messages.js for why that is not an incremented integer.
const dailyCount = () => sentSince(startOfIstDay());

// ── Reconciling the ladder with what this number actually did ──────────────────
// warmup.json is a small file that records which days had a send. The message
// rows record the same fact and are the thing a self-hoster actually backs up,
// so a warmup.json that is missing, truncated, or left behind by a move puts a
// number that has been sending for months back on rung one at twenty a day —
// with nothing on screen explaining why every campaign suddenly stops at 20.
//
// Merging rather than replacing: the file can legitimately know about a day the
// messages table does not (rows aged out, a migration), and either source
// finding a day is evidence the day happened. Idempotent, so running it at every
// boot costs one query and writes nothing once the two agree.
//
// Called from server.js's require.main block, like the other reconciliations —
// never at require time, so `npm test` does not write to the repo's warmup.json.
function reconcileWarmupDays() {
  const before = new Set(W.days);
  const merged = new Set([...W.days, ...sendingDays()]);
  if (merged.size === before.size) return { added: 0, days: W.days.length };
  W.days = [...merged].sort();
  saveWarmup();
  const added = merged.size - before.size;
  log('info', `Warm-up — found ${added} sending day(s) in the message history that warmup.json did not know about; this number is on day ${W.days.length}`);
  return { added, days: W.days.length };
}

function markWarmupDay() {
  const today = todayKey();
  if (W.days.includes(today)) return;
  W.days.push(today);
  saveWarmup();
  const cap = warmupCap();
  log('info', cap === null
    ? `Warm-up complete after ${W.days.length} sending days — the ceiling is now your own cap and Meta's tier`
    : `Warm-up — day ${W.days.length}, today's ceiling is ${cap}`);
}

module.exports = { W, WARMUP_PLAN, saveWarmup, warmupStep, warmupCap, effectiveCap,
                   markWarmupDay, graduated, dailyCount, reconcileWarmupDays };
