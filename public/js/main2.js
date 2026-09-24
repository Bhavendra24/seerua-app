// ------------------------------------------------------------------
// Seerua Appliance Care — customer site logic
// ------------------------------------------------------------------
// BUG FIX: these 3 used to be declared much further down the file
// (right before applyAccountToBookingFields) — but the #track/#book
// hash-triggered code near the very top of this same script (see
// bindUrlTriggeredSections and the plain if/else right below it) calls
// openAccountGate(), which reads agIntent, BEFORE that later `let`
// statement had ever run. `let`/`const` (unlike `function`) aren't
// hoisted usably — that's a genuine "Cannot access 'agIntent' before
// initialization" crash, not just a style issue. Declaring them here,
// before anything that could possibly reference them, fixes it for
// every entry point (in-page click, #track/#book on load, this
// session's new City/Appliance-City page header icon linking to
// /#track, etc.) at once.
let agIntent = null; // 'booking' | 'account' | 'quickbook' | 'profile-edit'
let agPendingApplianceId = null;
// Remembers whether "Add" or "Book Now" was the one being attempted
// when Quick Book paused for phone+OTP (see qbDoAdd()) — resumes
// automatically once that completes, instead of leaving the customer
// to notice and press it again themselves.
let qbPendingRetryAction = null; // 'add' | 'book' | null
// BUG FIX: the per-service-card Add/Book buttons (qbAddService(), used by
// AC's Window/Split/Cassette service list) had their own separate
// account-gate pause, tracked here — same idea as qbPendingRetryAction
// above, but remembers *which specific service card* (svc.id) and
// whether it was "Add" or "Book Now", so that action resumes automatically
// once phone+OTP completes instead of leaving the customer stuck on an
// error with no visible field to fix it.
let qbPendingServiceAction = null; // { svcId, thenBook } | null
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
    // BUG FIX: this used to render <a href="/appliance-repair/...">
    // links — tapping a city there navigated to that city's separate
    // SEO page instead of actually setting anything on THIS page's own
    // booking form. The booking form's #fCity dropdown (and everything
    // priced/filtered from it) never changed, so it kept showing
    // whatever city was already in there (often Moradabad, from the
    // saved account) no matter which city someone picked from this
    // sheet — confusing since it looks like a plain city switcher.
    // Now sets #fCity directly and stays on this page.
    populateCitySheetGrid();
    openBottomSheet('citySheetBackdrop');
  });
}

// Desktop header's own "City" button (bottomNavCityBtn above is mobile
// bottom-nav only) — opens the exact same city-picker sheet.
const navCityBtn = document.getElementById('navCityBtn');
if (navCityBtn) {
  navCityBtn.addEventListener('click', () => {
    populateCitySheetGrid();
    openBottomSheet('citySheetBackdrop');
  });
}
function populateCitySheetGrid() {
  const grid = document.getElementById('bottomSheetCityGrid');
  if (!grid || typeof CITIES === 'undefined') return;
  grid.innerHTML = CITIES.map(c => `<button type="button" class="bottom-sheet-city-btn" data-city-id="${c.id}">${c.name}</button>`).join('');
}
// Event delegation on the grid's container (bound ONCE, ever) instead of
// re-attaching a listener to each button every time the sheet reopens —
// simpler and avoids any chance of stale/duplicate listeners piling up
// across repeated opens.
// Updates the mobile bottom-nav's and desktop header's own "City"
// button label to show whichever city is currently active — called
// both when someone explicitly picks one from this sheet, AND from
// applyAccountToBookingFields() (a returning customer's saved account
// city gets applied programmatically, which used to leave these
// buttons stuck on their old label — showing a DIFFERENT city than
// what the booking form was actually using underneath).
function updateCityButtonLabels(cityId) {
  const city = (typeof CITIES !== 'undefined') ? CITIES.find(c => c.id === cityId) : null;
  if (!city) return;
  const bottomBtnSpan = document.querySelector('#bottomNavCityBtn span');
  if (bottomBtnSpan) bottomBtnSpan.textContent = city.name;
  const desktopBtn = document.getElementById('navCityBtn');
  if (desktopBtn) desktopBtn.textContent = city.name;
}
document.getElementById('bottomSheetCityGrid')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-city-id]');
  if (!btn) return;
  const cityId = btn.getAttribute('data-city-id');
  const cityName = btn.textContent;
  const cityEl = document.getElementById('fCity');
  if (cityEl) {
    cityEl.value = cityId;
    if (typeof refreshAppliancesForCity === 'function') await refreshAppliancesForCity(cityId);
  }
  // SIMPLIFIED (per explicit request): remembers this choice across
  // visits/sessions (not just within this one page load) — so a
  // returning visitor who doesn't have a saved account yet still isn't
  // asked to pick their city again every single time.
  try { localStorage.setItem('seerua_last_city', cityId); } catch (e) { /* private browsing etc — non-fatal, just won't persist */ }
  closeBottomSheet('citySheetBackdrop');
  // BUG FIX: setting #fCity's value silently had NO visible effect
  // anywhere on the page — no confirmation text, no change to the
  // "City" button itself — so even though the selection genuinely did
  // take effect (appliances/pricing were correctly refreshed for it),
  // it looked exactly like nothing had happened at all. A toast plus
  // updating both City buttons' own label fixes that.
  if (typeof showToast === 'function') showToast(`City set to ${cityName}`);
  updateCityButtonLabels(cityId);
});

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
  // The old long booking form is retired — every old entry point now
  // lands in the one-screen popup (public/js/service-page.js).
  if (window.SeeruaBooking && window.SeeruaBooking.openFromOldEntry) { window.SeeruaBooking.openFromOldEntry(); return; }
  // Called while the page is still loading (e.g. arriving at /#book) —
  // the popup script loads right after this one, so wait for it.
  if (!window.SeeruaBooking && document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', openBookingForm, { once: true }); return; }
  // FLOW CHANGE: this used to un-hide a plain page section and scroll to
  // it — now opens as a proper floating modal (matching every other
  // popup on this site: Account Gate, Quick Book, Track Booking, etc.)
  // instead of being pushed inline into the middle of the page.
  const backdrop = document.getElementById('bookingModalBackdrop');
  if (backdrop) backdrop.classList.add('open');
  // Clears out any lingering success/error message from a previous
  // booking in the same session, so reopening the form doesn't briefly
  // flash old text before a new attempt.
  const msg = document.getElementById('formMsg');
  if (msg) { msg.className = 'form-msg'; msg.textContent = ''; }
  // Reset back to showing the actual form — a previous booking in this
  // same session may have left #bookingSuccessView showing instead.
  const successView = document.getElementById('bookingSuccessView');
  if (successView) successView.style.display = 'none';
  const bookingFormEl = document.getElementById('bookingForm');
  if (bookingFormEl) bookingFormEl.style.display = '';
  // Reset to the full form by default — see hideRedundantBookingFields()
  // for where/why these get hidden again for the Quick Book shortcut.
  const cityField = document.getElementById('fCityField');
  if (cityField) cityField.style.display = '';
  const addBox = document.querySelector('.cart-add-box');
  if (addBox) addBox.style.display = '';
  // BUG FIX: #fPhoneField was hardcoded display:none, on the assumption
  // that phone is always captured up front by Account Gate before this
  // form is ever shown — true when opened via the old #book flow, but
  // no longer true now that #book opens straight to this form instead
  // (per explicit request: no OTP until they actually try to Add). A
  // brand new visitor with no saved account had no field at all to type
  // a phone number into. Show it whenever there's no known account yet;
  // applyAccountToBookingFields() (for a returning customer) still
  // hides it again right after, same as before.
  const phoneField = document.getElementById('fPhoneField');
  if (phoneField) phoneField.style.display = getAccount() ? 'none' : '';
}

// Collapses the form again — used once a booking is successfully placed,
// or when the person taps the ✕ / taps outside the modal.
function closeBookingForm() {
  const backdrop = document.getElementById('bookingModalBackdrop');
  if (backdrop) backdrop.classList.remove('open');
}

// Short confirmation chime played alongside the checkmark when a booking
// succeeds — same technique as the technician panel's own completion
// sound (generated via Web Audio API, no audio file needed).
function playSuccessChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1175, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) { /* Web Audio not available/blocked — the visual checkmark alone is still shown */ }
}

// Tapping the dark backdrop itself (not the form card) closes it too —
// same pattern as every other modal on the site. BUG FIX: this used to
// apply even once the booking succeeded and the confirmation screen
// (#bookingSuccessView) was showing — a stray tap/click anywhere in the
// dark area closed it without the customer ever tapping OK, which
// directly contradicted "screen ruke jab tak OK na dabaye". Skipped
// specifically while that success view is visible; the OK button is
// the only way to close it from there.
document.getElementById('bookingModalBackdrop')?.addEventListener('click', (e) => {
  if (e.target.id !== 'bookingModalBackdrop') return;
  const successView = document.getElementById('bookingSuccessView');
  if (successView && successView.style.display !== 'none') return;
  closeBookingForm();
});

// Soft nudge (not a hard block) if the typed address mentions a DIFFERENT
// city than the one selected above it — easy mistake to make (typing
// fast, copy-pasting an old address, etc.) and worth a gentle "are you
// sure?" without actually preventing submission, since an address can
// legitimately reference another nearby place as a landmark.
function checkAddressCityMismatch() {
  const addressEl = document.getElementById('fAddress');
  const cityEl = document.getElementById('fCity');
  const warningEl = document.getElementById('fAddressCityWarning');
  if (!addressEl || !cityEl || !warningEl || typeof CITIES === 'undefined') return;
  const address = addressEl.value.toLowerCase();
  const selectedCity = CITIES.find(c => c.id === cityEl.value);
  if (!address.trim() || !selectedCity) { warningEl.style.display = 'none'; return; }
  const selectedCityName = selectedCity.name.toLowerCase();
  const mentionedOtherCity = CITIES.find(c =>
    c.id !== selectedCity.id && address.includes(c.name.toLowerCase())
  );
  if (mentionedOtherCity && !address.includes(selectedCityName)) {
    warningEl.style.display = 'block';
    warningEl.textContent = `⚠️ You selected ${selectedCity.name} as the city, but this address mentions ${mentionedOtherCity.name} — please double-check it's correct.`;
  } else {
    warningEl.style.display = 'none';
  }
}
document.getElementById('fAddress')?.addEventListener('input', checkAddressCityMismatch);
document.getElementById('fCity')?.addEventListener('change', checkAddressCityMismatch);

// ---------------- SELECT ADDRESS / ADD NEW ADDRESS (Jay Home Services
// style flow) ----------------------------------------------------------
// Replaces the old plain "type your full address" textarea with a proper
// Select Address → Add New Address flow: saved addresses (kept in
// localStorage per phone number, since there's no server-side multi-
// address table) are shown as pickable cards, and "+ Add New Address"
// opens a structured form (House/Flat/Block No, Landmark/Society name,
// Save as Home/Work/Other) plus a "Use Current Location" button.
// NOTE: there is no live Google Map preview here — that needs a Google
// Maps JavaScript API key (with billing) on the business's own Google
// Cloud account, which this codebase doesn't have. "Use Current Location"
// still works via the browser's own GPS + a free reverse-geocoding
// lookup (OpenStreetMap Nominatim) to prefill the Landmark field.
let activeAddressTargetInputId = null;
let activeAddressPreviewId = null;
// Tracks whichever modal (Account Gate during a new booking, or the
// Edit Details modal from My Account) this address flow was opened from
// — see the BUG FIX comment in openSelectAddressModal() below for why.
let activeAddressParentModalId = null;
let selectedSaveAs = null;
let pendingLatLng = null;
// Tracks which saved address (by its own id) is currently being edited
// via the pencil icon on its card — null means "Add New Address" is
// creating a brand new entry instead of updating an existing one.
let editingAddressId = null;

function getSavedAddresses(phone) {
  try { return JSON.parse(localStorage.getItem(`seerua_addresses_${phone || 'guest'}`) || '[]'); }
  catch (e) { return []; }
}
function setSavedAddresses(phone, list) {
  localStorage.setItem(`seerua_addresses_${phone || 'guest'}`, JSON.stringify(list));
}
function currentAddressPhone() {
  const acc = (typeof getAccount === 'function') ? getAccount() : null;
  const agPhoneVal = document.getElementById('agPhone')?.value.trim();
  const fPhoneVal = document.getElementById('fPhone')?.value.trim();
  if (agPhoneVal && /^[0-9]{10}$/.test(agPhoneVal)) return agPhoneVal;
  if (fPhoneVal && /^[0-9]{10}$/.test(fPhoneVal)) return fPhoneVal;
  return (acc && acc.phone) || 'guest';
}
function saveAsIcon(val) { return val === 'Home' ? '🏠' : val === 'Work' ? '💼' : '📍'; }

// Keeps a preview span in sync with a hidden address textarea's current
// value — used whenever that textarea gets filled programmatically
// (returning-customer auto-fill, "Edit Profile", etc.) rather than
// through applyChosenAddress() below.
function updateAddressPreview(targetInputId, previewId) {
  const target = document.getElementById(targetInputId);
  const preview = document.getElementById(previewId);
  if (!target || !preview) return;
  preview.textContent = target.value.trim() ? `📍 ${target.value.trim()}` : '📍 Select Address';
}

