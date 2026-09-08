// ------------------------------------------------------------------
// Seerua Appliance Care — customer site logic
// ------------------------------------------------------------------
let BOOKING_PAUSED_STATUS = null; // set once at page load from /api/booking-status; checked by openQuickBookModal() too, so a paused booking is caught right when someone tries to start, not just deep in the old checkout form
document.getElementById('year').textContent = new Date().getFullYear();

// Mobile nav toggle
// FLOW CHANGE: there used to be two separate ways to open essentially
// the same menu — a hamburger up in the header, and this bottom-nav
// "Menu" button. Consolidated down to just this one: it's the
// thumb-reachable option, consistent with the rest of this bottom-nav
// bar (Home/City/Cart/Menu), and matches app-style navigation the site
// already leans on elsewhere. The header hamburger button and its
// #navLinks dropdown are gone from the template — on desktop the same
// Services/FAQ/Careers links show directly in the header with no
// toggle needed either way.
// BUG FIX: "Menu" and "City" further down were both fully built out in
// the HTML (their own bottom sheets) but never actually wired up to
// open anything at all. Fixed here.

function openBottomSheet(id) {
  document.querySelectorAll('.bottom-sheet-backdrop.open').forEach(el => el.classList.remove('open'));
  const sheet = document.getElementById(id);
  if (sheet) sheet.classList.add('open');
}
function closeBottomSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet) sheet.classList.remove('open');
}
function bindBottomSheet(id) {
  const backdrop = document.getElementById(id);
  if (!backdrop) return;
  // Tapping the dark backdrop itself (not the white sheet panel) closes it.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeBottomSheet(id);
  });
  // Any actual link/option inside the sheet closes it once tapped — the
  // navigation itself is the dismissal.
  backdrop.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('click', () => closeBottomSheet(id));
  });
}
['menuSheetBackdrop', 'citySheetBackdrop', 'supportSheetBackdrop'].forEach(bindBottomSheet);

const bottomNavMenuBtn = document.getElementById('bottomNavMenuBtn');
if (bottomNavMenuBtn) bottomNavMenuBtn.addEventListener('click', () => openBottomSheet('menuSheetBackdrop'));

const bottomNavCityBtn = document.getElementById('bottomNavCityBtn');
if (bottomNavCityBtn) {
  bottomNavCityBtn.addEventListener('click', () => {
    const grid = document.getElementById('bottomSheetCityGrid');
    if (grid && !grid.children.length && typeof CITIES !== 'undefined') {
      grid.innerHTML = CITIES.map(c => `<a href="/appliance-repair/${slugify(c.name)}" class="bottom-sheet-city-btn">${c.name}</a>`).join('');
    }
    openBottomSheet('citySheetBackdrop');
  });
}

// Custom line icons (white strokes, sit on the .service-icon's gradient
// circle) instead of emoji — emoji render inconsistently across devices
// and read as an unstyled placeholder rather than a designed icon set.
const ICONS = {
  snowflake: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="9" rx="2.5"/><circle cx="7.5" cy="9.5" r="1" fill="#fff" stroke="none"/><path d="M4 18c1.2-1.6 2.4-1.6 3.6 0M9.6 18c1.2-1.6 2.4-1.6 3.6 0M15.2 18c1.2-1.6 2.4-1.6 3.6 0"/></svg>',
  washer: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3" width="17" height="18" rx="2.5"/><circle cx="6.5" cy="6" r="0.4" fill="#fff" stroke="none"/><circle cx="9" cy="6" r="0.4" fill="#fff" stroke="none"/><circle cx="12" cy="14" r="5"/><circle cx="12" cy="14" r="2.1"/></svg>',
  droplet: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.4 4 6 7.4 6 10.8a6 6 0 1 1-12 0c0-3.4 2.6-6.8 6-10.8Z"/><path d="M9.3 15.3c0 1.5 1.2 2.5 2.5 2.6"/></svg>',
  fridge: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2.2"/><line x1="5" y1="9.5" x2="19" y2="9.5"/><line x1="8.2" y1="4.8" x2="8.2" y2="7.2"/><line x1="8.2" y1="12" x2="8.2" y2="15"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 4.9L3 17.5 6.5 21l6.3-6.3a4 4 0 0 0 4.9-5.4l-2.8 2.8-2.4-2.4 2.8-2.8Z"/></svg>'
};

let CITIES = [];
let CAREER_CITIES = []; // separate, admin-managed list for the Careers modal's city dropdown — independent of the main service-area Cities list
let CAREER_APPLIANCES = []; // separate, admin-managed list for the Careers modal's appliance checkboxes — independent of the main service Appliances list
let ALL_APPLIANCES = []; // full list — used for the general "what we offer" grid, not tied to any one city
let APPLIANCES = [];     // the list actually selectable in the booking form — filtered to the chosen city once one is picked
let EDUCATION_LEVELS = []; // options for the Careers form's education dropdown — admin-managed, same pattern as Cities
let selectedService = 'service';
let incomingReferralCode = null; // set from ?ref= in the URL, sent along with the booking

// Booking form is hidden until the person taps a "Book Now" button in the
// header or the mobile sticky bar. Every such link points to #book —
// instead of letting the browser jump there directly, we intercept those
// clicks so the form is revealed first, then scroll to it.
function openBookingForm() {
  // The header's own "Book Now" button sits next to the hamburger menu,
  // not inside it — so if the mobile nav menu was left open, tapping it
  // would scroll to the booking form while that menu's fixed white panel
  // stayed open on top, hiding the form behind it. Always close the menu
  // here so that can't happen, no matter which "Book Now" was tapped.
  const wrap = document.getElementById('bookingWrap');
  if (wrap) wrap.hidden = false;
  const section = document.getElementById('book');
  if (section) section.scrollIntoView({ behavior: 'smooth' });
  // Reset to the full form by default — see hideRedundantBookingFields()
  // for where/why these get hidden again for the Quick Book shortcut.
  const cityField = document.getElementById('fCityField');
  if (cityField) cityField.style.display = '';
  const addBox = document.querySelector('.cart-add-box');
  if (addBox) addBox.style.display = '';
}

// Collapses the form again — used once a booking is successfully placed.
function closeBookingForm() {
  const wrap = document.getElementById('bookingWrap');
  if (wrap) wrap.hidden = true;
}

// My History (order tracking + referral) is hidden until the person taps
// "Track" or "My Booking" in the nav/footer — every such link points to
// #track, intercepted the same way as the booking form's #book links.
function openTrackHistory(skipScroll) {
  const wrap = document.getElementById('trackWrap');
  if (wrap) wrap.hidden = false;
  if (skipScroll) return;
  const section = document.getElementById('track');
  if (section) section.scrollIntoView({ behavior: 'smooth' });
}

// FLOW CHANGE: both "My Account" and every "Book Now" (#book) link now
// funnel through the same shared Account Gate first (Mobile → OTP →
// Add Address) instead of opening their section directly — see
// openAccountGate() below. A customer who already has a saved account
// skips straight through with no extra steps.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href="#track"]');
  if (link) {
    e.preventDefault();
    openAccountGate('account');
  }
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href="#book"]');
  if (link) {
    e.preventDefault();
    openAccountGate('booking');
  }
});

// Arriving from a city/SEO page's "Book Now", the chat assistant, or a
// "rate your service" WhatsApp/SMS link (?trackPhone=...) all land here
// with a #book/#track hash or query param already in the URL. Reveals
// the relevant section right away (so it's not sitting empty while data
// loads), but the actual scroll is deferred until init() has finished
// fetching data and rendering everything above it — otherwise the page's
// height is still changing as content loads in, and a scroll started
// too early ends up pointed at whatever content happened to land there
// once the page settles, not the form itself.
function bindUrlTriggeredSections() {
  const trackPhoneParam = new URLSearchParams(window.location.search).get('trackPhone');
  if (trackPhoneParam && /^[0-9]{10}$/.test(trackPhoneParam)) {
    const input = document.getElementById('trackPhone');
    if (input) {
      input.value = trackPhoneParam;
      const btn = document.getElementById('trackBtn');
      if (btn) btn.click(); // opens the Track Booking popup directly
    }
  }
  if (window.location.hash === '#book') {
    document.getElementById('book').scrollIntoView({ behavior: 'smooth' });
  }
}
// A #track/#book link followed from outside the page (e.g. an SMS/WhatsApp
// link, or a bookmark) goes through the same Account Gate as an in-page
// click — trackPhone param is the one exception, since that link already
// carries a known phone number (e.g. a "rate your service" link) rather
// than asking the person to prove who they are again.
if (new URLSearchParams(window.location.search).get('trackPhone')) {
  // handled by bindUrlTriggeredSections() once init() finishes loading
} else if (window.location.hash === '#track') {
  openAccountGate('account');
} else if (window.location.hash === '#book') {
  openAccountGate('booking');
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// Used whenever customer-typed free text (a review, etc.) is inserted into
// the page, so it's shown as plain text and can't break out of the HTML.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Turns the Admin-written "what we do during service" text (plain text,
// blank line between paragraphs) into safe HTML paragraphs. Mirrors
// formatServiceProcessHtml() in server.js, which does the same for the
// server-rendered city pages.
function formatServiceProcessHtml(text) {
  const t = (text || '').trim();
  if (!t) return '';
  return t.split(/\n\s*\n/).map(p => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

// Joins names the natural way: "AC", "AC and Fridge", "AC, Fridge and RO".
function joinWithAnd(names) {
  if (names.length === 0) return 'every essential home appliance';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// Updates the "From AC to fridge..." line under the Services heading to
// name the appliances currently offered — stays in sync automatically as
// Admin adds/removes appliances. Kept in English regardless of the EN/HI
// toggle, same as the rest of this live-data content (see i18n.js).
function renderServicesSubText() {
  const el = document.getElementById('servicesSubText');
  if (!el) return;
  const names = ALL_APPLIANCES.map(a => a.name);
  el.textContent = `From ${joinWithAnd(names)}, repair and service for every essential home appliance.`;
}

// Renders the "Appliance care, explained" homepage section from each
// appliance's aboutText (Admin panel → Appliances & Types). Only appliances
// that currently exist AND have text written for them get a block — so
// adding/deleting an appliance in Admin automatically adds/removes its
// block here too, no code changes needed.
function renderServiceDetails() {
  const section = document.getElementById('serviceDetails');
  const list = document.getElementById('serviceDetailsList');
  if (!section || !list) return;
  const withText = ALL_APPLIANCES.filter(a => (a.aboutText || '').trim());
  if (!withText.length) {
    section.style.display = 'none';
    return;
  }
  list.innerHTML = withText.map(a => `
    <div>
      <h3 class="appliance-detail-title">${escapeHtml(a.name)} Service</h3>
      <div class="appliance-detail-text">${formatServiceProcessHtml(a.aboutText)}</div>
    </div>
  `).join('');
  section.style.display = '';
}

function populateSelect(el, items, placeholder) {
  el.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    opt.disabled = true;
    opt.selected = true;
    el.appendChild(opt);
  }
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name;
    el.appendChild(opt);
  });
}

// Keeps the booking form's appliance dropdown in sync with the selected
// city — any appliance an Admin has disabled for that city is left out
// entirely, so it can't be picked (and won't silently 404 on price lookup).
// With no city chosen yet, falls back to the full list.
async function refreshAppliancesForCity(cityId) {
  if (cityId) {
    try {
      APPLIANCES = await fetchJSON(`/api/appliances?cityId=${cityId}`);
    } catch (e) {
      APPLIANCES = ALL_APPLIANCES;
    }
  } else {
    APPLIANCES = ALL_APPLIANCES;
  }
  const currentApplianceId = document.getElementById('fAppliance').value;
  populateSelect(document.getElementById('fAppliance'), APPLIANCES, 'Select appliance');
  if (currentApplianceId && APPLIANCES.some(a => a.id === currentApplianceId)) {
    document.getElementById('fAppliance').value = currentApplianceId;
  }
  refreshFormTypes();
}

async function init() {
  loadCartFromStorage();
  try {
    CITIES = await fetchJSON('/api/cities');
    CAREER_CITIES = await fetchJSON('/api/career-cities');
    CAREER_APPLIANCES = await fetchJSON('/api/career-appliances');
    ALL_APPLIANCES = await fetchJSON('/api/appliances');
    APPLIANCES = ALL_APPLIANCES;
    EDUCATION_LEVELS = await fetchJSON('/api/education-levels');
  } catch (e) {
    console.error(e);
    return;
  }

  // Booking form selects
  populateSelect(document.getElementById('fCity'), CITIES, 'Select city');
  populateSelect(document.getElementById('fAppliance'), APPLIANCES, 'Select appliance');
  refreshFormTypes();
  renderServiceDetails();
  renderServicesSubText();

  // Pre-select city/appliance/type if arriving from a city-specific SEO page,
  // a footer/service link, or the chat assistant's price lookup
  // (e.g. /?city=c1&appliance=a1&type=t1)
  const urlParams = new URLSearchParams(window.location.search);
  const urlCityId = urlParams.get('city');
  const urlApplianceId = urlParams.get('appliance');
  const urlTypeId = urlParams.get('type');
  if (urlCityId && CITIES.some(c => c.id === urlCityId)) {
    document.getElementById('fCity').value = urlCityId;
    await refreshAppliancesForCity(urlCityId);
  }
  if (urlApplianceId && APPLIANCES.some(a => a.id === urlApplianceId)) {
    document.getElementById('fAppliance').value = urlApplianceId;
  }
  refreshFormTypes();
  if (urlTypeId) {
    const appliance = APPLIANCES.find(a => a.id === urlApplianceId);
    if (appliance && appliance.types.some(t => t.id === urlTypeId)) {
      document.getElementById('fType').value = urlTypeId;
    }
  }

  // Services grid
  renderServicesGrid();
  bindFooterApplianceLinks();

  // City chips — link each to its own SEO landing page
  const chipRow = document.getElementById('cityChipRow');
  chipRow.innerHTML = CITIES.map(c => `<a href="/appliance-repair/${slugify(c.name)}" class="city-chip">${c.name}</a>`).join('');

  loadPublicStats();
  loadPublicReviews();
  bindCareersModal();
  bindReferralSection();
  checkIncomingReferral();
  autoOpenBookingFromUrlParams();
  bindScrollReveal();

  bindFormEvents();
  bindBottomNav();
  if (cartItems.length) renderCart();

  // Now that every section above has finished rendering (services grid,
  // city chips, stats, reviews, etc.), it's safe to scroll to whichever
  // section the URL asked for — see bindUrlTriggeredSections() for why
  // this can't happen any earlier.
  bindUrlTriggeredSections();

  // SUGGESTION IMPLEMENTED: checked in its own try/catch, separately from
  // the critical data above — if this one fetch fails for any reason, the
  // booking form just stays in its normal (open) state rather than
  // breaking page load entirely.
  try {
    BOOKING_PAUSED_STATUS = await fetchJSON('/api/booking-status');
    applyBookingPausedStatus(BOOKING_PAUSED_STATUS);
  } catch (e) {
    console.error('Could not check booking-paused status:', e);
  }
}

// SUGGESTION IMPLEMENTED: when Admin has paused new bookings (e.g. "not
// enough technicians right now"), the form is replaced with a friendly
// notice instead — everything else on the site (SEO pages, careers,
// browsing appliances/pricing) stays exactly as normal, unlike
// Maintenance Mode which would take the whole site down and actively
// hurt the Google ranking / hiring this is meant to protect.
function applyBookingPausedStatus(status) {
  const form = document.getElementById('bookingForm');
  const notice = document.getElementById('bookingPausedNotice');
  if (!form || !notice) return;
  if (status && status.bookingPaused) {
    form.hidden = true;
    notice.hidden = false;
    if (status.bookingPausedMessage) {
      document.getElementById('bookingPausedMessageText').textContent = status.bookingPausedMessage;
    }
  } else {
    form.hidden = false;
    notice.hidden = true;
  }
}

// Shows a real rating in the hero and stats strip — never a hardcoded
// number. Prefers Admin's Google rating when it's turned on (independently
// verified by Google, generally trusted more by new visitors, and linked
// straight to the real listing so anyone can check it themselves);
// otherwise falls back to the rating computed live from this site's own
// "Rate this service" data. If neither exists yet, both spots quietly stay
// on their honest, evergreen fallback ("✔ Verified Technicians").
let GOOGLE_REVIEW_URL = null;

async function loadPublicStats() {
  try {
    const stats = await fetchJSON('/api/stats/public');
    const heroRating = document.getElementById('heroRating');
    const statValue = document.getElementById('statRatingValue');
    const statLabel = document.getElementById('statRatingLabel');

    if (stats.googleRating) {
      const g = stats.googleRating;
      GOOGLE_REVIEW_URL = g.profileUrl;
      const reviewWord = g.reviewCount === 1 ? 'review' : 'reviews';
      if (heroRating) {
        document.getElementById('heroRatingText').innerHTML =
          `<a href="${g.profileUrl}" target="_blank" rel="noopener" style="color:inherit;">${g.rating}/5 on Google · ${g.reviewCount} ${reviewWord}</a>`;
        heroRating.style.display = 'inline-flex';
      }
      if (statValue && statLabel) {
        statValue.textContent = `${g.rating}★`;
        statLabel.innerHTML = `<a href="${g.profileUrl}" target="_blank" rel="noopener" style="color:inherit;">${g.reviewCount} Google ${reviewWord}</a>`;
      }
      return;
    }

    if (!stats.avgRating || !stats.ratingCount) return;
    const reviewWord = stats.ratingCount === 1 ? 'review' : 'reviews';
    if (heroRating) {
      document.getElementById('heroRatingText').textContent = `${stats.avgRating}/5 rated service · ${stats.ratingCount} ${reviewWord}`;
      heroRating.style.display = 'inline-flex';
    }
    if (statValue && statLabel) {
      statValue.textContent = `${stats.avgRating}★`;
      statLabel.textContent = `${stats.ratingCount} ${reviewWord}`;
    }
  } catch (e) {
    // Stats are a nice-to-have — if the request fails, the page just keeps
    // its honest fallback copy instead of showing anything broken or fake.
  }
}

// Replaces the homepage's clearly-labelled SAMPLE testimonials with real
// customer reviews (rating + text, from "Track Order → Rate this service")
// once there are at least 3 of them — enough to not look sparse/empty. Below
// that threshold the honest sample cards (labelled as samples) stay as-is,
// same "don't show fake data" principle used for the rating badge.
// The Testimonials section stays hidden until there are at least 3 real
// customer reviews — no placeholder/sample cards are ever shown, so the
// site never displays anything that isn't real (same rule used everywhere
// else on the site for ratings/reviews).
async function loadPublicReviews() {
  const section = document.getElementById('testimonialsSection');
  if (!section) return;
  try {
    const reviews = await fetchJSON('/api/reviews/public');
    if (!reviews || reviews.length < 3) {
      section.style.display = 'none';
      return;
    }
    const grid = document.getElementById('testimonialGrid');
    const note = document.getElementById('testimonialSectionNote');
    grid.innerHTML = reviews.slice(0, 6).map(r => `
      <div class="testimonial-card">
        <div class="testimonial-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
        <p class="testimonial-quote">"${escapeHtml(r.reviewText)}"</p>
        <div class="testimonial-person">
          <div class="testimonial-avatar">${escapeHtml(r.initials)}</div>
          <div>
            <div class="testimonial-name">${escapeHtml(r.displayName)}</div>
            <div class="testimonial-meta">${escapeHtml(r.cityName)} · ${escapeHtml(r.applianceName)} · Verified booking</div>
          </div>
        </div>
      </div>
    `).join('');
    if (note) note.textContent = 'Real reviews from verified Seerua Appliance Care bookings.';
    section.style.display = '';
  } catch (e) {
    section.style.display = 'none';
  }
}

// Fades/slides each ".reveal" element into place the first time it scrolls
// into view — a small polish touch used across the page's sections.
function bindScrollReveal() {
  const targets = document.querySelectorAll('.reveal');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('in-view'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  targets.forEach(el => observer.observe(el));
}

// Makes the footer's "Services" links actually change the selected appliance
// in the booking form (they used to just scroll down without selecting
// anything) — each link carries a data-appliance id set by the server.
function bindFooterApplianceLinks() {
  document.querySelectorAll('.footer-appliance-link').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('data-appliance');
      if (!id || !APPLIANCES.some(x => x.id === id)) return;
      e.preventDefault();
      openQuickBookModal(id);
    });
  });
}

