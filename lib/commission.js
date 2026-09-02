// Commission calculation — centralized here so the Commission Report, the
// Technician Earnings table, the Analytics trend, and the technician's own
// app all resolve a job's commission the exact same way and can never
// disagree with each other.
//
// SUGGESTION IMPLEMENTED: commission can now be a flat ₹ amount per service
// OR a percentage of the job's price — Admin picks per rate (global,
// per-appliance, per-technician). A flat ₹50 on a ₹400 RO service (12.5%)
// vs a ₹2000 AC service (2.5%) was an inconsistent real cost to
// technicians; percent mode fixes that where Admin wants it, while flat
// mode stays available for appliances/technicians where a fixed fee makes
// more sense.

// A "rate" is always { mode: 'flat'|'percent', value: number }.
// Normalizes old data too: a bare number (the original flat-only format)
// is treated as { mode: 'flat', value: <that number> } so existing
// commission-config.json / technician.variableAmount values keep working
// with zero migration needed.
function normalizeRate(rate) {
  if (rate === null || rate === undefined) return null;
  if (typeof rate === 'number') return { mode: 'flat', value: rate };
  if (typeof rate === 'object' && rate.mode && rate.value !== undefined && rate.value !== null) {
    return { mode: rate.mode === 'percent' ? 'percent' : 'flat', value: Number(rate.value) || 0 };
  }
  return null;
}

// Technician's own override (highest priority) > appliance-specific rate >
// global default. `!= null` checks throughout (not truthy checks) because
// an explicit 0 — "this technician/appliance owes no commission, ever" —
// must never be silently treated as "not set" and fall through to the
// next tier.
function getEffectiveCommissionRate(tech, cfg, applianceId) {
  if (tech && tech.variableAmount !== null && tech.variableAmount !== undefined) {
    return normalizeRate({ mode: tech.variableAmountMode || 'flat', value: tech.variableAmount });
  }
  const perAppliance = cfg && cfg.perApplianceRates;
  if (applianceId && perAppliance && perAppliance[applianceId] !== undefined && perAppliance[applianceId] !== null) {
    return normalizeRate(perAppliance[applianceId]);
  }
  const globalRate = cfg && (cfg.mode === 'percent'
    ? { mode: 'percent', value: cfg.percentValue }
    : { mode: 'flat', value: cfg.amountPerService });
  return normalizeRate(globalRate) || { mode: 'flat', value: 0 };
}

// SUGGESTION IMPLEMENTED: commission used to be waived the instant a
// technician self-reported a Google review — nothing stopped a technician
// from falsely claiming one to keep 100% of every job. Now waiving
// requires `reviewVerifiedByStaff` (only Admin/Sub-Admin can set this, via
// PUT .../google-review) — a technician's own report only sets
// `reviewBrought` as a claim awaiting confirmation, shown to staff as
// "pending verification" in the Commission report, and does NOT affect
// what the technician owes until staff confirms it really happened.
function computeItemCommission(item, rate) {
  if (item.itemStatus !== 'completed') return 0;
  if (item.reviewVerifiedByStaff) return 0;
  const r = normalizeRate(rate) || { mode: 'flat', value: 0 };
  if (r.mode === 'percent') {
    return Math.min(Math.round(item.lineTotal * (r.value / 100)), item.lineTotal);
  }
  return Math.min(r.value, item.lineTotal);
}

module.exports = { normalizeRate, getEffectiveCommissionRate, computeItemCommission };
