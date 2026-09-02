# Seerua Appliance Care — Website

An AC, Washing Machine, RO and Fridge repair/service booking website — built with Node.js (Express), featuring city-wise pricing, a customer booking form, an Admin Panel, and a Technician Panel.

## 🚀 Setup after cloning from GitHub

This repo doesn't include real passwords/API keys (see `.gitignore`) — a few files need to be copied into place first:

```
cd data
copy admin.json.example admin.json
copy technicians.json.example technicians.json
copy notification-config.json.example notification-config.json
copy otp-config.json.example otp-config.json
copy sub-admins.json.example sub-admins.json
copy customers.json.example customers.json
copy bookings.json.example bookings.json
copy referrals.json.example referrals.json
copy referral-uses.json.example referral-uses.json
copy verified-phones.json.example verified-phones.json
copy technician-applications.json.example technician-applications.json
cd ..
npm install
node server.js
```

(On Mac/Linux, use `cp` instead of `copy`.)

Then open `data/admin.json` and change the default password before going live. Site runs at `http://localhost:3000`.

## 📤 Pushing this project to GitHub for the first time

```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO-NAME.git
git push -u origin main
```

Replace the URL with the one GitHub shows you after creating a new (empty) repository on github.com. Keep the repo **Private** — even with `.gitignore` protecting the most sensitive files, this is still your live business's source code.

## 🆕 Latest update — fixes & additions

- **Warranty mention reduced to one place per page** — it used to repeat ("30-day warranty/guarantee") in 5 different spots on the homepage alone with inconsistent wording. Now it's stated once — in the homepage FAQ, and once in each city page's "Why choose us" section — with consistent "30-day warranty" wording. (Full policy detail still lives on the Terms & Conditions page, as before.)
- **OTP only on a customer's first-ever booking** — once a phone number completes OTP once, every later booking (online) from that number skips OTP automatically. Enforced server-side, so it can't be bypassed. Admin/Sub-Admin phone bookings also mark the number as verified.
- **A "👷 Careers" button is now on the homepage itself** (header, nav menu, and city pages) — clicking it opens the application form right there in a popup and submits it immediately, no need to hunt for it in the footer. It also now collects an optional ID type + number (KYC). The standalone `/careers` page still exists too and behaves the same way. **Works during Maintenance Mode**: since the homepage itself is swapped out for the "We'll be right back" notice while Maintenance Mode is on (so the on-page popup isn't reachable then), that notice page now also shows a "Want to join us as a Technician Partner? Apply here" link straight to `/careers` — which is a separate route the Maintenance Mode switch never touches, so applications can still be submitted the entire time.
- **Admin → Pricing filters fixed** — selecting a specific city or appliance used to snap back to "All Cities/All Appliances" immediately; the dropdown rebuild no longer wipes your selection.
- **Coupon/referral code is now shown on the homepage** in a banner (pulled live from Admin → Coupons), instead of being hidden until a customer had already added an item to their cart.
- **Time Slots can now be blocked per appliance**, not just per city — e.g. block AC bookings in a city/date/slot while Washing Machine bookings in that same slot stay open.
- **Footer "Services" links actually change the selected appliance** in the booking form now (they used to just scroll down without selecting anything).
- **Fewer duplicate "Book" buttons** — removed the redundant Book links from the footer's Quick Links (Header, Hero, Price Calculator and the final CTA banner remain).
- **Admin → Customers → "+ Add New Customer"** lets you manually register a customer's account (e.g. right after a phone call) even before they have a real booking.
- **Sub-Admin logins** — Admin → Sub-Admins lets you create limited staff accounts that log in separately at `/subadmin` and can only assign technicians, manage time slots, and add new customers (nothing else Admin-only).
- **Admin → Career Applications → "Make Partner"** pre-fills the Add Technician form from an applicant's details, so turning an applicant into an active technician takes one click instead of re-typing everything.
- **Admin → Technicians table now shows each technician's field** (which appliances they work on — AC, Washing Machine, RO, Fridge) as a "Field (Appliances)" column — this data was already being collected via Specialities when adding/editing a technician, but was never actually displayed in the list. Also added to the CSV ranking export.
- Assign-technician dropdowns (Admin & Sub-Admin) now also show each technician's years of experience.
- **New: "🎁 Refer & Earn" program** — a real referral system, not just a static code:
  - On the homepage (new "Refer & Earn" section, plus a nav link) a customer enters their own mobile number and instantly gets a personal link like `https://yoursite.com/?ref=SEERUA1111UJ` (auto-generated, no admin setup needed per customer).
  - **Sharing**: a "📋 Copy" button and a "💬 Share on WhatsApp" button (pre-filled message + link, opens WhatsApp directly) are right next to the link — this answers "referral link kaise jayega": customer taps Share, picks a contact/group in WhatsApp, done.
  - When someone opens that link, the site shows them a banner ("🎉 Referred by X — you'll get ₹100 off your first booking!") and the discount is applied automatically when they book — no code to type in.
  - The discount only works on that person's **first-ever booking** (checked server-side against past bookings), and a customer can't use their own link on themselves.
  - The **referrer only gets their reward after the referred person's booking is marked "Completed"** by the technician — not at booking time — so it can't be gamed with fake/cancelled bookings. The reward is a coupon (default ₹100 off) tied to the referrer's own phone number only (can't be shared/resold).
  - The homepage section also shows the customer their own stats — how many people they've referred, how many are still pending completion, and their earned reward coupons.
  - **Admin → 🎁 Refer & Earn** — a new panel to configure the discount amount, reward amount, and reward coupon validity (days), turn the whole program on/off, and see every referral (who referred whom, which booking, and reward status) in one table.