// ---------------- Refer & Earn ----------------
// A customer's own referral link is fetched using their phone number and
// sent straight to WhatsApp — no separate "here's your link" box shown in
// between. Anyone who books through that link gets a discount on their
// first booking; once their booking is marked completed by the
// technician, the referrer gets a reward coupon automatically (handled
// server-side).
//
// We already know the customer's phone once they've looked up their
// bookings in "My Booking" just above — so in that case we skip asking
// for it again entirely. The manual phone box only appears as a fallback
// for someone who lands here via a referral banner without having looked
// up their bookings yet (see checkIncomingReferral / the "Get my referral
// link" banner), since there's no other way to know who they are in that
// case.

// Renders the referral stats/rewards box — referredCount, pendingCount,
// and every reward coupon earned so far (code, amount, used/unused,
// expiry). All of this data already came back from /api/referral/my-info
// but was previously never shown anywhere, so a referrer had no way to
// discover they'd actually earned something.
function renderReferralStatus(info) {
  const box = document.getElementById('referStatus');
  if (!box) return;
  const rewardsHtml = info.rewardCoupons && info.rewardCoupons.length
    ? info.rewardCoupons.map(c => `
        <div class="row1" style="padding:8px 0;border-bottom:1px solid var(--line);">
          <span><strong style="color:var(--blue-900);">${escapeHtml(c.code)}</strong> · ₹${c.discountValue} off</span>
          <span class="status-pill ${c.used ? 'status-completed' : 'status-assigned'}">${c.used ? 'Used' : 'Available'}</span>
        </div>
        ${!c.used ? `<div class="row2" style="margin-top:-4px;margin-bottom:6px;">Valid till ${c.expiryDate} — enter this code at checkout on your own next booking.</div>` : ''}
      `).join('')
    : '';
  box.innerHTML = `
    <div class="row2" style="margin-bottom:8px;">Your link: <a href="${info.link}" style="color:var(--blue-600);word-break:break-all;">${info.link}</a></div>
    <div class="row1"><span>People you've referred</span><strong>${info.referredCount || 0}</strong></div>
    <div class="row1"><span>Rewards pending (waiting for their service to complete)</span><strong>${info.pendingCount || 0}</strong></div>
    ${rewardsHtml ? `<div style="margin-top:10px;"><strong style="color:var(--blue-900);font-size:0.88rem;">Your reward coupons</strong>${rewardsHtml}</div>` : `<div class="row2" style="margin-top:8px;">No reward coupons yet — you'll get one automatically once someone you referred completes their first service.</div>`}
  `;
  box.style.display = 'block';
}

// Fetches the customer's referral link and opens WhatsApp with it
// pre-filled, in one motion — no intermediate "here's your link" box to
// look at or a second button to press. The blank tab is opened
// synchronously, before the `await`, so browsers still treat it as a
// direct result of the tap and don't block it as a pop-up; its
// destination is filled in once the link is back from the server.
async function sendReferralLinkViaWhatsApp(phone) {
  const msg = document.getElementById('referMsg');
  msg.className = 'form-msg';
  msg.textContent = '';
  const popup = window.open('', '_blank');
  try {
    const info = await fetchJSON(`/api/referral/my-info?phone=${phone}`);
    if (!info.active) {
      if (popup) popup.close();
      msg.className = 'form-msg error';
      msg.textContent = 'The referral program is not active right now. Please check back later.';
      return false;
    }
    renderReferralStatus(info);
    const shareText = `Hi! I use Seerua Appliance Care for AC/Washing Machine/RO/Fridge repair — book through my link and get ₹${info.referredDiscount} off your first service: ${info.link}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    if (popup) popup.location.href = whatsappUrl;
    else window.open(whatsappUrl, '_blank'); // popup blocked anyway — try once more directly
    return true;
  } catch (e) {
    if (popup) popup.close();
    msg.className = 'form-msg error';
    msg.textContent = e.message || 'Could not get your referral link. Please try again.';
    return false;
  }
}

function resetReferralSectionToPrompt() {
  const toggleRow = document.getElementById('referToggleRow');
  const lookup = document.getElementById('referLookup');
  const msg = document.getElementById('referMsg');
  const status = document.getElementById('referStatus');
  if (toggleRow) toggleRow.style.display = 'flex';
  if (lookup) lookup.style.display = 'none';
  if (status) { status.style.display = 'none'; status.innerHTML = ''; }
  if (msg) { msg.className = 'form-msg'; msg.textContent = ''; }
}

function bindReferralSection() {
  const openBtn = document.getElementById('referOpenBtn');
  const getLinkBtn = document.getElementById('referGetLinkBtn');
  if (!openBtn || !getLinkBtn) return;

  // Tapped from the collapsed "🎁 Refer a Friend" prompt. If we already
  // know the phone (from "My Booking" just above), send straight to
  // WhatsApp in one motion — no separate "here's your link" box to open
  // first. Only falls back to asking for the phone number if we truly
  // don't know it yet (arrived via the referral banner cold).
  openBtn.addEventListener('click', async () => {
    if (knownReferralPhone) {
      openBtn.disabled = true;
      openBtn.textContent = 'Please wait...';
      await sendReferralLinkViaWhatsApp(knownReferralPhone);
      openBtn.disabled = false;
      openBtn.textContent = 'Get My Referral Link';
    } else {
      document.getElementById('referToggleRow').style.display = 'none';
      document.getElementById('referLookup').style.display = 'block';
    }
  });

  getLinkBtn.addEventListener('click', async () => {
    const phoneEl = document.getElementById('referPhone');
    const phone = phoneEl.value.trim();
    const msg = document.getElementById('referMsg');

    if (!/^[0-9]{10}$/.test(phone)) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please enter a valid 10 digit mobile number.';
      return;
    }

    getLinkBtn.disabled = true;
    getLinkBtn.textContent = 'Please wait...';
    try {
      const ok = await sendReferralLinkViaWhatsApp(phone);
      if (ok) knownReferralPhone = phone;
    } finally {
      getLinkBtn.disabled = false;
      getLinkBtn.textContent = 'Get My Referral Link';
    }
  });
}

// If this page was opened via someone's referral link (?ref=CODE), validate
// it with the server and, if valid, show a banner and remember the code so
// it's sent along with the booking to apply the discount.
// If this page was reached with ?appliance=ID (optionally &city=ID too) in
// the URL — e.g. redirected here from the AI chat's "open booking form"
// fallback when the customer was on a city/appliance-city page that
// doesn't have the booking form itself — automatically open the Quick
// Book modal for that appliance instead of leaving the customer to land
// on the homepage with nothing happening.
function autoOpenBookingFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const applianceId = params.get('appliance');
  const cityId = params.get('city');
  if (cityId && document.getElementById('fCity')) {
    const match = CITIES.find(c => c.id === cityId);
    if (match) document.getElementById('fCity').value = cityId;
  }
  if (applianceId && APPLIANCES.find(a => a.id === applianceId && !a.hidden)) {
    openQuickBookModal(applianceId);
  } else if (window.location.hash === '#book' || window.location.hash === '#services') {
    document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' });
  }
}

async function checkIncomingReferral() {
  const urlParams = new URLSearchParams(window.location.search);
  const ref = urlParams.get('ref');
  if (!ref) return;
  try {
    const result = await fetchJSON(`/api/referral/validate?code=${encodeURIComponent(ref)}`);
    incomingReferralCode = ref;
    const banner = document.getElementById('referBannerReferred');
    if (banner) {
      banner.textContent = `🎉 Referred by ${result.referrerName} — you'll get ₹${result.discountAmount} off your first booking! Just book below (discount applies automatically).`;
      banner.style.display = 'block';
    }
    const referBlock = document.getElementById('refer');
    if (referBlock) referBlock.hidden = false;
    // "My Booking" (which contains the refer block) is hidden until the
    // person opens it manually — but someone arriving via a referral link
    // needs to actually SEE their discount confirmation, so open + scroll
    // to it automatically in this one case.
    if (typeof openTrackHistory === 'function') openTrackHistory();
  } catch (e) {
    // Invalid/expired referral code — silently ignore, customer can still book normally.
    incomingReferralCode = null;
  }
}

// ---------------- Careers button + modal (fill & submit right on this page) ----------------
// A full standalone version of the same form also lives at /careers, which
// keeps working even when Maintenance Mode is on (Maintenance Mode only
// blocks the booking API and swaps out this homepage — /careers is a
// separate route that is never touched by it).
function openCareersModal() {
  const modal = document.getElementById('careersModal');
  if (!modal) return;
  document.getElementById('mcapCity').innerHTML = '<option value="" disabled selected>Select city</option>' + CAREER_CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('mcapEducation').innerHTML = '<option value="" disabled selected>Select education</option>' + EDUCATION_LEVELS.map(ed => `<option value="${ed.id}">${ed.name}</option>`).join('');
  document.getElementById('mcapAppliancePicker').innerHTML = CAREER_APPLIANCES.map(a => `
    <label class="chip" style="cursor:pointer;">
      <input type="checkbox" value="${a.id}" name="mcapAppliance" style="margin-right:5px;">${a.name}
    </label>
  `).join('');
  document.getElementById('mcapMsg').className = 'form-msg';
  document.getElementById('mcapMsg').textContent = '';
  // Reset button states left over from a previous successful submission
  // (submit shows "✓ Submitted" and Cancel gets disabled while the modal
  // auto-closes) — a fresh open of the form should start clean.
  const mcapSubmitBtn = document.querySelector('#careersModalForm button[type="submit"]');
  if (mcapSubmitBtn) { mcapSubmitBtn.disabled = false; mcapSubmitBtn.textContent = 'Submit Application'; }
  const mcapCancelBtn = document.getElementById('careersModalCancel');
  if (mcapCancelBtn) mcapCancelBtn.disabled = false;
  modal.classList.add('open');
  // Without locking the background page's scroll, a mouse-wheel scroll
  // that reaches the bottom of the form (or starts just outside its
  // bounds within the backdrop's padding) can fall through and scroll the
  // page behind the modal instead — on some browsers/laptops that then
  // registers as if the click/press landed on the backdrop itself,
  // closing the form. Locking it removes that entire failure mode.
  document.body.style.overflow = 'hidden';
}
function closeCareersModal() {
  const modal = document.getElementById('careersModal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function bindCareersModal() {
  const openBtn = document.getElementById('careersBtn');
  const navLink = document.getElementById('careersNavLink');
  const modal = document.getElementById('careersModal');
  if (!modal) return;

  if (openBtn) openBtn.addEventListener('click', openCareersModal);
  // FLOW CHANGE: this used to intercept the click and open the modal
  // below instead of navigating — but that meant the header's "Careers"
  // link (used across the whole site) never actually sent anyone to the
  // real /careers page, which is the one with proper SEO meta tags,
  // JobPosting structured data, and real descriptive content for
  // Google. It just quietly opened an invisible-to-search-engines
  // duplicate of the same form instead. #careersNavLink now has a real
  // href="/careers" in the template and is left to navigate normally.
  document.getElementById('careersModalClose').addEventListener('click', closeCareersModal);
  document.getElementById('careersModalCancel').addEventListener('click', closeCareersModal);

  // Close only when the tap/click both STARTS and ENDS on the empty
  // backdrop itself — not just ends there. Without this, tapping/scrolling
  // anywhere inside the form on a touchscreen (a field, a checkbox, even
  // just scrolling the form up/down) can register its "click" against the
  // backdrop and close the whole modal, wiping out whatever the person had
  // filled in. Requiring the press to also start on the backdrop fixes that
  // while still letting a genuine tap outside the form close it.
  let careersBackdropPressStartedOnBackdrop = false;
  let careersBackdropPressStartXY = null;
  modal.addEventListener('pointerdown', (e) => {
    careersBackdropPressStartedOnBackdrop = (e.target === modal);
    careersBackdropPressStartXY = { x: e.clientX, y: e.clientY };
  });
  modal.addEventListener('click', (e) => {
    // Also require the pointer didn't move much between press and
    // release — a scroll/drag gesture that happens to start and end on
    // the backdrop still fires a "click", but it isn't really a tap
    // meant to dismiss the form.
    const moved = careersBackdropPressStartXY
      ? Math.hypot(e.clientX - careersBackdropPressStartXY.x, e.clientY - careersBackdropPressStartXY.y) > 8
      : false;
    if (e.target === modal && careersBackdropPressStartedOnBackdrop && !moved) closeCareersModal();
    careersBackdropPressStartedOnBackdrop = false;
    careersBackdropPressStartXY = null;
  });

  document.getElementById('careersModalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('mcapMsg');
    msg.className = 'form-msg';

    const applianceIds = Array.from(document.querySelectorAll('input[name="mcapAppliance"]:checked')).map(i => i.value);
    const phone = document.getElementById('mcapPhone').value.trim();

    if (!/^[0-9]{10}$/.test(phone)) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please enter a valid 10 digit mobile number.';
      return;
    }
    if (!applianceIds.length) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please select at least one appliance you can work on.';
      return;
    }
    if (!document.getElementById('mcapEducation').value) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please select your highest education level.';
      return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const cancelBtn = document.getElementById('careersModalCancel');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      await fetchJSON('/api/technician-applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('mcapName').value.trim(),
          phone,
          address: document.getElementById('mcapAddress').value.trim(),
          cityId: document.getElementById('mcapCity').value,
          applianceIds,
          educationId: document.getElementById('mcapEducation').value,
          experienceYears: document.getElementById('mcapExperience').value,
          idType: document.getElementById('mcapIdType').value,
          idNumber: document.getElementById('mcapIdNumber').value.trim(),
          notes: document.getElementById('mcapNotes').value.trim()
        })
      });
      msg.className = 'form-msg success';
      msg.textContent = "Application submitted! Our team will contact you when there's an opening in your city.";
      e.target.reset();
      // Keep the button showing a clear "done" state instead of reverting
      // to "Submit Application" — otherwise it looks ready to submit again
      // right under a success message, which reads as if nothing happened.
      submitBtn.textContent = '✓ Submitted';
      if (cancelBtn) cancelBtn.disabled = true;
      // Long enough to actually read the confirmation before the form
      // disappears — 1.8s was barely a flash, easy to miss and mistake
      // for the submission not having worked at all.
      msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(closeCareersModal, 4500);
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message || 'Could not submit your application. Please try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Application';
    }
  });
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function refreshFormTypes() {
  const applianceId = document.getElementById('fAppliance').value;
  const appliance = APPLIANCES.find(a => a.id === applianceId);
  populateSelect(document.getElementById('fType'), appliance ? appliance.types : [], 'Select type');
}

