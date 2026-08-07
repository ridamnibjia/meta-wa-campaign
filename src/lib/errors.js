'use strict';

// ── Meta error codes → plain English + what to actually do ─────────────────────
// Meta returns bare numbers and a terse message. Without this table a failure log
// reads "(131042) Business eligibility payment issue", which tells you nothing
// about where to click. Only codes reachable from this app's flows are listed;
// anything unlisted falls through to Meta's own message.
const META_ERRORS = {
  // -1 is OURS, not Meta's: fetch threw, so there is no Meta response to have a
  // code in. It is listed here because everything downstream — the skip report,
  // the failure list — looks a code up in this table, and without an entry the
  // report told the operator to look -1 up in Meta's error reference, which does
  // not mention it and never will.
  '-1':   ['Could not reach Meta from this server',   'A network problem on the machine running this server — DNS, TLS, no outbound access, or credentials that are not set. Nothing is wrong with the contact, and a running campaign retries the send on its own.'],
  4:      ['App hit its hourly API call limit',        'The loop backs off on its own. If it repeats, raise "Delay between sends".'],
  10:     ['Permission denied for this action',        'The token is missing whatsapp_business_messaging or whatsapp_business_management. Regenerate it with both.'],
  33:     ['Phone Number ID not found',                'PHONE_NUMBER_ID is wrong, or the token belongs to a different app. Recheck WhatsApp → API Setup.'],
  100:    ['Invalid parameter in the request',         'Usually a template name/language mismatch. Re-run Check Template.'],
  190:    ['Access token expired or invalid',          'Generate a fresh System User token (Business Settings → System Users → Generate Token) and update ACCESS_TOKEN.'],
  200:    ['Permission error on the WABA',             'The System User needs admin access to this WhatsApp Business Account. Add it under Business Settings → Users.'],
  80007:  ['WABA rate limit reached',                  'Slow down. Raise the delay, or lower the daily cap.'],
  130429: ['Throughput rate limit reached',           'Sending faster than the number is allowed to. The loop retries this contact automatically.'],
  131000: ['Meta-side error, cause unspecified',      'Transient. Retry the campaign; if every send fails, check status at metastatus.com.'],
  131008: ['A required parameter was missing',        'Template variables do not match the approved template. Re-run Check Template.'],
  131009: ['A parameter value was rejected',          'Usually a variable containing a newline, tab, or 4+ spaces. Check the CSV cell.'],
  131016: ['WhatsApp service temporarily unavailable','Transient on Meta\'s side. Pause and resume in a few minutes.'],
  131021: ['Sender and recipient are the same number','You are messaging your own business number. Remove it from the CSV.'],
  131026: ['Message undeliverable',                   'Number is not on WhatsApp, or Meta blocked it on quality grounds. Nothing to fix — it is counted as skipped.'],
  131031: ['Account locked for a policy violation',   'Check Business Support Home in Business Manager. Sending stays blocked until resolved.'],
  131042: ['Billing not set up for this business',    'Add or fix the payment method: Business Settings → Billing & Payments. Sends stay blocked until it clears.'],
  131047: ['Outside the 24-hour customer service window', 'Only approved templates can open a conversation. Confirm you are sending the template, not free text.'],
  131049: ['Meta chose not to deliver this one',      'This recipient hit their per-user marketing limit — a rolling, per-person cap Meta applies across every business messaging them. Not your error. Retry on a later day, or send it as a UTILITY-category template, which the cap does not apply to.'],
  131051: ['Unsupported message type',                'The template was changed after approval. Re-run Check Template.'],
  132000: ['Wrong number of template variables',      'The approved template expects a different variable count than the CSV supplies. Re-run Check Template.'],
  132001: ['Template not found in that language',     'Name or language code does not match an APPROVED template. Check spelling and the language code (en vs en_US).'],
  132005: ['Filled-in template text is too long',     'A CSV value is pushing the body past 1024 characters. Shorten the longest values.'],
  132007: ['Template content policy violation',       'Meta rejected the formatting. Rewrite the body and resubmit.'],
  132012: ['Template variable format mismatch',       'A value does not match the sample you submitted for approval.'],
  132015: ['Template is paused for low quality',      'Too many blocks or reports. Wait for the pause to lift, or submit a new template. Do not retry.'],
  132016: ['Template is disabled',                    'Permanently disabled by Meta. Create and submit a new template.'],
  133010: ['Phone number is not registered',          'Register the number under WhatsApp → API Setup before sending.'],
  2388023:['Template is missing example values',      'Meta requires a sample for every variable. Fill in the sample fields and resubmit.'],
};