// BUG FIX ("Book Your Service ke do popup hote hain" — Add New Address ke
// pehli baar click par do popup dikhte hain jabki matter same hai): this
// address picker (and the Add/Edit Address form it leads to) opens ON TOP
// OF whichever modal launched it — Account Gate during a new customer's
// booking, or Edit Details from My Account. That parent modal was never
// actually hidden while this one was open, only visually covered by it —
// so its own popup card (same size, same center position) stuck out from
// behind this narrower/shorter one, and on screen it genuinely looked like
// two separate popups were open together. Hiding the parent for as long as
// this address flow is on screen (restored the moment an address is
// picked, or this is closed without picking one — see
// closeSelectAddressModal()/closeAddAddressModal()/applyChosenAddress()
// below) fixes the look without changing how the address itself is chosen.
function hideAddressParentModal(targetInputId) {
  activeAddressParentModalId = targetInputId === 'agEditAddress' ? 'accountEditModal' : 'accountGateModal';
  document.getElementById(activeAddressParentModalId)?.classList.remove('open');
}
function restoreAddressParentModal() {
  if (activeAddressParentModalId) {
    document.getElementById(activeAddressParentModalId)?.classList.add('open');
  }
}

function openSelectAddressModal(targetInputId, previewId) {
  activeAddressTargetInputId = targetInputId;
  activeAddressPreviewId = previewId;
  hideAddressParentModal(targetInputId);
  const phone = currentAddressPhone();
  let list = getSavedAddresses(phone);
  // BUG FIX: this "saved addresses" list lives entirely in localStorage,
  // completely separate from the account's own `address` field — a
  // returning customer whose address was set some other way (an older
  // version of this flow, Admin editing a booking's address, etc.)
  // would see "No saved addresses yet" here even though they very much
  // DO have an address on file, making it look like their address had
  // vanished and forcing them to type a brand new one from scratch just
  // to make a small edit. If the list is empty but the account (or
  // whatever this modal's own target field currently holds) has real
  // address text, seed the list with that one entry first — so it's
  // selectable (and therefore keepable/editable) instead of invisible.
  if (!list.length) {
    const acc = (typeof getAccount === 'function') ? getAccount() : null;
    const existingAddressText = (document.getElementById(targetInputId)?.value || (acc && acc.address) || '').trim();
    if (existingAddressText) {
      list = [{ id: 'existing', saveAs: 'Home', fullText: existingAddressText }];
    }
  }
  const container = document.getElementById('savedAddressList');
  if (!list.length) {
    container.innerHTML = `<p style="font-size:0.85rem;color:var(--slate);margin:0 0 14px;">No saved addresses yet — add one below.</p>`;
  } else {
    container.innerHTML = list.map((a, i) => `
      <div class="saved-address-row">
        <button type="button" class="saved-address-card" data-idx="${i}">
          <strong>${saveAsIcon(a.saveAs)} ${escapeHtml(a.saveAs)}</strong>
          <span>${escapeHtml(a.fullText)}</span>
        </button>
        <button type="button" class="saved-address-edit-btn" data-idx="${i}" aria-label="Edit this address" title="Edit">✏️</button>
        <button type="button" class="saved-address-delete-btn" data-idx="${i}" aria-label="Delete this address" title="Delete">🗑️</button>
      </div>
    `).join('');
    container.querySelectorAll('.saved-address-card').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = list[parseInt(btn.getAttribute('data-idx'), 10)];
        applyChosenAddress(a);
      });
    });
    // BUG FIX (the actual "address edit nahi ho raha" report): there was
    // previously no way to fix a typo or update an existing saved
    // address at all — only "select it as-is" or "add a completely
    // separate new one". This pencil button opens the same Add Address
    // form, pre-filled with THIS entry's own details — since
    // editingAddressId is set below, Save then updates this specific
    // entry in place instead of creating a duplicate new one.
    container.querySelectorAll('.saved-address-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const a = list[parseInt(btn.getAttribute('data-idx'), 10)];
        editingAddressId = a.id;
        closeSelectAddressModal();
        openAddAddressModal(true);
        document.getElementById('naHouseNo').value = a.houseNo || (a.fullText ? a.fullText.split(',')[0].trim() : '');
        document.getElementById('naLandmark').value = a.landmark || '';
        selectedSaveAs = a.saveAs || null;
        document.querySelectorAll('.save-as-pill').forEach(p => {
          p.classList.toggle('selected', p.getAttribute('data-val') === selectedSaveAs);
        });
      });
    });
    // Flipkart-style delete-from-the-list — removes just this one saved
    // address (the account's own current address field, if it happens
    // to match, is untouched; this only affects the "pick a different
    // saved one" list itself). Simple confirm() to guard against an
    // accidental tap, since there's no undo.
    container.querySelectorAll('.saved-address-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        const a = list[idx];
        if (!confirm(`Delete this address?\n${a.fullText}`)) return;
        const phone = currentAddressPhone();
        const stored = getSavedAddresses(phone);
        const newList = stored.filter(x => x.id !== a.id);
        setSavedAddresses(phone, newList);
        openSelectAddressModal(activeAddressTargetInputId, activeAddressPreviewId);
      });
    });
  }
  document.getElementById('selectAddressModal').classList.add('open');
}
function closeSelectAddressModal() {
  document.getElementById('selectAddressModal')?.classList.remove('open');
  // Safe to always restore here, even when this is actually a same-tick
  // hand-off to the Add/Edit Address form (closeSelectAddressModal()
  // immediately followed by openAddAddressModal() — see the
  // addNewAddressBtn/edit-btn handlers below): openAddAddressModal()
  // re-hides the parent right after, synchronously, before the browser
  // ever paints this in-between state, so there's no visible flash.
  restoreAddressParentModal();
}
function applyChosenAddress(a) {
  const target = document.getElementById(activeAddressTargetInputId);
  if (target) {
    target.value = a.fullText;
    target.dispatchEvent(new Event('input'));
    target.dispatchEvent(new Event('change'));
  }
  if (activeAddressPreviewId) updateAddressPreview(activeAddressTargetInputId, activeAddressPreviewId);
  // Both of these restore the parent modal themselves (see their own
  // definitions) — calling both here is harmless (the second is a no-op)
  // and keeps this working regardless of which of the two was actually
  // open when the address got picked.
  closeSelectAddressModal();
  closeAddAddressModal();
}
function openAddAddressModal(isEditing) {
  // Re-hides the parent modal (Account Gate / Edit Details) — this is
  // reached either straight from openSelectAddressModal() (which already
  // hid it, so this is a harmless no-op) or, when re-entered on its own
  // via the edit-pencil handler after closeSelectAddressModal() already
  // restored it, this is what actually keeps it hidden. Either way,
  // activeAddressParentModalId was already set by the openSelectAddressModal()
  // call that necessarily preceded this one.
  document.getElementById(activeAddressParentModalId)?.classList.remove('open');
  if (!isEditing) editingAddressId = null;
  const titleEl = document.getElementById('addAddressModalTitle');
  if (titleEl) titleEl.textContent = isEditing ? 'Edit Address' : 'Add New Address';
  const saveBtn = document.getElementById('saveNewAddressBtn');
  if (saveBtn) saveBtn.textContent = isEditing ? 'Save Changes' : 'Save Address';
  if (!isEditing) {
    document.getElementById('naHouseNo').value = '';
    document.getElementById('naLandmark').value = '';
    selectedSaveAs = null;
    document.querySelectorAll('.save-as-pill').forEach(p => p.classList.remove('selected'));
  }
  pendingLatLng = null;
  const locMsg = document.getElementById('addAddressLocationMsg');
  if (locMsg) { locMsg.textContent = ''; locMsg.style.color = ''; }
  const msg = document.getElementById('addAddressMsg');
  if (msg) { msg.className = 'form-msg'; msg.textContent = ''; }
  document.getElementById('addAddressModal').classList.add('open');
}
function closeAddAddressModal() {
  document.getElementById('addAddressModal')?.classList.remove('open');
  // Safe to always restore here too — see closeSelectAddressModal()'s
  // comment for why a same-tick hand-off elsewhere never causes a flash.
  restoreAddressParentModal();
}

document.getElementById('addNewAddressBtn')?.addEventListener('click', () => {
  closeSelectAddressModal();
  openAddAddressModal();
});
document.getElementById('selectAddressModalClose')?.addEventListener('click', closeSelectAddressModal);
document.getElementById('addAddressModalClose')?.addEventListener('click', closeAddAddressModal);
document.getElementById('selectAddressModal')?.addEventListener('click', (e) => { if (e.target.id === 'selectAddressModal') closeSelectAddressModal(); });
document.getElementById('addAddressModal')?.addEventListener('click', (e) => { if (e.target.id === 'addAddressModal') closeAddAddressModal(); });

document.querySelectorAll('.save-as-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.save-as-pill').forEach(p => p.classList.remove('selected'));
    pill.classList.add('selected');
    selectedSaveAs = pill.getAttribute('data-val');
  });
});