- **New: SMS / WhatsApp booking confirmation** — Admin → 🔔 Notifications lets you turn on an automatic SMS and/or WhatsApp message to the customer the moment their booking is confirmed (name, Booking ID, visit date & slot, total amount).
  - Uses **MSG91** — the same service already used for OTP on this site — so no new vendor account is needed if you already have MSG91 set up; you just add your AuthKey, an SMS Template ID + Sender ID (SMS needs DLT registration in India), and a WhatsApp Business number + approved template name (for WhatsApp).
  - Both channels are **off by default** and completely optional — leave them off and nothing changes. If a message ever fails to send (wrong credentials, MSG91 down, etc.) the booking itself is never affected — it always completes normally either way.
  - A **"Send Test Message"** button lets you test your MSG91 setup on your own number and see per-channel success/failure before relying on it for real customers.
- **New: Customer-facing site redesigned to look more like an established platform:**
  - Hero section now has a subtle decorative background and a floating stats card (cities served, appliance categories, rating, same-day service) that overlaps the hero's bottom edge.
  - **The star rating shown in the hero and stats card is real, not made up.** By default it's computed live from the actual star ratings customers leave on "Track Order → Rate this service" (a new `GET /api/stats/public` endpoint). Until there's at least one real rating, the site does **not** show a fake number at all — both spots quietly show "✔ Verified Technicians" instead.
  - **New: Admin → ⭐ Site Rating.** Shows your real, live, uneditable booking rating side by side with an optional Google rating field — since a Google rating (independently verified by Google) is generally trusted more by new visitors than a number a site shows about itself. Enter your current Google rating, review count, and a link to your Google Business listing; the homepage then shows that instead, and the number is clickable straight through to your real Google listing so anyone can verify it. This doesn't auto-sync with Google (no API key or billing needed) — refresh it yourself whenever your Google rating changes.
  - Service cards (AC/Washing Machine/RO/Fridge) now have colour-coded gradient icons, a stronger hover lift, and an animated arrow on "Book Now".
  - **New "We repair and service every major brand" section** — a clean badge row (LG, Samsung, Voltas, Whirlpool, IFB, Godrej, Haier, Bosch, Panasonic, Blue Star, Daikin, Kent).
  - "How it works" is now a connected 3-step timeline with numbered circular badges instead of plain text.
  - "Why choose us" items are now proper cards with icons, shadows and hover-lift instead of plain text blocks.
  - **New Testimonials section** — shows real customer reviews (star rating, quote, avatar, name, city) once at least 3 exist. **Update:** this section now stays completely hidden (not even placeholder/sample cards) until there are 3 real reviews — nothing fake is ever shown, same "no made-up data" rule used everywhere else on the site. It appears automatically the moment enough real reviews come in from "Track Order → Rate this service."
  - Every major section now gently fades/slides into view as you scroll (a small, tasteful animation used across big platforms — respects "reduce motion" settings for accessibility).
  - **New sticky bottom action bar on mobile** (Call + Book Now) so booking is always one tap away on a phone, without hunting for a button.
  - Removed a leftover duplicate "Careers" entry from the header (it appeared as both a nav link and a separate button) and a redundant "Book" nav link, so the header no longer crowds out and truncates the site name on smaller desktop widths.
  - City landing pages (`/appliance-repair/:city`) got the same header cleanup, plus the same colourful service cards, "Why choose us" cards, and scroll-fade polish — including a layout fix so the 4-item "Why choose us" row on city pages no longer leaves an orphaned card on its own line.
