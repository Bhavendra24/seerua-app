const { readData } = require('../db');
const fetch = global.fetch || require('node-fetch');

// Verifies an MSG91 OTP widget access-token against our secret AuthKey,
// AND that the token was actually issued for the phone number this
// booking is for.
//
// BUG FIX: this used to only check `type === 'success'` — i.e. "is this
// access-token valid at all", not "is it valid FOR THIS PHONE NUMBER".
// The browser flow happens to be safe (the phone number is locked into a
// local variable before the OTP widget ever opens — see main.js), but
// nothing stopped a request sent directly to this API (bypassing the
// browser UI entirely) from verifying OTP on one phone number and then
// submitting a booking for a completely different one, reusing that
// token. That would mark an arbitrary phone number "verified" — and
// therefore able to skip OTP on every future booking — without ever
// proving anyone actually controls it, defeating the entire point of
// OTP (and turning that number into a target for repeated SMS/WhatsApp
// booking confirmations and technician calls it never asked for).
//
// MSG91's verify-access-token response is expected to echo back which
// identifier (phone number) the token was issued for, but the exact
// field name isn't consistently documented across MSG91's API versions.
// Defensively checked across every field name MSG91 is known to use
// (identifier / mobile / message) rather than assuming one: if any of
// them contains a phone number and it does NOT match, the booking is
// rejected. If none of those fields are present at all (a future MSG91
// response shape this doesn't recognize), it falls back to the old
// behavior rather than breaking every real booking — logged clearly so
// this can be tightened once the actual response shape is confirmed.
function extractVerifiedIdentifier(verifyData) {
  const candidates = [verifyData.identifier, verifyData.mobile, verifyData.message]
    .filter(v => typeof v === 'string' && v.trim());
  for (const raw of candidates) {
    const digits = raw.replace(/\D/g, '');
    // MSG91 identifiers are submitted as "91XXXXXXXXXX" (see main.js) —
    // strip a leading country code so this compares like-for-like against
    // the plain 10-digit number the rest of the app uses everywhere else.
    const last10 = digits.slice(-10);
    if (last10.length === 10) return last10;
  }
  return null;
}

// SECURITY FIX: the MSG91 AuthKey now comes from the MSG91_AUTHKEY
// environment variable when set, so the real secret never has to live in
// data/otp-config.json (and therefore never ends up in a project ZIP,
// backup, or git history by accident). Falls back to cfg.authkey only for
// local/dev convenience when the env var isn't set.
function resolveAuthkey(cfg) {
  return process.env.MSG91_AUTHKEY || cfg.authkey;
}

async function verifyOtpAccessToken(accessToken, expectedPhone) {
  const cfg = readData('otp-config');
  // BUG FIX: MSG91's AuthKey is a single account-level secret, but the
  // Admin Panel UI only ever had a place to save it under Notifications
  // (data/notification-config.json) — never under OTP Verification
  // (data/otp-config.json), which is what this function actually read
  // from. That meant otp-config.json's authkey was permanently empty
  // for anyone who set it up through the Admin Panel (rather than by
  // hand-editing the JSON file), so every single access-token
  // verification silently sent an empty authkey to MSG91 and always
  // came back rejected — "OTP verification failed, expired, or does
  // not match this phone number", even with a fully correct code.
  // Checks both config files now, so whichever one it was actually
  // saved into (most likely Notifications) is picked up.
  const notifCfg = readData('notification-config');
  const authkey = resolveAuthkey(cfg) || notifCfg.authkey;
  const verifyRes = await fetch(cfg.verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authkey, 'access-token': accessToken })
  });
  const verifyData = await verifyRes.json().catch(() => null);
  if (!verifyRes.ok || !verifyData || verifyData.type !== 'success') return false;

  const verifiedPhone = extractVerifiedIdentifier(verifyData);
  if (verifiedPhone === null) {
    // SECURITY FIX (fail-closed): previously this returned true when no
    // recognizable phone field was found, which meant phone-binding could
    // never actually be enforced against a differently-shaped MSG91
    // response — silently defeating the whole point of this check. Now it
    // rejects instead, so a booking can only go through once we can prove
    // the OTP was verified for the exact phone number being booked. Logged
    // loudly so this can be diagnosed if MSG91 changes their response shape.
    console.warn('[OTP] Could not find a phone identifier in MSG91\'s verify response — rejecting (fail-closed). Response was:', JSON.stringify(verifyData));
    return false;
  }
  if (verifiedPhone !== String(expectedPhone)) {
    console.warn(`[OTP] Rejected: access-token was verified for a different phone number (ends in ${verifiedPhone.slice(-4)}) than the booking's phone number (ends in ${String(expectedPhone).slice(-4)}).`);
    return false;
  }
  return true;
}