function renderServicesGrid() {
  const grid = document.getElementById('servicesGrid');
  grid.innerHTML = ALL_APPLIANCES.map(a => `
    <div class="service-card" data-appliance="${a.id}">
      ${a.photoUrl
        ? `<img class="service-card-photo" src="${a.photoUrl}" alt="${a.name} service technician at work" loading="lazy">`
        : `<div class="service-icon-wrap"><div class="service-icon">${ICONS[a.icon] || ICONS.wrench}</div></div>`}
      <h3>${a.name}</h3>
      <a href="#book" class="btn btn-outline btn-sm">Book Now</a>
    </div>
  `).join('');

  grid.querySelectorAll('.service-card').forEach(card => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const applianceId = card.getAttribute('data-appliance');
      openQuickBookModal(applianceId);
    });
  });
}

const CART_STORAGE_KEY = 'seerua_cart_v1';

function loadCartFromStorage() {
  try {
    const raw = sessionStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.cartItems)) cartItems = saved.cartItems;
    if (saved.appliedCoupon) appliedCoupon = saved.appliedCoupon;
    if (saved.cartPhoneNumber) cartPhoneNumber = saved.cartPhoneNumber;
  } catch (e) { /* corrupted/old data — just start with an empty cart */ }
}

function saveCartToStorage() {
  try {
    sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ cartItems, appliedCoupon, cartPhoneNumber }));
  } catch (e) { /* storage full or unavailable — cart just won't survive a refresh this time */ }
}

let cartItems = [];
// The phone number the current cart's items were added under — set when
// the first item goes in, cleared when the cart empties out again. See
// the check in addItemToCart() for why this exists.
let cartPhoneNumber = null;
// SUGGESTION IMPLEMENTED: OTP now happens right when the first item is
// added to the cart (not at final Submit) — this remembers that
// verification across the rest of the flow, so Submit doesn't ask again
// for the same session, and so it can be safely discarded if the phone
// number is changed after verifying (a different number needs its own
// fresh OTP).
let verifiedBookingAccessToken = null;
let verifiedBookingPhone = null;

let appliedCoupon = null;

function renderCart() {
  updateBottomNavCartBadge();
  const offset = quickBookViewStartIndex !== null ? quickBookViewStartIndex : 0;
  const visibleItems = quickBookViewStartIndex !== null ? cartItems.slice(quickBookViewStartIndex) : cartItems;
  // BUG FIX: nothing stopped a customer from adding one appliance, then
  // changing the phone number field and adding a second appliance under
  // a completely different number — both items still end up in the SAME
  // cart, and the final "Book Now" submits everything under whichever
  // number happens to be in the field at that moment, silently ignoring
  // whatever number was showing when the earlier item(s) were added.
  // Locking the phone field the moment the cart has its first item
  // guarantees one cart == one phone number == one customer, for the
  // whole life of that cart.
  const phoneField = document.getElementById('fPhone');
  const phoneLockNote = document.getElementById('fPhoneLockNote');
  if (phoneField && quickBookViewStartIndex === null) {
    const shouldLock = cartItems.length > 0;
    phoneField.readOnly = shouldLock;
    phoneField.style.background = shouldLock ? 'var(--mist)' : '';
    if (phoneLockNote) phoneLockNote.style.display = shouldLock ? 'block' : 'none';
    if (!shouldLock) cartPhoneNumber = null; // cart's empty again — free to start over with any number
  }
  // Clear, visible confirmation that this is an isolated "just this one
  // item" checkout — so it's obvious nothing else from the regular cart
  // is quietly being bundled into this booking.
  const scopeNote = document.getElementById('quickBookScopeNote');
  if (scopeNote) scopeNote.style.display = (quickBookViewStartIndex !== null && offset > 0) ? 'block' : 'none';
  // Only persist/restore the REAL full cart to storage — a standalone
  // Book session is meant to be quick and self-contained, not something
  // that needs to survive a refresh independent of the main cart.
  if (quickBookViewStartIndex === null) saveCartToStorage();
  const list = document.getElementById('cartList');
  const empty = document.getElementById('cartEmpty');
  const couponRow = document.getElementById('couponRow');
  const summaryCard = document.getElementById('paymentSummaryCard');
  if (!visibleItems.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    couponRow.style.display = 'none';
    if (summaryCard) summaryCard.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  // Coupons apply to the real, full cart only — kept out of the simpler
  // standalone single-item Book view.
  couponRow.style.display = (quickBookViewStartIndex === null) ? 'flex' : 'none';
  const subtotal = visibleItems.reduce((s, it) => s + it.lineTotal, 0);
  const discount = (quickBookViewStartIndex === null && appliedCoupon) ? appliedCoupon.discountAmount : 0;
  const finalTotal = subtotal - discount;

  list.innerHTML = visibleItems.map((it, localIdx) => {
    const idx = offset + localIdx; // real index into cartItems, so qty/remove target the right item
    // BUG FIX: the quantity +/- stepper used to show even in the
    // standalone "Quick Book" (direct-book) view — but that flow is
    // meant to be a fixed, single-item checkout (city/appliance/type
    // already chosen one at a time), so a quantity control there doesn't
    // make sense and just added confusion. Only shown in the real,
    // full-cart view now.
    const qtyHtml = quickBookViewStartIndex === null
      ? `<div class="cart-item-qty-stepper">
          <button type="button" onclick="adjustCartItemQty(${idx}, -1)" aria-label="Decrease quantity">−</button>
          <span>${it.qty}</span>
          <button type="button" onclick="adjustCartItemQty(${idx}, 1)" aria-label="Increase quantity">+</button>
        </div>`
      : '';
    return `
    <div class="cart-item">
      <div class="cart-item-info">
        <strong>${it.applianceName}</strong> — ${it.typeName}, ${it.serviceType === 'repair' ? 'Repair' : 'Service'}
        ${it.problem ? `<br><span style="color:var(--slate);">${it.problem}</span>` : ''}
        ${it.photoUrl ? `<br><a href="${it.photoUrl}" target="_blank" rel="noopener" style="color:var(--blue-600);font-size:0.82rem;">📷 View attached photo</a>` : ''}
        ${qtyHtml}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
        <span class="cart-item-price">₹${it.lineTotal}</span>
        <button type="button" class="cart-item-trash" onclick="removeCartItem(${idx})" title="Remove">🗑️</button>
      </div>
    </div>
  `;
  }).join('') +
    (discount ? `<div class="discount-row"><span>Coupon "${appliedCoupon.code}" applied</span><span>− ₹${discount}</span></div>` : '') +
    // In the standalone Quick Book (direct-book) view, this is always a
    // single fixed item — showing an item-count next to it ("Total (1
    // item)") is redundant clutter for what's meant to be a simple direct
    // checkout, so just "Total" there; the full item count still shows in
    // the real multi-item cart view.
    `<div class="cart-total-row">
      <span>${quickBookViewStartIndex === null ? `Total (${visibleItems.length} item${visibleItems.length > 1 ? 's' : ''})` : 'Total'}</span>
      <span class="amount">₹${finalTotal}</span>
    </div>`;

  // Payment Summary card — kept in sync with the same numbers as the
  // cart total above (no extra platform fee, per explicit request).
  if (summaryCard) {
    summaryCard.style.display = 'block';
    document.getElementById('paymentSummaryItemTotal').textContent = `₹${subtotal}`;
    document.getElementById('paymentSummaryTotal').textContent = `₹${finalTotal}`;
  }
}

// Adjusts an already-added item's quantity directly from the cart line
// (the qty field in the "add appliance" box only sets the STARTING
// quantity when first adding — this is what lets it be changed after).
function adjustCartItemQty(idx, delta) {
  const it = cartItems[idx];
  if (!it) return;
  const newQty = Math.max(1, Math.min(10, it.qty + delta));
  if (newQty === it.qty) return;
  it.qty = newQty;
  it.lineTotal = it.unitPrice * newQty;
  renderCart();
}

function removeCartItem(idx) {
  cartItems.splice(idx, 1);
  if (appliedCoupon) {
    appliedCoupon = null;
    document.getElementById('couponCode').value = '';
    document.getElementById('couponMsg').className = 'msg-inline-coupon';
    document.getElementById('couponMsg').textContent = '';
  }
  renderCart();
  if (document.getElementById('fDate').value) refreshSlots();
}

document.getElementById('applyCouponBtn').addEventListener('click', async () => {
  const msg = document.getElementById('couponMsg');
  msg.className = 'msg-inline-coupon';
  const code = document.getElementById('couponCode').value.trim();
  if (!code) {
    msg.className = 'msg-inline-coupon error';
    msg.textContent = 'Please enter a coupon code.';
    return;
  }
  const subtotal = cartItems.reduce((s, it) => s + it.lineTotal, 0);
  const phone = document.getElementById('fPhone').value.trim();
  try {
    const result = await fetchJSON('/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, totalPrice: subtotal, phone })
    });
    appliedCoupon = { code: result.code, discountAmount: result.discountAmount };
    msg.className = 'msg-inline-coupon success';
    msg.textContent = `Coupon applied! You saved ₹${result.discountAmount}.`;
    renderCart();
  } catch (err) {
    appliedCoupon = null;
    msg.className = 'msg-inline-coupon error';
    msg.textContent = err.message || 'Invalid coupon code.';
    renderCart();
  }
});

let pendingPhotoUrl = '';
let photoUploading = false;

document.getElementById('fPhoto').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const preview = document.getElementById('fPhotoPreview');
  pendingPhotoUrl = '';
  if (!file) { preview.style.display = 'none'; preview.innerHTML = ''; return; }

  preview.style.display = 'block';
  preview.innerHTML = `<span style="font-size:0.82rem;color:var(--slate);">Uploading photo…</span>`;
  photoUploading = true;
  try {
    const formData = new FormData();
    formData.append('photo', file);
    const res = await fetch('/api/upload-photo', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not upload photo.');
    pendingPhotoUrl = data.url;
    preview.innerHTML = `
      <div class="photo-preview-thumb">
        <img src="${data.url}" alt="Uploaded photo">
        <span>Photo attached</span>
        <button type="button" onclick="clearPendingPhoto()">✕</button>
      </div>`;
  } catch (err) {
    preview.innerHTML = `<span style="font-size:0.82rem;color:var(--red);">${escapeHtml(err.message)}</span>`;
  } finally {
    photoUploading = false;
  }
});

function clearPendingPhoto() {
  pendingPhotoUrl = '';
  document.getElementById('fPhoto').value = '';
  const preview = document.getElementById('fPhotoPreview');
  preview.style.display = 'none';
  preview.innerHTML = '';
}

let addingItem = false;