document.getElementById('useCurrentLocationBtn')?.addEventListener('click', () => {
  const msg = document.getElementById('addAddressLocationMsg');
  if (!navigator.geolocation) {
    msg.style.color = 'var(--red)';
    msg.textContent = 'Location is not supported on this device/browser.';
    return;
  }
  msg.style.color = 'var(--slate)';
  msg.textContent = '📡 Getting your location...';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    pendingLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${pendingLatLng.lat}&lon=${pendingLatLng.lng}`);
      const data = await res.json();
      const addr = data.address || {};
      const locality = addr.suburb || addr.neighbourhood || addr.road || addr.village || addr.town || '';
      const landmarkEl = document.getElementById('naLandmark');
      if (locality && landmarkEl && !landmarkEl.value.trim()) landmarkEl.value = locality;
      msg.style.color = '#16a34a';
      msg.textContent = '✓ Location detected — please confirm the details below.';
    } catch (e) {
      msg.style.color = '#16a34a';
      msg.textContent = '✓ Location captured — please fill in the details below.';
    }
  }, () => {
    msg.style.color = 'var(--red)';
    msg.textContent = 'Could not get your location. Please allow location access, or fill the address in manually.';
  }, { enableHighAccuracy: true, timeout: 10000 });
});

document.getElementById('saveNewAddressBtn')?.addEventListener('click', () => {
  const msg = document.getElementById('addAddressMsg');
  msg.className = 'form-msg';
  const houseNo = document.getElementById('naHouseNo').value.trim();
  const landmark = document.getElementById('naLandmark').value.trim();
  if (!houseNo) { msg.className = 'form-msg error'; msg.textContent = 'Please enter House/Flat/Block No.'; return; }
  if (!landmark) { msg.className = 'form-msg error'; msg.textContent = 'Please enter a Landmark or Society name.'; return; }
  if (!selectedSaveAs) { msg.className = 'form-msg error'; msg.textContent = 'Please choose Save as Home, Work or Other.'; return; }
  // BUG FIX (the actual "Kasganj kaise juda hai, edit nahi ho raha"
  // report): this used to silently append whatever city happened to be
  // selected in a totally SEPARATE dropdown (#fCity/#agCity, not part of
  // this Add/Edit Address form at all) onto the end of the address text
  // — so a saved address could show "...Kasganj" with no way to change
  // or even understand where that came from from within this exact
  // form. City is already tracked properly on its own (the account's
  // cityId, and the separate City dropdown in Edit Profile) — this
  // address text only needs to be the address itself now.
  const fullText = `${houseNo}, ${landmark}`;
  const phone = currentAddressPhone();
  const list = getSavedAddresses(phone);
  // BUG FIX (see openSelectAddressModal's own edit-button comment): when
  // editingAddressId is set, this is editing an existing entry, not
  // adding a new one — update it in place (keeping its original id) so
  // Save doesn't leave a stray duplicate sitting alongside the corrected
  // version.
  let savedAddr;
  if (editingAddressId != null) {
    const existingIdx = list.findIndex(a => a.id === editingAddressId);
    savedAddr = { id: editingAddressId, houseNo, landmark, saveAs: selectedSaveAs, fullText, lat: pendingLatLng ? pendingLatLng.lat : undefined, lng: pendingLatLng ? pendingLatLng.lng : undefined };
    if (existingIdx >= 0) list[existingIdx] = savedAddr;
    else list.unshift(savedAddr); // the seeded "existing account address" entry (id: 'existing') was never actually in this list — first edit adds it for real
  } else {
    savedAddr = { id: Date.now(), houseNo, landmark, saveAs: selectedSaveAs, fullText, lat: pendingLatLng ? pendingLatLng.lat : undefined, lng: pendingLatLng ? pendingLatLng.lng : undefined };
    list.unshift(savedAddr);
  }
  setSavedAddresses(phone, list);
  editingAddressId = null;
  applyChosenAddress(savedAddr);
});

// agAddressSelectBtn removed (see index.template.html's #agPhoneStep
// comment) — the first-time booking gate's address is now a plain
// textarea typed directly on the same card, not a button opening a
// second popup. #agEditAddressSelectBtn (Edit Profile, for an
// already-registered customer managing saved addresses) still uses the
// picker — different, later use case.
document.getElementById('agEditAddressSelectBtn')?.addEventListener('click', () => openSelectAddressModal('agEditAddress', 'agEditAddressPreview'));

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
    openTrackBookingModal();
  }
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href="#book"]');
  if (link) {
    e.preventDefault();
    // FLOW CHANGE (per explicit request): opens the booking form
    // directly — no more asking for phone+OTP before they've even
    // picked an appliance or seen a price. Account-gate (if needed at
    // all — an existing saved account skips it) now only happens at
    // actual Add/Submit time, inside addItemToCart(), same as Quick
    // Book's flow.
    openBookingForm();
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
// BUG FIX ("page refresh karne par quick book appliance ka form khul raha
// hai"): landing on /?city=..&appliance=..&type=..#quickbook (from a
// Google-indexed SEO page's Book link) opens the Quick Book modal, but
// that URL itself was never cleaned up afterward — so it just sits in the
// address bar. Any later refresh of that same tab (or the customer coming
// back to it, or forwarding the link to someone else) re-triggers the
// exact same auto-open all over again, even though there's nothing left
// to "land on" — they're just looking at their own homepage. Stripping
// just the city/appliance/type params and the #quickbook hash right after
// the modal has actually opened (via history.replaceState, which changes
// the address bar without reloading the page or losing modal state) means
// a refresh from here on just shows the plain homepage, exactly like a
// customer who opened it directly. Other params some other feature might
// still rely on (e.g. ?ref=... for referrals) are left untouched.
function clearQuickBookUrlParams() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('city');
    url.searchParams.delete('appliance');
    url.searchParams.delete('type');
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
  } catch (e) { /* URL/history APIs unavailable — not worth failing over */ }
}

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
    // FLOW CHANGE (per explicit request): opens the booking form
    // directly instead of asking for phone+OTP first — see the matching
    // change on the in-page a[href="#book"] click handler above for why.
    openBookingForm();
  } else if (window.location.hash === '#quickbook') {
    // Landed here from a City/Appliance-City page's "Book Now" (those
    // pages don't load this whole script, so their button just
    // redirects here with the appliance id in the URL instead of
    // calling openQuickBookModal() directly — see the small polyfill
    // of that same name in city.template.html).
    const qbUrlParams = new URLSearchParams(window.location.search);
    const urlApplianceId = qbUrlParams.get('appliance');
    // BUG FIX: also honor &type=... when present (a type-specific SEO
    // page's Book link, e.g. "Split AC Service in Jalesar") so the modal
    // opens straight to that type instead of always the first one.
    const urlTypeId = qbUrlParams.get('type');
    if (urlApplianceId) {
      openQuickBookModal(urlApplianceId, urlTypeId);
      clearQuickBookUrlParams();
    }
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
  openTrackBookingModal();
} else if (window.location.hash === '#book') {
  openBookingForm();
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// Consistent "DD Mon YYYY" date display used everywhere a date is shown
// to a customer (booking success screen, Track Booking, etc.) — per
// explicit request, since dates were previously a mix of raw ISO
// strings (e.g. "2026-09-20") and differently-formatted ones depending
// on which screen showed them. Accepts either a "YYYY-MM-DD" string or
// an ISO datetime string; returns the input unchanged if it can't be
// parsed as a date, rather than showing "Invalid Date".
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.length === 10 ? dateStr + 'T00:00:00' : dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Used whenever customer-typed free text (a review, etc.) is inserted into
// the page, so it's shown as plain text and can't break out of the HTML.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// WebP versions of appliance photos sit alongside the original at the
// same path (same filename, .webp extension) — <picture> lets a
// supporting browser use the smaller file while any other browser
// silently falls back to the original. If no .webp file actually
// exists for a given photo, the <source> is just ignored.
function toWebpUrl(url) {
  return String(url || '').replace(/\.(jpe?g|png)$/i, '.webp');
}
function buildPictureHtml(photoUrl, imgAttrs) {
  return `<picture><source srcset="${escapeHtml(toWebpUrl(photoUrl))}" type="image/webp"><img src="${escapeHtml(photoUrl)}" ${imgAttrs}></picture>`;
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
  } else {
    // SIMPLIFIED (per explicit request): fall back to whichever city
    // was last picked in an earlier visit (see bottomSheetCityGrid's own
    // click handler, which saves this) — so a returning visitor without
    // a saved account isn't asked to pick their city again on every
    // single visit. Only applies when nothing more specific (a URL
    // param) already said otherwise.
    let lastCityId = null;
    try { lastCityId = localStorage.getItem('seerua_last_city'); } catch (e) { /* private browsing etc */ }
    if (lastCityId && CITIES.some(c => c.id === lastCityId)) {
      document.getElementById('fCity').value = lastCityId;
      await refreshAppliancesForCity(lastCityId);
      if (typeof updateCityButtonLabels === 'function') updateCityButtonLabels(lastCityId);
    }
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

  // City chips — link directly to each city's first appliance page
  // (the combined city-only page now just redirects there anyway; going
  // straight there avoids the extra redirect hop for the common case).
  const chipRow = document.getElementById('cityChipRow');
  const serverRenderedCities = chipRow && chipRow.children.length > 0; // server HTML is correct (priced pages only) — don't redraw
  const firstApplianceSlug = APPLIANCES.length ? `/${applianceSlug(APPLIANCES[0].name)}` : '';
  if (!serverRenderedCities) chipRow.innerHTML = CITIES.map(c => `<a href="/appliance-repair/${slugify(c.name)}${firstApplianceSlug}" class="city-chip">${c.name}</a>`).join('');

  // SEO FIX: the chip above only linked each city's FIRST appliance page,
  // so a search like "fridge repair in Noida" had no direct homepage link
  // even though that exact page exists. Every appliance-city page already
  // cross-links to its sibling appliances in the same city (see
  // otherAppliancesHtml in server.js), so the pages were always reachable
  // by Google in one extra hop — but a direct link from the homepage is a
  // stronger, faster signal. This adds one real <a href> per
  // city+appliance combination, collapsed behind a <details> per city (as
  // used already on /careers) so it stays out of the way visually while
  // remaining fully present and crawlable in the page's HTML.
  const allServicesBox = document.getElementById('allServicesByCity');
  if (allServicesBox && !serverRenderedCities) {
    if (CITIES.length && APPLIANCES.length) {
      allServicesBox.innerHTML = CITIES.map(c => {
        const cityApplianceLinks = APPLIANCES
          .filter(a => !(a.disabledCities || []).includes(c.id))
          .map(a => `<a href="/appliance-repair/${slugify(c.name)}/${applianceSlug(a.name)}" class="city-chip">${a.name} Service in ${c.name}</a>`)
          .join(' ');
        return `<details style="max-width:640px;margin:0 auto 8px;text-align:left;border:1px solid var(--mist);border-radius:var(--radius-sm);padding:10px 14px;">
          <summary style="cursor:pointer;font-weight:700;color:var(--blue-900);">${c.name} — all services</summary>
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;">${cityApplianceLinks}</div>
        </details>`;
      }).join('');
    } else {
      allServicesBox.innerHTML = '';
    }
  }

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
  // BUG FIX: same &type=... fix as bindUrlTriggeredSections() below — this
  // is the other code path that opens the modal from URL params (this one
  // runs regardless of the #quickbook hash), so it needs the same fix or
  // the type would only be honored sometimes depending on which of the two
  // paths happens to fire first.
  const typeId = params.get('type');
  if (cityId && document.getElementById('fCity')) {
    const match = CITIES.find(c => c.id === cityId);
    if (match) document.getElementById('fCity').value = cityId;
  }
  if (applianceId && APPLIANCES.find(a => a.id === applianceId && !a.hidden)) {
    openQuickBookModal(applianceId, typeId);
    clearQuickBookUrlParams();
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
  const modal = document.getElementById('careersModal');
  if (!modal) return;

  if (openBtn) openBtn.addEventListener('click', openCareersModal);
  // The header's own "Careers" link is now just a plain link inside the
  // Menu sheet (see index.template.html) with a real href="/careers" —
  // no JS interception needed, so nothing to bind here for it anymore.
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
// Mirrors applianceSlug() in server.js — needed client-side now that a
// few places (like the homepage's city chips) link directly to a city's
// first appliance page instead of the old combined city-only page.
function applianceSlug(name) {
  return `${slugify(name)}-service`;
}

function refreshFormTypes() {
  const applianceId = document.getElementById('fAppliance').value;
  const appliance = APPLIANCES.find(a => a.id === applianceId);
  populateSelect(document.getElementById('fType'), appliance ? appliance.types : [], 'Select type');
}

// Picks a real, bookable /appliance-repair/:city/:appliance URL for an
// appliance card on the general "what we offer" grid, which isn't tied to
// any one city. Uses the first city (in CITIES order) that hasn't
// disabled this appliance, so the link always lands on a live page
// instead of a 404 — falls back to CITIES[0] in the unlikely case every
// city has it disabled, and to '#' only if there are no cities at all.
function firstCityUrlForAppliance(a) {
  if (!Array.isArray(CITIES) || !CITIES.length) return null;
  const disabled = a.disabledCities || [];
  const city = CITIES.find(c => !disabled.includes(c.id)) || CITIES[0];
  return `/appliance-repair/${slugify(city.name)}/${applianceSlug(a.name)}`;
}

function renderServicesGrid() {
  const grid = document.getElementById('servicesGrid');
  // Server already rendered the tiles with proper links (and only for
  // appliances that have prices) — keep those.
  if (grid && grid.querySelector('.service-card')) return;
  // SEO FIX: each card's photo/title now sits inside a real <a href> to
  // that appliance's own SEO landing page (in addition to the "Book Now"
  // button, which keeps opening the quick-book modal) — previously the
  // whole card was just a JS onclick with no crawlable link at all, so
  // Google had no way to discover these pages by following links from the
  // homepage.
  grid.innerHTML = ALL_APPLIANCES.map(a => {
    const href = firstCityUrlForAppliance(a) || '#';
    return `
    <div class="service-card" data-appliance="${a.id}">
      <a href="${href}" class="service-card-link" aria-label="${a.name} repair and service details" style="display:block;color:inherit;text-decoration:none;">
        ${a.photoUrl
          ? buildPictureHtml(a.photoUrl, `class="service-card-photo" alt="${a.name} service technician at work" loading="lazy"`)
          : `<div class="service-icon-wrap"><div class="service-icon">${ICONS[a.icon] || ICONS.wrench}</div></div>`}
        <h3>${a.name}</h3>
      </a>
      <button type="button" class="btn btn-outline btn-sm" onclick="openApplianceBoxesPanel('${a.id}')">Book Now</button>
    </div>
  `;
  }).join('');
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
    if (saved.cartCityId) cartCityId = saved.cartCityId;
  } catch (e) { /* corrupted/old data — just start with an empty cart */ }
}

function saveCartToStorage() {
  try {
    sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ cartItems, appliedCoupon, cartPhoneNumber, cartCityId }));
  } catch (e) { /* storage full or unavailable — cart just won't survive a refresh this time */ }
}

let cartItems = [];
// The phone number the current cart's items were added under — set when
// the first item goes in, cleared when the cart empties out again. See
// the check in addItemToCart() for why this exists.
let cartPhoneNumber = null;
// Same idea, for city — item prices are calculated per-city at the
// moment each one is added, so switching cities mid-cart would leave
// already-added items charging the OLD city's rates under the NEW
// city's name. See the check in addItemToCart() and the City-field lock
// in renderCart() below.
let cartCityId = null;
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
  // Same lock, for the same reason, on City: items already in the cart
  // were priced for whichever city was active when each was added, so
  // switching cities mid-cart would leave them silently charging the
  // OLD city's rates under the NEW city's name. Locks the field while
  // the cart has anything in it, regardless of account status — City
  // isn't tied to the account (see applyAccountToBookingFields), so
  // there's no separate account-level lock to defer to here.
  const cityField = document.getElementById('fCity');
  if (cityField && quickBookViewStartIndex === null) {
    const shouldLockCity = cartItems.length > 0;
    cityField.disabled = shouldLockCity;
    cityField.style.background = shouldLockCity ? 'var(--mist)' : '';
    if (!shouldLockCity) cartCityId = null; // cart's empty again — free to start over with any city
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
  if (!visibleItems.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    couponRow.style.display = 'none';
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
        ${visibleItems.length > 1 ? `<button type="button" class="cart-item-trash" onclick="removeCartItem(${idx})" title="Remove">🗑️</button>` : ''}
        <!-- BUG FIX (per explicit request): removing the only item in a
             single-item booking doesn't make sense the same way it does
             in a real multi-item cart — there's nothing to "pick between"
             once it's the only one. The delete/trash icon now only shows
             once there are 2+ items, matching a true cart scenario. -->
      </div>
    </div>
  `;
  }).join('') +
    (discount ? `<div class="discount-row"><span>Coupon "${appliedCoupon.code}" applied</span><span>− ₹${discount}</span></div>` : '') +
    // SIMPLIFIED (per explicit request): a compact 3-line summary
    // instead of the earlier, more detailed Payment Summary card —
    // Service Amount / Processing Charges / Total, in one place right
    // under the cart items (not a separate card lower down). Processing
    // Charges stays ₹0 because the booking API doesn't currently add any
    // fee on top of the item total — Total here always matches
    // finalTotal (the real charge), so this stays accurate.
    `<div class="cart-total-row" style="flex-direction:column;align-items:stretch;gap:4px;">
      <div style="display:flex;justify-content:space-between;font-size:0.85rem;font-weight:500;"><span>Service Amount</span><span>₹${finalTotal}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:0.85rem;font-weight:500;"><span>Processing Charges</span><span>₹0</span></div>
      <div style="display:flex;justify-content:space-between;padding-top:4px;border-top:1px solid var(--line);"><span style="font-weight:700;">Total</span><span class="amount">₹${finalTotal}</span></div>
    </div>`;
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
  // SIMPLIFIED (per explicit request): City is no longer tied to the
  // account or cross-checked against it — Name/Address/Phone are the
  // same everywhere, but City is just whatever's currently on the page,
  // used as-is for this booking. No mismatch check, no blocking modal.
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

  // BUG FIX: cart items store their price CALCULATED for whichever city
  // was selected at the moment each one was added — changing the City
  // dropdown afterward doesn't retroactively re-price anything already
  // in the list. Without this check, a customer could add an item under
  // Moradabad, change the dropdown to Kasganj, then add/submit — the
  // booking's cityId ends up Kasganj but the already-added item(s) keep
  // charging Moradabad's price, a real mismatch between what the order
  // says and what it actually charges. Blocked the same way the phone-
  // number mismatch above already is, rather than silently either
  // re-pricing or submitting something inconsistent.
  if (cartItems.length > 0 && cartCityId && cityId !== cartCityId) {
    const cartCityName = (typeof CITIES !== 'undefined' ? CITIES.find(c => c.id === cartCityId) : null);
    msg.className = 'form-msg error';
    msg.textContent = `This booking is already using ${cartCityName ? cartCityName.name : 'a different city'} (item prices are city-specific). Please switch the City field back, or remove the item(s) below first to start over with a different city.`;
    document.getElementById('fCity').value = cartCityId;
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
      cartCityId = cityId; // locks this cart to this city — see the check above and renderCart()
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
let selectedSlotLabel = null;

// Renders available slots grouped under Morning/Afternoon/Evening headings
// (Jay Home Services style) into the #dateTimeModal, instead of the old
// flat 3-across grid. Groups are based on each slot's startHour (added to
// the /api/slots response in server.js) — a slot with no matching group
// (shouldn't normally happen) falls back into Afternoon.
function groupSlotsByTimeOfDay(slots) {
  const groups = { morning: [], afternoon: [], evening: [] };
  slots.forEach(s => {
    const h = typeof s.startHour === 'number' ? s.startHour : 12;
    if (h < 12) groups.morning.push(s);
    else if (h < 16) groups.afternoon.push(s);
    else groups.evening.push(s);
  });
  return groups;
}

function renderDtSlotGroups(slots) {
  const container = document.getElementById('dtSlotGroups');
  if (!container) return;
  const groups = groupSlotsByTimeOfDay(slots);
  const sections = [
    { key: 'morning', icon: '☀️', label: 'Morning' },
    { key: 'afternoon', icon: '🌤️', label: 'Afternoon' },
    { key: 'evening', icon: '🌙', label: 'Evening' }
  ];
  container.innerHTML = sections
    .filter(sec => groups[sec.key].length)
    .map(sec => `
      <div class="dt-slot-section">
        <p class="dt-slot-section-title">${sec.icon} ${sec.label}</p>
        <div class="dt-slot-grid">
          ${groups[sec.key].map(s => `
            <button type="button" class="slot-btn ${s.available ? '' : 'full'} ${selectedSlotId === s.id ? 'selected' : ''}" data-slot="${s.id}" data-label="${escapeHtml(s.label)}" ${s.available ? '' : 'disabled'}>
              ${s.label}
              <small>${s.available ? 'Available' : (s.expired ? 'Time Over' : 'Full')}</small>
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');
  container.querySelectorAll('.slot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedSlotId = btn.getAttribute('data-slot');
      selectedSlotLabel = btn.getAttribute('data-label');
      container.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      updateDtTriggerText();
      // Matches the reference flow: picking a slot is the final step, so
      // the popup closes itself right away instead of needing a separate
      // "Confirm" tap.
      closeDateTimeModal();
    });
  });
  if (!slots.some(s => s.id === selectedSlotId)) { selectedSlotId = null; selectedSlotLabel = null; }
}

