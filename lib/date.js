// India-only business — every "which calendar day is this" decision (today's
// date for slot expiry, which day's Daily Report / Commission Report an item
// belongs to) must be computed in IST (UTC+5:30), not UTC.
//
// BUG THIS FIXES: the rest of the app used `new Date().toISOString().slice(0,10)`
// to get "today" / "which day did this happen on". toISOString() always
// returns UTC. IST is 5.5 hours ahead of UTC, so anything that happened
// between 12:00 AM and 5:29 AM IST was being reported as still "yesterday"
// (UTC hasn't crossed midnight yet) — e.g. a service completed at 1 AM IST
// would silently vanish from that day's Commission Report and show up on the
// previous day's instead. Same bug affected the "is this slot still bookable
// today" check right around midnight IST.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

// Returns YYYY-MM-DD for the given date (or now) as seen in IST.
function istDateStr(date) {
  const d = date ? new Date(date) : new Date();
  const istMs = d.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

// Returns the current hour (0-23) in IST — used for "has this time slot's
// window already passed today" checks.
function istCurrentHour() {
  const istMs = Date.now() + IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(istMs).getUTCHours();
}

module.exports = { istDateStr, istCurrentHour };