async function addItemToCart() {
  if (addingItem) return; // already processing a click — ignore extra clicks (prevents double-adds from a fast double tap on mobile)
  // Uses its own message box right under the "+ Add to Booking" button —
  // not the form's #formMsg way down near Submit, which used to leave
  // people confused about where a message like "already in your list"
  // even came from since it appeared nowhere near what they'd just tapped.
  const msg = document.getElementById('addItemMsg');
  msg.className = 'form-msg';
  if (photoUploading) {
    msg.className = 'form-msg error';
    msg.textContent = 'Please wait for the photo to finish uploading.';
    return;
  }
  const cityId = document.getElementById('fCity').value;
  const applianceId = document.getElementById('fAppliance').value;
  const typeId = document.getElementById('fType').value;
  const serviceType = document.getElementById('fServiceType').value;
  const qty = Math.max(1, parseInt(document.getElementById('fQty').value, 10) || 1);
  const problem = document.getElementById('fProblem').value.trim();

  if (!cityId) {
    msg.className = 'form-msg error';
    msg.textContent = 'Please select your city first.';
    return;
  }
  if (!applianceId || !typeId) {
    msg.className = 'form-msg error';
    msg.textContent = 'Please select an appliance and type.';
    return;
  }
  if (!APPLIANCES.some(a => a.id === applianceId)) {
    msg.className = 'form-msg error';
    msg.textContent = 'Sorry, this appliance is currently not available for service in your selected city.';
    return;
  }

  const phone = document.getElementById('fPhone').value.trim();
  if (!/^[0-9]{10}$/.test(phone)) {
    msg.className = 'form-msg error';
    msg.textContent = 'Please enter a valid 10 digit mobile number.';
    return;
  }

  // BUG FIX: this is the ONE shared entry point both the main booking form
  // AND Quick Book funnel through (Quick Book syncs its own phone field
  // into fPhone right before calling this) — so checking here, in one
  // place, guarantees one cart == one phone number regardless of which UI
  // added each item. Without this, a customer could add an appliance,
  // then either edit the main phone field directly or reopen Quick Book
  // (which resets its own phone field blank each time) and add a second
  // appliance under a completely different number — both landing in the
  // same cart, silently submitted together under whichever number
  // happened to be showing at final checkout.
  if (cartItems.length > 0 && cartPhoneNumber && phone !== cartPhoneNumber) {
    msg.className = 'form-msg error';
    msg.textContent = `This booking is already using ${cartPhoneNumber}. Please use the same number, or remove the item(s) below first to start over with a different number.`;
    return;
  }

  const addBtn = document.getElementById('addItemBtn');
  const originalBtnText = addBtn.textContent;
  addingItem = true;
  addBtn.disabled = true;

  // OTP verification happens here — right when adding the first item (or
  // if the phone number changed since it was last verified) — rather
  // than waiting until final Submit. A number already verified from a
  // past booking, or with OTP turned off in Admin Panel, skips straight
  // through; the server independently re-checks this too either way.
  if (verifiedBookingPhone !== phone) {
    verifiedBookingAccessToken = null;
    verifiedBookingPhone = null;
    let phoneAlreadyVerified = false;
    try {
      const check = await fetchJSON(`/api/phone-verified?phone=${phone}`);
      phoneAlreadyVerified = !!check.verified;
    } catch (e) { /* fall back to normal OTP flow */ }

    let otpEnabled = true;
    try {
      const cfg = await ensureOtpConfig();
      otpEnabled = cfg.enabled !== false;
    } catch (e) { /* fall back to normal OTP flow */ }

    if (otpEnabled && !phoneAlreadyVerified) {
      addBtn.textContent = 'Verifying number…';
      msg.className = 'form-msg';
      msg.textContent = 'Please complete the OTP verification that just opened.';
      try {
        verifiedBookingAccessToken = await verifyPhoneWithOtp(phone);
        verifiedBookingPhone = phone;
      } catch (err) {
        addingItem = false;
        addBtn.disabled = false;
        addBtn.textContent = originalBtnText;
        msg.className = 'form-msg error';
        msg.textContent = err.message || 'OTP verification failed. Please try again.';
        return;
      }
    } else {
      verifiedBookingPhone = phone; // already verified or OTP disabled — nothing more needed for this number
    }
  }

  addBtn.textContent = 'Adding…';

  try {
    const row = await fetchJSON(`/api/price?cityId=${cityId}&applianceId=${applianceId}&typeId=${typeId}`);
    // qbSkuOverride is set by the Quick Book services-list flow (see
    // qbAddService below) when the customer picked a specific service
    // SKU (e.g. "Installation", "Gas Filling") that has its own price,
    // distinct from the plain service/repair split this form normally
    // uses. Falls back to the normal servicePrice/repairPrice otherwise.
    const unitPrice = (typeof qbSkuOverride !== 'undefined' && qbSkuOverride)
      ? qbSkuOverride.price
      : (serviceType === 'repair' ? row.repairPrice : row.servicePrice);
    const appliance = APPLIANCES.find(a => a.id === applianceId);
    const type = appliance ? appliance.types.find(t => t.id === typeId) : null;

    // If the same appliance + type + service + problem note is already in
    // the cart, don't touch the cart at all — no second line, and no
    // silently bumping the existing line's quantity either. Just tell the
    // person it's already there; if they want a different quantity they
    // can remove that line and re-add it with the qty they want.
    const existing = cartItems.find(it =>
      it.applianceId === applianceId && it.typeId === typeId &&
      it.serviceType === serviceType && it.problem === problem &&
      it.photoUrl === pendingPhotoUrl
    );
    if (existing) {
      // Not an actual error (nothing is wrong, nothing failed) — so this is
      // shown in the calmer "notice" style, not red, and it doesn't stop
      // the person from submitting the booking with what's already in the
      // list below.
      msg.className = 'form-msg notice';
      msg.textContent = "Already in your list below — no need to add it again. To change the quantity, remove it below and re-add with the quantity you want.";
    } else {
      cartItems.push({
        applianceId, applianceName: appliance ? appliance.name : '',
        typeId, typeName: type ? type.name : '',
        serviceType, qty, problem,
        photoUrl: pendingPhotoUrl,
        skuId: (typeof qbSkuOverride !== 'undefined' && qbSkuOverride) ? qbSkuOverride.skuId : null,
        unitPrice, lineTotal: unitPrice * qty
      });
      cartPhoneNumber = phone; // locks this cart to this number — see the check above and renderCart()
      renderCart();
      document.getElementById('fProblem').value = '';
      document.getElementById('fQty').value = 1;
      clearPendingPhoto();
      if (document.getElementById('fDate').value) refreshSlots();
    }
  } catch (err) {
    msg.className = 'form-msg error';
    msg.textContent = 'Could not get price for this selection. Please try again.';
  } finally {
    addingItem = false;
    addBtn.disabled = false;
    addBtn.textContent = originalBtnText;
    qbSkuOverride = null;
  }
}

let selectedSlotId = null;

async function refreshSlots() {
  const cityId = document.getElementById('fCity').value;
  const date = document.getElementById('fDate').value;
  const picker = document.getElementById('slotPicker');
  if (!cityId || !date) {
    picker.innerHTML = '<p style="font-size:0.82rem;color:var(--slate);margin:0;">Select city and date above to see available slots.</p>';
    selectedSlotId = null;
    return;
  }
  picker.innerHTML = '<p style="font-size:0.82rem;color:var(--slate);margin:0;">Loading slots...</p>';
  try {
    // Pass along which appliances are in the cart so a slot that's only
    // blocked for a specific appliance (e.g. AC) in this city/date shows
    // correctly as Full/Available for what the customer is actually booking.
    const applianceIds = [...new Set(cartItems.map(it => it.applianceId))].join(',');
    const slots = await fetchJSON(`/api/slots?date=${date}&cityId=${cityId}${applianceIds ? `&applianceIds=${applianceIds}` : ''}`);
    picker.innerHTML = slots.map(s => `
      <button type="button" class="slot-btn ${s.available ? '' : 'full'} ${selectedSlotId === s.id ? 'selected' : ''}" data-slot="${s.id}" ${s.available ? '' : 'disabled'}>
        ${s.label}
        <small>${s.available ? 'Available' : (s.expired ? 'Time Over' : 'Full')}</small>
      </button>
    `).join('');
    picker.querySelectorAll('.slot-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedSlotId = btn.getAttribute('data-slot');
        picker.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
    if (!slots.some(s => s.id === selectedSlotId)) selectedSlotId = null;
  } catch (e) {
    picker.innerHTML = '<p style="font-size:0.82rem;color:var(--red);margin:0;">Could not load slots. Please try again.</p>';
  }
}

// Looks up whether this phone number belongs to a returning customer (has
// booked before) and, if so, fills in their name/address/city — but only
// into fields that are currently EMPTY, so it never overwrites something
// the customer has already typed themselves (e.g. if they're booking for
// a different address this time). Reused by both the main checkout form's
// phone field and the Quick Book modal's phone field, since both
// eventually feed into the same underlying fName/fAddress/fCity inputs.
async function autoFillReturningCustomer(phoneFieldId, nameFieldId, addressFieldId, cityFieldId) {
  const phone = document.getElementById(phoneFieldId).value.trim();
  if (!/^[0-9]{10}$/.test(phone)) return;
  try {
    const result = await fetchJSON(`/api/customer-lookup?phone=${phone}`);
    if (!result.found) return;
    const nameEl = document.getElementById(nameFieldId);
    const addressEl = document.getElementById(addressFieldId);
    const cityEl = document.getElementById(cityFieldId);
    let filledAnything = false;
    if (nameEl && !nameEl.value.trim() && result.name) { nameEl.value = result.name; filledAnything = true; }
    if (addressEl && !addressEl.value.trim() && result.address) { addressEl.value = result.address; filledAnything = true; }
    if (cityEl && !cityEl.value && result.cityId) {
      cityEl.value = result.cityId;
      // Setting .value directly doesn't fire the city dropdown's own
      // 'change' handler (which loads that city's appliances/slots) — so
      // trigger that follow-up work manually, same as if the customer had
      // picked it themselves.
      if (typeof refreshAppliancesForCity === 'function') await refreshAppliancesForCity(result.cityId);
      if (typeof refreshSlots === 'function') refreshSlots();
      filledAnything = true;
    }
    if (filledAnything) {
      const msg = document.getElementById('addItemMsg') || document.getElementById('qbMsg');
      if (msg && !msg.textContent) {
        msg.className = 'form-msg success';
        msg.textContent = '👋 Welcome back! Filled in your details from your last booking — feel free to change anything that\'s different this time.';
        setTimeout(() => { if (msg.textContent.startsWith('👋 Welcome back')) { msg.className = 'form-msg'; msg.textContent = ''; } }, 4500);
      }
    }
  } catch (e) { /* non-critical — silently skip if the lookup fails, customer just fills the form normally */ }
}

// ---------------- Custom date calendar (replaces native <input
// type="date"> for #fDate — see the template comment for why) ----------------
let dateCalViewYear, dateCalViewMonth; // 0-indexed month, currently-displayed page
let dateCalSelected = null; // 'YYYY-MM-DD' or null

function dateCalToStr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function selectDateCalendarDay(str) {
  dateCalSelected = str;
  const fDateEl = document.getElementById('fDate');
  const displayEl = document.getElementById('fDateDisplay');
  fDateEl.value = str;
  const d = new Date(str + 'T00:00:00');
  displayEl.value = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  fDateEl.dispatchEvent(new Event('change')); // existing refreshSlots listener picks this up
  closeDateCalendar();
}

function renderDateCalendar() {
  const label = document.getElementById('dateCalMonthLabel');
  const grid = document.getElementById('dateCalGrid');
  const prevBtn = document.getElementById('dateCalPrev');
  if (!label || !grid) return;
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  label.textContent = `${monthNames[dateCalViewMonth]} ${dateCalViewYear}`;

  const now = new Date();
  const todayStr = dateCalToStr(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = dateCalToStr(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
  document.getElementById('dateCalTodayBtn')?.classList.toggle('active', dateCalSelected === todayStr);
  document.getElementById('dateCalTomorrowBtn')?.classList.toggle('active', dateCalSelected === tomorrowStr);
  // Can't navigate to a month before the current one — nothing bookable back there anyway.
  prevBtn.disabled = (dateCalViewYear === now.getFullYear() && dateCalViewMonth === now.getMonth());

  const firstWeekday = new Date(dateCalViewYear, dateCalViewMonth, 1).getDay();
  const daysInMonth = new Date(dateCalViewYear, dateCalViewMonth + 1, 0).getDate();

  let html = '';
  for (let i = 0; i < firstWeekday; i++) html += '<span class="date-cal-day is-empty"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const str = dateCalToStr(dateCalViewYear, dateCalViewMonth, d);
    const isPast = str < todayStr;
    const isToday = str === todayStr;
    const isSelected = str === dateCalSelected;
    html += `<button type="button" class="date-cal-day${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}" data-date="${str}" ${isPast ? 'disabled' : ''}>${d}</button>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.date-cal-day[data-date]').forEach(btn => {
    btn.addEventListener('click', () => selectDateCalendarDay(btn.getAttribute('data-date')));
  });
}

function openDateCalendar() {
  const now = new Date();
  const current = document.getElementById('fDate').value;
  if (current) {
    const [y, m] = current.split('-').map(Number);
    dateCalViewYear = y;
    dateCalViewMonth = m - 1;
    dateCalSelected = current;
  } else {
    dateCalViewYear = now.getFullYear();
    dateCalViewMonth = now.getMonth();
    dateCalSelected = null;
  }
  renderDateCalendar();
  document.getElementById('dateCalendarModal').classList.add('open');
}

function closeDateCalendar() {
  document.getElementById('dateCalendarModal').classList.remove('open');
}

function bindDateCalendar() {
  document.getElementById('fDateDisplay').addEventListener('click', openDateCalendar);
  document.getElementById('dateCalendarClose').addEventListener('click', closeDateCalendar);
  document.getElementById('dateCalendarModal').addEventListener('click', (e) => {
    if (e.target.id === 'dateCalendarModal') closeDateCalendar();
  });
  document.getElementById('dateCalPrev').addEventListener('click', () => {
    dateCalViewMonth--;
    if (dateCalViewMonth < 0) { dateCalViewMonth = 11; dateCalViewYear--; }
    renderDateCalendar();
  });
  document.getElementById('dateCalNext').addEventListener('click', () => {
    dateCalViewMonth++;
    if (dateCalViewMonth > 11) { dateCalViewMonth = 0; dateCalViewYear++; }
    renderDateCalendar();
  });
  // Quick shortcuts (matches the original wireframe) — jump straight to
  // Today/Tomorrow without needing to find the right cell in the grid.
  document.getElementById('dateCalTodayBtn').addEventListener('click', () => {
    const now = new Date();
    selectDateCalendarDay(dateCalToStr(now.getFullYear(), now.getMonth(), now.getDate()));
  });
  document.getElementById('dateCalTomorrowBtn').addEventListener('click', () => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    selectDateCalendarDay(dateCalToStr(t.getFullYear(), t.getMonth(), t.getDate()));
  });
}

function bindFormEvents() {
  document.getElementById('fAppliance').addEventListener('change', refreshFormTypes);
  document.getElementById('addItemBtn').addEventListener('click', addItemToCart);
  document.getElementById('fDate').addEventListener('change', refreshSlots);
  bindDateCalendar();

  document.getElementById('fCity').addEventListener('change', async () => {
    await refreshAppliancesForCity(document.getElementById('fCity').value);
    refreshSlots();
    if (cartItems.length) {
      cartItems = [];
      appliedCoupon = null;
      renderCart();
      // Same box as "Add to Booking" messages, right by the appliance
      // fields — this notice is about the cart, so it belongs near where
      // appliances get (re-)added, not down by the final Submit button.
      const msg = document.getElementById('addItemMsg');
      msg.className = 'form-msg error';
      msg.textContent = 'City changed — please re-add your appliances so prices are correct for the new city.';
    }
  });

  document.getElementById('fPhone').addEventListener('blur', () => autoFillReturningCustomer('fPhone', 'fName', 'fAddress', 'fCity'));
  document.getElementById('qbPhone')?.addEventListener('blur', () => autoFillReturningCustomer('qbPhone', 'fName', 'fAddress', 'fCity'));

  const form = document.getElementById('bookingForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('formMsg');
    msg.className = 'form-msg';
    msg.textContent = '';

    if (!cartItems.length) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please add at least one appliance to your booking.';
      return;
    }

    const phone = document.getElementById('fPhone').value.trim();
    if (!/^[0-9]{10}$/.test(phone)) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please enter a valid 10 digit mobile number.';
      return;
    }

    if (!selectedSlotId) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please select an available time slot for your visit.';
      return;
    }

    const itemsToSubmit = quickBookViewStartIndex !== null ? cartItems.slice(quickBookViewStartIndex) : cartItems;
    const payload = {
      name: document.getElementById('fName').value.trim(),
      phone,
      address: document.getElementById('fAddress').value.trim(),
      cityId: document.getElementById('fCity').value,
      items: itemsToSubmit.map(it => ({ applianceId: it.applianceId, typeId: it.typeId, serviceType: it.serviceType, qty: it.qty, problem: it.problem, photoUrl: it.photoUrl || '', skuId: it.skuId || null })),
      bookingDate: document.getElementById('fDate').value,
      timeSlotId: selectedSlotId,
      couponCode: (quickBookViewStartIndex === null && appliedCoupon) ? appliedCoupon.code : undefined,
      referralCode: incomingReferralCode || undefined
    };

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    // If this exact phone number was already verified when the item(s)
    // were added to the cart, reuse that token — no need to ask for OTP
    // a second time at the very end of the same session.
    if (verifiedBookingPhone === phone && verifiedBookingAccessToken) {
      payload.accessToken = verifiedBookingAccessToken;
    } else {
      // Fallback path — covers the phone number being changed after
      // adding items (a real, if unusual, case), or verifiedBookingPhone
      // never having been set for some other reason. Re-checks from
      // scratch exactly as before this change.
      let phoneAlreadyVerified = false;
      try {
        const check = await fetchJSON(`/api/phone-verified?phone=${phone}`);
        phoneAlreadyVerified = !!check.verified;
      } catch (e) { /* if the check itself fails, fall back to normal OTP flow */ }

      let otpEnabled = true;
      try {
        const cfg = await ensureOtpConfig();
        otpEnabled = cfg.enabled !== false;
      } catch (e) { /* if the config fetch fails, fall back to normal OTP flow */ }

      if (otpEnabled && !phoneAlreadyVerified) {
        submitBtn.textContent = 'Sending OTP...';
        msg.className = 'form-msg';
        msg.textContent = 'Please complete the OTP verification that just opened to confirm your booking.';
        try {
          payload.accessToken = await verifyPhoneWithOtp(phone);
        } catch (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit';
          msg.className = 'form-msg error';
          msg.textContent = err.message || 'OTP verification failed. Please try again.';
          return;
        }
      }
    }

    submitBtn.textContent = 'Booking...';

    try {
      const data = await fetchJSON('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const savedBits = [];
      if (data.booking.discountAmount) savedBits.push(`coupon: ₹${data.booking.discountAmount}`);
      if (data.booking.referralDiscount) savedBits.push(`referral: ₹${data.booking.referralDiscount}`);
      msg.className = 'form-msg success';
      msg.textContent = `Booking confirmed! Your Booking ID: ${data.booking.id}. Total: ₹${data.booking.totalPrice}${savedBits.length ? ` (you saved ${savedBits.join(' + ')}!)` : ''}. Visit slot: ${data.booking.timeSlot} on ${data.booking.bookingDate}.`;
      form.reset();
      // BUG FIX: form.reset() alone doesn't reliably clear the phone
      // field — many mobile browsers ignore autocomplete="off" for phone
      // number fields and silently refill it right back from their own
      // saved-forms memory (without firing any input/blur event, so the
      // "returning customer" address auto-fill never gets a chance to run
      // for the next booking). Explicitly force it empty as well so a
      // second booking in the same session starts with a clean phone
      // field — typing the number back in (a real keystroke) correctly
      // re-triggers the address lookup on blur, same as for any new visit.
      document.getElementById('fPhone').value = '';
      if (quickBookViewStartIndex !== null) {
        cartItems.splice(quickBookViewStartIndex); // remove only this standalone booking's item(s), leave earlier cart items untouched
        quickBookViewStartIndex = null;
      } else {
        cartItems = [];
        appliedCoupon = null;
      }
      incomingReferralCode = null;
      const referBanner = document.getElementById('referBannerReferred');
      if (referBanner) referBanner.style.display = 'none';
      document.getElementById('couponMsg').className = 'msg-inline-coupon';
      document.getElementById('couponMsg').textContent = '';
      renderCart();
      selectedSlotId = null;
      document.getElementById('slotPicker').innerHTML = '<p style="font-size:0.82rem;color:var(--slate);margin:0;">Select city and date above to see available slots.</p>';

      // Give the customer a few seconds to read the confirmation, then
      // collapse the form and take them straight to "My Account" so they
      // can immediately see this exact booking's status — reusing the
      // same OTP verification they just completed, so this doesn't ask
      // them to verify a second time in the same visit.
      const bookedPhone = payload.phone;
      setTimeout(() => {
        closeBookingForm();
        const trackPhoneInput = document.getElementById('trackPhone');
        if (trackPhoneInput) trackPhoneInput.value = bookedPhone;
        if (payload.accessToken) {
          verifiedBookingPhone = bookedPhone;
          verifiedBookingAccessToken = payload.accessToken;
        }
        // FLOW CHANGE: results now open in the Track Booking popup (see
        // trackBtn's click handler below), not the old permanent
        // "Registered Mobile Number" section on the page — nothing to
        // scroll to here anymore.
        document.getElementById('trackBtn')?.click();
      }, 3500);
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message || 'Something went wrong with your booking, please try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  });

  renderCart();
}

function bookingCardHtml(b, showBookAgain) {
  const itemsHtml = (b.items || []).map(it => `
    <div class="row1" style="margin-top:6px;">
      <span>${it.qty}x ${it.applianceName} (${it.typeName}, ${it.serviceType === 'repair' ? 'Repair' : 'Service'})</span>
      <span class="status-pill status-${it.itemStatus}">${it.itemStatus.replace('-', ' ')}</span>
    </div>
    ${it.technicianName ? `<div class="row2">Technician: ${it.technicianName}</div>` : ''}
    ${it.itemStatus === 'completed' && it.completionPhotoUrl ? `<div class="row2"><a href="${it.completionPhotoUrl}" target="_blank" rel="noopener" style="color:var(--blue-600);">📷 View photo of completed work</a></div>` : ''}
    ${it.itemStatus === 'completed' ? ratingHtml(b.id, it) : ''}
  `).join('');
  return `
      <div class="track-order-card">
        <div class="row2" style="font-weight:700;color:var(--blue-900);">Booking ID: ${b.id} · ${b.cityName} · ₹${b.totalPrice} · ${new Date(b.createdAt).toLocaleDateString('en-IN')}</div>
        ${b.timeSlot ? `<div class="row2">🕐 Visit: ${b.bookingDate} · ${b.timeSlot}</div>` : ''}
        ${itemsHtml}
        ${showBookAgain ? `<button type="button" class="btn btn-outline btn-sm" style="margin-top:10px;" onclick="bookAgain('${b.id}')">↻ Book Again</button>` : ''}
      </div>
    `;
}

function ratingHtml(bookingId, item) {
  if (item.rating) {
    const reviewLine = item.reviewText ? `<div class="row2" style="font-style:italic;">"${escapeHtml(item.reviewText)}"</div>` : '';
    return `<div class="row2">Your rating: ${'⭐'.repeat(item.rating)}</div>${reviewLine}`;
  }
  const taskKey = `${bookingId}__${item.id}`;
  const stars = [1, 2, 3, 4, 5].map(n =>
    `<span class="rate-star" data-task="${taskKey}" data-n="${n}" onclick="selectRatingStar('${bookingId}','${item.id}',${n})" title="${n} star${n > 1 ? 's' : ''}">☆</span>`
  ).join('');
  return `
    <div class="row2">Rate this service: <span class="rate-stars" id="stars-${taskKey}">${stars}</span></div>
    <div class="row2" id="reviewBox-${taskKey}" style="display:none;margin-top:6px;">
      <textarea id="reviewText-${taskKey}" maxlength="280" placeholder="Optional: share a quick word about the service (shown on our homepage, no phone number shared)" style="width:100%;min-height:52px;padding:8px;border:1.5px solid var(--line);border-radius:8px;font-family:inherit;font-size:0.85rem;"></textarea>
      <button type="button" class="btn btn-primary btn-sm" style="margin-top:6px;" onclick="submitCustomerRating('${bookingId}','${item.id}')">Submit Rating</button>
    </div>
  `;
}

let pendingRating = {};
function selectRatingStar(bookingId, itemId, rating) {
  const taskKey = `${bookingId}__${itemId}`;
  pendingRating[taskKey] = rating;
  const starsWrap = document.getElementById(`stars-${taskKey}`);
  if (starsWrap) {
    starsWrap.querySelectorAll('.rate-star').forEach(el => {
      el.textContent = Number(el.getAttribute('data-n')) <= rating ? '★' : '☆';
    });
  }
  const box = document.getElementById(`reviewBox-${taskKey}`);
  if (box) box.style.display = 'block';
}

async function submitCustomerRating(bookingId, itemId) {
  const taskKey = `${bookingId}__${itemId}`;
  const rating = pendingRating[taskKey];
  if (!rating) return;
  const phone = document.getElementById('trackPhone').value.trim();
  if (!/^[0-9]{10}$/.test(phone)) {
    alert('Please enter your mobile number above and search first.');
    return;
  }
  const reviewEl = document.getElementById(`reviewText-${taskKey}`);
  const reviewText = reviewEl ? reviewEl.value.trim() : '';
  try {
    await fetchJSON(`/api/bookings/${bookingId}/items/${itemId}/rate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, phone, reviewText })
    });
    // Only happy customers (4-5 stars) get asked to also post on Google —
    // asking unhappy customers would just invite a public bad review, and
    // we only ever link to a real, Admin-verified Google profile.
    if (rating >= 4 && GOOGLE_REVIEW_URL) {
      showGoogleReviewPrompt();
    } else {
      document.getElementById('trackBtn').click();
    }
  } catch (e) {
    alert(e.message || 'Could not submit your rating.');
  }
}

