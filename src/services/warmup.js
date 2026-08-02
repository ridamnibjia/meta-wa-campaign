'use strict';
const { FILES } = require('../config');
const { readJSON, writeJSON } = require('../lib/store');
const { S, log, todayKey } = require('../state');

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

// Which rung today sits on. A day already sent on keeps its rung; a fresh day
// climbs one — unless quality has slipped, in which case it holds where it was.
function warmupStep() {
  const i = W.days.indexOf(todayKey());
  let step = i >= 0 ? i : W.days.length;
  if (step > 0 && ['RED', 'YELLOW'].includes(S.quality)) step -= 1;
  return Math.min(step, WARMUP_PLAN.length - 1);
}

function warmupCap() { return W.enabled ? WARMUP_PLAN[warmupStep()] : null; }

// The cap actually enforced: the warm-up rung, or your own number, whichever is lower.
function effectiveCap() {
  const w = warmupCap();
  return w === null ? S.config.dailyCap : Math.min(S.config.dailyCap, w);
}

function markWarmupDay() {
  const today = todayKey();
  if (W.days.includes(today)) return;
  W.days.push(today);
  saveWarmup();
  log('info', `Warm-up — day ${W.days.length}, today's ceiling is ${warmupCap()}`);
}

module.exports = { W, WARMUP_PLAN, saveWarmup, warmupStep, warmupCap, effectiveCap, markWarmupDay };
