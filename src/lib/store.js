'use strict';
// ponytail: flat JSON files, whole-file rewrites. This app tracks hundreds of
// contacts and thousands of message IDs, not millions — a database would be more
// machinery than the problem needs. Move to SQLite only when a single write
// becomes measurably slow.
const fs = require('fs');

// A missing or corrupt file is not fatal: the app boots with the fallback and
// says so. Throwing here would mean one bad byte in opt-outs.json bricks the
// whole server.
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[WARN] Could not read ${file}: ${e.message} — starting from empty`);
    return fallback;
  }
}

// Write to a temp file and rename. A rename is atomic on POSIX, so a crash
// mid-write leaves the previous good file intact rather than a truncated one —
// which matters because these files are the only copy of the send queue.
function writeJSON(file, data) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`[ERROR] Could not write ${file}: ${e.message}`);
  }
}

// Collapses a burst of writes into one. The send loop touches state on every
// message; without this a 1000-contact campaign would mean 1000 full rewrites.
function debouncedWriter(file, ms = 2000) {
  let timer = null;
  const flush = getData => { clearTimeout(timer); timer = null; writeJSON(file, getData()); };
  return {
    schedule(getData) {
      clearTimeout(timer);
      timer = setTimeout(() => writeJSON(file, getData()), ms);
    },
    flush,
  };
}

module.exports = { readJSON, writeJSON, debouncedWriter };