// ---------------- Booking confirmation SMS / WhatsApp ----------------
// Reuses the same MSG91 account that already handles OTP (MSG91 offers SMS
// and WhatsApp Business API sending too). Both channels are OFF by default
// — Admin turns them on from Admin Panel > Notifications once real MSG91
// credentials + an approved template are in place. Until then this is a
// harmless no-op so it can never block or break a booking.
async function sendBookingSms(booking, cfg) {
  const authkey = resolveAuthkey(cfg);
  if (!authkey || !cfg.smsTemplateId) {
    console.log('[SMS] Skipped for booking', booking.id, '— MSG91 authkey/template not configured yet.');
    return;
  }
  const smsRes = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey },
    body: JSON.stringify({
      template_id: cfg.smsTemplateId,
      short_url: '0',
      recipients: [{
        mobiles: '91' + booking.phone,
        name: booking.name,
        booking_id: booking.id,
        booking_date: booking.bookingDate,
        time_slot: booking.timeSlot,
        amount: String(booking.totalPrice)
      }]
    })
  });
  if (!smsRes.ok) {
    const errBody = await smsRes.text().catch(() => '');
    throw new Error(`MSG91 SMS API returned ${smsRes.status} ${errBody}`.trim());
  }
}

async function sendBookingWhatsapp(booking, cfg) {
  const authkey = resolveAuthkey(cfg);
  if (!authkey || !cfg.whatsappIntegratedNumber || !cfg.whatsappTemplateName) {
    console.log('[WhatsApp] Skipped for booking', booking.id, '— MSG91 WhatsApp not configured yet.');
    return;
  }
  const waRes = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey },
    body: JSON.stringify({
      integrated_number: cfg.whatsappIntegratedNumber,
      content_type: 'template',
      payload: {
        to: '91' + booking.phone,
        type: 'template',
        template: {
          name: cfg.whatsappTemplateName,
          language: { code: 'en', policy: 'deterministic' },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: booking.name },
              { type: 'text', text: booking.id },
              { type: 'text', text: booking.bookingDate },
              { type: 'text', text: booking.timeSlot },
              { type: 'text', text: String(booking.totalPrice) }
            ]
          }]
        }
      }
    })
  });
  if (!waRes.ok) {
    const errBody = await waRes.text().catch(() => '');
    throw new Error(`MSG91 WhatsApp API returned ${waRes.status} ${errBody}`.trim());
  }
}

// ---------------- "Service completed" SMS / WhatsApp ----------------
// Same MSG91 account, but its own separate DLT-approved SMS template and
// WhatsApp template — Indian telecom regulation (DLT) requires every SMS
// template to be pre-registered and approved individually, so the booking
// -confirmation template can't just be reused here; a "your service is
// done" message needs its own template ID configured by Admin.
// SUGGESTION IMPLEMENTED: nudges the customer to rate their service (and,
// if happy, cross-post to Google) right while the visit is fresh in their
// mind — same idea as Urban Company's post-job rating prompt. `ratingLink`
// already includes ?trackPhone=<their number>, so tapping it in
// WhatsApp/SMS lands them straight on the rating stars with zero retyping
// (see bindTrackPrompt() in main.js).
//
// IMPORTANT: MSG91 SMS (DLT-registered) and WhatsApp Business templates
// must be pre-approved with fixed text — this code cannot invent a new
// message on the fly. `ratingLink` is passed as an additional template
// variable; it will only actually show up in what the customer receives
// once Admin adds a matching {{var}}/parameter slot to the already
// -approved completionSmsTemplateId / completionWhatsappTemplateName
// templates on the MSG91 dashboard and gets it re-approved. Until then,
// this is silently ignored by MSG91 (extra parameters beyond what a
// template expects are simply unused, not an error), so nothing breaks.
async function sendCompletionSms(booking, item, cfg, ratingLink) {
  const authkey = resolveAuthkey(cfg);
  if (!authkey || !cfg.completionSmsTemplateId) {
    console.log('[SMS] Completion message skipped for', booking.id, '— completion SMS template not configured yet.');
    return;
  }
  const smsRes = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey },
    body: JSON.stringify({
      template_id: cfg.completionSmsTemplateId,
      short_url: '0',
      recipients: [{
        mobiles: '91' + booking.phone,
        name: booking.name,
        booking_id: booking.id,
        appliance: item.applianceName,
        rating_link: ratingLink
      }]
    })
  });
  if (!smsRes.ok) {
    const errBody = await smsRes.text().catch(() => '');
    throw new Error(`MSG91 SMS API returned ${smsRes.status} ${errBody}`.trim());
  }
}