- **New: Brand accent colour changed from orange/yellow to sky blue** — every button, badge, price highlight, icon, and active-state colour across the customer site, Admin Panel, Technician Panel, and Sub-Admin Panel now uses a single consistent sky blue (`#0ea5e9`) instead of orange, pairing cleanly with the site's existing navy blue while staying visually distinct from it. This was a full site-wide swap (not just one page), done through the site's central colour variables so every screen stays consistent.
- **New: Technician rating is now broken down per appliance, not just one blended number** — a technician who's great at AC but new to Fridge repairs no longer gets one average rating that hides that. Admin → Technicians now shows each technician's rating **next to each appliance chip** (e.g. "AC ⭐4.8", "Fridge" if not yet rated for that appliance), alongside their overall rating.
  - **Admin → Orders → Assign Technician** now ranks and labels each eligible technician by their rating **for that specific appliance** first (e.g. "⭐4.8 for Washing Machine (12 jobs), overall ⭐4.3") — so the person you assign is picked based on how they've actually performed on that exact kind of job, not a blended score from every appliance they service.
  - The Technicians CSV export ("Export Ranking") now includes a "Rating by Appliance" column with the same per-appliance breakdown for offline review.
  - **Technicians can now see this too** — a new "⭐ My Rating" tab in the Technician Panel shows their own overall rating plus the same per-appliance breakdown (rating, rated jobs, completed jobs) that Admin uses to decide assignments, so they know exactly where they stand.
