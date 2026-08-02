'use strict';
const { FILES } = require('../config');
const { readJSON, writeJSON } = require('../lib/store');
const { normalizePhone } = require('../lib/phone');

// ponytail: flat JSON file, loaded into a Set on boot. Hundreds of numbers, not
// millions — swap for SQLite only if the list outgrows a single file read.
const optOuts = new Set(readJSON(FILES.optOuts, []));

const save = () => writeJSON(FILES.optOuts, [...optOuts]);

function addOptOut(phone) {
  const d = normalizePhone(phone);
  if (!d || optOuts.has(d)) return false;
  optOuts.add(d);
  save();
  return true;
}

function removeOptOut(phone) {
  const d = normalizePhone(phone);
  if (!d || !optOuts.delete(d)) return false;
  save();
  return true;
}

module.exports = { optOuts, addOptOut, removeOptOut };
