-- =====================================================================
-- OPTION 2: Real indexed SQL tables for the `bookings` collection.
--
-- STATUS: Ready to use, but NOT yet active. The live app still reads/
-- writes `bookings` as one JSON blob (via db.js — see app_data table).
-- This schema + the migration script (migrate-bookings-to-tables.js) are
-- prepared and tested so they can be activated later without starting
-- from scratch, once real usage actually needs the extra capacity these
-- indexes provide (see CHANGES.md for realistic capacity numbers).
--
-- WHY ONLY `bookings`, NOT EVERY DATA FILE:
-- Every other collection (cities, appliances, technicians, pricing,
-- coupons, etc.) is small — hundreds of rows at most, never queried at
-- high frequency by a specific field — so keeping them as JSON blobs in
-- app_data is completely fine, forever. `bookings` is the ONE collection
-- that grows unboundedly and gets searched by specific fields (phone,
-- technician, date, city) constantly, which is exactly what SQL indexes
-- are for.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bookings (
  id VARCHAR(50) NOT NULL PRIMARY KEY,
  phone VARCHAR(15) NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city_id VARCHAR(50) NOT NULL,
  city_name VARCHAR(100),
  coupon_code VARCHAR(50) DEFAULT '',
  discount_amount INT NOT NULL DEFAULT 0,
  referral_code VARCHAR(50) DEFAULT '',
  referral_discount INT NOT NULL DEFAULT 0,
  subtotal INT NOT NULL DEFAULT 0,
  total_price INT NOT NULL DEFAULT 0,
  booking_date VARCHAR(20),
  time_slot_id VARCHAR(50),
  time_slot VARCHAR(100),
  source VARCHAR(20) DEFAULT 'online',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  -- These indexes are the whole point: each turns a "scan every booking
  -- in JS" operation into an instant lookup, no matter how many bookings
  -- exist.
  INDEX idx_phone (phone),                    -- Track Order, rating, referral matching
  INDEX idx_city (city_id),                   -- city-scoped Sub-Admin views, Analytics
  INDEX idx_booking_date (booking_date),      -- slot availability, Daily Report
  INDEX idx_created_at (created_at),          -- Analytics trend, archiving cutoff
  INDEX idx_archived (archived)               -- hide archived rows from the hot path by default
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS booking_items (
  id VARCHAR(50) NOT NULL PRIMARY KEY,
  booking_id VARCHAR(50) NOT NULL,
  appliance_id VARCHAR(50),
  appliance_name VARCHAR(100),
  type_id VARCHAR(50),
  type_name VARCHAR(100),
  service_type VARCHAR(20),
  qty INT DEFAULT 1,
  unit_price INT,
  line_total INT,
  problem TEXT,
  photo_url VARCHAR(500),
  technician_id VARCHAR(50),
  technician_name VARCHAR(100),
  item_status VARCHAR(30) NOT NULL,
  technician_report TEXT,
  review_brought TINYINT(1) NOT NULL DEFAULT 0,
  review_verified_by_staff TINYINT(1) NOT NULL DEFAULT 0,
  review_marked_by VARCHAR(100),
  review_marked_at DATETIME(3),
  rating INT,
  rating_source VARCHAR(20),
  review_text TEXT,
  assigned_at DATETIME(3),
  updated_at DATETIME(3) NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  -- The single most valuable index in this whole schema: every
  -- Commission Report, technician dashboard, and Daily Report query
  -- filters by technician_id + item_status. In the current JSON-blob
  -- design, this means scanning every item of every booking, every time.
  INDEX idx_technician (technician_id),
  INDEX idx_status (item_status),
  INDEX idx_booking (booking_id),
  INDEX idx_updated_at (updated_at)           -- date-bucketing for reports (IST-converted before querying — see lib/date.js)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