- **New: One-click "⚡ Auto-Assign Best" in Admin → Orders / Bookings** — instantly assigns the top-ranked eligible technician for that exact appliance (same ranking used in the manual Assign dropdown) without opening the Assign modal. Shows a confirmation with the technician's name and appliance-specific rating before assigning, and clearly says so if no eligible technician exists (so it never silently assigns the wrong person).
- **New: Real customer reviews replace the sample testimonials once there are enough of them** — customers can now add an optional short text review alongside their star rating on "Track Order → Rate this service" (max 280 characters, sanitized against unsafe input). Once at least 3 real reviews exist, the homepage automatically swaps its "Sample reviews" testimonial cards for real ones (rating, quote, first name + last initial, city, appliance) — below that threshold the honest, clearly-labelled sample cards stay, same "don't show fake data" principle used everywhere else on the site.
- **New: "Rating by Appliance (site-wide)" table in Admin → Analytics** — shows the average customer rating for each appliance category (AC, Washing Machine, RO, Fridge) across all technicians combined, so a whole service line that's underperforming (not just one technician) is easy to spot.
- **New: Technician Online/Offline status** — Admin → Technicians now has a "Live" column showing 🟢 Online (their Technician Panel is currently open and has checked in within the last ~90 seconds) or ⚪ Offline · last seen X ago. This is separate from the existing Active/Inactive toggle — Active/Inactive is whether Admin has enabled their account at all, Online/Offline is whether they're actually at their phone right now. The same live status is also shown in the Assign Technician dropdown (Admin and Sub-Admin both) so you can factor in "will they see this job immediately" when assigning, not just their rating.
- **New: Stronger Local SEO** — on top of the per-city SEO pages that already auto-generate/remove as cities are added/deleted:
  - **`robots.txt`** now correctly lists the sitemap and blocks Admin/Technician/Sub-Admin panels and API routes from being indexed.
  - **`og:url`** added to the homepage and every city page (was missing before — needed for correct link previews when shared on WhatsApp/Facebook/etc.).
  - **`sameAs` links to your real Google Business Profile** in the page's structured data, once you've entered it in Admin → Site Rating — helps Google connect your website to your Google listing.
  - **Real star ratings now show in Google's structured data** (`aggregateRating`) — site-wide on the homepage, and scoped to that specific city's own rated jobs on each city page. Only appears once there's at least one real rating for that scope; never a fake number, same rule as everywhere else on the site. This is what can make ⭐ stars show up directly in Google search results.
  - **FAQPage structured data** on the homepage, mirroring the real FAQ content — makes the homepage eligible for Google's expandable FAQ rich results, which take up more space in search results.
  - **BreadcrumbList structured data** (Home → City) on every city page, so Google can show a breadcrumb trail instead of the raw URL in search results.
  - Note: since your address isn't a fixed, stable location (government housing that changes with postings), no street address was added to the schema — that's correct per Google's own guidance for service-area businesses; a fake or unstable address would hurt Local SEO more than help it.
- **New: Max Jobs Per Technician Per Day** — stops one technician getting overloaded and causing delays. Set a site-wide default in Admin → Time Slots ("Max Jobs Per Technician Per Day") — e.g. 5/day — and/or a per-technician override in their Add/Edit form ("Max Jobs Per Day (override)") for a technician who should get more or fewer than the default (their personal number always wins over the site-wide one). Once a technician has reached their limit of jobs on a given date, they're **not removed** from the Assign dropdown or Auto-Assign — they're just pushed to the bottom of the ranking with a clear "⚠️ at daily limit (X/Y jobs on that date)" warning, so Admin/Sub-Admin can still manually assign them if there's truly no one else free. "⚡ Auto-Assign Best" automatically skips at-capacity technicians and picks the best-ranked one who still has room, only falling back to an at-capacity technician (with a warning in the confirmation) if every eligible technician for that appliance/city is already full that day. Leave both the site-wide and per-technician fields blank for no limit at all (the default, so nothing changes unless you set one). Undated/phone-in bookings without a specific visit date are not counted against this limit.
- **New: Admin → Technicians → "👁 Password"** — lets Admin look up a technician's current login password later (e.g. if you've forgotten what you set), with a one-click Copy button. It's a separate on-demand lookup (Admin-only, not Sub-Admin) rather than showing passwords in the main technician list, so a password is only ever fetched when Admin explicitly asks to see that one technician's.
- **New: Simple website chat assistant (💬 bubble on homepage and every city page)** — a menu-driven helper (quick-reply buttons, not free text) that runs entirely on this site's own code and existing APIs, so it costs nothing extra to run (no external AI service). It can: look up the real price for any city + appliance + type combo and jump straight into a pre-filled booking form; open the booking form directly; track an order by phone number and show each item's live status; answer the site's common FAQ; and hand off to a call or WhatsApp chat. On city pages (which don't have the booking form on them) it hands off to the homepage's booking form via the same `?city=&appliance=&type=` link pattern already used elsewhere on the site — the homepage now also picks up a `type=` param the same way it already did for `city=`/`appliance=`.

## 🚀 How to Run the Site (On Your Computer)

