const { readData } = require('../db');

// ---------- Auth middlewares ----------
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Admin login required' });
}

// A deleted or deactivated staff account loses access on its very next
// request -- not only when its 12-hour session happens to expire.
function activeTechnician(req) {
  if (!req.session || !req.session.technicianId) return null;
  const t = readData('technicians').find(x => x.id === req.session.technicianId);
  return t && t.active !== false ? t : null;
}
function activeSubAdmin(req) {
  if (!req.session || !req.session.subAdminId) return null;
  const s = readData('sub-admins').find(x => x.id === req.session.subAdminId);
  return s && s.active !== false ? s : null;
}
function endStaleSession(req) {
  if (req.session) { delete req.session.technicianId; delete req.session.subAdminId; }
}

function requireTechnician(req, res, next) {
  if (activeTechnician(req)) return next();
  endStaleSession(req);
  return res.status(401).json({ error: 'Technician login required' });
}

// Sub-Admin — a limited staff login that can assign technicians, control
// booking slots, and add new customers, without full Admin access (pricing,
// coupons, technician management, maintenance mode, etc. stay Admin-only).
function requireSubAdmin(req, res, next) {
  if (activeSubAdmin(req)) return next();
  if (req.session && req.session.subAdminId) endStaleSession(req);
  return res.status(401).json({ error: 'Sub-Admin login required' });
}

// Used on the handful of routes both Admin and Sub-Admin are allowed to use.
function requireStaff(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (activeSubAdmin(req)) return next();
  if (req.session && req.session.subAdminId) endStaleSession(req);
  return res.status(401).json({ error: 'Login required' });
}

// City-scoped Sub-Admin access: Super Admin can restrict a Sub-Admin to only
// see/act on bookings, customers, and slots for specific cities. Returns:
//   null            -> unrestricted (Super Admin, or a Sub-Admin with no cities assigned)
//   [cityId, ...]   -> restricted to exactly these city IDs
function getStaffCityScope(req) {
  if (!req.session) return null;
  if (req.session.isAdmin) return null; // Super Admin always sees everything
  if (req.session.subAdminId) {
    const subAdmins = readData('sub-admins');
    const me = subAdmins.find(s => s.id === req.session.subAdminId);
    if (!me || me.active === false) return []; // deleted/disabled -> no access at all (never "everything")
    if (Array.isArray(me.cityIds) && me.cityIds.length) return me.cityIds;
    return null; // no cities assigned = unrestricted (backward compatible)
  }
  return null;
}

// Human-readable label for whichever staff member is logged in — used to
// record who manually confirmed something (e.g. a Google review), so it's
// auditable later rather than just a silent boolean flip.
function getStaffDisplayName(req) {
  if (!req.session) return 'Staff';
  if (req.session.isAdmin) return 'Super Admin';
  if (req.session.subAdminId) {
    const subAdmins = readData('sub-admins');
    const me = subAdmins.find(s => s.id === req.session.subAdminId);
    return me ? me.name : 'Admin';
  }
  return 'Staff';
}

module.exports = {
  requireAdmin,
  requireTechnician,
  requireSubAdmin,
  requireStaff,
  getStaffCityScope,
  getStaffDisplayName
};
