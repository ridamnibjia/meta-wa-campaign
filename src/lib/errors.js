'use strict';

// ── Meta error codes → plain English + what to actually do ─────────────────────
// Meta returns bare numbers and a terse message. Without this table a failure log
// reads "(131042) Business eligibility payment issue", which tells you nothing
// about where to click. Only codes reachable from this app's flows are listed;
// anything unlisted falls through to Meta's own message.
const META_ERRORS = {
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

module.exports = { META_ERRORS, explainError };