1. **Install Node.js** (if you don't already have it): download the LTS version from https://nodejs.org
2. **Unzip** this folder anywhere on your computer.
3. Open a Terminal / Command Prompt and go into the folder:
   ```
   cd seerua-appliance-care
   ```
4. Install the required packages (only needed once):
   ```
   npm install
   ```
5. Start the server:
   ```
   npm start
   ```
6. Open your browser at: **http://localhost:3000**

To stop the server, press `Ctrl + C` in the terminal.

## 🌐 How to Deploy Online

This is a Node.js app, so it can be hosted on any Node.js hosting provider, such as:
- Render.com
- Railway.app
- Hostinger (Node.js hosting plan)
- DigitalOcean / a VPS

When deploying:
1. Upload `package.json` and the entire project.
2. Start command: `npm start`
3. Once your domain is connected, update these with your real domain:
   - `public/robots.txt` (the `Sitemap:` line)
   - `views/index.template.html` (the canonical URL and Open Graph tags near the top)
   - The `SITE_URL` constant near the top of the homepage/city-page routes in `server.js` (used for city page canonical URLs and the sitemap)

## 🔑 Default Login

**Admin Panel** — `/admin`
- Username: `admin`
- Password: `seerua@admin123`

**Technician Panel** — `/technician`
- Phone: `9389585479`
- Password: `tech123`

**Sub-Admin Panel** — `/subadmin`
- No default account — create one from Admin Panel → Sub-Admins first.

⚠️ **Be sure to change these passwords before making the site live.**
The admin password can be changed in the `data/admin.json` file. New technicians can be added only from the Admin Panel.

## 📁 Project Structure

```
seerua-appliance-care/
├── server.js              # Main Express server (all API routes + homepage rendering live here)
├── db.js                  # Simple JSON file database helper
├── package.json
├── views/
│   ├── index.template.html # Homepage template — server.js fills in the live city list here
│   └── city.template.html  # Per-city SEO landing page template — one auto-generated page per city
├── data/                  # All website data is saved here as JSON files
│   ├── cities.json        # Service area cities
│   ├── appliances.json    # Appliances and their types
│   ├── pricing.json       # Price for every city + appliance + type combination
│   ├── technicians.json   # Technician login and details
│   ├── bookings.json      # All customer bookings (each with its own items array)
│   ├── otp-config.json    # MSG91 OTP credentials (keep private)
│   ├── slots-config.json  # Booking time slot capacity and manual blocks
│   ├── coupons.json       # Discount coupon codes
│   ├── technician-applications.json  # Career page job applications
│   └── admin.json         # Admin login credentials
└── public/                # All other frontend pages for the website
    ├── terms.html          # Terms & Conditions
    ├── careers.html         # Technician Partner recruitment page
    ├── admin.html           # Admin Panel
    ├── technician.html      # Technician Panel
    ├── robots.txt
    ├── css/
    └── js/
```

## 🔍 About the Homepage & SEO

The homepage (`/`) is generated by `server.js` from `views/index.template.html` on every request. This means:
- Whenever you add, rename, or remove a city in the Admin Panel, the homepage's SEO content (structured data for Google + the FAQ answer listing service cities) updates **immediately** — no rebuild or restart needed.
- Same for appliances — the footer's Services list updates automatically when you add or remove an appliance category.
- This keeps Google and other search engines showing your current list of service cities, not an outdated one.

## 🏙️ Per-City SEO Pages

Every active city automatically gets its own dedicated page at `/appliance-repair/<city-name>` (e.g. `/appliance-repair/noida`, `/appliance-repair/delhi`) — built live from `views/city.template.html`, `data/cities.json`, and `data/pricing.json`. Each page has:
- A unique title, meta description, and heading naming that city (helps it rank for searches like "AC repair in Noida")
- That city's real, exact prices in a table
- Its own structured data (schema.org) so Google understands it's a location-specific service page
- Links to and from every other city page (internal linking), and a "Book Now" button that jumps straight to the homepage with that city pre-selected in the booking form

**These pages need no manual work to keep in sync:**
- Add a city in the Admin Panel → its page exists immediately.
- Rename a city → its page URL and content update immediately.
- Delete or deactivate a city → its page returns a 404 immediately.
- The sitemap at `/sitemap.xml` is also generated live and always lists exactly the cities that are currently active — nothing to regenerate by hand.

## ⭐ Technician Ranking

Every technician builds a track record automatically:
- **Completed jobs** and **rejected jobs** are counted from real booking activity — no manual entry needed.
- After a job is marked completed, the Admin can rate it 1–5 stars from the Orders page (a dropdown appears right on the completed item).
- A technician's **average rating** is calculated from all their rated jobs.

The **Technicians page always lists technicians best-first** (highest rating → most completed jobs → fewest rejections), and the **Assign Technician** dropdown shows the same ranking (e.g. "Ramesh Kumar — ⭐4.8, 23 jobs done") for every eligible technician — so it's easy to pick the best-suited person for the job, while final choice always stays with the Admin.

## 📊 Excel/CSV Exports

Three places to download real work data as a spreadsheet (CSV opens directly in Excel, Google Sheets, or Numbers):
- **Admin → Daily Report → Export to Excel (CSV)** — every completed item for the selected date, with customer, appliance, technician, price, and rating.
- **Technician Panel → Today's Summary → Export to Excel (CSV)** — a technician's own day, for their personal records.
- **Admin → Technicians → Export Ranking (CSV)** — every technician's full performance stats (experience, jobs completed/rejected, rating, revenue generated) in one file.

## 🔔 Job Alerts for Technicians

When a technician opens their panel and taps **"Enable Job Alerts"**, the browser asks for notification permission. From then on, while their panel tab stays open:
- The app checks for newly assigned jobs every 25 seconds.
- A short beep plays and a browser notification appears the moment a new job is assigned to them.

**Important limitation:** this only works while the technician's browser tab is open (it's a website, not a phone app) — it will not reach them if their phone is locked or the tab is closed. For a true "always reaches their phone" alert (SMS or push notification even when the app is closed), you'd need to either send an SMS through your MSG91 account for each new assignment (extra cost per message, and a separate template/route to set up) or build this into a proper mobile app with push notifications — both bigger additions than this. Let me know if you'd like either built next.