// Returns "what — action", or null when the code is unknown to us.
function explainError(code) {
  const e = META_ERRORS[code];
  return e ? `${e[0]} — ${e[1]}` : null;
}

// ── The skip report's classifier ───────────────────────────────────────────────
// After a run, the operator gets two lists: people worth trying again, and
// people Meta will refuse no matter how many times you ask. This function is
// what sorts one from the other, and it is a POLICY call rather than a lookup —
// which is why it is a function with a table in front of it rather than another
// column in META_ERRORS.
//
// The distinction that matters is about the FUTURE, not the past:
//
//   'retry'      — the send failed because of this moment. A rate limit, a Meta
//                  outage, a per-user marketing cap that resets. Trying again
//                  on another day is reasonable and may well work.
//   'permanent'  — the send failed because of this NUMBER. Not on WhatsApp,
//                  blocked on quality grounds. Retrying is never right, and the
//                  contact has already been disabled with 'failed_hard'.
//   'fix'        — the send failed because of something on OUR side that a
//                  human can correct: a template that needs re-approval, a
//                  billing problem, a bad variable. Retrying unchanged repeats
//                  the failure; fixing the cause makes the whole list sendable.
//
// Codes worth thinking about, with their meanings from META_ERRORS above:
//   131026 undeliverable · 131049 per-user marketing cap · 131047 outside the
//   24h window · 130429 / 80007 / 4 rate limits · 131000 / 131016 transient
//   Meta faults · 132000 / 132001 / 131008 template mismatches · 132015 /
//   132016 template paused or disabled · 131042 billing · 131031 policy lock
//
// The table below is the policy. It is deliberately a whitelist in both
// directions: a code has to be named to be retried, and a code has to be named
// to be given up on. Anything unlisted is 'unclassified', which the loop treats
// as "do not retry" and the report renders with the raw code rather than a
// guess — a Meta code we have never seen must not silently cost re-sends, and
// must not silently write someone off either.
const SKIP_DISPOSITIONS = ['retry', 'permanent', 'fix', 'unclassified'];

// About the MOMENT. Trying the same number again later is reasonable.
//   -1     is ours, not Meta's: fetch threw. DNS, TLS, no outbound network, or
//          the header asset failed to upload. The single most common reason a
//          contact used to be dropped from a run forever — one blip at #340.
//   131049 is the per-user marketing cap, counted across every business
//          messaging that person. Nothing on our side caused it or fixes it.
//   131000 / 131016 are Meta faults it tells you are transient.
//   130429 / 80007 / 4 are rate limits. The loop already sleeps and re-sends
//          these without touching the queue; they are listed so that one which
//          survives the in-loop backoff still lands in "try again" rather than
//          in a bucket that reads as final.
const RETRY = new Set([-1, 4, 80007, 130429, 131000, 131016, 131049]);

// About the NUMBER. No amount of retrying changes the answer, and the contact
// has already been disabled with 'failed_hard' by the campaign loop.
const PERMANENT = new Set([131026]);

// About US. A human can correct the cause, and doing so makes the whole
// remaining list sendable — which is why these are not 'retry': retrying
// unchanged just reproduces the failure once per contact.
const FIX = new Set([
  10, 33, 100, 190, 200,            // token / permissions / wrong id
  131008, 131009, 131021, 131047,   // bad variable, own number, wrong message type for the window
  131031, 131042, 133010,           // policy lock, billing, number not registered
  131051, 132000, 132001, 132005,   // template drifted from what was approved
  132007, 132012, 132015, 132016, 2388023,
]);

function skipDisposition(code) {
  const n = Number(code);
  if (RETRY.has(n))     return 'retry';
  if (PERMANENT.has(n)) return 'permanent';
  if (FIX.has(n))       return 'fix';
  return 'unclassified';
}

module.exports = { META_ERRORS, explainError, skipDisposition, SKIP_DISPOSITIONS };