async function sendCompletionWhatsapp(booking, item, cfg, ratingLink) {
  const authkey = resolveAuthkey(cfg);
  if (!authkey || !cfg.whatsappIntegratedNumber || !cfg.completionWhatsappTemplateName) {
    console.log('[WhatsApp] Completion message skipped for', booking.id, '— completion WhatsApp template not configured yet.');
    return;
  }
  const waRes = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey },
    body: JSON.stringify({
      integrated_number: cfg.whatsappIntegratedNumber,
      content_type: 'template',
      payload: {
        to: '91' + booking.phone,
        type: 'template',
        template: {
          name: cfg.completionWhatsappTemplateName,
          language: { code: 'en', policy: 'deterministic' },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: booking.name },
              { type: 'text', text: item.applianceName },
              { type: 'text', text: booking.id },
              { type: 'text', text: ratingLink }
            ]
          }]
        }
      }
    })
  });
  if (!waRes.ok) {
    const errBody = await waRes.text().catch(() => '');
    throw new Error(`MSG91 WhatsApp API returned ${waRes.status} ${errBody}`.trim());
  }
}

// Called right after a technician marks one item completed. Same
// fire-and-forget safety as the booking-confirmation notification — a
// failure here (bad credentials, MSG91 down, template not approved yet)
// must never affect the job actually being marked done.
//
// `ratingLink` is built by the caller (server.js, which owns SITE_URL) —
// see the long comment on sendCompletionSms above for what's needed on
// MSG91's side before it actually shows up in the message customers get.
async function sendCompletionNotification(booking, item, ratingLink) {
  const cfg = readData('notification-config');
  if (!cfg || (!cfg.smsEnabled && !cfg.whatsappEnabled)) return;
  const jobs = [];
  if (cfg.smsEnabled) jobs.push(sendCompletionSms(booking, item, cfg, ratingLink));
  if (cfg.whatsappEnabled) jobs.push(sendCompletionWhatsapp(booking, item, cfg, ratingLink));
  await Promise.allSettled(jobs);
}

// Called right after a booking is created. Fires both channels in parallel
// and never throws — a notification failure (bad credentials, MSG91 down,
// etc.) must never stop the customer's booking from succeeding.
async function sendBookingNotification(booking) {
  const cfg = readData('notification-config');
  if (!cfg || (!cfg.smsEnabled && !cfg.whatsappEnabled)) return;
  const jobs = [];
  if (cfg.smsEnabled) jobs.push(sendBookingSms(booking, cfg));
  if (cfg.whatsappEnabled) jobs.push(sendBookingWhatsapp(booking, cfg));
  const results = await Promise.allSettled(jobs);
  results.forEach(r => {
    if (r.status === 'rejected') console.error('Booking notification failed for', booking.id, '-', r.reason && r.reason.message);
  });
}

module.exports = {
  verifyOtpAccessToken,
  sendBookingNotification,
  sendCompletionNotification,
  // Also exported individually — the Admin Panel's "Send Test
  // Notification" buttons call these directly (not through the wrapper
  // above) so Admin can test SMS and WhatsApp independently.
  sendBookingSms,
  sendBookingWhatsapp,
  sendCompletionSms,
  sendCompletionWhatsapp
};