## 🪪 Technician KYC (Experience & ID Proof)

When adding or editing a technician, you can record their **years of experience** and basic **ID verification details** (ID type: Aadhar / PAN / Driving License / Voter ID, plus an ID number field).

⚠️ **Privacy note:** Indian law restricts private businesses from storing full Aadhar numbers without special authorization from UIDAI. The form includes a reminder to store only a masked reference (e.g. the last 4 digits, like `XXXX-XXXX-1234`) rather than the complete number — the Admin Panel also displays ID numbers masked automatically. Use PAN, Driving License, or Voter ID instead of Aadhar where possible, as these carry fewer restrictions.

## 🎟️ Coupons

Admin → Coupons lets you create discount codes — flat amount (₹) or percentage off — with optional rules: minimum order value, a total usage cap, an expiry date, and whether each customer can use it only once. A `SAVE50` coupon (₹50 off, ₹200 minimum order) is included by default.

On the booking form, customers enter a code and tap **Apply** to see the discount instantly before they confirm. The discount is re-validated independently on the server when the booking is actually created — so a discount amount typed in the browser can never be trusted or forged; the server always recomputes it from the coupon's real rules.

## 📈 Analytics Dashboard

Admin → Analytics gives a real-time picture of the business: total and this-month revenue, average order value, total discounts given, revenue by city, bookings by appliance, a 14-day revenue trend, the current mix of order statuses, and a top-5 technician leaderboard. Everything is computed live from actual bookings — nothing needs to be manually entered or refreshed by hand.

## 🧑‍🔧 Careers — Recruiting Technician Partners

