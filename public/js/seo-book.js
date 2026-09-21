// ------------------------------------------------------------------
// EMBEDDED BOOKING WIDGET for SEO landing pages
// (/appliance-repair/:city/:appliance and /:city/:appliance/:type).
//
// WHY THIS EXISTS (per explicit request): a visitor who searched
// "fridge service in Jalesar" and landed on this page's own dedicated
// URL used to have to tap "Book Now" and get sent to the HOMEPAGE
// (/?city=...&appliance=...#quickbook) to actually book — an extra
// navigation away from the page they searched for, and (per an
// earlier, separate bug) the general /appliance-repair/:city URL used
// to blindly redirect to the FIRST appliance's page regardless of what
// was actually searched for. This widget puts a real, working booking
// form directly on THIS page instead, with the city/appliance (and
// type, on a type-specific page) already fixed — no navigation, no
// re-picking anything the URL already told us.
//
// DELIBERATELY NOT sharing code with main2.js (the homepage's booking
// script): main2.js's booking form, Quick Book modal, cart, and
// Account Gate are all wired together through one shared set of DOM
// ids (#fCity, #cartItems, #quickBookModal, etc.) and a handful of
// top-level `document.getElementById(...).addEventListener(...)`
// calls that run immediately when the script loads — safe on the
// homepage (which has every one of those elements), but any missing
// element on a different page throws immediately and would silently
// break EVERYTHING after it, on every single SEO page site-wide. This
// page also doesn't need a city selector, appliance selector, or a
// multi-item cart at all — the whole point of this page is that both
// are already fixed — so a small, dedicated, single-item widget with
// its own scoped ids (all prefixed sb*) is both safer and genuinely
// simpler than trying to shoehorn the shared homepage flow in here.
//
// Reuses the exact same backend APIs the homepage form uses
// (/api/slots, /api/otp-config, /api/phone-verified, /api/bookings)
// and the same MSG91 exposeMethods:true OTP approach already proven
// out on the homepage's Account Gate — so nothing about how a booking
// actually gets created or how OTP actually gets verified is new or
// untested, only the (much smaller) page-specific form around it.
(function () {
  const ctx = window.SB_CONTEXT;
  if (!ctx) return; // context script failed to load/parse — nothing to do safely

  const CITY_ID = ctx.cityId;
  const APPLIANCE_ID = ctx.applianceId;
  // Every type available on this page, each with its own resolved
  // Service/AMC + Repair price so switching the Type dropdown (general
  // appliance page) or Service/Repair dropdown updates the shown price
  // instantly with zero extra network round trips.
  const TYPES = Array.isArray(ctx.types) ? ctx.types : [];
  const FOCUS_TYPE_ID = ctx.focusTypeId || null;

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(async (r) => {
      let data = {};
      try { data = await r.json(); } catch (e) { /* empty/non-JSON body */ }
      if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      return data;
    });
  }

  function el(id) { return document.getElementById(id); }

  // Same "DD Mon YYYY" convention used everywhere else on the site
  // (see formatDateDisplay() in main2.js) — kept as its own tiny copy
  // here rather than depending on main2.js, which this page doesn't load.
  function formatDateDisplay(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr.length === 10 ? dateStr + 'T00:00:00' : dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // Set only when a pricing-table "Book" button for an extra SKU
  // (Installation, Gas Filling, Uninstallation, ...) was clicked — see
  // window.sbApplyPreset below. Overrides the Service/Repair dropdown's
  // price entirely (that dropdown is hidden while this is set), and its
  // skuId is sent with the booking so the server prices it exactly like
  // that row said, not as a plain Service/Repair item.
  let forcedSku = null;

  // ---------------- Type / price ----------------
  function currentType() {
    if (FOCUS_TYPE_ID) return TYPES.find(t => t.id === FOCUS_TYPE_ID) || TYPES[0];
    const sel = el('sbType');
    return TYPES.find(t => t.id === (sel && sel.value)) || TYPES[0];
  }

  // Same "was ₹X / now ₹Y" discount-badge look as the homepage's Quick
  // Book price card (see qbUpdatePrice() in main2.js) — the strike-
  // through price is purely a visual badge (20% above the real price,
  // rounded to the nearest 10), never what's actually charged.
  function updatePriceDisplay() {
    const priceEl = el('sbPriceDisplay');
    const strikeEl = el('sbPriceStrike');
    const titleEl = el('sbPriceTitle');
    if (!priceEl) return;
    if (forcedSku) {
      if (strikeEl) strikeEl.textContent = '';
      if (titleEl) titleEl.textContent = forcedSku.label || '';
      priceEl.textContent = (typeof forcedSku.price === 'number') ? `₹${forcedSku.price}` : '';
      return;
    }
    const t = currentType();
    if (!t) { priceEl.textContent = ''; if (strikeEl) strikeEl.textContent = ''; return; }
    if (titleEl) titleEl.textContent = `${ctx.applianceName || ''} ${t.name}`.trim();
    const serviceType = el('sbServiceType') ? el('sbServiceType').value : 'service';
    const price = serviceType === 'repair' ? t.repairPrice : t.servicePrice;
    if (typeof price === 'number') {
      const shownMrp = Math.round((price * 1.2) / 10) * 10;
      if (strikeEl) strikeEl.textContent = `₹${shownMrp}`;
      priceEl.textContent = `₹${price}`;
    } else {
      if (strikeEl) strikeEl.textContent = '';
      priceEl.textContent = '';
    }
  }

  function populateTypeSelect() {
    const wrap = el('sbTypeField');
    const sel = el('sbType');
    if (!wrap || !sel) return;
    if (FOCUS_TYPE_ID || TYPES.length <= 1) {
      // Type is already fixed by the page itself (a type-specific page,
      // or the appliance only has one type) — nothing to pick.
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    sel.innerHTML = TYPES.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    sel.addEventListener('change', () => { forcedSku = null; updateServiceTypeVisibility(); updatePriceDisplay(); });
  }

  // Same pill-toggle behavior as the homepage's Quick Book
  // (.qb-service-type-btn / .active in style.css) — clicking one marks
  // it active, updates the hidden #sbServiceType value, and refreshes
  // the shown price for that choice.
  function bindServiceTypeToggle() {
    const row = el('sbServiceTypeRow');
    const hidden = el('sbServiceType');
    if (!row || !hidden) return;
    row.querySelectorAll('.qb-service-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.qb-service-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        hidden.value = btn.dataset.serviceType;
        updatePriceDisplay();
      });
    });
  }

  function updateServiceTypeVisibility() {
    const row = el('sbServiceTypeRow');
    if (!row) return;
    row.style.display = forcedSku ? 'none' : '';
  }

  // Called from a pricing-table "Book" button's onclick (see
  // buildSbBookOnclick() in server.js) to pre-select this exact row —
  // a plain Service/Repair row (skuId omitted) or an extra-SKU row
  // (Installation, Gas Filling, ...) — right before opening the popup.
  window.sbApplyPreset = function (typeId, skuId, skuLabel, skuPrice) {
    if (!FOCUS_TYPE_ID) {
      const sel = el('sbType');
      if (sel && TYPES.some(t => t.id === typeId)) sel.value = typeId;
    }
    if (skuId) {
      forcedSku = { skuId, label: skuLabel, price: skuPrice };
    } else {
      forcedSku = null;
    }
    updateServiceTypeVisibility();
    updatePriceDisplay();
  };

  // ---------------- Popup open/close ----------------
  // FLOW CHANGE (per explicit request — "form main page me hi hai...
  // main chahta hu ki form alag se ho"): this widget used to be a
  // section sitting directly in the page's normal scroll flow, always
  // visible. Now that the homepage's own "Book Now" opens a single
  // small POPUP (see #hbModal/openCompactBookModal() in main2.js), this
  // page's form needs to behave the exact same way for the whole site
  // to feel consistent — a popup that opens on tap, closed by default.
  window.openSbModal = function () {
    const modal = el('sbModal');
    if (!modal) return;
    el('sbFormStep').style.display = '';
    el('sbOtpStep').style.display = 'none';
    el('sbSuccess').style.display = 'none';
    const msg = el('sbMsg');
    if (msg) { msg.className = 'form-msg'; msg.textContent = ''; }
    const submitBtn = el('sbSubmitBtn');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Book Now'; }
    modal.classList.add('open');
  };
  function closeSbModal() {
    const modal = el('sbModal');
    if (modal) modal.classList.remove('open');
  }

  // ---------------- Slots ----------------
  let selectedSlotId = null;
  let selectedSlotLabel = null;

  function renderSlots(slots) {
    const box = el('sbSlots');
    if (!box) return;
    selectedSlotId = null;
    selectedSlotLabel = null;
    if (!slots.length) {
      box.innerHTML = '<p class="form-msg">No slots configured.</p>';
      return;
    }
    box.innerHTML = slots.map(s => {
      const disabled = !s.available;
      return `<button type="button" class="btn btn-outline btn-sm sb-slot-btn" data-slot-id="${s.id}" data-slot-label="${s.label}" ${disabled ? 'disabled' : ''} style="margin:0 6px 6px 0;${disabled ? 'opacity:.45;cursor:not-allowed;' : ''}">${s.label}${disabled ? ' (Full)' : ''}</button>`;
    }).join('');
    box.querySelectorAll('.sb-slot-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        box.querySelectorAll('.sb-slot-btn').forEach(b => b.classList.remove('btn-primary'));
        btn.classList.add('btn-primary');
        selectedSlotId = btn.dataset.slotId;
        selectedSlotLabel = btn.dataset.slotLabel;
      });
    });
  }

  async function refreshSlots() {
    const date = el('sbDate').value;
    const box = el('sbSlots');
    if (!box) return;
    if (!date) { box.innerHTML = ''; return; }
    box.innerHTML = '<p class="form-msg">Loading slots...</p>';
    try {
      const slots = await fetchJSON(`/api/slots?date=${encodeURIComponent(date)}&cityId=${encodeURIComponent(CITY_ID)}&applianceIds=${encodeURIComponent(APPLIANCE_ID)}`);
      renderSlots(slots);
    } catch (e) {
      box.innerHTML = '<p class="form-msg error">Could not load slots. Please try again.</p>';
    }
  }

  // ---------------- OTP (same MSG91 exposeMethods:true approach as
  // the homepage's Account Gate — see main2.js's verifyPhoneWithOtp
  // for the fuller history of why this exact approach was landed on).
  let otpScriptLoaded = false;
  let OTP_CONFIG = null;

  function loadOtpScript(urls) {
    return new Promise((resolve, reject) => {
      if (otpScriptLoaded && typeof window.initSendOTP === 'function') return resolve();
      let i = 0;
      function attempt() {
        const s = document.createElement('script');
        s.src = urls[i];
        s.async = true;
        s.onload = () => {
          if (typeof window.initSendOTP === 'function') { otpScriptLoaded = true; resolve(); }
          else reject(new Error('OTP service did not load correctly.'));
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

  function waitForOtpMethods(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function') resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error('OTP service did not initialize in time. Please try again in a moment.'));
        else setTimeout(poll, 150);
      })();
    });
  }

  // Prewarm, same as the homepage does in openAccountGate() — by the
  // time the customer actually taps Submit, the script has very likely
  // already finished loading, so there's no first-tap script-load race
  // (the exact bug fixed on the homepage's Account Gate earlier).
  ensureOtpConfig()
    .then((cfg) => (cfg && cfg.enabled !== false)
      ? loadOtpScript(['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js'])
      : null)
    .catch(() => {});

  function showOtpStep(phone) {
    el('sbFormStep').style.display = 'none';
    el('sbOtpStep').style.display = '';
    el('sbOtpPhone').value = phone;
    el('sbOtpCode').value = '';
    el('sbOtpMsg').className = 'form-msg notice';
    el('sbOtpMsg').textContent = `OTP sent to ${phone}. Enter it below to confirm your booking.`;
  }
  function hideOtpStep() {
    el('sbOtpStep').style.display = 'none';
    el('sbFormStep').style.display = '';
  }

  // Resolves with the verified access token once the customer enters
  // the correct OTP, or rejects (form re-shown, error message set) if
  // they cancel/close instead.
  function verifyPhoneWithOtp(phone) {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      const cleanup = () => { hideOtpStep(); };
      const submitBtn = el('sbOtpSubmit');
      const resendBtn = el('sbOtpResend');
      const backBtn = el('sbOtpBack');
      const msgEl = el('sbOtpMsg');
      const codeEl = el('sbOtpCode');

      function onBack() {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('OTP verification cancelled.'));
      }
      function onSubmit() {
        if (settled) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying...';
        window.verifyOtp(codeEl.value.trim(), (data) => {
          settled = true;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Verify';
          cleanup();
          resolve(typeof data === 'string' ? data : (data && data.message) || 'verified');
        }, (err) => {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Verify';
          msgEl.className = 'form-msg error';
          msgEl.textContent = (err && (err.message || err)) || 'Incorrect OTP. Please try again.';
        });
      }
      function onResend() {
        if (settled) return;
        resendBtn.disabled = true;
        window.retryOtp('text', () => {
          resendBtn.disabled = false;
          msgEl.className = 'form-msg notice';
          msgEl.textContent = `OTP re-sent to ${phone}.`;
        }, () => {
          resendBtn.disabled = false;
          msgEl.className = 'form-msg error';
          msgEl.textContent = 'Could not resend OTP. Please try again.';
        });
      }

      submitBtn.onclick = onSubmit;
      resendBtn.onclick = onResend;
      backBtn.onclick = onBack;

      try {
        const cfg = await ensureOtpConfig();
        await loadOtpScript(['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js']);
        window.initSendOTP({
          widgetId: cfg.widgetId,
          tokenAuth: cfg.tokenAuth,
          exposeMethods: true,
          success: () => {},
          failure: () => {}
        });
        await waitForOtpMethods(8000);
        showOtpStep(phone);
        window.sendOtp(phone, () => {}, (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error((err && (err.message || err)) || 'Could not send OTP. Please try again.'));
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  // ---------------- Submit ----------------
  async function handleSubmit(e) {
    e.preventDefault();
    const msg = el('sbMsg');
    msg.className = 'form-msg';
    msg.textContent = '';

    const type = currentType();
    if (!type) {
      msg.className = 'form-msg error';
      msg.textContent = 'This service is not available here right now.';
      return;
    }
    const name = el('sbName').value.trim();
    const phone = el('sbPhone').value.trim();
    const address = el('sbAddress').value.trim();
    const serviceType = el('sbServiceType') ? el('sbServiceType').value : 'service';
    const date = el('sbDate').value;

    if (!name) { msg.className = 'form-msg error'; msg.textContent = 'Please enter your name.'; return; }
    if (!/^[0-9]{10}$/.test(phone)) { msg.className = 'form-msg error'; msg.textContent = 'Please enter a valid 10 digit mobile number.'; return; }
    if (!address) { msg.className = 'form-msg error'; msg.textContent = 'Please enter your full address.'; return; }
    if (!date) { msg.className = 'form-msg error'; msg.textContent = 'Please select a preferred date.'; return; }
    if (!selectedSlotId) { msg.className = 'form-msg error'; msg.textContent = 'Please select an available time slot.'; return; }

    const submitBtn = el('sbSubmitBtn');
    submitBtn.disabled = true;

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

    let accessToken;
    if (otpEnabled && !phoneAlreadyVerified) {
      submitBtn.textContent = 'Sending OTP...';
      msg.textContent = 'Please complete the OTP verification that just opened to confirm your booking.';
      try {
        accessToken = await verifyPhoneWithOtp(phone);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Book Now';
        msg.className = 'form-msg error';
        msg.textContent = err.message || 'OTP verification failed. Please try again.';
        return;
      }
    }

    submitBtn.textContent = 'Booking...';
    const payload = {
      name,
      phone,
      address,
      cityId: CITY_ID,
      items: [{ applianceId: APPLIANCE_ID, typeId: type.id, serviceType, qty: 1, problem: '', photoUrl: '', skuId: forcedSku ? forcedSku.skuId : null }],
      bookingDate: date,
      timeSlotId: selectedSlotId
    };
    if (accessToken) payload.accessToken = accessToken;

    try {
      const data = await fetchJSON('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      el('sbFormStep').style.display = 'none';
      el('sbOtpStep').style.display = 'none';
      el('sbSuccess').style.display = '';
      const serviceLabel = forcedSku
        ? `${ctx.applianceName || ''} (${type.name}, ${forcedSku.label})`
        : `${ctx.applianceName || ''} (${type.name}, ${serviceType === 'repair' ? 'Repair' : 'Service'})`;
      el('sbSuccessId').textContent = data.booking.id;
      el('sbSuccessService').textContent = serviceLabel.trim();
      el('sbSuccessVisit').textContent = `${selectedSlotLabel}, ${formatDateDisplay(date)}`;
      el('sbSuccessCharge').textContent = `₹${data.booking.totalPrice}`;
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Book Now';
      msg.className = 'form-msg error';
      msg.textContent = err.message || 'Could not complete booking. Please try again or call us.';
    }
  }

  function init() {
    const form = el('sbForm');
    if (!form) return; // widget markup not present on this page for some reason — do nothing
    populateTypeSelect();
    bindServiceTypeToggle();
    updatePriceDisplay();
    const dateEl = el('sbDate');
    if (dateEl) {
      const today = new Date();
      const y = today.getFullYear(), m = String(today.getMonth() + 1).padStart(2, '0'), d = String(today.getDate()).padStart(2, '0');
      dateEl.min = `${y}-${m}-${d}`;
      dateEl.addEventListener('change', refreshSlots);
    }
    form.addEventListener('submit', handleSubmit);

    // Popup open/close wiring — see window.openSbModal() above. The
    // plain "Book Now" links (header/hero/CTA banner) call
    // window.openSbModal() directly; the pricing table's per-row "Book"
    // buttons call window.sbApplyPreset() then window.openSbModal().
    const closeBtn = el('sbModalClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSbModal);
    const modal = el('sbModal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target.id === 'sbModal') closeSbModal(); });
    const doneBtn = el('sbSuccessDone');
    if (doneBtn) doneBtn.addEventListener('click', closeSbModal);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