function showGoogleReviewPrompt() {
  const results = document.getElementById('trackResults');
  if (!results) { document.getElementById('trackBtn').click(); return; }
  results.innerHTML = `
    <div class="track-box" style="text-align:center;max-width:440px;margin:0 auto;">
      <div style="font-size:2rem;">🎉</div>
      <h4 style="margin:8px 0 6px;">Thanks for rating us!</h4>
      <p style="color:var(--slate);font-size:0.88rem;margin-bottom:16px;">Glad you had a good experience. Would you mind sharing it on Google too? It takes 30 seconds and really helps other people in your city find us.</p>
      <a href="${GOOGLE_REVIEW_URL}" target="_blank" rel="noopener" class="btn btn-primary btn-block" onclick="document.getElementById('trackBtn').click();">⭐ Rate us on Google</a>
      <button type="button" class="btn btn-outline btn-block" style="margin-top:8px;" onclick="document.getElementById('trackBtn').click();">Maybe later</button>
    </div>
  `;
}

function closeReferModal() {
  const modal = document.getElementById('referModal');
  const body = document.getElementById('referModalBody');
  if (modal) modal.classList.remove('open');
  if (body) body.innerHTML = ''; // truly gone, not just hidden with stale content
}

// Own popup for "Refer a Friend" (same pattern as Track Booking) — opens
// WhatsApp with the referral message pre-filled AND shows the referral
// stats/rewards here, in this one self-contained box, instead of
// reusing the old always-on-page "My Account" section.
async function openReferModal() {
  const acc = getAccount();
  if (!acc) { openAccountGate('account'); return; }
  const modal = document.getElementById('referModal');
  const body = document.getElementById('referModalBody');
  if (!modal || !body) return;
  modal.classList.add('open');
  body.innerHTML = '<p class="spinner-text" style="color:var(--slate);"><span class="spinner-dot"></span>Getting your referral link...</p>';
  // Opened synchronously, before the `await`, so browsers still treat it
  // as a direct result of the tap and don't block it as a pop-up.
  const popup = window.open('', '_blank');
  try {
    const info = await fetchJSON(`/api/referral/my-info?phone=${acc.phone}`);
    if (!info.active) {
      if (popup) popup.close();
      body.innerHTML = '<p style="color:var(--red)">The referral program is not active right now. Please check back later.</p>';
      return;
    }
    const rewardsHtml = info.rewardCoupons && info.rewardCoupons.length
      ? info.rewardCoupons.map(c => `
          <div class="row1" style="padding:8px 0;border-bottom:1px solid var(--line);">
            <span><strong style="color:var(--blue-900);">${escapeHtml(c.code)}</strong> · ₹${c.discountValue} off</span>
            <span class="status-pill ${c.used ? 'status-completed' : 'status-assigned'}">${c.used ? 'Used' : 'Available'}</span>
          </div>
          ${!c.used ? `<div class="row2" style="margin-top:-4px;margin-bottom:6px;">Valid till ${c.expiryDate} — enter this code at checkout on your own next booking.</div>` : ''}
        `).join('')
      : '';
    body.innerHTML = `
      <div class="row2" style="margin-bottom:8px;">Your link: <a href="${info.link}" style="color:var(--blue-600);word-break:break-all;">${info.link}</a></div>
      <div class="row1"><span>People you've referred</span><strong>${info.referredCount || 0}</strong></div>
      <div class="row1"><span>Rewards pending (waiting for their service to complete)</span><strong>${info.pendingCount || 0}</strong></div>
      ${rewardsHtml ? `<div style="margin-top:10px;"><strong style="color:var(--blue-900);font-size:0.88rem;">Your reward coupons</strong>${rewardsHtml}</div>` : `<div class="row2" style="margin-top:8px;">No reward coupons yet — you'll get one automatically once someone you referred completes their first service.</div>`}
    `;
    const shareText = `Hi! I use Seerua Appliance Care for AC/Washing Machine/RO/Fridge repair — book through my link and get ₹${info.referredDiscount} off your first service: ${info.link}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    if (popup) popup.location.href = whatsappUrl;
    else window.open(whatsappUrl, '_blank'); // popup blocked anyway — try once more directly
  } catch (e) {
    if (popup) popup.close();
    body.innerHTML = `<p style="color:var(--red)">${e.message || 'Could not get your referral link. Please try again.'}</p>`;
  }
}

function bindReferModal() {
  document.getElementById('referModalClose')?.addEventListener('click', closeReferModal);
  document.getElementById('referModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'referModal') closeReferModal();
  });
}
bindReferModal();

// ---------------- Track Booking popup (its own box, not a permanent
// section left open on the page) ----------------
function closeTrackBookingModal() {
  const modal = document.getElementById('trackBookingModal');
  const body = document.getElementById('trackBookingModalBody');
  if (modal) modal.classList.remove('open');
  if (body) body.innerHTML = ''; // truly gone, not just hidden with stale content
}

// Thin wrapper reused by the header's "Track Booking" button and the
// Account Gate's 'account' intent — both just need "look up this
// account's phone", and the shared #trackBtn engine above already does
// the OTP-check/fetch/render-into-the-popup work in one place.
function openTrackBookingModal() {
  const acc = getAccount();
  if (!acc) { openAccountGate('account'); return; }
  const trackPhoneInput = document.getElementById('trackPhone');
  if (trackPhoneInput) trackPhoneInput.value = acc.phone;
  verifiedBookingPhone = acc.phone;
  if (acc.accessToken) verifiedBookingAccessToken = acc.accessToken;
  document.getElementById('trackBtn')?.click();
}

function bindTrackBookingModal() {
  document.getElementById('trackBookingModalClose')?.addEventListener('click', closeTrackBookingModal);
  document.getElementById('trackBookingModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'trackBookingModal') closeTrackBookingModal();
  });
}
bindTrackBookingModal();

// My Account — was "Track my booking", now OTP-protected (see the
// matching server-side fix on /api/bookings/track): a customer's booking
// history includes their name, home address, and exact appliance
// details, which anyone could previously read just by typing in any
// 10-digit number. Reuses the exact same OTP flow as placing a booking —
// if this phone was already verified earlier in this session (e.g. they
// just booked something), it's reused instead of asking twice.
let lastTrackedBookings = [];
let knownReferralPhone = null; // set once the customer has looked themselves up in "My Booking", so the referral button doesn't need to ask for the number a second time
document.getElementById('trackBtn').addEventListener('click', async () => {
  const phone = document.getElementById('trackPhone').value.trim();
  // FLOW CHANGE: results render into the Track Booking popup, not the
  // old always-on-page "Registered Mobile Number" box (that box, and
  // its results div, are now permanently hidden — see .track-box in
  // the template). This one popup is the single display surface for
  // every path that leads here: header "Track Booking", after placing
  // a booking, or a "rate your service" SMS/WhatsApp link.
  const modal = document.getElementById('trackBookingModal');
  const results = document.getElementById('trackBookingModalBody');
  if (modal) modal.classList.add('open');
  if (!/^[0-9]{10}$/.test(phone)) {
    results.innerHTML = '<p style="color:var(--red)">Please enter a valid 10 digit mobile number.</p>';
    return;
  }
  try {
    let accessToken;
    if (verifiedBookingPhone === phone && verifiedBookingAccessToken) {
      accessToken = verifiedBookingAccessToken; // already verified this number earlier in this visit
    } else {
      // Same check as everywhere else OTP is used (Account Gate, Add to
      // Booking, booking submit) — a number already verified before, or
      // OTP turned OFF in Admin Panel, skips straight through with no
      // popup. Previously this always tried to open the OTP widget
      // regardless of that setting, which hung forever whenever OTP
      // wasn't configured.
      let phoneAlreadyVerified = false;
      try {
        const check = await fetchJSON(`/api/phone-verified?phone=${phone}`);
        phoneAlreadyVerified = !!check.verified;
      } catch (e) { /* fall back to normal OTP flow */ }

      let otpEnabled = true;
      try {
        const cfg = await ensureOtpConfig();
        otpEnabled = cfg.enabled !== false;
      } catch (e) { /* fall back to normal OTP flow */ }

      if (otpEnabled && !phoneAlreadyVerified) {
        results.innerHTML = '<p style="color:var(--slate);">Please complete the OTP verification that just opened.</p>';
        accessToken = await verifyPhoneWithOtp(phone);
      }
      verifiedBookingPhone = phone;
      verifiedBookingAccessToken = accessToken;
    }
    results.innerHTML = '<p class="spinner-text" style="color:var(--slate);"><span class="spinner-dot"></span>Searching...</p>';
    const bookings = await fetchJSON(`/api/bookings/track?phone=${phone}&accessToken=${encodeURIComponent(accessToken || '')}`);
    lastTrackedBookings = bookings;
    knownReferralPhone = phone; // so the header's "Refer a Friend" doesn't need to ask for the number again
    results.innerHTML = bookings.length ? bookings.map(b => bookingCardHtml(b, true)).join('') : '<p>No bookings found for this number.</p>';
  } catch (e) {
    results.innerHTML = `<p style="color:var(--red)">${e.message || 'Something went wrong, please try again.'}</p>`;
  }
});