A public page at `/careers` (also linked in the footer) lets prospective technicians apply to work with you: name, address, mobile number, city, the appliances they can repair, years of experience, and any notes. No login needed — anyone can apply.

Every application lands in **Admin → Career Applications**, filterable by status (New / Contacted / Hired / Rejected) and by city. So when you need an experienced technician in a particular city, you already have a ready pool of applicants to check — no separate hiring channel required. Once you decide to bring someone on, just add them for real from **Admin → Technicians** using the same details.

## 🕒 Booking Time Slots

Every booking now includes a date and one of three fixed visit slots: **8:00 AM–11:00 AM**, **12:00 PM–3:00 PM**, and **4:00 PM–7:00 PM**. Availability is tracked per date and per city, and controlled two ways from **Admin → Time Slots**:

- **Auto-control (capacity):** set a max number of bookings allowed per slot (e.g. 5). Once that many bookings exist for a date + city + slot, it automatically shows as "Full" to customers — no manual work needed.
- **Manual control:** block a specific date + slot + city outright (e.g. a public holiday, or a technician on leave that day), even if it hasn't reached capacity yet.

The booking form shows live availability the moment a customer picks a city and date, and won't let them select a full or blocked slot. The server independently re-checks availability when the booking is submitted, so two customers can't both grab the last spot in a slot at the same time.

