// =====================================================================
// OPTION 2 ACTIVATION SCRIPT — run this ONCE when you're ready to switch
// `bookings` from a single JSON blob (in app_data) to real indexed
// tables (schema.sql). Safe to run against a live database — it only
// READS from app_data and INSERTs into the new tables; it never deletes
// or modifies the existing app_data row, so if anything goes wrong you
// can simply not flip the switch in db.js and nothing is lost.
//
// USAGE:
//   node sql/migrate-bookings-to-tables.js
// (reads DB_HOST/DB_USER/DB_PASSWORD/DB_NAME from the environment, same
// as the main app)
//
// WHAT THIS DOES NOT DO (see CHANGES.md for the full picture):
// This script only creates and populates the new tables — it does NOT
// change db.js or server.js to actually USE them. That's a deliberate,
// separate step (flip USE_NORMALIZED_BOOKINGS in db.js — see the comment
// there) done only when you're ready, so the new tables can be verified
// against real data first without any risk to the live app.
// =====================================================================

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  if (!process.env.DB_HOST) {
    console.error('DB_HOST is not set. Set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME (same as the main app) and run again.');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5
  });

  console.log('Creating tables from schema.sql (if not already present)...');
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  // Split on semicolons at end of statements — schema.sql is written
  // simply enough (no semicolons inside string literals) for this to be
  // safe.
  const statements = schemaSql.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  console.log('Tables ready: bookings, booking_items');

  console.log('Reading existing bookings from app_data...');
  const [rows] = await pool.query("SELECT data FROM app_data WHERE name IN ('bookings', 'bookings-archive')");
  let allBookings = [];
  for (const row of rows) {
    const parsed = JSON.parse(row.data);
    allBookings = allBookings.concat(parsed);
  }
  console.log(`Found ${allBookings.length} bookings to migrate (active + archived).`);

  if (allBookings.length === 0) {
    console.log('Nothing to migrate. Tables are created and empty — ready for new bookings once activated.');
    await pool.end();
    return;
  }

  // Figure out which ones were archived, so the flag carries over correctly.
  const [archiveRow] = await pool.query("SELECT data FROM app_data WHERE name = 'bookings-archive'");
  const archivedIds = new Set(
    archiveRow.length ? JSON.parse(archiveRow[0].data).map(b => b.id) : []
  );

  let migratedBookings = 0, migratedItems = 0;
  // Booking timestamps are stored as ISO 8601 strings (e.g.
  // "2026-08-18T02:23:17.627Z") everywhere in the app — MySQL's DATETIME
  // columns need "YYYY-MM-DD HH:MM:SS.mmm" instead. null-safe (some older
  // fields like assignedAt/reviewMarkedAt can legitimately be absent).
  function toMysqlDatetime(iso) {
    if (!iso) return null;
    return new Date(iso).toISOString().slice(0, 23).replace('T', ' ');
  }

  for (const b of allBookings) {
    await pool.query(
      `INSERT INTO bookings
        (id, phone, name, address, city_id, city_name, coupon_code, discount_amount,
         referral_code, referral_discount, subtotal, total_price, booking_date,
         time_slot_id, time_slot, source, created_at, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         phone=VALUES(phone), name=VALUES(name), address=VALUES(address),
         city_id=VALUES(city_id), city_name=VALUES(city_name),
         updated_at=VALUES(updated_at), archived=VALUES(archived)`,
      [
        b.id, b.phone, b.name, b.address || '', b.cityId, b.cityName || '',
        b.couponCode || '', b.discountAmount || 0, b.referralCode || '',
        b.referralDiscount || 0, b.subtotal || 0, b.totalPrice || 0,
        b.bookingDate || '', b.timeSlotId || '', b.timeSlot || '',
        b.source || 'online', toMysqlDatetime(b.createdAt), toMysqlDatetime(b.updatedAt),
        archivedIds.has(b.id) ? 1 : 0
      ]
    );
    migratedBookings++;

    for (const it of (b.items || [])) {
      await pool.query(
        `INSERT INTO booking_items
          (id, booking_id, appliance_id, appliance_name, type_id, type_name, service_type,
           qty, unit_price, line_total, problem, photo_url, technician_id, technician_name,
           item_status, technician_report, review_brought, review_verified_by_staff,
           review_marked_by, review_marked_at, rating, rating_source, review_text,
           assigned_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           item_status=VALUES(item_status), technician_id=VALUES(technician_id),
           updated_at=VALUES(updated_at)`,
        [
          it.id, b.id, it.applianceId || '', it.applianceName || '', it.typeId || '',
          it.typeName || '', it.serviceType || '', it.qty || 1, it.unitPrice || 0,
          it.lineTotal || 0, it.problem || '', it.photoUrl || '', it.technicianId || null,
          it.technicianName || null, it.itemStatus, it.technicianReport || '',
          it.reviewBrought ? 1 : 0, it.reviewVerifiedByStaff ? 1 : 0,
          it.reviewMarkedBy || null, toMysqlDatetime(it.reviewMarkedAt), it.rating || null,
          it.ratingSource || null, it.reviewText || null, toMysqlDatetime(it.assignedAt), toMysqlDatetime(it.updatedAt)
        ]
      );
      migratedItems++;
    }
  }

  console.log(`Migrated ${migratedBookings} bookings and ${migratedItems} items into the normalized tables.`);
  console.log('Next step: verify the data (see sql/verify-migration.sql for sanity-check queries), then flip USE_NORMALIZED_BOOKINGS in db.js when ready.');
  await pool.end();
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