// One-click reorder: pre-fill the booking form from a past booking
function bookAgain(bookingId) {
  const b = lastTrackedBookings.find(x => x.id === bookingId);
  if (!b) return;
  closeTrackBookingModal(); // "Book Again" tapped from the popup — close it so it doesn't sit on top of the booking form
  document.getElementById('fName').value = b.name;
  document.getElementById('fPhone').value = b.phone;
  document.getElementById('fAddress').value = b.address;
  document.getElementById('fCity').value = b.cityId;
  refreshAppliancesForCity(b.cityId);

  cartItems = (b.items || []).map(it => ({
    applianceId: it.applianceId, applianceName: it.applianceName,
    typeId: it.typeId, typeName: it.typeName,
    serviceType: it.serviceType, qty: it.qty, problem: '',
    unitPrice: it.unitPrice, lineTotal: it.unitPrice * it.qty
  }));
  appliedCoupon = null;
  document.getElementById('couponCode').value = '';
  renderCart();
  selectedSlotId = null;
  refreshSlots();

  const msg = document.getElementById('formMsg');
  msg.className = 'form-msg success';
  msg.textContent = 'Your saved details and past items have been filled in. Please pick a fresh date and time slot, then confirm below.';

  openBookingForm();
}

// FAQ accordion
document.querySelectorAll('.faq-item').forEach(item => {
  item.querySelector('.faq-q').addEventListener('click', () => {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});
const faqMoreBtn = document.getElementById('faqMoreBtn');
if (faqMoreBtn) {
  // BUG FIX: this used to be one-way — clicking it revealed the extra
  // questions and then removed itself, with no way to collapse them back
  // down again. Now toggles between "+ More questions" and "- Show less".
  let faqExpanded = false;
  faqMoreBtn.addEventListener('click', () => {
    faqExpanded = !faqExpanded;
    document.querySelectorAll('.faq-item-extra').forEach(item => { item.style.display = faqExpanded ? '' : 'none'; });
    faqMoreBtn.innerHTML = faqExpanded ? '<span class="plus">−</span> Show less' : '<span class="plus">+</span> More questions';
  });
}

// ---------------- OTP verification (used at booking time) ----------------
let OTP_CONFIG = null;
let otpScriptLoaded = false;

function loadOtpScript(urls) {
  return new Promise((resolve, reject) => {
    if (otpScriptLoaded && typeof window.initSendOTP === 'function') return resolve();
    let i = 0;
    function attempt() {
      const s = document.createElement('script');
      s.src = urls[i];
      s.async = true;
      s.onload = () => {
        if (typeof window.initSendOTP === 'function') {
          otpScriptLoaded = true;
          resolve();
        } else {
          reject(new Error('OTP service did not load correctly.'));
        }
      };
      s.onerror = () => {
        i++;
        if (i < urls.length) attempt();
        else reject(new Error('Could not load OTP service. Check your internet connection.'));
      };
      document.head.appendChild(s);
    }
    attempt();
  });
}

async function ensureOtpConfig() {
  if (!OTP_CONFIG) OTP_CONFIG = await fetchJSON('/api/otp-config');
  return OTP_CONFIG;
}

// BUG FIX: calling window.initSendOTP({exposeMethods: true, ...}) does NOT
// attach window.sendOtp/verifyOtp/retryOtp synchronously — MSG91's widget
// does its own async setup first (fetching the widget's config from their
// servers) before those methods exist. Calling window.sendOtp immediately
// afterward, with no wait, hits "window.sendOtp is not a function" almost
// every time. This polls briefly until they're actually attached (or
// times out with a clear error, e.g. if the Widget ID/Token in Admin
// Panel are wrong and the widget never finishes initializing at all).
function waitForOtpMethods(timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function') {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('OTP service did not initialize in time. In Admin Panel, double-check the Widget ID / Token, and on your MSG91 dashboard make sure this website\'s domain is whitelisted for that widget.'));
      } else {
        setTimeout(poll, 150);
      }
    })();
  });
}

// Opens the MSG91 OTP widget for the given phone number and resolves with
// the verified access-token once the customer completes the OTP step.
// FLOW CHANGE / BUG FIX: this used to configure MSG91 with
// `exposeMethods: false`, which relies entirely on MSG91's own built-in
// popup to actually show the OTP entry box to the customer — and that
// built-in popup was confirmed to send real SMS OTPs but never actually
// render any visible UI on screen (see the comment on #otpEntryModal
// below, which was built for exactly this reason but was never actually
// wired up to anything, so it sat unused while the invisible built-in
// popup kept being relied on underneath it). The customer would type
// their number, the OTP would genuinely be sent, and then... nothing —
// no popup to enter it into, so the promise never resolved and the flow
// just sat there forever with no visible progress.
//
// Now uses MSG91's `exposeMethods: true` mode instead, which suppresses
// MSG91's own popup entirely and hands us `window.sendOtp` /
// `window.verifyOtp` / `window.retryOtp` to drive #otpEntryModal (our
// own, always-visible modal) directly.
function verifyPhoneWithOtp(phone) {
  return new Promise(async (resolve, reject) => {
    const modal = document.getElementById('otpEntryModal');
    const phoneEl = document.getElementById('otpEntryPhone');
    const codeEl = document.getElementById('otpEntryCode');
    const msgEl = document.getElementById('otpEntryMsg');
    const submitBtn = document.getElementById('otpEntrySubmit');
    const resendBtn = document.getElementById('otpEntryResend');
    const closeBtn = document.getElementById('otpEntryClose');
    if (!modal || !phoneEl || !codeEl || !msgEl || !submitBtn || !resendBtn || !closeBtn) {
      reject(new Error('OTP entry is not available on this page.'));
      return;
    }

    let settled = false;
    const cleanup = () => {
      modal.classList.remove('open');
      codeEl.value = '';
      msgEl.className = 'form-msg';
      msgEl.textContent = '';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Verify';
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend Code';
      submitBtn.removeEventListener('click', onSubmit);
      resendBtn.removeEventListener('click', onResend);
      closeBtn.removeEventListener('click', onClose);
      codeEl.removeEventListener('keydown', onKeydown);
    };
    const finishResolve = (token) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(token);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    function onSubmit() {
      const code = codeEl.value.trim();
      if (!/^[0-9]{4,6}$/.test(code)) {
        msgEl.className = 'form-msg error';
        msgEl.textContent = 'Please enter the code you received.';
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying...';
      msgEl.className = 'form-msg';
      msgEl.textContent = '';
      window.verifyOtp(code, (data) => {
        const accessToken = data && (data.message || data.token || data['access-token']);
        if (!accessToken) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Verify';
          msgEl.className = 'form-msg error';
          msgEl.textContent = 'Verification succeeded but no token was received. Please try again.';
          return;
        }
        finishResolve(accessToken);
      }, () => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Verify';
        msgEl.className = 'form-msg error';
        msgEl.textContent = 'Incorrect or expired code. Please try again.';
      });
    }
    function onKeydown(e) { if (e.key === 'Enter') onSubmit(); }

    async function onResend() {
      resendBtn.disabled = true;
      resendBtn.textContent = 'Resending...';
      msgEl.className = 'form-msg';
      msgEl.textContent = '';
      // SAFETY NET: if retryOtp's callbacks never fire for any reason
      // (as happened when the channel arg was `undefined` instead of
      // the required `null` — fixed below, but this guards against any
      // similar silent-hang case in the future), don't leave the button
      // stuck on "Resending..." forever.
      let settledResend = false;
      const resendTimeout = setTimeout(() => {
        if (settledResend) return;
        settledResend = true;
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Code';
        msgEl.className = 'form-msg error';
        msgEl.textContent = 'Resend timed out. Please try again.';
      }, 15000);
      // BUG FIX: MSG91's docs specify the channel argument must be the
      // literal `null` for "use the widget's default channel" — passing
      // `undefined` instead makes the widget hang silently (neither
      // success nor failure ever fires), which is exactly what was seen
      // stuck on "Resending...".
      window.retryOtp(null, () => {
        if (settledResend) return;
        settledResend = true;
        clearTimeout(resendTimeout);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Code';
        msgEl.className = 'form-msg success';
        msgEl.textContent = 'A new code has been sent.';
      }, (error) => {
        if (settledResend) return;
        settledResend = true;
        clearTimeout(resendTimeout);
        console.log('OTP resend failure:', error);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Code';
        msgEl.className = 'form-msg error';
        const detail = (error && (error.message || error.type || (typeof error === 'string' ? error : JSON.stringify(error)))) || 'Unknown error';
        msgEl.textContent = `Could not resend the code: ${detail}.`;
      });
    }

    function onClose() {
      finishReject(new Error('OTP verification was cancelled.'));
    }

    submitBtn.addEventListener('click', onSubmit);
    resendBtn.addEventListener('click', onResend);
    closeBtn.addEventListener('click', onClose);
    codeEl.addEventListener('keydown', onKeydown);

    try {
      const cfg = await ensureOtpConfig();
      if (!cfg.widgetId || !cfg.tokenAuth) {
        finishReject(new Error('OTP is turned ON but the Widget ID / Token are not set in Admin Panel > OTP Settings. Add them there first.'));
        return;
      }
      await loadOtpScript(['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js']);
      const identifier = '91' + phone; // MSG91 requires country code, no '+' or spaces
      phoneEl.textContent = phone;
      modal.classList.add('open');
      msgEl.className = 'form-msg';
      msgEl.textContent = 'Sending code...';
      codeEl.focus();
      window.initSendOTP({
        widgetId: cfg.widgetId,
        tokenAuth: cfg.tokenAuth,
        // BUG FIX: 'identifier' was passed here AND again in the
        // explicit window.sendOtp(identifier, ...) call just below —
        // per MSG91's own docs, identifier here is only optional/for
        // their own (unused, since exposeMethods:true) UI flow, while
        // sendOtp() is what actually, genuinely sends the OTP. Having
        // it in both places was very likely triggering two separate
        // sends for one tap — exactly matching two different OTP codes
        // arriving in two separate SMS for a single "Send OTP" tap.
        exposeMethods: true,
        success: (data) => {
          // Some widget versions call this directly rather than via the
          // verifyOtp callback below — handled the same way either way.
          const accessToken = data && (data.message || data.token || data['access-token']);
          if (accessToken) finishResolve(accessToken);
        },
        failure: (error) => { console.log('OTP failure:', error); }
      });
      await waitForOtpMethods(10000);
      msgEl.className = 'form-msg';
      msgEl.textContent = 'Sending code...';
      let settledSend = false;
      const sendTimeout = setTimeout(() => {
        if (settledSend) return;
        settledSend = true;
        msgEl.className = 'form-msg error';
        msgEl.textContent = 'Sending the code timed out. Tap "Resend Code" to try again.';
      }, 15000);
      window.sendOtp(identifier, () => {
        if (settledSend) return;
        settledSend = true;
        clearTimeout(sendTimeout);
        msgEl.className = 'form-msg';
        msgEl.textContent = '';
      }, (error) => {
        if (settledSend) return;
        settledSend = true;
        clearTimeout(sendTimeout);
        console.log('OTP send failure:', error);
        msgEl.className = 'form-msg error';
        // Surfaces MSG91's actual failure reason on screen (not just a
        // generic message) so it can be screenshotted/read directly —
        // this is genuine diagnostic info (wrong DLT template, domain
        // not whitelisted, low balance, etc.), not something to hide.
        const detail = (error && (error.message || error.type || (typeof error === 'string' ? error : JSON.stringify(error)))) || 'Unknown error';
        msgEl.textContent = `Could not send the code: ${detail}. Tap "Resend Code" to try again.`;
      });
    } catch (err) {
      finishReject(err);
    }
  });
}
// ---------------- Bottom navigation — Cart button (homepage only) ----------------
// Support/City/Menu sheet wiring lives in chatbot.js (loaded on every
// page — homepage, city pages, appliance+city pages) so it works
// identically everywhere without duplicating that logic here. Only the
// Cart button is genuinely homepage-specific (only this page has a real
// cart), so only it is wired here — see the data-has-cart="true"
// attribute on the button in the template, which chatbot.js checks to
// know to skip binding its own generic fallback for this button.
function updateBottomNavCartBadge() {
  const badge = document.getElementById('bottomNavCartBadge');
  if (!badge) return;
  // BUG FIX: during a standalone Quick Book (direct-book) session, the
  // item being booked is technically appended to cartItems (for code
  // reuse with the normal Add-to-cart flow), but it isn't really "in the
  // cart" from the customer's point of view — it's a separate, one-off
  // direct booking. The bottom-nav cart badge used to count it anyway,
  // showing a number even during what's meant to be a cart-free flow.
  // Only count real, pre-existing cart items here.
  const count = quickBookViewStartIndex !== null
    ? quickBookViewStartIndex
    : ((typeof cartItems !== 'undefined') ? cartItems.length : 0);
  badge.textContent = count;
  badge.hidden = count === 0;
}