Phone-call bookings created by the Admin can optionally include a date/slot too, but Admin is allowed to knowingly overbook a slot for a phone customer (the capacity check is skipped for Admin-created bookings, since it's a deliberate choice).

## ⭐ Customer Ratings

Once a service is marked completed, the customer can rate it themselves from the **Track Order** section — no login needed, just their phone number (the same one used to look up the booking, which also verifies it's really their booking). Ratings feed into the same technician ranking system the Admin sees, and each rating is labeled as "by customer" or "by admin" so it's clear who gave it.

## 🛠️ Maintenance Mode

If the site has an issue, needs fixes, or you just want it briefly offline, go to the **Dashboard** and flip the **"Site Maintenance Mode"** switch. While it's on:
- The homepage and every city page show a friendly "We'll be right back" notice (with your logo, a custom message you control, and Call/WhatsApp buttons) instead of the normal site.
- New bookings can't be submitted (the booking API itself is blocked, not just hidden in the UI).
- The **Admin Panel and Technician Panel stay fully working** the whole time — so you can keep managing existing orders and turn maintenance mode back off the moment things are fixed.

Turning it off instantly restores the normal site — no restart needed.

## 📞 Registering a Phone-Call Booking (Admin)

Not every customer books online — some call or message directly. On the Orders page, tap **"New Booking (Phone Call)"** to register their booking yourself: name, phone, address, city, and appliances, exactly like the customer-facing form, but without needing OTP (since you're already logged in as Admin). It's saved and searchable exactly like any other booking — findable later by the customer's phone number in Track Order, the Customer ledger, and Orders search. Each booking's source (Online vs Phone) is shown as a small badge in the Orders table.

## 🛒 Multiple Appliances, Multiple Technicians in One Booking

Customers can book more than one appliance in a single order — for example, 2 Window ACs and 1 Washing Machine together. On the booking form, they pick a city, then add each appliance one at a time (appliance, type, service/repair, quantity, and an optional note) to a running cart, see the live total, and submit everything as one booking.

**Each appliance in that booking is assigned and tracked completely independently:**
- The Admin can assign a **different technician to each item** — e.g. one technician handles the AC, a different one handles the Washing Machine, each visiting on their own schedule.
- Every item has its own status (pending → assigned → accepted → in-progress → completed), its own technician, and its own progress report.
- The technician panel shows each assigned item as a separate task, so a technician only ever sees the work that's actually theirs.
- Daily reports and revenue are calculated per completed item, not per whole booking, so numbers stay accurate even when a booking is only partially finished.

### No-override technician matching

When assigning a technician to an item, the Admin Panel only shows technicians who are **based in that exact city AND have that exact appliance listed as a speciality**. If nobody matches, the dropdown shows "No eligible technician" and the Assign button is disabled — there is no way to force an assignment, from the UI or by calling the API directly. The server itself rejects any assignment that doesn't fully match, so this rule can't be bypassed even by mistake.

If this happens often, it usually means you need to either add a technician for that city/appliance combination, or update an existing technician's **City** or **Specialities** from Admin Panel → Technicians → Edit.

## 🔒 OTP Verification on Every Booking (Fraud Prevention)

To stop fake or prank bookings, the customer's phone number must be verified with a real OTP (powered by MSG91) **at the moment they submit the booking form** — not through a separate login step that could be skipped.

How it works:
1. Customer fills in the booking form (city, appliances, name, phone, address) and taps **"Verify OTP & Confirm Booking"**.
2. The MSG91 widget opens right there and sends an OTP by SMS to the number they entered.
3. Once they enter the correct OTP, the widget hands back a verification token.
4. That token is sent to our server along with the booking — and our server independently re-checks it with MSG91 using our secret AuthKey (`data/otp-config.json`) before the booking is saved.
5. If the OTP was never verified, or the token doesn't check out, the booking is rejected outright (this is enforced in `server.js`, not just in the browser, so it can't be bypassed).

There's no separate "create an account" step — verification happens right where it matters, at the point of booking. Customers can still check the status of any past order any time from the "Track Order" section using just their phone number (read-only, no OTP needed for that), and can tap **"↻ Book Again"** there to instantly refill the booking form with their saved details.

### OTP configuration
- `data/otp-config.json` holds the MSG91 **AuthKey** (secret, server-side only), **Widget ID**, and **Token Auth** (safe to expose to the browser, used by the client-side widget).
- If you ever regenerate these in your MSG91 dashboard, just update this file — no code changes needed.
- ⚠️ Keep `data/otp-config.json` private. Never commit it to a public repository or share the `authkey` value.
- This sandbox environment has no internet access, so the live MSG91 verification call could not be fully tested end-to-end here (the booking-blocking logic itself was tested and works correctly). Please test the full OTP flow once the site is deployed with real internet access, and let me know if MSG91's response format needs any adjustment on the server side (in `server.js`, inside the `verifyOtpAccessToken` function).
- The phone number sent to the widget always includes the `91` country code with no `+` or spaces (e.g. `919389585479`), per MSG91's documented format — this avoids the widget defaulting to the wrong number. If you still see the OTP widget substituting a different number than what the customer typed, please double check nothing else on the page is auto-filling the phone field (some mobile browsers offer saved-number suggestions) and let me know what you see.

## 🛡️ Service Guarantee

Every booking includes a 1-month (30-day) service guarantee, shown on the homepage price calculator and detailed in the Terms & Conditions page.

## ✅ What You Can Do From the Admin Panel

- Add/delete/activate-deactivate cities
- Add/delete appliances and their types (e.g. AC → Window/Split/Cassette)
- Set Service and Repair prices for every city + appliance + type combination
- Add/delete technicians, and edit their city and specialities at any time
- View all bookings, and assign a technician to each appliance individually (only fully-matching technicians can be assigned — see above)
- Customer ledger — view any customer's complete past record
- Daily report — see the day's bookings, completed items and revenue

## 🧑‍🔧 What You Can Do From the Technician Panel

- View tasks assigned to you (one per appliance, even across different bookings)
- Accept or reject a task
- Start the job, write a progress report, and mark it as completed
- View a daily summary of your own work (tasks completed, earnings)

## 📝 Important Notes

- Data is stored in JSON files (in the `data/` folder) — no separate database setup is required.
- For a live/production site, it's a good idea to regularly back up the `data/` folder.
- The WhatsApp number and email can be updated in `data/admin.json` and in the HTML files.
- The logo is located at `public/images/logo.png` — to change it, simply replace it with a new file of the same name.

For any questions: WhatsApp **9389585479** or email **b4india@gmail.com**
