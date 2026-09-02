const bcrypt = require('bcryptjs');

// BUG FIX: admin, sub-admin, and technician passwords were stored and
// compared as plain text (`password === stored.password`) — anyone who
// gets read access to the data/*.json files (a backup, a leaked zip, a
// misconfigured server) instantly has every login's real password, not
// just a hash of it. People also commonly reuse passwords across sites, so
// a leak here can compromise accounts elsewhere too.
//
// `verifyAndUpgrade` supports both old plaintext records AND new bcrypt
// hashes so existing data/*.json files keep working with zero manual
// migration: the first time someone logs in with a still-plaintext record,
// it's verified the old way and then immediately re-saved as a bcrypt
// hash via the provided `onUpgrade` callback. From then on that record is
// hashed. New passwords (created via "add technician" etc.) should always
// go through hashPassword() directly.

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

// Returns true/false. If the stored value was still plaintext and the
// password matched, calls onUpgrade(hashedPassword) so the caller can
// persist the upgrade (e.g. write it back to admin.json).
function verifyAndUpgrade(plainAttempt, storedValue, onUpgrade) {
  if (!storedValue) return false;
  if (isBcryptHash(storedValue)) {
    return bcrypt.compareSync(plainAttempt, storedValue);
  }
  // Legacy plaintext record.
  const matches = plainAttempt === storedValue;
  if (matches && typeof onUpgrade === 'function') {
    onUpgrade(hashPassword(plainAttempt));
  }
  return matches;
}

module.exports = { hashPassword, verifyAndUpgrade, isBcryptHash };