function bindBottomNav() {
  const cartBtn = document.getElementById('bottomNavCartBtn');
  if (cartBtn) {
    cartBtn.addEventListener('click', () => {
      document.querySelectorAll('.bottom-sheet-backdrop.open').forEach(el => el.classList.remove('open'));
      document.getElementById('bottomNavSupportBtn')?.classList.remove('open');
      document.getElementById('supportFanOut')?.classList.remove('open');
      quickBookViewStartIndex = null;
      renderCart();
      if (cartItems.length) {
        openBookingForm();
        hideRedundantBookingFields();
      } else {
        const services = document.getElementById('services');
        if (services) services.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }
  updateBottomNavCartBadge();
}

// ---------------- Quick Book modal (per-appliance city→type→price flow) ----------------
// Opened by tapping an appliance card. This is a friendlier front end
// that populates the SAME hidden fields (#fCity, #fAppliance, #fType,
// #fServiceType, #fPhone) and calls the SAME addItemToCart()/OTP logic
// already built and tested for the main booking form — "Book" simply
// reveals that form afterward for the remaining name/address/date/slot
// fields, rather than re-implementing that logic a second time here.

// Short, real feature bullets per appliance (not auto-generated from
// serviceProcess text, which is too long/prose-y for a checklist) —
// matches the reference layout's short tick-mark list style.
const QB_CHECKLISTS = {
  a1: ['Foam-jet wash of the indoor and outdoor units', 'High-pressure water flush of the cooling coil', 'Refrigerant pressure and leak check', 'Cooling tested before the technician leaves', 'Ongoing support for any follow-up questions'],
  a2: ['Drum cleaned thoroughly inside and out', 'Drain path and motor checked for smooth running', 'Worn parts flagged before they cause bigger issues', 'Machine run-tested after the work is done', 'Support available if anything comes up later'],
  a3: ['Filters and membrane checked for wear', 'Full system flushed and sanitized', 'Water flow rate and TDS level checked', 'Machine run-tested after the work is done', 'Support available if anything comes up later'],
  a4: ['Cooling and compressor performance checked', 'Door seals checked for a proper, tight fit', 'Interior given a thorough clean', 'Machine run-tested after the work is done', 'Support available if anything comes up later']
};

let qbApplianceId = null;
let qbSelectedTypeId = null;
let qbServiceType = 'service';
let qbSkuOverride = null; // { price, skuName } — set when adding a specific service-list SKU
// When set (to an index into cartItems), the cart display/submit only
// shows/books items from that index onward — used so "Book" behaves as
// a standalone single-item checkout, completely separate from whatever
// was already sitting in the cart from earlier "Add" actions. Reset to
// null (showing the full cart again) whenever "Add" or the bottom-nav
// Cart button is used instead.
let quickBookViewStartIndex = null;

// Hides the two fields that are redundant once a customer arrives here
// via Quick Book's "Book" action — city was already chosen there, and
// the appliance/type/etc. box was already filled+submitted there too.
// What's left visible: the cart summary (so they can see exactly what
// they're paying for), Payment Summary, coupon, and Name/Address/Date/
// Slot — a much shorter checkout than filling the whole form from
// scratch.
function hideRedundantBookingFields() {
  const cityField = document.getElementById('fCityField');
  if (cityField) cityField.style.display = 'none';
  const addBox = document.querySelector('.cart-add-box');
  if (addBox) addBox.style.display = 'none';
}

// ---------------- Unified Account Gate (Booking + My Account + Instant
// Booking all share this) ----------------
// One chain: Mobile Number -> OTP verify -> (new customers only) Add
// Address. Saving the address is what actually "creates the account".
// Once an account is saved (localStorage, keyed per-browser — this is a
// customer convenience, not a security boundary; the server still
// independently re-checks OTP verification on every real action), every
// later visit to Booking, My Account, or Instant Booking skips straight
// past all of this and goes directly to item selection / account
// history, exactly as requested.
const ACCOUNT_STORAGE_KEY = 'seerua_account_v1';

function getAccount() {
  try {
    const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
    const acc = raw ? JSON.parse(raw) : null;
    return (acc && /^[0-9]{10}$/.test(acc.phone) && acc.name && acc.address && acc.cityId) ? acc : null;
  } catch (e) { return null; }
}
function saveAccount(acc) {
  try { localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(acc)); } catch (e) { /* private/incognito mode, etc. — chain still works, just won't be remembered next visit */ }
  updateHeaderAccountUI();
}
function clearAccount() {
  try { localStorage.removeItem(ACCOUNT_STORAGE_KEY); } catch (e) {}
  verifiedBookingPhone = null;
  verifiedBookingAccessToken = null;
  updateHeaderAccountUI();
}

// Header icon: plain person icon with no account, a filled circle with
// the customer's name-initial once one exists (see saveAccount/
// clearAccount above, and the "Logout" menu item below).
function updateHeaderAccountUI() {
  const btn = document.getElementById('headerAccountBtn');
  const icon = document.getElementById('headerAccountIcon');
  const initialEl = document.getElementById('headerAccountInitial');
  if (!btn) return;
  const acc = getAccount();
  if (acc && acc.name) {
    btn.classList.add('has-account');
    if (icon) icon.style.display = 'none';
    if (initialEl) { initialEl.style.display = 'block'; initialEl.textContent = acc.name.trim().charAt(0).toUpperCase(); }
  } else {
    btn.classList.remove('has-account');
    if (icon) icon.style.display = '';
    if (initialEl) initialEl.style.display = 'none';
  }
}

function bindHeaderAccountMenu() {
  const wrap = document.getElementById('headerAccountWrap');
  const btn = document.getElementById('headerAccountBtn');
  const menu = document.getElementById('headerAccountMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const acc = getAccount();
    if (!acc) {
      // No account yet — go straight into the Account Gate instead of
      // showing a menu with nothing useful in it yet.
      openAccountGate('account');
      return;
    }
    menu.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (menu.classList.contains('open') && !wrap.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  document.getElementById('headerAccountTrackBtn')?.addEventListener('click', () => {
    menu.classList.remove('open');
    openTrackBookingModal();
  });

  // One-tap "Refer a Friend" straight from the account menu — its own
  // popup (same pattern as Track Booking), not the old always-on-page
  // section.
  document.getElementById('headerAccountReferBtn')?.addEventListener('click', () => {
    menu.classList.remove('open');
    openReferModal();
  });

  document.getElementById('headerAccountLogoutBtn')?.addEventListener('click', () => {
    menu.classList.remove('open');
    clearAccount();
    // Reset the booking form's fields too, in case it's open right now
    // with the previous account's (now logged-out) details still showing.
    const nameEl = document.getElementById('fName');
    const addrEl = document.getElementById('fAddress');
    if (nameEl) { nameEl.value = ''; nameEl.readOnly = false; }
    if (addrEl) { addrEl.value = ''; addrEl.readOnly = false; }
    const editBtn = document.getElementById('editAddressBtn');
    if (editBtn) editBtn.style.display = 'none';
    showToast('Logged out');
  });
}
bindHeaderAccountMenu();
updateHeaderAccountUI();

let agIntent = null; // 'booking' | 'account' | 'quickbook'
let agPendingApplianceId = null;
let agEditMode = false;

// Pushes a known account's details into the shared hidden fields the
// rest of the app (cart, submit, Quick Book) already reads from, and
// marks this phone pre-verified for the session so the existing OTP
// checks in addItemToCart()/the booking submit skip straight through
// instead of asking a second time.
function applyAccountToBookingFields(acc) {
  const phoneEl = document.getElementById('fPhone');
  const nameEl = document.getElementById('fName');
  const addrEl = document.getElementById('fAddress');
  const cityEl = document.getElementById('fCity');
  if (phoneEl) phoneEl.value = acc.phone;
  if (nameEl) { nameEl.value = acc.name; nameEl.readOnly = true; }
  if (addrEl) { addrEl.value = acc.address; addrEl.readOnly = true; }
  if (cityEl && acc.cityId && cityEl.value !== acc.cityId) { cityEl.value = acc.cityId; refreshAppliancesForCity(acc.cityId); }
  const editBtn = document.getElementById('editAddressBtn');
  if (editBtn) editBtn.style.display = 'inline-block';
  verifiedBookingPhone = acc.phone;
  if (acc.accessToken) verifiedBookingAccessToken = acc.accessToken;
}

function openAccountGate(intent, applianceId) {
  agIntent = intent;
  agPendingApplianceId = applianceId || null;
  agEditMode = false;
  const acc = getAccount();
  if (acc) {
    proceedAfterAccountGate(acc);
    return;
  }
  document.getElementById('agPhoneMsg').textContent = '';
  document.getElementById('agPhone').value = '';
  document.getElementById('agPhoneStep').style.display = 'block';
  document.getElementById('agAddressStep').style.display = 'none';
  const title = document.getElementById('agPhoneTitle');
  const sub = document.getElementById('agPhoneSub');
  if (title) title.textContent = 'Welcome 👋';
  if (sub) sub.textContent = intent === 'account' ? 'Enter your mobile number for My Account' : 'Enter your mobile number for booking';
  document.getElementById('accountGateModal').classList.add('open');
}

function closeAccountGate() {
  document.getElementById('accountGateModal').classList.remove('open');
}

// Called once the phone+address chain is fully complete (either just
// now, or already done on an earlier visit) — sends the customer
// straight on to whatever they originally asked for. This is the
// "chain advances itself" part: no extra taps needed in between.
function proceedAfterAccountGate(acc) {
  closeAccountGate();
  if (agIntent === 'account') {
    // FLOW CHANGE: opens the Track Booking popup directly — no more
    // revealing the old permanent on-page section first.
    const trackPhoneInput = document.getElementById('trackPhone');
    if (trackPhoneInput) trackPhoneInput.value = acc.phone;
    verifiedBookingPhone = acc.phone;
    if (acc.accessToken) verifiedBookingAccessToken = acc.accessToken;
    document.getElementById('trackBtn')?.click();
  } else if (agIntent === 'quickbook') {
    applyAccountToBookingFields(acc);
    openQuickBookModalReal(agPendingApplianceId);
  } else {
    openBookingForm();
    applyAccountToBookingFields(acc);
  }
}

function bindAccountGateModal() {
  document.getElementById('accountGateClose').addEventListener('click', closeAccountGate);
  document.getElementById('accountGateModal').addEventListener('click', (e) => {
    if (e.target.id === 'accountGateModal') closeAccountGate();
  });

  // FLOW CHANGE (back to manual, per explicit request): typing the
  // number alone no longer auto-fires this — a tap on "Send OTP" does.
  // Editing the number after a failed attempt and tapping Send OTP
  // again is a fresh, deliberate attempt (agSending only blocks a
  // second tap while one is already in flight, via the button's own
  // disabled state below).
  let agSending = false;
  async function attemptAccountGateVerification() {
    if (agSending) return;
    const msg = document.getElementById('agPhoneMsg');
    const phone = document.getElementById('agPhone').value.trim();
    const btn = document.getElementById('agSendBtn');
    if (!/^[0-9]{10}$/.test(phone)) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please enter a valid 10 digit mobile number.';
      return;
    }
    agSending = true;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    msg.className = 'form-msg';
    msg.textContent = '';
    try {
      // Same check every other OTP entry point in this app already does
      // (addItemToCart, the booking submit, My Account) — a number
      // already verified before, or OTP turned OFF in Admin Panel, skips
      // straight through with no popup at all.
      let phoneAlreadyVerified = false;
      try {
        const check = await fetchJSON(`/api/phone-verified?phone=${phone}`);
        phoneAlreadyVerified = !!check.verified;
      } catch (e) { /* fall back to normal OTP flow */ }

      let otpEnabled = true;
      try {
        const cfg = await ensureOtpConfig();
        otpEnabled = cfg.enabled !== false;
      } catch (e) { /* fall back to normal OTP flow */ }

      let accessToken = null;
      if (otpEnabled && !phoneAlreadyVerified) {
        msg.textContent = 'Sending OTP — please complete the verification that just opened.';
        accessToken = await verifyPhoneWithOtp(phone);
      }
      verifiedBookingPhone = phone;
      verifiedBookingAccessToken = accessToken;
      msg.textContent = 'Verified! Checking your details...';
      let lookup = { found: false };
      try { lookup = await fetchJSON(`/api/customer-lookup?phone=${phone}`); } catch (e) { /* fall through to Add Address either way */ }
      if (lookup.found && lookup.name && lookup.address && lookup.cityId) {
        // Already has an account/past address on file — nothing more to
        // ask, the chain jumps straight to whatever they came here for.
        const acc = { phone, name: lookup.name, address: lookup.address, cityId: lookup.cityId, accessToken };
        saveAccount(acc);
        proceedAfterAccountGate(acc);
      } else {
        // Brand new number — one more step (Add Address) before the
        // account actually exists. This step opens itself — no tap
        // needed to get here.
        document.getElementById('agPhoneStep').style.display = 'none';
        document.getElementById('agAddressStep').style.display = 'block';
        document.getElementById('agName').value = lookup.name || '';
        document.getElementById('agAddress').value = lookup.address || '';
        populateSelect(document.getElementById('agCity'), CITIES, 'Select city');
        if (lookup.cityId) document.getElementById('agCity').value = lookup.cityId;
        document.getElementById('agAddressMsg').textContent = '';
      }
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message || 'OTP verification failed. Please try again.';
    } finally {
      agSending = false;
      btn.disabled = false;
      btn.textContent = 'Send OTP';
    }
  }
  document.getElementById('agSendBtn').addEventListener('click', attemptAccountGateVerification);

  document.getElementById('agSaveBtn').addEventListener('click', async () => {
    const msg = document.getElementById('agAddressMsg');
    const existingAcc = getAccount();
    const phone = document.getElementById('agPhone').value.trim() || (existingAcc && existingAcc.phone) || verifiedBookingPhone;
    const name = document.getElementById('agName').value.trim();
    const address = document.getElementById('agAddress').value.trim();
    const cityId = document.getElementById('agCity').value;
    if (!phone) { msg.className = 'form-msg error'; msg.textContent = 'Please verify your mobile number first.'; return; }
    if (!name) { msg.className = 'form-msg error'; msg.textContent = 'Please enter your name.'; return; }
    if (!address) { msg.className = 'form-msg error'; msg.textContent = 'Please enter your full address.'; return; }
    if (!cityId) { msg.className = 'form-msg error'; msg.textContent = 'Please select your city.'; return; }
    const btn = document.getElementById('agSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    msg.className = 'form-msg';
    msg.textContent = '';
    try {
      await fetchJSON('/api/customer-profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name, address, cityId, accessToken: verifiedBookingAccessToken || undefined })
      });
      const acc = { phone, name, address, cityId, accessToken: verifiedBookingAccessToken };
      saveAccount(acc);
      if (agEditMode) {
        closeAccountGate();
        applyAccountToBookingFields(acc);
      } else {
        proceedAfterAccountGate(acc);
      }
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message || 'Could not save your address. Please try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });

  document.getElementById('editAddressBtn')?.addEventListener('click', () => {
    const acc = getAccount();
    if (!acc) return;
    agEditMode = true;
    document.getElementById('agAddressTitle').textContent = 'Edit Address';
    document.getElementById('agPhoneStep').style.display = 'none';
    document.getElementById('agAddressStep').style.display = 'block';
    document.getElementById('agName').value = acc.name || '';
    document.getElementById('agAddress').value = acc.address || '';
    populateSelect(document.getElementById('agCity'), CITIES, 'Select city');
    if (acc.cityId) document.getElementById('agCity').value = acc.cityId;
    document.getElementById('agAddressMsg').textContent = '';
    document.getElementById('accountGateModal').classList.add('open');
  });
}
bindAccountGateModal();

// Instant Booking entry point (tapping an appliance card) — now gated by
// the same shared Account Gate as Booking/My Account, per the unified
// flow. Once an account exists this is completely transparent: the
// modal below (openQuickBookModalReal) opens immediately with the
// mobile number field already filled in and hidden.
function openQuickBookModal(applianceId) {
  if (BOOKING_PAUSED_STATUS && BOOKING_PAUSED_STATUS.bookingPaused) {
    // Don't open the modal at all — reveal the existing "not accepting
    // bookings" notice instead, right at the moment someone tries to
    // start, rather than letting them go through city/service selection
    // only to be turned away at the very end. openBookingForm() un-hides
    // the wrapper this notice lives inside (it's hidden by default until
    // someone starts booking) and scrolls to it in one step.
    if (typeof openBookingForm === 'function') openBookingForm();
    return;
  }
  const acc = getAccount();
  if (!acc) {
    openAccountGate('quickbook', applianceId);
    return;
  }
  applyAccountToBookingFields(acc);
  openQuickBookModalReal(applianceId);
}

function openQuickBookModalReal(applianceId) {
  qbApplianceId = applianceId;
  qbServiceType = 'service';
  const modal = document.getElementById('quickBookModal');
  const cityStep = document.getElementById('qbCityStep');
  const detailsStep = document.getElementById('qbDetailsStep');
  const msg = document.getElementById('qbMsg');
  if (msg) { msg.className = 'form-msg'; msg.textContent = ''; }
  // FLOW CHANGE: the mobile number field is hidden (see #qbPhoneField in
  // the template) — by the time this runs, openQuickBookModal() has
  // already gated on the shared account, so it's filled in from there
  // instead of typed here.
  const qbPhoneEl = document.getElementById('qbPhone');
  const qbAcc = getAccount();
  if (qbPhoneEl) qbPhoneEl.value = qbAcc ? qbAcc.phone : '';

  const existingCity = document.getElementById('fCity').value;
  if (existingCity) {
    // Already have a city from earlier in this session — skip straight
    // to the details step instead of asking again.
    cityStep.style.display = 'none';
    detailsStep.style.display = 'block';
    qbShowDetails();
  } else {
    cityStep.style.display = 'block';
    detailsStep.style.display = 'none';
    const citySelect = document.getElementById('qbCitySelect');
    populateSelect(citySelect, CITIES, 'Select city');
  }
  modal.classList.add('open');
}

function closeQuickBookModal() {
  document.getElementById('quickBookModal').classList.remove('open');
}

// Small, self-dismissing confirmation toast — used when the Quick Book
// modal closes right after "Add" so the person still gets clear feedback
// that it worked, even though the modal (and its inline message) is gone.
// Top-level (not nested inside bindQuickBookModal) so both qbAddService
// and qbAddBtn's own click handler can call it.
function showToast(text) {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.className = 'global-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.remove('show');
  // Force a reflow so re-triggering the animation works even if a toast
  // is already showing when a second one comes in quick succession.
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

async function qbShowDetails() {
  const appliance = APPLIANCES.find(a => a.id === qbApplianceId);
  if (!appliance) {
    // BUG FIX: this used to just silently `return` here, leaving whatever
    // was already in the modal (often its default empty/blank placeholder
    // markup) on screen with no explanation. This is the "appliance isn't
    // served in this city at all" case — a step earlier than "no pricing
    // set for it" (which qbUpdatePrice/qbRenderServicesList already
    // handle) — same friendly notice applies here too.
    document.getElementById('qbApplianceTitle').textContent = 'Service';
    document.getElementById('qbTypeTabs').innerHTML = '';
    qbSetNotAvailable(true);
    return;
  }
  qbSetNotAvailable(false); // clear any notice left over from a previous appliance in this same modal session
  document.getElementById('qbApplianceTitle').textContent = appliance.name + ' Service';
  document.getElementById('qbPriceImg').src = appliance.photoUrl || '';
  document.getElementById('qbPriceImg').alt = appliance.name;

  const tabsEl = document.getElementById('qbTypeTabs');
  tabsEl.innerHTML = appliance.types.map((t, i) =>
    `<button type="button" data-type="${t.id}" class="${i === 0 ? 'active' : ''}">${t.name}</button>`
  ).join('');
  qbSelectedTypeId = appliance.types[0] ? appliance.types[0].id : null;

  tabsEl.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      qbSelectedTypeId = btn.getAttribute('data-type');
      qbRenderForSelectedType();
    });
  });

  qbRenderForSelectedType();
}

// Decides which view to show for the currently-selected type: the new
// scrollable multi-service list (when the type has one defined, e.g.
// AC's Service/Repair/Installation/Uninstallation/Gas Filling) or the
// original single price-card fallback (everything else for now).
async function qbRenderForSelectedType() {
  const appliance = APPLIANCES.find(a => a.id === qbApplianceId);
  const type = appliance ? appliance.types.find(t => t.id === qbSelectedTypeId) : null;
  const servicesList = document.getElementById('qbServicesList');
  const singleView = document.getElementById('qbSingleServiceView');
  qbSetNotAvailable(false); // clear any "not available" notice left over from switching appliance/type tabs

  if (type && Array.isArray(type.services) && type.services.length) {
    singleView.style.display = 'none';
    servicesList.style.display = 'grid';
    await qbRenderServicesList(type);
  } else {
    servicesList.style.display = 'none';
    singleView.style.display = 'block';
    document.getElementById('qbChecklist').innerHTML =
      (QB_CHECKLISTS[qbApplianceId] || ['Trained Technician', 'Transparent Pricing', 'Final Performance Check After Work', 'Full Support'])
        .map(item => `<li>${item}</li>`).join('');
    qbUpdatePrice();
  }
}

async function qbRenderServicesList(type) {
  const listEl = document.getElementById('qbServicesList');
  const cityId = document.getElementById('fCity').value;
  const appliance = APPLIANCES.find(a => a.id === qbApplianceId);
  const city = CITIES.find(c => c.id === cityId);
  const cityLabel = city ? city.name : 'Your City';
  listEl.innerHTML = '<p style="text-align:center;color:var(--slate);padding:20px;">Loading prices…</p>';
  if (!cityId) return;

  let row;
  try {
    row = await fetchJSON(`/api/price?cityId=${cityId}&applianceId=${qbApplianceId}&typeId=${type.id}`);
  } catch (e) {
    // Same "not available" notice as the single-service view — this
    // appliance/type has no pricing set up for the selected city.
    listEl.innerHTML = '';
    listEl.style.display = 'none';
    qbSetNotAvailable(true);
    return;
  }
  const servicePrices = row.servicePrices || {};

  listEl.innerHTML = type.services.map(svc => {
    const price = servicePrices[svc.id];
    const priceDisplay = typeof price === 'number'
      ? (() => { const mrp = Math.round((price * 1.2) / 10) * 10; return `<span class="qb-price-tag">🏷️</span><span class="qb-price-strike">₹${mrp}</span><span class="qb-price-now">₹${price}</span>`; })()
      : '<span class="qb-price-now">Contact us for price</span>';
    return `
      <div class="qb-service-card" data-service-id="${svc.id}">
        <div class="qb-price-card qb-price-card-nophoto">
          <div>
            <div class="qb-price-title">${type.name} ${svc.name} In ${cityLabel}</div>
            <div class="qb-price-row">${priceDisplay}</div>
            <div class="qb-price-trust">✔ Most Trusted Service</div>
          </div>
        </div>
        <ul class="qb-checklist">${svc.checklist.map(item => `<li>${item}</li>`).join('')}</ul>
        <div class="qb-actions">
          <button type="button" class="qb-btn qb-btn-add" data-action="add" data-service-id="${svc.id}">🛒 Add</button>
          <button type="button" class="qb-btn qb-btn-book" data-action="book" data-service-id="${svc.id}">Book</button>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const svcId = btn.getAttribute('data-service-id');
      const svc = type.services.find(s => s.id === svcId);
      const price = servicePrices[svcId];
      if (btn.getAttribute('data-action') === 'add') qbAddService(svc, price, false);
      else qbAddService(svc, price, true);
    });
  });
}

// Shared by both the "Add" and "Book" buttons on each service card —
// sets the SKU price override, maps the specific service name onto the
// existing service/repair field (plus notes it in the problem field for
// anything more specific than plain Service/Repair, so it's never lost
// even though the underlying booking record only tracks those two
// categories), then reuses the same tested addItemToCart()/OTP logic.
async function qbAddService(svc, price, thenBook) {
  const msg = document.getElementById('qbMsg');
  const phone = document.getElementById('qbPhone').value.trim();
  if (!/^[0-9]{10}$/.test(phone)) {
    msg.className = 'form-msg error';
    msg.textContent = 'Please enter a valid 10 digit mobile number.';
    return;
  }
  document.getElementById('fAppliance').value = qbApplianceId;
  refreshFormTypes();
  document.getElementById('fType').value = qbSelectedTypeId;
  const mappedServiceType = (svc.id === 'svc-repair' || svc.id === 'svc-install' || svc.id === 'svc-uninstall' || svc.id === 'svc-gasfill') ? 'repair' : 'service';
  document.getElementById('fServiceType').value = mappedServiceType;
  document.getElementById('fQty').value = 1;
  document.getElementById('fPhone').value = phone;
  document.getElementById('fProblem').value = (svc.id === 'svc-service' || svc.id === 'svc-repair') ? '' : `${svc.name} requested.`;
  qbSkuOverride = { price, skuName: svc.name, skuId: svc.id };

  // For "Book": remember exactly where in cartItems this new item will
  // land, so the checkout that follows shows/submits ONLY this item —
  // completely separate from anything already sitting in the cart from
  // earlier "Add" actions. For plain "Add": make sure we're NOT still in
  // a leftover windowed view from an earlier abandoned Book attempt.
  if (thenBook) quickBookViewStartIndex = cartItems.length;
  else quickBookViewStartIndex = null;
  const expectedIndex = cartItems.length;

  await addItemToCart();
  const addMsg = document.getElementById('addItemMsg');
  if (addMsg && addMsg.className.includes('error')) {
    msg.className = 'form-msg error';
    msg.textContent = addMsg.textContent;
    quickBookViewStartIndex = null;
    return;
  }
  // BUG FIX: same issue as qbDoAdd — a duplicate item sets the 'notice'
  // class (not 'error') and adds nothing, but this used to still proceed
  // to "Book" anyway. That left quickBookViewStartIndex pointing past the
  // real end of cartItems, which is exactly what let a later, unrelated
  // cart item slip into what was supposed to be a standalone "book just
  // this one" checkout. Double-checked here too: bail out unless a new
  // item genuinely landed at the expected index.
  if (thenBook && cartItems.length <= expectedIndex) {
    quickBookViewStartIndex = null;
    msg.className = addMsg ? addMsg.className.replace('form-msg', 'form-msg') : 'form-msg notice';
    msg.textContent = addMsg ? addMsg.textContent : 'This is already in your cart.';
    return;
  }
  if (thenBook) {
    closeQuickBookModal();
    openBookingForm();
    hideRedundantBookingFields();
  } else {
    // BEHAVIOR CHANGE (per explicit request): close the Appliance Details
    // modal immediately after a successful Add here too — this is the
    // OTHER "Add" path (per-service-card Add/Book buttons, as opposed to
    // qbAddBtn's single top-level Add), and was still leaving the modal
    // open with an inline message. Same toast treatment as qbAddBtn now.
    closeQuickBookModal();
    showToast(`✅ ${svc.name} added to your cart!`);
  }
}

async function qbUpdatePrice() {
  const cityId = document.getElementById('fCity').value;
  if (!cityId || !qbApplianceId || !qbSelectedTypeId) return;
  const priceNowEl = document.getElementById('qbPriceNow');
  const priceStrikeEl = document.getElementById('qbPriceStrike');
  priceNowEl.textContent = '...';
  priceStrikeEl.textContent = '';
  try {
    const row = await fetchJSON(`/api/price?cityId=${cityId}&applianceId=${qbApplianceId}&typeId=${qbSelectedTypeId}`);
    const actual = qbServiceType === 'repair' ? row.repairPrice : row.servicePrice;
    // A visual "was" price above the real one, purely for the discount-
    // badge look in the reference layout — the real, actual price
    // charged is always the one from pricing data (actual), never this.
    const shownMrp = Math.round((actual * 1.2) / 10) * 10;
    priceStrikeEl.textContent = `₹${shownMrp}`;
    priceNowEl.textContent = `₹${actual}`;
    qbSetNotAvailable(false);
  } catch (e) {
    // BUG FIX: this used to just show "Price unavailable" text inline
    // while leaving everything else (Service/Repair toggle, checklist,
    // Add/Book buttons) looking normal and clickable — confusing, since
    // there's nothing to actually add or book. Most common real cause:
    // this appliance/type was removed from (or never set up for) the
    // customer's city. Now shows a clear, friendly notice instead and
    // hides the rest of the step.
    qbSetNotAvailable(true);
  }
}

// Toggles between the normal price-card/checklist/actions view and the
// "not available in your city" notice — used by both the single-service
// view (qbUpdatePrice) and the multi-service list view (qbRenderServicesList).
function qbSetNotAvailable(isUnavailable) {
  const notAvailEl = document.getElementById('qbNotAvailable');
  const singleView = document.getElementById('qbSingleServiceView');
  const servicesList = document.getElementById('qbServicesList');
  if (notAvailEl) notAvailEl.style.display = isUnavailable ? 'block' : 'none';
  // #qbPhoneField stays permanently hidden now (see template) — no
  // longer toggled here.
  if (isUnavailable) {
    if (singleView) singleView.style.display = 'none';
    if (servicesList) servicesList.style.display = 'none';
  }
}

function bindQuickBookModal() {
  document.getElementById('qbCityContinueBtn').addEventListener('click', () => {
    const cityId = document.getElementById('qbCitySelect').value;
    if (!cityId) return;
    document.getElementById('fCity').value = cityId;
    refreshAppliancesForCity(cityId).then(() => {
      document.getElementById('qbCityStep').style.display = 'none';
      document.getElementById('qbDetailsStep').style.display = 'block';
      qbShowDetails();
    });
  });

  document.querySelectorAll('.qb-service-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.qb-service-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      qbServiceType = btn.getAttribute('data-service-type');
      qbUpdatePrice();
    });
  });

  document.getElementById('quickBookModalClose').addEventListener('click', closeQuickBookModal);
  document.getElementById('quickBookModal').addEventListener('click', (e) => {
    if (e.target.id === 'quickBookModal') closeQuickBookModal();
  });

  // Sets up the hidden main-form fields to match what was chosen here,
  // then calls the same, already-tested addItemToCart() — this is the
  // one place both "Add" and "Book" share, since both need the item
  // actually added to the cart first.
  async function qbDoAdd() {
    const msg = document.getElementById('qbMsg');
    const phone = document.getElementById('qbPhone').value.trim();
    if (!/^[0-9]{10}$/.test(phone)) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please enter a valid 10 digit mobile number.';
      return false;
    }
    document.getElementById('fAppliance').value = qbApplianceId;
    refreshFormTypes();
    document.getElementById('fType').value = qbSelectedTypeId;
    document.getElementById('fServiceType').value = qbServiceType;
    document.getElementById('fQty').value = 1;
    document.getElementById('fPhone').value = phone;
    await addItemToCart();
    const addMsg = document.getElementById('addItemMsg');
    if (addMsg && addMsg.className.includes('error')) {
      msg.className = 'form-msg error';
      msg.textContent = addMsg.textContent;
      return false;
    }
    // BUG FIX: this used to only check for the 'error' class — but when
    // the item is already in the cart (a duplicate), addItemToCart() sets
    // the 'notice' class and does NOT actually add anything, yet this
    // function still returned true (treated as success). The caller
    // (qbBookBtn) had already set quickBookViewStartIndex = cartItems.length
    // BEFORE this ran, expecting one new item to land there — if nothing
    // actually got added, that index now points past the real end of the
    // array, so the "just this item" checkout that follows ends up empty
    // or, worse, mis-scoped once anything else changes cartItems.length
    // afterward. Treat "nothing was actually added" as not-success too.
    if (addMsg && addMsg.className.includes('notice')) {
      msg.className = 'form-msg notice';
      msg.textContent = addMsg.textContent;
      return false;
    }
    return true;
  }

document.getElementById('qbAddBtn').addEventListener('click', async () => {
  quickBookViewStartIndex = null;
  const ok = await qbDoAdd();
  if (ok) {
    // BEHAVIOR CHANGE (per explicit request): close the Appliance Details
    // modal immediately after a successful Add, instead of leaving it
    // open with an inline message — a toast confirms it worked without
    // requiring an extra tap to dismiss the modal.
    closeQuickBookModal();
    showToast('✅ Added to your cart!');
  }
});

  document.getElementById('qbBookBtn').addEventListener('click', async () => {
    const expectedIndex = cartItems.length;
    quickBookViewStartIndex = expectedIndex;
    const ok = await qbDoAdd();
    // SAFETY CHECK: even if qbDoAdd() reported success, confirm a new item
    // actually landed at the expected index before treating this as a
    // scoped "book just this one" checkout — protects against this ever
    // silently mis-scoping and pulling in unrelated cart items (or
    // submitting nothing) if some other edge case slips past qbDoAdd's
    // own check.
    if (ok && cartItems.length > expectedIndex) {
      closeQuickBookModal();
      openBookingForm();
      hideRedundantBookingFields();
    } else {
      quickBookViewStartIndex = null;
    }
  });
}

bindQuickBookModal();

init();