async function refreshSlots() {
  const cityId = document.getElementById('fCity').value;
  const date = document.getElementById('fDate').value;
  const container = document.getElementById('dtSlotGroups');
  if (!container) return;
  if (!cityId || !date) {
    container.innerHTML = '<p style="font-size:0.82rem;color:var(--slate);margin:0;">Select a city and date above to see available slots.</p>';
    selectedSlotId = null;
    selectedSlotLabel = null;
    return;
  }
  container.innerHTML = '<p style="font-size:0.82rem;color:var(--slate);margin:0;">Loading slots...</p>';
  try {
    // Pass along which appliances are in the cart so a slot that's only
    // blocked for a specific appliance (e.g. AC) in this city/date shows
    // correctly as Full/Available for what the customer is actually booking.
    const applianceIds = [...new Set(cartItems.map(it => it.applianceId))].join(',');
    const slots = await fetchJSON(`/api/slots?date=${date}&cityId=${cityId}${applianceIds ? `&applianceIds=${applianceIds}` : ''}`);
    renderDtSlotGroups(slots);
  } catch (e) {
    container.innerHTML = '<p style="font-size:0.82rem;color:var(--red);margin:0;">Could not load slots. Please try again.</p>';
  }
}

// ---------------- Select Date & Time modal (Jay Home Services style) ---
function updateDtTriggerText() {
  const el = document.getElementById('dtTriggerText');
  if (!el) return;
  const dateVal = document.getElementById('fDateDisplay').value;
  if (dateVal && selectedSlotLabel) el.textContent = `📅 ${dateVal}, ${selectedSlotLabel}`;
  else if (dateVal) el.textContent = `📅 ${dateVal} — choose a time`;
  else el.textContent = '📅 Select Date & Time';
}

