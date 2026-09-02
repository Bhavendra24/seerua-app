-- Run these after migrate-bookings-to-tables.js to sanity-check the
-- migration before actually activating the new tables.

-- 1. Row counts should match what you'd expect from the app_data blob.
SELECT COUNT(*) AS total_bookings FROM bookings;
SELECT COUNT(*) AS total_items FROM booking_items;

-- 2. Every item should belong to a real booking (should return 0 rows).
SELECT bi.id, bi.booking_id
FROM booking_items bi
LEFT JOIN bookings b ON b.id = bi.booking_id
WHERE b.id IS NULL;

-- 3. Spot-check a specific customer's history reconstructs correctly —
--    replace the phone number, compare against what Track Order shows
--    for the same number in the live app.
SELECT b.id, b.name, b.phone, b.total_price, bi.appliance_name, bi.item_status
FROM bookings b
JOIN booking_items bi ON bi.booking_id = b.id
WHERE b.phone = 'REPLACE_WITH_A_REAL_PHONE_NUMBER'
ORDER BY b.created_at DESC;

-- 4. Confirm the indexes are actually being used (should show
--    key: idx_phone / idx_technician, not "ALL" under type).
EXPLAIN SELECT * FROM bookings WHERE phone = 'REPLACE_WITH_A_REAL_PHONE_NUMBER';
EXPLAIN SELECT * FROM booking_items WHERE technician_id = 'REPLACE_WITH_A_REAL_TECH_ID' AND item_status = 'completed';
