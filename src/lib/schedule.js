'use strict';
// Clock arithmetic for the retry ladder. Pure: no database, no HTTP, no
// Date.now() — every answer is a function of the timestamp handed in, which is
// what lets test.js assert on 3am without waiting until 3am.

// IST is UTC+05:30 and has no daylight saving, so the whole zone is this one
// constant. Offsetting a UTC instant by it produces a Date whose *UTC* fields
// read as IST wall-clock time, which is the only reliable way to ask "what hour
// is it in India" on a server that may be running in any zone.
const IST_OFFSET_MS = 5.5 * 3600000;

// A retry that lands at 3am wakes a dealer up. Delivery works fine; what breaks
// is the quality rating, because night notifications are what people block and
// report — and the quality rating is what gates the messaging tier.
//
// resumeAt is 8 while the window ends at 7 on purpose. The extra hour is grace:
// a night's worth of deferred retries all become due at the same instant, and
// releasing that herd at 07:00 sharp is releasing it while people are still
// asleep. A deadline that independently survived to 07:30 is a morning deadline
// and fires on time.
function deferPastQuietHours(at, { start = 23, end = 7, resumeAt = 8 } = {}) {
  const ist  = new Date(at + IST_OFFSET_MS);
  const hour = ist.getUTCHours();          // UTC getter, IST value — see above

  // The window wraps midnight, so it is two ranges, not one. Written to still
  // be correct if someone later configures a window that does not wrap.
  const inQuiet = start > end ? (hour >= start || hour < end)
                              : (hour >= start && hour < end);
  if (!inQuiet) return at;

  ist.setUTCHours(resumeAt, 0, 0, 0);
  // Only the wrapping window's pre-midnight half rolls over. `hour >= start`
  // alone is not the test: in a window that stays inside one day, every hour in
  // it is >= start, and rolling those over would cost the contact a full extra
  // day for a deadline that resumeAt already covers this afternoon.
  if (start > end && hour >= start) ist.setUTCDate(ist.getUTCDate() + 1);
  return ist.getTime() - IST_OFFSET_MS;
}

module.exports = { deferPastQuietHours, IST_OFFSET_MS };