function openDateTimeModal() {
  const fDateEl = document.getElementById('fDate');
  const label = document.getElementById('dtSelectedDateLabel');
  if (label) {
    if (fDateEl.value) {
      const d = new Date(fDateEl.value + 'T00:00:00');
      label.textContent = d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    } else {
      label.textContent = 'No date selected';
    }
  }
  refreshSlots();
  document.getElementById('dateTimeModal').classList.add('open');
}
function closeDateTimeModal() {
  document.getElementById('dateTimeModal')?.classList.remove('open');
}
function bindDateTimeModal() {
  document.getElementById('dtTriggerBtn')?.addEventListener('click', () => {
    // SIMPLIFIED (per explicit request): opens the plain calendar
    // directly instead of the quick-pills step first — selecting a day
    // there (see selectDateCalendarDay()) already returns to this same
    // Date & Time popup to show that date's slots, so nothing else here
    // needs to change.
    openDateCalendar();
  });
  document.getElementById('dateTimeModalClose')?.addEventListener('click', closeDateTimeModal);
  document.getElementById('dtChangeDateBtn')?.addEventListener('click', openDateCalendar);
  document.getElementById('dateTimeModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'dateTimeModal') closeDateTimeModal();
  });
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
  // Picking a further-out date from the full "Pick" calendar returns to
  // the Select Date & Time popup so the customer can immediately choose
  // a time slot for it, same as tapping one of the quick date pills.
  if (typeof openDateTimeModal === 'function') openDateTimeModal();
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
  document.getElementById('addItemBtn').addEventListener('click', () => addItemToCart());
  document.getElementById('fDate').addEventListener('change', refreshSlots);
  bindDateCalendar();
  bindDateTimeModal();

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
    // were added to the cart, skip straight through — no need to ask
    // for OTP a second time at the very end of the same session.
    //
    // BUG FIX: this used to unconditionally REUSE the cached
    // verifiedBookingAccessToken here — but MSG91 access tokens are
    // single-use, and that same token had already been consumed once
    // already (validating it during the earlier combined-form step,
    // which calls /api/customer-profile). Sending it again here for the
    // SAME final booking submit had the server correctly reject it as
    // already-used/invalid, surfacing as the generic "OTP verification
    // failed" message right at the last step, even though the customer
    // had genuinely already verified successfully minutes earlier.
    // Re-checking isPhoneVerified() (server-side, persists regardless of
    // any client-side token) is the actual source of truth for whether
    // OTP is still needed at all — an accessToken is now only sent if
    // this comes back false, matching what the server's own check
    // already prioritizes.
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
      // BACK TO ONE SCREEN (per explicit request: the two-stage
      // details-then-thank-you version is removed again) — everything
      // (tick, booking number, service, date & time, charge) fills in and
      // shows immediately on #bookingSuccessView, chime playing right
      // away with the tick.
      const visitLabel = `${data.booking.timeSlot}, ${formatDateDisplay(data.booking.bookingDate)}`;
      document.getElementById('successBookingId').textContent = data.booking.id;
      document.getElementById('successVisit').textContent = visitLabel;
      const serviceListText = itemsToSubmit
        .map(it => `${it.qty}x ${it.applianceName} (${it.typeName}, ${it.serviceType === 'repair' ? 'Repair' : 'Service'})`)
        .join(', ');
      document.getElementById('detailsServiceList').textContent = serviceListText;
      document.getElementById('detailsCharge').textContent = `₹${data.booking.totalPrice}`;
      document.getElementById('bookingForm').style.display = 'none';
      document.getElementById('bookingSuccessView').style.display = 'block';
      playSuccessChime();
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
      selectedSlotLabel = null;
      document.getElementById('fDate').value = '';
      document.getElementById('fDateDisplay').value = '';
      updateDtTriggerText();
      document.getElementById('dtSlotGroups').innerHTML = '<p style="font-size:0.82rem;color:var(--slate);margin:0;">Select a city and date above to see available slots.</p>';

      // FLOW CHANGE: this used to also auto-open the Track Booking popup
      // right after — right on top of the green "Booking confirmed!"
      // message the person is still reading, which felt pointless/
      // confusing (two confirmations of the same thing, back to back).
      // Now it just shows the success screen and leaves the customer to
      // close it themselves; they can open Track Booking whenever they
      // actually want to check on it.
      const bookedPhone = payload.phone;
      if (payload.accessToken) {
        verifiedBookingPhone = bookedPhone;
        verifiedBookingAccessToken = payload.accessToken;
      }
      // BUG FIX ("popup bhi bhi bhaag raha hai" — the success screen
      // closing itself before OK was tapped): this used to also auto-
      // close the whole booking modal 3.5 seconds after success, via a
      // setTimeout left over from an earlier version of this flow —
      // completely separate from (and missed when removing) the visible
      // countdown-and-redirect behavior removed earlier in this same
      // session. That timer fired regardless of whether the customer
      // had even seen or read the confirmation yet, let alone tapped
      // OK, directly contradicting "screen ruke jab tak OK na dabaye".
      // Removed entirely — OK (closeBookingForm(), wired to the button
      // in the template) is now the only thing that closes this screen.
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
        <div class="row2" style="font-weight:700;color:var(--blue-900);">Booking ID: ${b.id} · ${b.cityName} · ₹${b.totalPrice} · ${formatDateDisplay(b.createdAt)}</div>
        ${b.timeSlot ? `<div class="row2">🕐 Visit: ${formatDateDisplay(b.bookingDate)} · ${b.timeSlot}</div>` : ''}
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
  if (!acc) { openAccountGate('refer'); return; }
  const modal = document.getElementById('referModal');
  const body = document.getElementById('referModalBody');
  if (!modal || !body) return;
  modal.classList.add('open');
  body.innerHTML = '<p class="spinner-text" style="color:var(--slate);"><span class="spinner-dot"></span>Getting your referral link...</p>';
  try {
    const info = await fetchJSON(`/api/referral/my-info?phone=${acc.phone}`);
    if (!info.active) {
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
    const shareText = `Hi! I use Seerua Appliance Care for AC/Washing Machine/RO/Fridge repair — book through my link and get ₹${info.referredDiscount} off your first service: ${info.link}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    // BUG FIX (the actual "WhatsApp khulta hai, samajh nahi aata" report):
    // this used to auto-redirect an already-opened popup straight to
    // WhatsApp the moment this data arrived — before the customer had
    // any real chance to read what's actually on this screen (how much
    // their friend saves, how many people they've referred, their
    // pending/earned rewards). The referral program's own value was
    // invisible; it just looked like a plain "share this link" button
    // that mysteriously opens WhatsApp. Now shows all of that plainly
    // first, with a clear, explicit "Share on WhatsApp" button the
    // customer taps only once they understand what they're sharing and
    // why — WhatsApp only opens on that explicit tap, never automatically.
    body.innerHTML = `
      <div class="row2" style="margin-bottom:10px;padding:10px 12px;background:#e7f8ee;border-radius:var(--radius-sm);color:var(--ink);">
        🎁 Share your link — your friend gets <strong>₹${info.referredDiscount} off</strong> their first service, and you get a reward coupon once their service is completed.
      </div>
      <div class="row2" style="margin-bottom:8px;">Your link: <a href="${info.link}" style="color:var(--blue-600);word-break:break-all;">${info.link}</a></div>
      <div class="row1"><span>People you've referred</span><strong>${info.referredCount || 0}</strong></div>
      <div class="row1"><span>Rewards pending (waiting for their service to complete)</span><strong>${info.pendingCount || 0}</strong></div>
      ${rewardsHtml ? `<div style="margin-top:10px;"><strong style="color:var(--blue-900);font-size:0.88rem;">Your reward coupons</strong>${rewardsHtml}</div>` : `<div class="row2" style="margin-top:8px;">No reward coupons yet — you'll get one automatically once someone you referred completes their first service.</div>`}
      <a href="${whatsappUrl}" target="_blank" rel="noopener" class="btn btn-primary btn-block" style="margin-top:14px;">💬 Share on WhatsApp</a>
    `;
  } catch (e) {
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
  const modal = document.getElementById('trackBookingModal');
  const body = document.getElementById('trackBookingModalBody');
  if (acc) {
    // Logged in — pre-fill and search immediately, same as before.
    const trackPhoneInput = document.getElementById('trackPhone');
    if (trackPhoneInput) trackPhoneInput.value = acc.phone;
    document.getElementById('trackBtn')?.click();
    return;
  }
  // BUG FIX: the visible popup (#trackBookingModal) never actually had
  // its own phone-input field — the underlying #trackPhone/#trackBtn
  // engine this reuses sits inside a permanently display:none box on
  // the page itself, which a real person can never type into (only
  // JS setting .value programmatically, as in the branch above, ever
  // worked). A logged-out customer opening this had nothing to type
  // into at all. Renders an actual, visible phone-input form directly
  // into this popup for that case.
  if (modal) modal.classList.add('open');
  if (body) {
    body.innerHTML = `
      <div class="field">
        <label for="trackPhoneModal">Mobile Number</label>
        <input type="tel" id="trackPhoneModal" placeholder="10 digit number" maxlength="10" inputmode="numeric">
      </div>
      <button type="button" class="btn btn-primary btn-block" id="trackBtnModal">Check Status</button>
    `;
    document.getElementById('trackBtnModal').addEventListener('click', async () => {
      const phone = document.getElementById('trackPhoneModal').value.trim();
      if (!/^[0-9]{10}$/.test(phone)) {
        body.insertAdjacentHTML('beforeend', '<p style="color:var(--red)">Please enter a valid 10 digit mobile number.</p>');
        return;
      }
      body.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
      try {
        const bookings = await fetchJSON(`/api/bookings/track?phone=${phone}`);
        lastTrackedBookings = bookings;
        knownReferralPhone = phone;
        body.innerHTML = bookings.length ? bookings.map(b => bookingCardHtml(b, true)).join('') : '<div style="text-align:center;padding:24px 10px;"><div style="font-size:2.4rem;margin-bottom:8px;">📭</div><p style="color:var(--slate);margin:0;">No bookings found for this number.</p></div>';
      } catch (e) {
        body.innerHTML = `<p style="color:var(--red)">${e.message || 'Something went wrong, please try again.'}</p>`;
      }
    });
  }
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
  // SIMPLIFIED (per explicit request): OTP removed from Track Booking —
  // just looking up bookings by phone number now, no verification step.
  // Note: this does mean anyone who knows/guesses a phone number can see
  // that number's booking history (name, address, appliance details) —
  // a deliberate tradeoff made explicitly in favor of simplicity here.
  try {
    results.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
    const bookings = await fetchJSON(`/api/bookings/track?phone=${phone}`);
    lastTrackedBookings = bookings;
    knownReferralPhone = phone; // so the header's "Refer a Friend" doesn't need to ask for the number again
    results.innerHTML = bookings.length ? bookings.map(b => bookingCardHtml(b, true)).join('') : '<div style="text-align:center;padding:24px 10px;"><div style="font-size:2.4rem;margin-bottom:8px;">📭</div><p style="color:var(--slate);margin:0;">No bookings found for this number.</p></div>';
  } catch (e) {
    results.innerHTML = `<p style="color:var(--red)">${e.message || 'Something went wrong, please try again.'}</p>`;
  }
});

// One-click reorder: pre-fill the booking form from a past booking
function bookAgain(bookingId) {
  const b = lastTrackedBookings.find(x => x.id === bookingId);
  if (!b) return;
  closeTrackBookingModal(); // "Book Again" tapped from the popup — close it so it doesn't sit on top of the booking form
  // Same one-screen popup as the rest of the site (not the old long form).
  if (window.SeeruaBooking && window.SeeruaBooking.openWithItems) {
    window.SeeruaBooking.openWithItems(b.cityId, b.items || [], { name: b.name, phone: b.phone, address: b.address, cityId: b.cityId });
    return;
  }
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
  selectedSlotLabel = null;
  document.getElementById('fDate').value = '';
  document.getElementById('fDateDisplay').value = '';
  if (typeof updateDtTriggerText === 'function') updateDtTriggerText();
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
// `opts.inline` (used by the Account Gate flow, see attemptAccountGateVerification)
// keeps everything inside the SAME popup that's already open — instead of
// opening the separate #otpEntryModal on top of / after it (the "ek popup
// band hota hai dusra khulta hai" report, part 2: even after every OTP
// caller correctly hid whatever modal was behind it, the customer still
// SAW one popup disappear and a different one appear a beat later, because
// it genuinely was two different modal-backdrops). Inline mode instead
// swaps two sibling <div> "steps" inside the still-open #accountGateModal
// (#agPhoneStep -> #agOtpStep), so nothing ever closes or reopens visually.
function verifyPhoneWithOtp(phone, opts) {
  opts = opts || {};
  const inline = !!opts.inline;
  return new Promise(async (resolve, reject) => {
    const ids = opts.ids || {
      modal: 'otpEntryModal', phone: 'otpEntryPhone', code: 'otpEntryCode',
      msg: 'otpEntryMsg', submit: 'otpEntrySubmit', resend: 'otpEntryResend', close: 'otpEntryClose'
    };
    const modal = inline ? null : document.getElementById(ids.modal);
    const phoneEl = document.getElementById(ids.phone);
    const codeEl = document.getElementById(ids.code);
    const msgEl = document.getElementById(ids.msg);
    const submitBtn = document.getElementById(ids.submit);
    const resendBtn = document.getElementById(ids.resend);
    const closeBtn = document.getElementById(ids.close);
    if (!phoneEl || !codeEl || !msgEl || !submitBtn || !resendBtn || !closeBtn || (!inline && !modal)) {
      reject(new Error('OTP entry is not available on this page.'));
      return;
    }

    // Inline mode: show/hide the two step-divs inside accountGateModal
    // (which stays open throughout). Modal mode (unchanged): show/hide
    // the standalone #otpEntryModal backdrop, same as before.
    const showOtpUI = inline
      ? () => {
          const phoneStep = document.getElementById('agPhoneStep');
          const otpStep = document.getElementById('agOtpStep');
          if (phoneStep) phoneStep.style.display = 'none';
          if (otpStep) otpStep.style.display = '';
        }
      : () => { modal.classList.add('open'); };
    const hideOtpUI = inline
      ? () => {
          const phoneStep = document.getElementById('agPhoneStep');
          const otpStep = document.getElementById('agOtpStep');
          if (otpStep) otpStep.style.display = 'none';
          if (phoneStep) phoneStep.style.display = '';
        }
      : () => { modal.classList.remove('open'); };

    let settled = false;
    const cleanup = () => {
      hideOtpUI();
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
    // BUG FIX ("ek popup band hota hai dusra khulta hai" — this turned out
    // to have TWO separate causes, not one: this function is called from
    // THREE different places (attemptAccountGateVerification() with
    // Account Gate open, but ALSO addItemToCart() and the main booking
    // form's Submit handler, which can run with Quick Book — or the older
    // combined booking form — open instead). Hard-coding "hide
    // accountGateModal" here only fixed the FIRST caller; a returning
    // customer (or anyone whose in-page verifiedBookingPhone hadn't been
    // set yet this session) hitting Add/Book straight from Quick Book
    // triggered addItemToCart()'s own OTP check with Quick Book itself
    // open, completely unaffected by that earlier fix — explaining why
    // the exact same report kept recurring even after Account Gate's own
    // case was confirmed fixed and deployed. Generalized here to hide
    // WHICHEVER modal-backdrop actually happens to be open, not one
    // hard-coded id, so every current AND future caller of this shared
    // function is covered the same way.
    let modalHiddenForOtp = null;
    const hideOpenModalForOtp = () => {
      // Inline mode deliberately keeps accountGateModal open the whole
      // time — there's nothing to hide behind it, that IS the fix.
      if (inline) return;
      const openModal = Array.from(document.querySelectorAll('.modal-backdrop.open'))
        .find(el => el.id !== 'otpEntryModal');
      modalHiddenForOtp = openModal || null;
      if (modalHiddenForOtp) {
        modalHiddenForOtp.classList.remove('open');
        modalHiddenForOtp.style.display = 'none';
      }
    };
    const restoreOpenModalAfterOtp = () => {
      if (modalHiddenForOtp) {
        modalHiddenForOtp.classList.add('open');
        modalHiddenForOtp.style.display = '';
        modalHiddenForOtp = null;
      }
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
      restoreOpenModalAfterOtp();
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
      // BUG FIX: one silent automatic retry before making the customer
      // tap Save a second time themselves — the prewarm in
      // openAccountGate() covers most of this already, but if that
      // hadn't finished yet (very fast typer, or it also hit a hiccup),
      // this gives the script one more chance to load before surfacing
      // an error and reverting to the phone/address step.
      const otpScriptUrls = ['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js'];
      try {
        await loadOtpScript(otpScriptUrls);
      } catch (firstErr) {
        await loadOtpScript(otpScriptUrls);
      }
      const identifier = '91' + phone; // MSG91 requires country code, no '+' or spaces
      phoneEl.textContent = phone;
      hideOpenModalForOtp();
      showOtpUI();
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
  // The booking popup (service-page.js) owns the cart and its badges now;
  // this old counter used to overwrite them with 0.
  if (window.SeeruaBooking && window.SeeruaBooking.refreshBadges) { window.SeeruaBooking.refreshBadges(); return; }
  const badge = document.getElementById('bottomNavCartBadge');
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
  if (badge) {
    badge.textContent = count;
    badge.hidden = count === 0;
  }
  // Same count, same visibility rule, for the desktop header's own Cart
  // icon (see headerCartBtn) — kept in sync here rather than duplicating
  // this whole counting rule a second time.
  const headerBadge = document.getElementById('headerCartBadge');
  if (headerBadge) {
    headerBadge.textContent = count;
    headerBadge.hidden = count === 0;
  }
}

function bindBottomNav() {
  const cartBtn = document.getElementById('bottomNavCartBtn');
  const cartClickHandler = () => {
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
  };
  if (cartBtn) cartBtn.addEventListener('click', cartClickHandler);
  // Desktop header's own Cart icon — identical behavior to the
  // mobile-only bottom-nav one above, just reachable when that's hidden.
  document.getElementById('headerCartBtn')?.addEventListener('click', cartClickHandler);
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
// Set right before opening the modal (by openQuickBookModal's optional
// second argument) when the customer arrived via a link that already
// names a specific type — e.g. a Google search result landing on the
// "Split AC Service in Jalesar" SEO page, whose Book link now carries
// &type=<id>. qbShowDetails() reads this ONCE to decide which tab starts
// active, then clears it — so it never leaks into a later open (a
// different appliance card tapped afterwards, or the same modal reopened)
// which should keep defaulting to that appliance's first type as before.
let qbInitialTypeId = null;
// BUG FIX ("Book Your Service ke do popup hote hain, same content, ek ki
// zaroorat hai" — reported AGAIN after the Select/Add Address stacking fix
// above, this time with a screenshot showing the Account Gate's own
// Name/Mobile/Address fields overlapping the Quick Book modal's service
// card underneath, "Ongoing support for any follow-up questions" / Add /
// Book bleeding through around the filled-in form): every path that opens
// Account Gate from inside an already-open Quick Book modal — tapping
// Add/Book on a service card, or "Book" on the single-service view, before
// an account exists — called openAccountGate()/showed accountGateModal
// directly without ever removing quickBookModal's own 'open' class. Both
// modal-backdrops stayed visually open at once, so the Quick Book modal's
// content showed through/around the Account Gate popup instead of being
// hidden behind it. Same root pattern as the address-modal stacking bug,
// same fix shape: hide the Quick Book modal for as long as Account Gate is
// up, and bring it back exactly once Account Gate is done with it — either
// closed outright (X / backdrop tap) or handed off to
// openQuickBookModalReal(), which re-adds 'open' anyway once it has real
// content to show.
let qbModalHiddenByGate = false;
function hideQuickBookModalForGate() {
  const qbModalEl = document.getElementById('quickBookModal');
  qbModalHiddenByGate = !!(qbModalEl && qbModalEl.classList.contains('open'));
  if (qbModalHiddenByGate) {
    qbModalEl.classList.remove('open');
    // BELT AND SUSPENDERS: the stylesheet already ties visibility to the
    // 'open' class (.modal-backdrop{display:none} / .open{display:flex}),
    // so removing the class above should be enough on its own — but this
    // bug kept reproducing live even after that was verified correct, so
    // force the inline style directly too. An inline style always wins
    // over a stylesheet rule regardless of any specificity/ordering
    // question, so this can't lose to anything.
    qbModalEl.style.display = 'none';
  }
}
function restoreQuickBookModalAfterGate() {
  if (qbModalHiddenByGate) {
    const qbModalEl = document.getElementById('quickBookModal');
    if (qbModalEl) {
      qbModalEl.classList.add('open');
      qbModalEl.style.display = ''; // hand control back to the normal .open CSS rule
    }
    qbModalHiddenByGate = false;
  }
}
// SAFETY NET (added after the above fix was reported as still visible live,
// with the exact same overlap, more than once — "Book Your Service" over
// "AC Service"/"Ongoing support.../Add/Book" from Quick Book underneath):
// rather than trust every current AND future call site to remember to call
// hideQuickBookModalForGate()/restoreQuickBookModalAfterGate() correctly (or
// trust that a live deploy always reflects the very latest edit), this
// watches the two modals' own 'open' class directly and self-corrects the
// instant they're EVER both open at once, regardless of which code path or
// timing caused it. It only ever acts when both are actually open
// together — the exact broken state — so it can't change behavior for any
// normal single-modal flow.
// GENERIC VERSION of the safety net below: forces `winnerId`'s modal to
// stay hidden while `loserId`'s modal is open (winner always wins),
// self-correcting via MutationObserver + a 300ms poll fallback,
// regardless of which code path or timing caused both to be open. Used
// for every modal pair found so far where one opens from within the
// other without properly hiding it first — each new one found (Address
// over Account Gate, Account Gate over Quick Book, now OTP over Account
// Gate) turned out to be the same underlying mistake repeated at a
// different call site, so this net is applied pair-by-pair rather than
// assumed to be exhaustive.
function enforceModalExclusivity(winnerId, loserId) {
  const winner = document.getElementById(winnerId);
  const loser = document.getElementById(loserId);
  if (!winner || !loser || typeof MutationObserver === 'undefined') return;
  const guardAttr = `hiddenByGuard_${winnerId}`;
  const reconcile = () => {
    // Read visibility the same way the CSS actually decides it (both the
    // class AND a possible inline style — belt and suspenders, matching
    // the hide functions' own inline style.display fallback), not just
    // the class, so this can't be fooled by whichever mechanism actually
    // ends up controlling the real live page.
    const winnerOpen = winner.classList.contains('open') && getComputedStyle(winner).display !== 'none';
    const loserOpen = loser.classList.contains('open') && getComputedStyle(loser).display !== 'none';
    if (winnerOpen && loserOpen) {
      loser.classList.remove('open');
      loser.style.display = 'none';
      loser.dataset[guardAttr] = '1';
    } else if (!winnerOpen && loser.dataset[guardAttr] && !loserOpen) {
      loser.classList.add('open');
      loser.style.display = '';
      delete loser.dataset[guardAttr];
    }
  };
  const observer = new MutationObserver(reconcile);
  observer.observe(winner, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(loser, { attributes: true, attributeFilter: ['class', 'style'] });
  // Ultimate fallback in case something about this page's real, live
  // environment stops the MutationObserver above from firing the way it
  // does in every local test — costs nothing (two classList/style reads,
  // ~3x/second per pair) and guarantees this self-corrects within a
  // third of a second even in the worst case.
  setInterval(reconcile, 300);
}
enforceModalExclusivity('accountGateModal', 'quickBookModal');
// BUG FIX: verifyPhoneWithOtp() (the OTP entry step) is shared by THREE
// different callers — attemptAccountGateVerification() (Account Gate
// open), addItemToCart() (Quick Book, or the older combined booking form,
// open), and the main Submit handler (same) — so a single hard-coded
// winner/loser pair like the ones above isn't enough; whichever OTHER
// modal happens to be open when OTP starts needs to yield, not just one
// specific one. This is exactly why the "one popup closes, another opens"
// report kept recurring even after Account Gate's own case (the first
// caller found) was fixed, confirmed live, and redeployed — the SECOND
// caller (Quick Book's own Add/Book, hit by anyone whose phone hadn't
// been re-verified yet this page load) was still wide open the whole
// time. hideOpenModalForOtp()/restoreOpenModalAfterOtp() inside
// verifyPhoneWithOtp() itself already handle this generically at the
// source; this applies the same "OTP always wins" rule as a safety net
// against every OTHER modal-backdrop on the page, not just one.
Array.from(document.querySelectorAll('.modal-backdrop'))
  .filter(el => el.id && el.id !== 'otpEntryModal')
  .forEach(el => enforceModalExclusivity('otpEntryModal', el.id));
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
  // Per explicit request: for Instant Booking specifically (the "Book"
  // button — always exactly one pre-selected item, as opposed to "Add",
  // which goes into the real multi-item cart), the "Add an appliance to
  // this booking" section doesn't make sense either — there's nothing
  // else to add to a booking that's meant to be just this one item.
  // hideRedundantBookingFields() is only ever called from the Instant
  // Booking ("thenBook"/qbBookBtn) paths, never from the regular Add
  // flow, so this only hides it for that specific case.
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

  // Opens the same "Add Address" step (in edit mode) the booking form's
  // own Edit button uses — one shared place a customer can update their
  // saved name/address/city without needing to start a booking first.
  document.getElementById('headerAccountEditBtn')?.addEventListener('click', () => {
    menu.classList.remove('open');
    openEditProfile();
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
    if (window.SeeruaBooking && window.SeeruaBooking.onLogout) window.SeeruaBooking.onLogout();
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
  // SIMPLIFIED (per explicit request): City is never locked to the
  // account, or cross-checked against it — Name/Address/Phone are the
  // same everywhere, but City is a per-booking choice. Only pre-fills
  // #fCity as a convenience default when it's currently empty — never
  // overwrites a choice already sitting there, and never disables the
  // field.
  if (cityEl && acc.cityId && !cityEl.value) { cityEl.value = acc.cityId; refreshAppliancesForCity(acc.cityId); }
  if (cityEl && cityEl.value && typeof updateCityButtonLabels === 'function') updateCityButtonLabels(cityEl.value);
  const editBtn = document.getElementById('editAddressBtn');
  if (editBtn) editBtn.style.display = 'inline-block';
  verifiedBookingPhone = acc.phone;
  if (acc.accessToken) verifiedBookingAccessToken = acc.accessToken;
  // BUG FIX: both the address and city above get set programmatically
  // here (readonly pre-fill from the saved account) — neither a plain
  // .value assignment (city) nor a readonly field (address, never
  // actually typed into) fires the 'change'/'input' events
  // checkAddressCityMismatch() normally listens for. So if someone's
  // OWN saved account address doesn't actually match their account's
  // saved city, the warning never had a chance to show at all. Call it
  // directly here so this exact scenario is covered too.
  if (typeof checkAddressCityMismatch === 'function') checkAddressCityMismatch();
}

function openAccountGate(intent, applianceId) {
  agIntent = intent;
  agPendingApplianceId = applianceId || null;
  // BUG FIX: this is the missing piece of the "wrong/default type opens
  // first" fix above. A new customer arriving via a type-specific SEO link
  // (e.g. "Split AC Service in Jalesar") lands with Split AC already
  // correctly selected — but tapping Add/Book before an account exists
  // routes through here, and proceedAfterAccountGate()'s 'quickbook'
  // branch re-opens the modal from scratch (openQuickBookModalReal() ->
  // qbShowDetails()) once they finish the phone+address step. By then
  // qbInitialTypeId had already been consumed by that first open, so
  // qbShowDetails() fell back to defaulting on appliance.types[0] again —
  // silently switching them back to Window AC right when they finally see
  // the price/booking form. Re-arming qbInitialTypeId here, from whatever
  // type is actually selected right now (qbSelectedTypeId — covers both
  // the SEO-link case and a manual tab switch), means the resumed re-open
  // starts on the same type they were already looking at.
  if (intent === 'quickbook' && qbSelectedTypeId) {
    qbInitialTypeId = qbSelectedTypeId;
  }
  const acc = getAccount();
  if (acc) {
    proceedAfterAccountGate(acc);
    return;
  }
  document.getElementById('agPhoneMsg').textContent = '';
  document.getElementById('agName').value = '';
  document.getElementById('agPhone').value = '';
  // Address is now a plain textarea typed directly on this same card (see
  // index.template.html's #agPhoneStep) — no more separate select/preview
  // popup to reset here.
  document.getElementById('agAddress').value = '';
  resetAgOtpStep();
  hideQuickBookModalForGate();
  document.getElementById('accountGateModal').classList.add('open');
  // BUG FIX ("Save davane se same form fir se bhara hua aa jata hai, fir
  // Save davane se OTP aata hai" — first tap "does nothing" and shows the
  // same filled-in form again, second tap works): NOT the popup-overlap
  // bug — that was already fixed. This is verifyPhoneWithOtp() waiting on
  // MSG91's OTP script to load fresh from their servers only once Save is
  // tapped; on a slow/flaky mobile connection (or a Render cold start)
  // that first load can time out, which correctly shows an error and
  // re-enables the form for a retry — but reads exactly like "same form
  // came back". Starting that script load right NOW, in the background,
  // while the customer is still typing their name/phone/address, means
  // it's very likely already cached by the time they tap Save, so the
  // slow-first-attempt case becomes rare. Failure here is silently
  // ignored — verifyPhoneWithOtp() still retries for real when Save is
  // actually tapped.
  ensureOtpConfig()
    .then((cfg) => (cfg && cfg.enabled !== false)
      ? loadOtpScript(['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js'])
      : null)
    .catch(() => {});
}

// Always start (and leave) accountGateModal on the Name/Phone/Address step,
// never mid-OTP — in case it's opened fresh, or closed (via the ✕) while
// the inline OTP step was showing.
function resetAgOtpStep() {
  const phoneStep = document.getElementById('agPhoneStep');
  const otpStep = document.getElementById('agOtpStep');
  const otpCode = document.getElementById('agOtpCode');
  const otpMsg = document.getElementById('agOtpMsg');
  if (otpStep) otpStep.style.display = 'none';
  if (phoneStep) phoneStep.style.display = '';
  if (otpCode) otpCode.value = '';
  if (otpMsg) { otpMsg.className = 'form-msg'; otpMsg.textContent = ''; }
}

function closeAccountGate() {
  // If the customer hits the top ✕ while mid-OTP (inline step showing),
  // settle that pending verifyPhoneWithOtp() promise as cancelled first —
  // same as tapping "← Back" — so its event listeners are cleaned up and
  // attemptAccountGateVerification()'s agSending flag doesn't get stuck
  // permanently true, blocking every future attempt.
  const otpStep = document.getElementById('agOtpStep');
  if (otpStep && otpStep.style.display !== 'none') {
    document.getElementById('agOtpBack')?.click();
  }
  document.getElementById('accountGateModal').classList.remove('open');
  qbPendingRetryAction = null;
  qbPendingServiceAction = null;
  resetAgOtpStep();
  restoreQuickBookModalAfterGate();
}

// Called once the phone+address chain is fully complete (either just
// now, or already done on an earlier visit) — sends the customer
// straight on to whatever they originally asked for. This is the
// "chain advances itself" part: no extra taps needed in between.
function proceedAfterAccountGate(acc) {
  const resumeQbAction = qbPendingRetryAction; // capture before closeAccountGate() clears it
  const resumeQbServiceAction = qbPendingServiceAction; // same, for the per-service-card Add/Book buttons
  closeAccountGate();
  if (agIntent === 'profile-edit') {
    // Just a re-verification so an expired Edit Profile could go
    // through — nothing further to do, already saved by the time this
    // runs.
    applyAccountToBookingFields(acc);
    showToast('✅ Details updated');
  } else if (agIntent === 'refer') {
    // BUG FIX: this used to share the plain 'account' intent with the
    // header's own Track Booking button — so a customer who tapped
    // "Refer a Friend" without an account yet, registered, and landed
    // back here got sent to Track Booking instead of back to what they
    // actually asked for. Own intent, opens the right thing.
    openReferModal();
  } else if (agIntent === 'account') {
    // BUG FIX ("customer login karta hai to uska tracking kyun self khul
    // jaata hai"): this used to jump straight to Track Booking the
    // moment someone registered via the header profile icon — even if
    // they'd tapped it just to see what's there (Edit Profile, Refer a
    // Friend, etc.), not specifically to track a booking. Opens the
    // account menu itself instead, same as tapping the profile icon
    // normally does once an account already exists — Track Booking is
    // one tap away from there if that's what they actually wanted.
    document.getElementById('headerAccountMenu')?.classList.add('open');
  } else if (agIntent === 'quickbook') {
    applyAccountToBookingFields(acc);
    const qbRenderPromise = openQuickBookModalReal(agPendingApplianceId);
    // BUG FIX ("appliance fir khul jaata hai" then, after an earlier fix
    // attempt, "confirmation ke baad main site — keemat ki details nahi
    // aayi", then — after THAT fix — "AC service Jalesar search kiya...
    // book davaya... appliance khul gaye, fir book davaya tab price
    // details aayi"): openQuickBookModalReal() above visually opens the
    // Quick Book popup (city/type/price) as a side effect of preparing
    // its internal state, right before auto-resuming Add/Book. The
    // customer had already made their appliance choice before this
    // phone+address step even started, so that screen flashing back
    // open was confusing, and just hiding the modal for that gap left a
    // worse blank-screen flash — both covered by this same loading
    // overlay.
    //
    // THIS bug was a THIRD, deeper issue underneath that overlay: the
    // auto-resume click used to fire on a fixed guessed delay (300ms),
    // and the overlay itself was removed on another fixed guessed delay
    // (600ms) — both tuned against this sandbox's near-instant local
    // network, where qbShowDetails()'s price fetch reliably finishes
    // well within 300ms. On a real phone's mobile network (and any
    // Render cold start), that same fetch can easily take longer.
    // qbRenderServicesList() (called from inside qbShowDetails()) throws
    // away and REBUILDS the service-card buttons from scratch once its
    // fetch resolves — so if that hadn't happened yet when the fixed
    // 300ms timer fired, the auto-click's querySelector found nothing
    // (the old placeholder had no such button yet) and silently did
    // nothing. The overlay then also vanished at 600ms regardless,
    // exposing the now-loaded-but-never-auto-clicked appliance/service
    // list sitting there — exactly "appliance khul gaye" — and the
    // customer had to tap Book themselves a second time to finally see
    // the price/booking-details form.
    //
    // Fix: openQuickBookModalReal() now returns the actual render
    // promise (see its own comment, and qbShowDetails()'s), so the
    // overlay is removed and the resume click is dispatched only once
    // the real, priced buttons genuinely exist in the DOM — no more
    // guessing at a delay. A generous safety-net timeout still forces
    // the overlay away if that promise never settles for some
    // unexpected reason, so nobody gets stuck looking at "Preparing
    // your booking…" forever.
    if (resumeQbAction || resumeQbServiceAction) {
      const qbModalBox = document.querySelector('#quickBookModal .quick-book-modal');
      let overlay = null;
      if (qbModalBox && !document.getElementById('qbResumeLoadingOverlay')) {
        // CSS overlay, NOT an innerHTML replacement — #qbAddBtn/#qbBookBtn
        // and the rest of the real form underneath must stay in the DOM
        // exactly as they are, since the resume click below targets them
        // directly. This only visually covers them until they're ready.
        overlay = document.createElement('div');
        overlay.id = 'qbResumeLoadingOverlay';
        overlay.style.cssText = 'position:absolute;inset:0;background:#fff;border-radius:inherit;display:flex;align-items:center;justify-content:center;z-index:5;';
        overlay.innerHTML = '<p class="spinner-text" style="color:var(--slate);"><span class="spinner-dot"></span>Preparing your booking…</p>';
        qbModalBox.style.position = 'relative';
        qbModalBox.appendChild(overlay);
      }
      const overlaySafetyTimer = setTimeout(() => overlay?.remove(), 10000);
      Promise.resolve(qbRenderPromise).catch(() => {}).then(() => {
        clearTimeout(overlaySafetyTimer);
        overlay?.remove();
        // Resume whichever action (Add / Book Now, or a specific
        // service card's Add/Book) was actually being attempted when
        // this got paused for phone+OTP — see qbDoAdd(), qbAddService(),
        // and the qbAddBtn/qbBookBtn/service-card click handlers. The
        // buttons targeted here are now guaranteed to exist, since we
        // waited for the real render above instead of guessing a delay.
        if (resumeQbAction === 'add') {
          document.getElementById('qbAddBtn')?.click();
        } else if (resumeQbAction === 'book') {
          document.getElementById('qbBookBtn')?.click();
        } else if (resumeQbServiceAction) {
          const action = resumeQbServiceAction.thenBook ? 'book' : 'add';
          document.querySelector(
            `#qbServicesList button[data-action="${action}"][data-service-id="${resumeQbServiceAction.svcId}"]`
          )?.click();
        }
      });
    }
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

  // SIMPLIFIED (per explicit request): one combined submit instead of
  // phone-first-then-address. Validates Name + Phone + Address together,
  // sends OTP only once everything else already checks out, and saves
  // the complete account the moment OTP succeeds — no separate second
  // step. City comes from whatever's already selected on the page
  // (#fCity) at the point of booking, not asked again here.
  let agSending = false;
  async function attemptAccountGateVerification() {
    if (agSending) return;
    const msg = document.getElementById('agPhoneMsg');
    const name = document.getElementById('agName').value.trim();
    const phone = document.getElementById('agPhone').value.trim();
    const address = document.getElementById('agAddress').value.trim();
    const btn = document.getElementById('agSendBtn');
    if (!name) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please enter your name.';
      return;
    }
    if (!/^[0-9]{10}$/.test(phone)) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please enter a valid 10 digit mobile number.';
      return;
    }
    if (!address) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please select or add your address.';
      return;
    }
    const cityId = document.getElementById('fCity').value;
    if (!cityId) {
      msg.className = 'form-msg error';
      msg.textContent = 'Please select a city first.';
      return;
    }
    agSending = true;
    btn.disabled = true;
    btn.textContent = 'Confirming...';
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
        // Inline mode: OTP entry swaps in as a second step INSIDE this
        // same accountGateModal popup (agPhoneStep -> agOtpStep) instead
        // of opening the separate #otpEntryModal — so there's only ever
        // one visible popup for a new customer signing up.
        accessToken = await verifyPhoneWithOtp(phone, {
          inline: true,
          ids: {
            phone: 'agOtpPhone', code: 'agOtpCode', msg: 'agOtpMsg',
            submit: 'agOtpSubmit', resend: 'agOtpResend', close: 'agOtpBack'
          }
        });
      }
      verifiedBookingPhone = phone;
      verifiedBookingAccessToken = accessToken;
      msg.textContent = 'Confirming your details...';
      try {
        await fetchJSON('/api/customer-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, name, address, cityId, accessToken })
        });
      } catch (e) { /* non-fatal — worst case, later steps re-check phone-verified the normal way */ }
      const acc = { phone, name, address, cityId, accessToken };
      saveAccount(acc);
      proceedAfterAccountGate(acc);
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message || 'Something went wrong. Please try again.';
    } finally {
      agSending = false;
      btn.disabled = false;
      btn.textContent = 'Confirm Booking';
    }
  }
  document.getElementById('agSendBtn').addEventListener('click', attemptAccountGateVerification);

  document.getElementById('agSaveBtn').addEventListener('click', async () => {
    const msg = document.getElementById('agAddressMsg');
    const existingAcc = getAccount();
    const phone = (existingAcc && existingAcc.phone) || verifiedBookingPhone;
    const name = document.getElementById('agEditName').value.trim();
    const address = document.getElementById('agEditAddress').value.trim();
    const cityId = document.getElementById('agCity').value;
    if (!phone) { msg.className = 'form-msg error'; msg.textContent = 'Please verify your mobile number first.'; return; }
    if (!name) { msg.className = 'form-msg error'; msg.textContent = 'Please enter your name.'; return; }
    if (!address) { msg.className = 'form-msg error'; msg.textContent = 'Please select or add your address.'; return; }
    if (!cityId) { msg.className = 'form-msg error'; msg.textContent = 'Please select your city.'; return; }
    const btn = document.getElementById('agSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    msg.className = 'form-msg';
    msg.textContent = '';
    try {
      await fetchJSON('/api/customer-profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name, address, cityId, accessToken: (existingAcc && existingAcc.accessToken) || verifiedBookingAccessToken || undefined })
      });
      const acc = { phone, name, address, cityId, accessToken: (existingAcc && existingAcc.accessToken) || verifiedBookingAccessToken };
      saveAccount(acc);
      document.getElementById('accountEditModal').classList.remove('open');
      applyAccountToBookingFields(acc);
      showToast('✅ Details updated');
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.message || 'Could not save your details. Please try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });

  document.getElementById('editAddressBtn')?.addEventListener('click', openEditProfile);
}
// Shared by the booking form's own "Edit Address / City" button AND the
// account menu's new "Edit Profile" item — same Account Gate "Add
// Address" step, reused in edit mode, so there's exactly one place that
// actually writes to the saved account either way.
async function openEditProfile() {
  const acc = getAccount();
  if (!acc) return;
  document.getElementById('agAddressMsg').textContent = '';

  // BUG FIX: a saved account lives in the browser (localStorage)
  // basically forever, but the server's memory of "this phone passed
  // OTP once" (data/verified-phones.json) can be lost independently —
  // e.g. a redeploy without a database configured. When that happens,
  // this used to jump straight to the edit form using the old
  // (now-unrecognized) accessToken from localStorage, and Save always
  // failed with a confusing "OTP verification failed, expired, or does
  // not match this phone number" error with no way to recover short of
  // logging out. Now it re-checks with the server first: if the phone
  // is still verified, opens the (name/city/address only) edit modal as
  // before; if not, re-uses the main combined booking form to re-verify
  // AND update their details in one go, since that form already does
  // exactly that.
  let stillVerified = true;
  try {
    const check = await fetchJSON(`/api/phone-verified?phone=${acc.phone}`);
    stillVerified = !!check.verified;
  } catch (e) { /* can't tell — assume still verified, Save will surface any real problem */ }

  if (stillVerified) {
    document.getElementById('agEditName').value = acc.name || '';
    document.getElementById('agEditAddress').value = acc.address || '';
    if (typeof updateAddressPreview === 'function') updateAddressPreview('agEditAddress', 'agEditAddressPreview');
    populateSelect(document.getElementById('agCity'), CITIES, 'Select city');
    if (acc.cityId) document.getElementById('agCity').value = acc.cityId;
    document.getElementById('accountEditModal').classList.add('open');
  } else {
    agIntent = 'profile-edit';
    document.getElementById('agPhoneMsg').textContent = '';
    document.getElementById('agName').value = acc.name || '';
    document.getElementById('agPhone').value = acc.phone;
    // Plain textarea now (see #agPhoneStep) — just prefill the value, no
    // separate preview span to keep in sync anymore.
    document.getElementById('agAddress').value = acc.address || '';
    const title = document.getElementById('agPhoneTitle');
    const sub = document.getElementById('agPhoneSub');
    if (title) title.textContent = 'Please verify again';
    if (sub) sub.textContent = 'Your verification expired — please verify your mobile number again to update your details.';
    hideQuickBookModalForGate();
    document.getElementById('accountGateModal').classList.add('open');
  }
}
bindAccountGateModal();

// Instant Booking entry point (tapping an appliance card) — now gated by
// the same shared Account Gate as Booking/My Account, per the unified
// flow. Once an account exists this is completely transparent: the
// modal below (openQuickBookModalReal) opens immediately with the
// mobile number field already filled in and hidden.
function openQuickBookModal(applianceId, typeId) {
  // The old Quick Book modal is retired: chat assistant, ?appliance= links
  // and every other caller now open the one-screen booking popup.
  if (window.SeeruaBooking && window.SeeruaBooking.openForAppliance) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    window.SeeruaBooking.openForAppliance(applianceId, typeId || (typeof qbSelectedTypeId !== 'undefined' ? qbSelectedTypeId : null), {
      cityId: val('fCity') || new URLSearchParams(location.search).get('city') || '',
      name: val('fName'), phone: val('fPhone') || val('qbPhone'), address: val('fAddress')
    });
    return;
  }
  if (!window.SeeruaBooking && document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => openQuickBookModal(applianceId, typeId), { once: true }); return; }
  // BUG FIX (per explicit request): a customer who searched "AC service in
  // Jalesar" on Google, landed on the Split-AC-specific SEO page, and
  // tapped its Book button used to always see this modal open on Window AC
  // (appliance.types[0]) instead of the Split AC they actually came for —
  // qbShowDetails() had no way to know which type the link was for. The
  // optional typeId argument here (threaded through from the URL's own
  // &type=... param — see bindUrlTriggeredSections()/
  // autoOpenBookingFromUrlParams()) lets qbShowDetails() start on the
  // right tab instead of always defaulting to the first one.
  qbInitialTypeId = typeId || null;
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
  // BUG FIX (per explicit request): this used to gate on having an
  // account BEFORE ever showing appliance type/price — meaning "Book
  // Now" on a card asked for a phone number + OTP immediately, before
  // the customer had seen anything about what they were even booking.
  // Now opens straight to type/price; account (and OTP, if this number
  // isn't already verified) is only ever asked for once they actually
  // try to Add/Book — see qbDoAdd().
  const acc = getAccount();
  if (acc) applyAccountToBookingFields(acc);
  openQuickBookModalReal(applianceId);
}

function openQuickBookModalReal(applianceId) {
  qbApplianceId = applianceId;
  qbServiceType = 'service';
  const modal = document.getElementById('quickBookModal');
  const msg = document.getElementById('qbMsg');
  if (msg) { msg.className = 'form-msg'; msg.textContent = ''; }
  // FLOW CHANGE: the mobile number field is hidden (see #qbPhoneField in
  // the template) — by the time this runs, openQuickBookModal() has
  // already gated on the shared account, so it's filled in from there
  // instead of typed here.
  const qbPhoneEl = document.getElementById('qbPhone');
  const qbAcc = getAccount();
  if (qbPhoneEl) qbPhoneEl.value = qbAcc ? qbAcc.phone : '';

  // SIMPLIFIED (per explicit request): City selector and Type/Price now
  // share one single screen instead of a separate "pick city, tap
  // Continue" step first — always shows qbDetailsStep, with the city
  // dropdown pre-filled from whatever's already chosen this session (if
  // anything). Selecting/changing the city right here (see its own
  // 'change' listener below) is what triggers loading the price.
  const citySelect = document.getElementById('qbCitySelect');
  populateSelect(citySelect, CITIES, 'Select city');
  const existingCity = document.getElementById('fCity').value;
  // BUG FIX: this used to just call qbShowDetails() without keeping its
  // promise — fine for a normal manual open (nobody's waiting on it),
  // but the account-gate "quickbook" resume flow in
  // proceedAfterAccountGate() needs to know once the real, priced
  // service-card buttons actually exist in the DOM before it can safely
  // auto-click one. Returning the promise here (still undefined for a
  // caller that doesn't await it, exactly as before) lets that one
  // caller wait for it without changing behavior for anyone else.
  let renderPromise = null;
  if (existingCity) {
    citySelect.value = existingCity;
    renderPromise = qbShowDetails();
  } else {
    document.getElementById('qbTypeTabs').innerHTML = '';
    document.getElementById('qbSingleServiceView').style.display = 'none';
    document.getElementById('qbServicesList').style.display = 'none';
    document.getElementById('qbNotAvailable').style.display = 'none';
  }
  modal.classList.add('open');
  return renderPromise;
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
  const qbImgEl = document.getElementById('qbPriceImg');
  qbImgEl.onerror = () => { qbImgEl.onerror = null; qbImgEl.src = appliance.photoUrl || ''; };
  qbImgEl.src = appliance.photoUrl ? toWebpUrl(appliance.photoUrl) : '';
  qbImgEl.alt = appliance.name;

  // BUG FIX: pick the tab to start on. If openQuickBookModal() was called
  // with a specific type (a SEO page's "Book <Type> Service" link), and
  // that type actually exists on this appliance, start there instead of
  // always on appliance.types[0] — that's the fix for the "wrong/default
  // type opens first" report. Read qbInitialTypeId once and clear it
  // immediately so it only affects this one open, not a later one (e.g.
  // tapping a different appliance card afterwards).
  const requestedTypeId = qbInitialTypeId;
  qbInitialTypeId = null;
  const initialType = (requestedTypeId && appliance.types.find(t => t.id === requestedTypeId))
    || appliance.types[0]
    || null;
  const initialTypeId = initialType ? initialType.id : null;

  // SIMPLIFY (per explicit request — booking felt "jatil"/complex):
  // appliances with only one type (Fridge, RO, Chimney, ...) were still
  // showing a type-tabs row with a single, un-skippable button — an
  // extra "step" that decided nothing, since qbSelectedTypeId is set to
  // that one type either way. Hidden entirely when there's nothing to
  // actually choose between; still rendered (and still functional) for
  // real multi-type appliances like AC (Window/Split/Cassette).
  const tabsEl = document.getElementById('qbTypeTabs');
  if (appliance.types.length > 1) {
    tabsEl.style.display = '';
    tabsEl.innerHTML = appliance.types.map((t) =>
      `<button type="button" data-type="${t.id}" class="${t.id === initialTypeId ? 'active' : ''}">${t.name}</button>`
    ).join('');
  } else {
    tabsEl.style.display = 'none';
    tabsEl.innerHTML = '';
  }
  qbSelectedTypeId = initialTypeId;

  tabsEl.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      qbSelectedTypeId = btn.getAttribute('data-type');
      qbRenderForSelectedType();
    });
  });

  // BUG FIX: this used to fire-and-forget qbRenderForSelectedType() here
  // (no `return`/`await`) — meaning qbShowDetails()'s own promise
  // resolved immediately, well before qbRenderForSelectedType()'s inner
  // qbRenderServicesList() had actually fetched pricing and rebuilt the
  // service-card buttons. openQuickBookModalReal() (below) and the
  // account-gate "quickbook" resume flow in proceedAfterAccountGate()
  // both need to know when those buttons genuinely exist in the DOM —
  // see the detailed comment there for the real-world bug this caused.
  return qbRenderForSelectedType();
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
      ? `<span class="qb-price-tag">🏷️</span><span class="qb-price-now">₹${price}</span>`
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
        <!-- SIMPLIFY (per explicit request): the full checklist used to
             always be expanded on every service card, which for an
             appliance with several services (AC: Service/Repair/
             Installation/Uninstallation/Gas Filling) made the modal a
             long, cluttered scroll. Collapsed behind a "What's included"
             toggle by default — same information, one tap away, but the
             card itself now reads as just a price and two buttons at a
             glance (closer to Urban Company's clean per-service cards). -->
        <details class="qb-checklist-details">
          <summary>What's included</summary>
          <ul class="qb-checklist">${svc.checklist.map(item => `<li>${item}</li>`).join('')}</ul>
        </details>
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
  // BUG FIX: this used to read #qbPhone's own value — that field is
  // permanently hidden (see the comment on it in the template), and
  // nothing ever fills it in for this per-service-card path, so it was
  // always empty. That made every service card's Add/Book fail with
  // "please enter a valid mobile number" and no visible field to type
  // one into. Same fix as qbDoAdd(): if we already have a signed-in
  // account, read its verified phone directly; if not, pause here,
  // remember exactly which card/action was being tried, and resume it
  // automatically once the Account Gate (phone + OTP) succeeds — see
  // qbPendingServiceAction and the 'quickbook' branch of
  // proceedAfterAccountGate().
  const acc = getAccount();
  if (!acc) {
    qbPendingServiceAction = { svcId: svc.id, thenBook };
    openAccountGate('quickbook', qbApplianceId);
    return;
  }
  const phone = acc.phone;
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

// APPLIANCE PRICE BOXES (per explicit request, restoring an older,
// simpler flow that had been lost from this codebase — "AC par click
// karega, uske niche AC ke type aur price ki akarshak alag-alag [cards]
// honge, customer 'Split AC Repairing' par click kare aur form me detail
// aa jaay"): tapping an appliance card on the homepage no longer jumps
// straight into the tabbed Quick Book popup. It opens THIS panel right
// below the services grid instead — one flat, scannable list of cards,
// one per type+service combo actually priced in the customer's city
// (Window AC Service, Window AC Repair, Split AC Service, Split AC
// Repair, ...), each showing its price up front. Deliberately no photo
// per card (qb-price-card-nophoto) — the appliance's own photo is
// already shown right above, in the services grid; repeating it on every
// card here was flagged before as pointless duplication. Tapping a
// card's "Book" goes straight into qbAddService(..., true) — the exact
// same call the Quick Book modal's own service cards use for "Book" — so
// it lands on the same short Name/Address/Date&Time form (phone already
// verified via the Account Gate) as every other booking path, no
// separate modal or OTP logic duplicated here.
function closeApplianceBoxesPanel() {
  document.getElementById('applianceBoxesPanel')?.classList.remove('open');
}

async function openApplianceBoxesPanel(applianceId) {
  const panel = document.getElementById('applianceBoxesPanel');
  const body = document.getElementById('applianceBoxesPanelBody');
  if (!panel || !body) { openQuickBookModal(applianceId); return; } // very old cached page without this popup's markup — fall back to the other popup rather than do nothing
  const appliance = (ALL_APPLIANCES.length ? ALL_APPLIANCES : APPLIANCES).find(a => a.id === applianceId);
  if (!appliance) return;

  const cityId = document.getElementById('fCity').value;
  // CHANGED (explicit, repeated request): this opens as a real popup
  // now — directly, on click — instead of an inline panel appended
  // below the appliance grid that needed a scroll to reach.
  panel.classList.add('open');

  if (!cityId) {
    body.innerHTML = `
      <div class="appliance-boxes-panel-head"><h3>${escapeHtml(appliance.name)} — choose a service</h3><button type="button" class="appliance-boxes-panel-close modal-close" aria-label="Close">&times;</button></div>
      <p class="form-msg">Please choose your city first, then tap this appliance again.</p>
      <button type="button" class="btn btn-primary btn-sm" id="applianceBoxesChooseCity">Choose City</button>
    `;
    body.querySelector('.appliance-boxes-panel-close').addEventListener('click', closeApplianceBoxesPanel);
    document.getElementById('applianceBoxesChooseCity')?.addEventListener('click', () => { closeApplianceBoxesPanel(); (document.getElementById('navCityBtn') || document.getElementById('bottomNavCityBtn'))?.click(); });
    return;
  }

  body.innerHTML = `
    <div class="appliance-boxes-panel-head"><h3>${escapeHtml(appliance.name)} — choose a service</h3><button type="button" class="appliance-boxes-panel-close modal-close" aria-label="Close">&times;</button></div>
    <p class="form-msg">Loading prices…</p>
  `;
  body.querySelector('.appliance-boxes-panel-close').addEventListener('click', closeApplianceBoxesPanel);

  try {
    const rows = await Promise.all((appliance.types || []).map(async (t) => {
      try {
        const row = await fetchJSON(`/api/price?cityId=${cityId}&applianceId=${appliance.id}&typeId=${t.id}`);
        return { type: t, row };
      } catch (e) {
        return { type: t, row: null };
      }
    }));
    const cardsHtml = rows.flatMap(({ type, row }) => {
      if (!row) return [];
      const services = (type.services && type.services.length) ? type.services : [{ id: 'svc-service', name: 'Service' }, { id: 'svc-repair', name: 'Repair' }];
      return services.map(svc => {
        const price = (row.servicePrices && typeof row.servicePrices[svc.id] === 'number')
          ? row.servicePrices[svc.id]
          : (svc.id === 'svc-service' ? row.servicePrice : (svc.id === 'svc-repair' ? row.repairPrice : null));
        if (typeof price !== 'number') return '';
        const checklistHtml = (svc.checklist || []).map(item => `<li>${item}</li>`).join('');
        return `
        <div class="qb-service-card">
          <div class="qb-price-card qb-price-card-nophoto">
            <div>
              <div class="qb-price-title">${escapeHtml(type.name)} ${escapeHtml(svc.name)}</div>
              <div class="qb-price-row"><span class="qb-price-tag">🏷️</span><span class="qb-price-now">₹${price}</span></div>
              <div class="qb-price-trust">✔ Most Trusted Service</div>
            </div>
          </div>
          ${checklistHtml ? `<details class="qb-checklist-details"><summary>What's included</summary><ul class="qb-checklist">${checklistHtml}</ul></details>` : ''}
          <div class="qb-actions">
            <button type="button" class="qb-btn qb-btn-book" data-type-id="${type.id}" data-sku-id="${svc.id}" data-price="${price}">Book — ₹${price}</button>
          </div>
        </div>`;
      });
    }).join('');

    if (!cardsHtml) {
      body.innerHTML = `
        <div class="appliance-boxes-panel-head"><h3>${escapeHtml(appliance.name)}</h3><button type="button" class="appliance-boxes-panel-close modal-close" aria-label="Close">&times;</button></div>
        <p class="form-msg">This appliance is not available in your city right now.</p>
      `;
      body.querySelector('.appliance-boxes-panel-close').addEventListener('click', closeApplianceBoxesPanel);
      return;
    }

    body.innerHTML = `
      <div class="appliance-boxes-panel-head"><h3>${escapeHtml(appliance.name)} — choose a service</h3><button type="button" class="appliance-boxes-panel-close modal-close" aria-label="Close">&times;</button></div>
      <div class="appliance-boxes-grid">${cardsHtml}</div>
    `;
    body.querySelector('.appliance-boxes-panel-close').addEventListener('click', closeApplianceBoxesPanel);
    body.querySelectorAll('.qb-btn-book[data-sku-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = (appliance.types || []).find(t => t.id === btn.dataset.typeId);
        const services = (type && type.services && type.services.length) ? type.services : [{ id: 'svc-service', name: 'Service' }, { id: 'svc-repair', name: 'Repair' }];
        const svc = services.find(s => s.id === btn.dataset.skuId) || { id: btn.dataset.skuId, name: 'Service' };
        qbApplianceId = applianceId;
        qbSelectedTypeId = btn.dataset.typeId;
        closeApplianceBoxesPanel();
        qbAddService(svc, Number(btn.dataset.price), true);
      });
    });
  } catch (e) {
    body.innerHTML = `
      <div class="appliance-boxes-panel-head"><h3>${escapeHtml(appliance.name)}</h3><button type="button" class="appliance-boxes-panel-close modal-close" aria-label="Close">&times;</button></div>
      <p class="form-msg error">Could not load prices. Please try again.</p>
    `;
    body.querySelector('.appliance-boxes-panel-close').addEventListener('click', closeApplianceBoxesPanel);
  }
}
window.openApplianceBoxesPanel = openApplianceBoxesPanel;

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
    priceStrikeEl.textContent = '';
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
  document.getElementById('qbCitySelect').addEventListener('change', () => {
    const cityId = document.getElementById('qbCitySelect').value;
    if (!cityId) return;
    document.getElementById('fCity').value = cityId;
    if (typeof updateCityButtonLabels === 'function') updateCityButtonLabels(cityId);
    try { localStorage.setItem('seerua_last_city', cityId); } catch (e) { /* private browsing etc */ }
    refreshAppliancesForCity(cityId).then(() => {
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

  // Tapping outside the appliance-boxes popup (on the dark backdrop)
  // closes it, same as the main Quick Book modal above.
  document.getElementById('applianceBoxesPanel')?.addEventListener('click', (e) => {
    if (e.target.id === 'applianceBoxesPanel') closeApplianceBoxesPanel();
  });

  // Sets up the hidden main-form fields to match what was chosen here,
  // then calls the same, already-tested addItemToCart() — this is the
  // one place both "Add" and "Book" share, since both need the item
  // actually added to the cart first.
  async function qbDoAdd() {
    const msg = document.getElementById('qbMsg');
    // BUG FIX: this used to be unreachable without an account (the old
    // gate in openQuickBookModal() already forced sign-in before the
    // modal ever opened) — now that browsing type/price needs no
    // account at all, this is the actual point that needs one. Pauses
    // here, remembers exactly what was being tried (Add vs Book Now)
    // via qbPendingRetryAction, and resumes it automatically once
    // account-gate succeeds — see the 'quickbook' branch in
    // proceedAfterAccountGate().
    if (!getAccount()) {
      openAccountGate('quickbook', qbApplianceId);
      return false;
    }
    // BUG FIX: this used to read #qbPhone's own value — that field is
    // intentionally hidden once an account exists (see the comment on
    // its prefill in openQuickBookModalReal), so if it was ever empty at
    // this exact moment for any reason (e.g. a timing gap right after
    // the account-gate auto-retry re-opens this modal), the person saw
    // 'please enter a valid mobile number' with literally no visible
    // field to type one into. Reading straight from the account itself
    // removes that fragile dependency entirely.
    const phone = getAccount().phone;
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
    const cartLengthBefore = cartItems.length;
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
    // BUG FIX: the city-mismatch check inside addItemToCart() (a saved
    // account's city differing from what's currently being booked) opens
    // its OWN separate modal and does a bare `return` — setting neither
    // the 'error' nor 'notice' class checked above. That meant THIS
    // function still fell through to `return true`, and the caller
    // showed a "✅ Added to your cart!" success toast — while the
    // mismatch modal was still open in the background and NOTHING had
    // actually been added. Checking whether cartItems' length genuinely
    // grew is a definitive, mechanism-agnostic way to catch this (and
    // any other future path that blocks the add without setting one of
    // those two classes).
    if (cartItems.length <= cartLengthBefore) {
      return false;
    }
    return true;
  }

document.getElementById('qbAddBtn').addEventListener('click', async () => {
  quickBookViewStartIndex = null;
  qbPendingRetryAction = 'add';
  const ok = await qbDoAdd();
  if (ok) {
    qbPendingRetryAction = null;
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
    qbPendingRetryAction = 'book';
    const ok = await qbDoAdd();
    // SAFETY CHECK: even if qbDoAdd() reported success, confirm a new item
    // actually landed at the expected index before treating this as a
    // scoped "book just this one" checkout — protects against this ever
    // silently mis-scoping and pulling in unrelated cart items (or
    // submitting nothing) if some other edge case slips past qbDoAdd's
    // own check.
    if (ok && cartItems.length > expectedIndex) {
      qbPendingRetryAction = null;
      closeQuickBookModal();
      openBookingForm();
      hideRedundantBookingFields();
    } else if (ok) {
      quickBookViewStartIndex = null;
    }
    // else: account-gate just opened (qbDoAdd returned false because no
    // account existed yet) — leave qbPendingRetryAction set, so success
    // there resumes this exact action automatically.
  });
}

bindQuickBookModal();

init();
