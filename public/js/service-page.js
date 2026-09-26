/* ==========================================================================
   Seerua one-screen booking popup — shared by the appliance+city service
   pages AND the homepage.

   Service page ("page" mode, city fixed by the URL):
     Tap "Book" on a card -> popup with that service already in it ->
     name / mobile / address (auto-filled for returning customers), date +
     first free slot pre-selected -> "Confirm Booking" -> done.
     "Add" collects several services first (cart bar at the bottom).

   Homepage ("home" mode):
     Tap any appliance photo / "Book Now" -> the same popup opens with that
     appliance, its first type and first service ALREADY selected (city =
     last used / saved city). The customer only changes what they want.

   OTP only on a number's first-ever booking (server decides), inside the
   same popup. After booking: big animated tick + a short chime + vibrate.
   Also: horizontal photo strips gently auto-scroll right-to-left.
   ========================================================================== */
(function () {
  'use strict';

  var CFG = {};
  try { var cfgEl = document.getElementById('spConfig'); if (cfgEl) CFG = JSON.parse(cfgEl.textContent || '{}'); } catch (e) { CFG = {}; }
  var MODE = CFG.cityId ? 'page' : 'home';
  var CART_KEY = 'seerua_sp_cart_v1';
  var ACCOUNT_KEY = 'seerua_account_v1';
  var REF_KEY = 'seerua_sp_ref';
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------ utils
  function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || 'Something went wrong. Please try again.'); err.status = res.status; throw err; }
        return data;
      });
    });
  }
  function postJSON(url, body) {
    return fetchJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function setMsg(el, text, kind) { if (!el) return; el.className = 'form-msg' + (kind ? ' ' + kind : ''); el.textContent = text || ''; }
  // India has no daylight saving, so IST = UTC + 5:30 always. (The old
  // Intl 'en-CA' trick broke on some older Android WebViews.)
  function istDate(offsetDays) {
    return new Date(Date.now() + offsetDays * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  }
  // "+91 98765 43210", "09876543210", "98765-43210" -> "9876543210"
  function normalizePhone(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length > 10) d = d.replace(/^(91|0)/, '');
    return d.slice(0, 10);
  }
  function isoToUtcNoon(iso) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 6)); }
  function dateLabel(iso, i) {
    if (i === 0) return 'Today';
    if (i === 1) return 'Tomorrow';
    return isoToUtcNoon(iso).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
  }
  function dateSub(iso) { return isoToUtcNoon(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  function bookingServiceType(skuId) { return ['svc-repair', 'svc-install', 'svc-uninstall', 'svc-gasfill'].indexOf(skuId) > -1 ? 'repair' : 'service'; }
  function typeDisplayName(typeName, applianceName) {
    return typeName.toLowerCase().indexOf(applianceName.toLowerCase()) > -1 ? typeName : typeName + ' ' + applianceName;
  }
  function servicesOf(type) {
    return (Array.isArray(type.services) && type.services.length) ? type.services
      : [{ id: 'svc-service', name: 'Service', checklist: [] }, { id: 'svc-repair', name: 'Repair', checklist: [] }];
  }
  function priceForSku(row, svcId) {
    if (!row) return null;
    if (row.servicePrices && typeof row.servicePrices[svcId] === 'number') return row.servicePrices[svcId];
    if (svcId === 'svc-service' && typeof row.servicePrice === 'number') return row.servicePrice;
    if (svcId === 'svc-repair' && typeof row.repairPrice === 'number') return row.repairPrice;
    return null;
  }
  function mrpForSku(row, svcId, price) {
    var m = row && row.mrpPrices ? Number(row.mrpPrices[svcId]) : 0;
    return (m > 0 && typeof price === 'number' && m > price) ? m : null;
  }
  function getAccount() { try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null'); } catch (e) { return null; } }
  function saveAccount(acc) { try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acc)); } catch (e) { /* ignore */ } updateHeaderInitial(); }
  // Logged-in customer (saved account) -> header profile icon shows the
  // first letter of their name instead of the generic person icon.
  function updateHeaderInitial() {
    var btn = $('headerAccountBtn'), icon = $('headerAccountIcon'), ini = $('headerAccountInitial');
    if (!btn) return;
    var acc = getAccount();
    var letter = acc && acc.name ? String(acc.name).trim().charAt(0).toUpperCase() : '';
    btn.classList.toggle('has-account', !!letter);
    if (icon) icon.style.display = letter ? 'none' : '';
    if (ini) { ini.style.display = letter ? 'block' : 'none'; ini.textContent = letter; }
  }

  // ------------------------------------------------------------------ popup markup (injected once)
  function ensureMarkup() {
    if ($('spSheet')) return;
    var html =
      '<div class="sp-sheet-backdrop" id="spSheet" aria-hidden="true">' +
      ' <div class="sp-sheet" role="dialog" aria-modal="true" aria-labelledby="spSheetTitle">' +
      '  <div class="sp-sheet-head"><h2 id="spSheetTitle">Book Service</h2>' +
      '   <button type="button" class="sp-sheet-close" id="spSheetClose" aria-label="Close">&times;</button></div>' +
      '  <div class="sp-sheet-body" id="spStepForm">' +
      '   <div id="spPausedMsg" class="form-msg error" hidden></div>' +
      '   <div id="spPicker" hidden>' +
      '    <div class="sp-pick-head"><img id="spPickImg" alt="" hidden><div class="sp-pick-sum"><strong id="spPickName"></strong><span id="spPickSummary"></span></div>' +
      '     <button type="button" class="sp-link-btn" id="spPickChange">Change</button></div>' +
      '   </div>' +
      '   <div class="sp-items" id="spItems"></div>' +
      '   <button type="button" class="sp-add-more" id="spAddMore">+ Add another service</button>' +
      '   <div class="sp-field-group">' +
      '    <div class="sp-saved" id="spSaved" hidden><div><strong id="spSavedName"></strong> · <span id="spSavedPhone"></span><div class="sp-saved-addr" id="spSavedAddr"></div></div>' +
      '     <button type="button" class="sp-link-btn" id="spEditDetails">Change</button></div>' +
      '    <div id="spDetailFields">' +
      '     <label class="sp-label" for="spName">Your name</label><input class="sp-input" id="spName" type="text" autocomplete="name" placeholder="Full name" maxlength="80">' +
      '     <label class="sp-label" for="spPhone">Mobile number</label><div class="sp-phone-wrap"><span>+91</span><input class="sp-input" id="spPhone" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="10 digit mobile number" maxlength="16"></div>' +
      '     <label class="sp-label" for="spAddress" id="spAddressLabel">Full address</label><textarea class="sp-input" id="spAddress" rows="2" autocomplete="street-address" placeholder="House no., street, area, landmark" maxlength="300"></textarea>' +
      '    </div>' +
      '    <div class="sp-loc"><button type="button" class="sp-loc-btn" id="spLocBtn">📍 Use my current location</button><button type="button" class="sp-loc-btn" id="spMapBtn">🗺️ Pick on map</button><span class="sp-loc-msg" id="spLocMsg">Optional — helps the technician find your home exactly.</span></div>' +
      '   </div>' +
      '   <div class="sp-label">Visit date</div><div class="sp-chips" id="spDates"></div>' +
      '   <div class="sp-label">Time slot</div><div class="sp-chips" id="spSlots"><span class="sp-muted">Loading slots…</span></div>' +
      '   <details class="sp-coupon"><summary>Have a coupon code?</summary><div class="sp-coupon-row">' +
      '    <input class="sp-input" id="spCoupon" type="text" placeholder="Enter code" maxlength="30" autocapitalize="characters">' +
      '    <button type="button" class="sp-link-btn" id="spCouponApply">Apply</button></div><div class="form-msg" id="spCouponMsg"></div></details>' +
      '   <div class="sp-total-row"><span>Total to pay after service</span><strong id="spTotal">₹0</strong></div>' +
      '   <div class="form-msg" id="spFormMsg" role="alert"></div>' +
      '   <button type="button" class="sp-confirm" id="spConfirm">Confirm Booking</button>' +
      '   <p class="sp-fine">Pay after the work is done. Spare parts, if needed, only with your approval.</p>' +
      '  </div>' +
      '  <div class="sp-sheet-body sp-cards-step" id="spStepType" hidden>' +
      '   <div class="sp-city-row"><label for="spPickCity">📍 City</label><select class="sp-input sp-select" id="spPickCity"></select></div>' +
      '   <div class="sp-tabs" id="spCardTabs"></div>' +
      '   <div class="sp-panel" id="spCardList"></div>' +
      '   <div class="sp-cardbar" id="spCardBar" hidden><span id="spCardBarText"></span><button type="button" class="sp-cartbar-btn" id="spCardBarBtn">Book Now →</button></div>' +
      '  </div>' +
      '  <div class="sp-sheet-body" id="spStepOtp" hidden>' +
      '   <p>We sent a code to <strong>+91 <span id="spOtpPhone"></span></strong>. <span id="spOtpWhy">Enter it to confirm your booking (only needed on your first booking).</span></p>' +
      '   <input class="sp-input sp-otp-input" id="spOtpCode" type="tel" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Enter OTP">' +
      '   <div class="form-msg" id="spOtpMsg" role="alert"></div>' +
      '   <button type="button" class="sp-confirm" id="spOtpVerify">Verify &amp; Book</button>' +
      '   <div class="sp-otp-actions"><button type="button" class="sp-link-btn" id="spOtpBack">← Change details</button><button type="button" class="sp-link-btn" id="spOtpResend">Resend code</button></div>' +
      '  </div>' +
      '  <div class="sp-sheet-body sp-success" id="spStepDone" hidden>' +
      '   <div class="sp-tick-wrap"><svg class="sp-tick" viewBox="0 0 120 120" aria-hidden="true"><circle class="sp-tick-circle" cx="60" cy="60" r="58"/><path class="sp-tick-mark" d="M33 61 L52 80 L88 42"/></svg></div>' +
      '   <h3 class="sp-thanks">Thank you!</h3>' +
      '   <p class="sp-thanks-sub">Your booking is confirmed. Our technician will call you before the visit.</p>' +
      '   <p class="sp-thanks-meta">Booking ID: <strong id="spDoneId"></strong><br><span id="spDoneWhen"></span></p>' +
      '   <button type="button" class="sp-confirm sp-confirm-done" id="spDoneClose">Done</button>' +
      '   <button type="button" class="sp-link-btn sp-cancel-link" id="spDoneCancel">Plans changed? Cancel this booking</button>' +
      '  </div>' +
      '  <div class="sp-sheet-body" id="spStepCancel" hidden>' +
      '   <div class="sp-cancel-sum" id="spCancelSum"></div>' +
      '   <div id="spCancelForm">' +
      '    <label class="sp-label" for="spCancelReason">Why are you cancelling?</label>' +
      '    <select class="sp-input sp-select" id="spCancelReason"><option>Plan changed</option><option>Price too high</option><option>Problem fixed itself</option><option>Got it done elsewhere</option><option>Booked by mistake</option><option>Other</option></select>' +
      '    <label class="sp-label" for="spCancelNote">Anything else? (optional)</label>' +
      '    <input class="sp-input" id="spCancelNote" type="text" maxlength="200" placeholder="Optional">' +
      '    <div class="form-msg" id="spCancelMsg" role="alert"></div>' +
      '    <button type="button" class="sp-confirm sp-confirm-danger" id="spCancelConfirm">Cancel Booking</button>' +
      '    <button type="button" class="sp-link-btn sp-cancel-keep" id="spCancelKeep">No, keep my booking</button>' +
      '   </div>' +
      '   <div id="spCancelDone" hidden><h3 class="sp-thanks">Booking cancelled</h3><p class="sp-thanks-sub">Your booking has been cancelled. You can book again any time.</p>' +
      '    <button type="button" class="sp-confirm sp-confirm-done" id="spCancelDoneClose">Done</button></div>' +
      '  </div>' +
      ' </div>' +
      '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
    if (!$('spToast')) document.body.insertAdjacentHTML('beforeend', '<div class="sp-toast" id="spToast" role="status" aria-live="polite"></div>');
  }

  var toastTimer = null;
  function toast(text) {
    var t = $('spToast'); if (!t) return;
    t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  // ------------------------------------------------------------------ state
  var city = { id: CFG.cityId || null, name: CFG.cityName || '' };
  function readCart() {
    if (MODE !== 'page') {
      // Homepage: same cart as the service pages (one cart site-wide).
      try {
        var hc = JSON.parse(sessionStorage.getItem(CART_KEY) || 'null');
        if (hc && hc.cityId && Array.isArray(hc.items)) return hc;
      } catch (e) { /* ignore */ }
      return { cityId: null, items: [] };
    }
    try {
      var c = JSON.parse(sessionStorage.getItem(CART_KEY) || 'null');
      if (c && c.cityId === city.id && Array.isArray(c.items)) return c;
    } catch (e) { /* ignore */ }
    return { cityId: city.id, items: [] };
  }
  // "Book" opens the form with ONLY that one service; the real cart is
  // parked in `stashedCart` meanwhile and comes back untouched when the
  // form closes. "Add" only ever touches the real cart.
  var stashedCart = null;
  function realCart() { return stashedCart || cart; }
  function writeCart() { try { sessionStorage.setItem(CART_KEY, JSON.stringify(realCart())); } catch (e) { /* ignore */ } }
  function startDirect(item) { if (!stashedCart) stashedCart = cart; cart = { cityId: stashedCart.cityId || city.id, items: [item] }; }
  function endDirect() { if (stashedCart) { cart = stashedCart; stashedCart = null; syncCityToCart(); } }
  // A cart always belongs to ONE city (prices differ per city). When the
  // real cart comes back after a one-off "Book", the popup follows it.
  function syncCityToCart() {
    if (!cart.items.length || !cart.cityId || cart.cityId === city.id) return;
    var c = (pick.cities || []).find(function (x) { return x.id === cart.cityId; });
    if (!c) return;
    setCity(c.id, c.name);
    if (pick.appliance && $('spPickCity')) renderPickCities();
  }
  function addToRealCart(item) {
    var c = realCart();
    if (c.items.some(function (i) { return i.key === item.key; }) && c.cityId === city.id) return false;
    if (c.cityId && c.cityId !== city.id) {
      if (c.items.length && !window.confirm('Your cart has services for another city. Start a new cart for ' + (city.name || 'this city') + '?')) return false;
      c.items = [];
    }
    c.cityId = city.id; c.items.push(item); writeCart(); refreshCartUi(); return true;
  }
  function removeFromRealCart(key) { var c = realCart(); c.items = c.items.filter(function (i) { return i.key !== key; }); writeCart(); refreshCartUi(); }
  function inRealCart(key) { var c = realCart(); return c.cityId === city.id && c.items.some(function (i) { return i.key === key; }); }
  var cart = readCart();
  try {
    var urlRef = new URLSearchParams(location.search).get('ref');
    if (urlRef) sessionStorage.setItem(REF_KEY, urlRef.trim().toUpperCase());
  } catch (e) { /* ignore */ }

  function inCart(key) { return cart.items.some(function (i) { return i.key === key; }); }
  function cartTotal() { return cart.items.reduce(function (s, i) { return s + i.price; }, 0); }
  function addItem(item) { if (inCart(item.key)) return false; cart.items.push(item); if (!stashedCart) writeCart(); refreshCartUi(); return true; }
  function removeItem(key) { cart.items = cart.items.filter(function (i) { return i.key !== key; }); if (!stashedCart) writeCart(); refreshCartUi(); }

  function refreshCartUi() {
    var n = realCart().items.length;
    if (MODE !== 'page') {
      var hbb = $('bottomNavCartBadge'); if (hbb) { hbb.textContent = String(n); hbb.hidden = n === 0; }
      var hdb = $('headerCartBadge'); if (hdb) { hdb.textContent = String(n); hdb.hidden = n === 0; }
      return;
    }
    var hb = $('spHeaderCartBadge'); if (hb) { hb.textContent = String(n); hb.hidden = n === 0; }
    var bb = $('bottomNavCartBadge'); if (bb) { bb.textContent = String(n); bb.hidden = n === 0; }
    var bar = $('spCartBar');
    if (bar) {
      bar.hidden = n === 0 || ($('spSheet') && $('spSheet').classList.contains('open'));
      $('spCartBarCount').textContent = n + (n === 1 ? ' service' : ' services') + ' in cart';
      $('spCartBarTotal').textContent = 'Total ' + inr(realCart().items.reduce(function (t, i) { return t + i.price; }, 0));
    }
    document.querySelectorAll('.sp-card').forEach(function (card) {
      var btn = card.querySelector('.sp-btn-add'); if (!btn) return;
      var added = inRealCart(itemFromCard(card).key);
      btn.classList.toggle('added', added);
      var label = btn.querySelector('span'); if (label) label.textContent = added ? 'Added ✓' : 'Add';
    });
  }

  // ------------------------------------------------------------------ page mode: tabs + cards
  function itemFromCard(card) {
    var d = card.dataset;
    return {
      key: d.applianceId + '|' + d.typeId + '|' + d.skuId,
      applianceId: d.applianceId, applianceName: d.applianceName,
      typeId: d.typeId, typeName: d.typeName, skuId: d.skuId, skuName: d.skuName,
      serviceType: d.serviceType, price: Number(d.price), title: d.title
    };
  }
  if (MODE === 'page') {
    document.querySelectorAll('.sp-tab').forEach(function (tab) {
      tab.addEventListener('click', function (e) {
        var panel = document.querySelector('.sp-panel[data-panel="' + tab.getAttribute('data-tab') + '"]');
        if (!panel) return;
        e.preventDefault();
        document.querySelectorAll('.sp-tab').forEach(function (t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
        document.querySelectorAll('.sp-panel').forEach(function (p) { p.hidden = p !== panel; });
      });
    });
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.sp-card .sp-btn');
      if (!btn) return;
      var item = itemFromCard(btn.closest('.sp-card'));
      // Add -> into the cart (header cart icon + badge, bar at the bottom).
      // Book -> straight to the booking form.
      if (btn.getAttribute('data-action') === 'add') {
        if (inRealCart(item.key)) { removeFromRealCart(item.key); toast('Removed from cart'); }
        else { addToRealCart(item); toast('🛒 ' + item.title + ' added to cart'); }
      } else {
        startDirect(item);
        openSheet();
      }
    });
  }

  // ------------------------------------------------------------------ home mode: appliance picker
  var dataCache = {};
  function cached(key, fn) { if (!dataCache[key]) dataCache[key] = fn().catch(function (e) { delete dataCache[key]; throw e; }); return dataCache[key]; }
  function loadCities() { return cached('cities', function () { return fetchJSON('/api/cities'); }); }
  function loadAppliances() { return cached('appliances', function () { return fetchJSON('/api/appliances'); }); }
  function loadPrice(cityId, applianceId, typeId) {
    return cached('p|' + cityId + '|' + applianceId + '|' + typeId, function () {
      return fetchJSON('/api/price?cityId=' + encodeURIComponent(cityId) + '&applianceId=' + encodeURIComponent(applianceId) + '&typeId=' + encodeURIComponent(typeId));
    });
  }
  var pick = { appliance: null, typeId: null, cities: [] };

  function guessCityId(cities) {
    var ids = cities.map(function (c) { return c.id; });
    var cands = [];
    var f = $('fCity'); if (f && f.value) cands.push(f.value);
    try { cands.push(localStorage.getItem('seerua_last_city')); } catch (e) { /* ignore */ }
    var acc = getAccount(); if (acc && acc.cityId) cands.push(acc.cityId);
    for (var i = 0; i < cands.length; i++) if (cands[i] && ids.indexOf(cands[i]) > -1) return cands[i];
    return ids[0] || null;
  }

  // Homepage flow (same look as the service pages): tap appliance ->
  // popup with its type tabs and one card per service (photo, price,
  // checklist, Add / Book — no Review). "Book" opens the booking form with
  // ONLY the chosen service(s) and their price.
  var photoMapPromise = null;
  function loadPhotoMap() {
    if (!photoMapPromise) photoMapPromise = fetchJSON('/api/service-photos').catch(function () { return {}; });
    return photoMapPromise;
  }

  var pendingDetails = null; // name/phone/address handed over by the chat assistant
  function openForAppliance(applianceId, typeId, opts) {
    ensureMarkup(); bindOnce();
    opts = opts || {};
    if (opts.name || opts.phone || opts.address) pendingDetails = { name: opts.name || '', phone: normalizePhone(opts.phone), address: opts.address || '' };
    Promise.all([loadCities(), loadAppliances(), loadPhotoMap()]).then(function (r) {
      pick.cities = r[0];
      pick.photos = r[2] || {};
      var appl = r[1].find(function (a) { return a.id === applianceId; });
      if (!appl || !appl.types.length) { toast('This service is not available right now.'); return; }
      // Not started in any city yet -> say so plainly instead of an empty popup.
      var openCities = pick.cities.filter(function (c) { return (appl.disabledCities || []).indexOf(c.id) === -1; });
      if (!openCities.length) { toast(appl.name + ' service is coming soon — booking is not open yet.'); return; }
      pick.appliance = appl;
      var cid = (opts.cityId && pick.cities.some(function (x) { return x.id === opts.cityId; })) ? opts.cityId
        : (cart.items.length && cart.cityId && pick.cities.some(function (x) { return x.id === cart.cityId; })) ? cart.cityId : guessCityId(pick.cities);
      var c = pick.cities.find(function (x) { return x.id === cid; }) || {};
      setCity(c.id || null, c.name || '');
      if (cart.cityId !== city.id && !cart.items.length) { cart = { cityId: city.id, items: [] }; writeCart(); refreshCartUi(); }
      $('spPickName').textContent = appl.name;
      var img = $('spPickImg');
      if (appl.photoUrl) { img.src = appl.photoUrl; img.alt = appl.name; img.hidden = false; } else img.hidden = true;
      pick.typeId = (typeId && appl.types.some(function (t) { return t.id === typeId; })) ? typeId : appl.types[0].id;
      renderPickCities();
      showTypeStep();
    }).catch(function (e) { toast(e.message || 'Could not load. Please try again.'); });
  }

  function showTypeStep() {
    var appl = pick.appliance;
    var tabs = $('spCardTabs');
    tabs.hidden = appl.types.length < 2;
    tabs.innerHTML = appl.types.map(function (t) {
      return '<button type="button" class="sp-tab' + (t.id === pick.typeId ? ' active' : '') + '" data-type="' + escapeHtml(t.id) + '">' + escapeHtml(t.name) + '</button>';
    }).join('');
    tabs.querySelectorAll('.sp-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        pick.typeId = b.getAttribute('data-type');
        tabs.querySelectorAll('.sp-tab').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderCards();
      });
    });
    openSheet('spStepType');
    renderCards();
  }

  function cardItem(appl, type, svc, price) {
    return {
      key: appl.id + '|' + type.id + '|' + svc.id, applianceId: appl.id, applianceName: appl.name,
      typeId: type.id, typeName: type.name, skuId: svc.id, skuName: svc.name,
      serviceType: bookingServiceType(svc.id), price: price,
      title: typeDisplayName(type.name, appl.name) + ' ' + svc.name
    };
  }

  var CHECK = '<svg class="sp-check" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/><path d="M5.5 10.3l3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var TAG = '<svg class="sp-tag" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12V4a1 1 0 011-1h8l9 9-9 9-9-9z"/><circle cx="7.5" cy="7.5" r="1.6" fill="#fff"/></svg>';
  var CART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a2 2 0 100 4 2 2 0 000-4zm10 0a2 2 0 100 4 2 2 0 000-4zM5.2 4l.4 2H21l-2 8H7.4l-.3 1.5H19v2H4.7L6.2 11 4.4 4H2V2h3.9z"/></svg>';

  function renderCards() {
    var appl = pick.appliance;
    var type = appl.types.find(function (t) { return t.id === pick.typeId; });
    var list = $('spCardList');
    if (!type || !city.id) { list.innerHTML = '<p class="sp-muted">Please choose your city.</p>'; updateCardBar(); return; }
    list.innerHTML = '<p class="sp-muted">Loading…</p>';
    var reqCity = city.id, reqType = type.id;
    loadPrice(city.id, appl.id, type.id).then(function (row) {
      if (reqCity !== city.id || reqType !== pick.typeId) return;
      var svcs = servicesOf(type).map(function (sv) { return { svc: sv, price: priceForSku(row, sv.id) }; })
        .filter(function (x) { return typeof x.price === 'number'; });
      if (!svcs.length) { list.innerHTML = '<p class="sp-muted">Not available in ' + escapeHtml(city.name) + ' yet.</p>'; updateCardBar(); return; }
      list.innerHTML = svcs.map(function (x, idx) {
        var it = cardItem(appl, type, x.svc, x.price);
        var photo = (pick.photos[appl.id + '_' + type.id + '_' + x.svc.id] || {}).url || appl.photoUrl;
        var checks = (x.svc.checklist && x.svc.checklist.length ? x.svc.checklist : ['Trained, verified technician', 'Price confirmed before work starts', 'Genuine spare parts', 'Performance checked after work', '30-day service warranty'])
          .slice(0, 5).map(function (c) { return '<li>' + CHECK + '<span>' + escapeHtml(c) + '</span></li>'; }).join('');
        var added = inRealCart(it.key);
        return '<article class="sp-card" data-idx="' + idx + '">' +
          '<div class="sp-card-img">' + (photo ? '<img src="' + escapeHtml(photo) + '" alt="' + escapeHtml(it.title) + '" loading="lazy">' : '<span class="sp-strip-fallback">🔧</span>') +
          '<span class="sp-badge">' + inr(x.price) + '/-</span></div>' +
          '<div class="sp-card-body"><h3 class="sp-card-title">' + escapeHtml(it.title) + ' In ' + escapeHtml(city.name) + '</h3>' +
          '<div class="sp-price">' + TAG + (function () { var m = mrpForSku(row, x.svc.id, x.price); return m ? '<s class="sp-mrp">' + inr(m) + '</s>' : ''; })() + '<strong>' + inr(x.price) + '</strong>' +
          (function () { var m = mrpForSku(row, x.svc.id, x.price); return m ? '<span class="sp-off">' + inr(m - x.price) + ' off</span>' : ''; })() +
          ((x.svc.id === 'svc-repair' || x.svc.id === 'svc-gasfill' || /repair|gas/i.test(x.svc.name || '')) ? '<span class="sp-parts">+ parts, if needed (with your OK)</span>' : '') + '</div>' +
          '<ul class="sp-checks">' + checks + '</ul></div>' +
          '<div class="sp-actions"><button type="button" class="sp-btn sp-btn-add' + (added ? ' added' : '') + '" data-act="add">' + CART_SVG + '<span>' + (added ? 'Added ✓' : 'Add') + '</span></button>' +
          '<button type="button" class="sp-btn sp-btn-book" data-act="book">Book</button></div></article>';
      }).join('');
      list.querySelectorAll('.sp-card').forEach(function (card) {
        var x = svcs[+card.getAttribute('data-idx')];
        var it = cardItem(appl, type, x.svc, x.price);
        card.querySelector('[data-act="add"]').addEventListener('click', function () {
          if (inRealCart(it.key)) removeFromRealCart(it.key); else { addToRealCart(it); toast('🛒 ' + it.title + ' added to cart'); }
          renderCards();
        });
        card.querySelector('[data-act="book"]').addEventListener('click', function () {
          startDirect(it);
          goToForm();
        });
      });
      updateCardBar();
    }).catch(function () {
      if (reqCity !== city.id) return;
      list.innerHTML = '<p class="sp-muted">' + escapeHtml(appl.name) + ' is not available in ' + escapeHtml(city.name) + ' yet.</p>';
      updateCardBar();
    });
  }

  function updateCardBar() {
    var bar = $('spCardBar'); if (!bar) return;
    var rc = realCart();
    var n = rc.items.length;
    bar.hidden = n === 0;
    var other = rc.cityId && rc.cityId !== city.id ? (pick.cities || []).find(function (x) { return x.id === rc.cityId; }) : null;
    $('spCardBarText').innerHTML = '🛒 <strong>' + n + (n === 1 ? ' service' : ' services') + ' in cart</strong>' + (other ? ' (' + escapeHtml(other.name) + ')' : '') + ' · ' + inr(rc.items.reduce(function (t, i) { return t + i.price; }, 0));
  }

  function goToForm() {
    syncCityToCart();
    $('spPickChange').hidden = true;
    $('spAddMore').hidden = !!stashedCart;
    showStep('spStepForm');
    appliedCoupon = null; setMsg($('spCouponMsg'), '');
    prefillDetails();
    updatePickSummary();
    renderItems();
    renderDates(); // also loads the slots (and jumps to tomorrow if today is full)
    var body = $('spStepForm'); if (body) body.scrollTop = 0;
  }

  function setCity(id, name) {
    city = { id: id, name: name };
    try { if (id) localStorage.setItem('seerua_last_city', id); } catch (e) { /* ignore */ }
    var lbl = $('spAddressLabel'); if (lbl) lbl.textContent = name ? 'Full address in ' + name : 'Full address';
  }

  function renderPickCities() {
    var sel = $('spPickCity');
    sel.innerHTML = pick.cities.map(function (c) {
      var off = (pick.appliance.disabledCities || []).indexOf(c.id) > -1;
      return '<option value="' + escapeHtml(c.id) + '"' + (c.id === city.id ? ' selected' : '') + (off ? ' disabled' : '') + '>' +
        escapeHtml(c.name) + (off ? ' (not available)' : '') + '</option>';
    }).join('');
    sel.onchange = function () {
      var c = pick.cities.find(function (x) { return x.id === sel.value; });
      if (!c || c.id === city.id) return;
      setCity(c.id, c.name);
      // One-off "Book" item is dropped (its price was for the old city);
      // the real cart is kept — adding here offers to start a new one.
      if (stashedCart) { cart = stashedCart; stashedCart = null; }
      refreshCartUi(); // prices differ per city
      appliedCoupon = null; setMsg($('spCouponMsg'), '');
      prefillDetails();
      renderCards();
    };
  }

  function updatePickSummary() {
    var el = $('spPickSummary'); if (!el) return;
    el.innerHTML = '<small>📍 ' + escapeHtml(city.name || '') + '</small>';
  }
  function afterItemsChange() {
    updatePickSummary();
    renderItems();
    loadSlots(false);
  }

  // ------------------------------------------------------------------ popup
  var selectedDate = null;
  var selectedSlot = null;
  var appliedCoupon = null;
  var bookingStatus = null;

  function openSheet(step) {
    ensureMarkup(); bindOnce();
    step = typeof step === 'string' ? step : 'spStepForm';
    if (MODE === 'page' && !cart.items.length) { toast('Pick a service first'); var s = $('services'); if (s) s.scrollIntoView({ behavior: 'smooth' }); return; }
    $('spPicker').hidden = MODE !== 'home';
    $('spItems').hidden = false;
    $('spAddMore').hidden = !!stashedCart;
    if (MODE === 'page') { setCity(city.id, city.name); $('spSheetTitle').textContent = 'Book Service'; }
    showStep(step);
    if (!$('spSheet').classList.contains('open')) { appliedCoupon = null; setMsg($('spCouponMsg'), ''); var cc = $('spCoupon'); if (cc) cc.value = ''; }
    renderItems();
    prefillDetails();
    renderDates();
    if (!$('spSheet').classList.contains('open')) pushSheetState();
    $('spSheet').classList.add('open');
    $('spSheet').setAttribute('aria-hidden', 'false');
    document.body.classList.add('sp-sheet-open');
    refreshCartUi();
    setMsg($('spFormMsg'), '');
    checkBookingStatus();
    prewarmOtp();
    setTimeout(restoreLoc, 0);
  }
  // Phone Back button closes the popup instead of leaving the page.
  var sheetHistory = false;
  function pushSheetState() {
    try { history.pushState({ spSheet: 1 }, ''); sheetHistory = true; } catch (e) { sheetHistory = false; }
  }
  window.addEventListener('popstate', function () {
    if (!sheetHistory) return;
    sheetHistory = false;
    var sheet = $('spSheet');
    if (mapIsOpen() && sheet && sheet.classList.contains('open')) { closeMap(); pushSheetState(); return; }
    if (sheet && sheet.classList.contains('open')) { if (posting) { pushSheetState(); return; } closeSheet(true); }
  });
  function closeSheet(fromBack) {
    var sheet = $('spSheet'); if (!sheet) return;
    // Never close while the booking is being saved — the confirmation
    // (and the cart clean-up) would happen behind a closed popup.
    if (posting) return;
    if (fromBack !== true && sheetHistory) { sheetHistory = false; try { history.back(); } catch (e) { /* ignore */ } }
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sp-sheet-open');
    if (otpSession) otpSession.cancel();
    endDirect();
    refreshCartUi();
  }
  function showStep(id) {
    ['spStepForm', 'spStepType', 'spStepOtp', 'spStepDone', 'spStepCancel'].forEach(function (s) { $(s).hidden = s !== id; });
    if (id === 'spStepOtp') $('spSheetTitle').textContent = 'Verify mobile number';
    else if (id === 'spStepCancel') $('spSheetTitle').textContent = 'Cancel booking';
    else if (id === 'spStepDone') $('spSheetTitle').textContent = '';
    else if (id === 'spStepType' && pick.appliance) $('spSheetTitle').textContent = pick.appliance.name + ' Service';
    else if (MODE === 'home' && cart.items.some(function (i) { return cart.items[0] && i.applianceId !== cart.items[0].applianceId; })) $('spSheetTitle').textContent = 'Book Services';
    else if (MODE === 'home' && pick.appliance) $('spSheetTitle').textContent = pick.appliance.name + ' Booking';
    else $('spSheetTitle').textContent = 'Book Service';
  }

  function renderItems() {
    var list = $('spItems');
    list.innerHTML = cart.items.map(function (i) {
      return '<div class="sp-item"><div class="sp-item-name">' + escapeHtml(i.title) + '<small>' + escapeHtml(city.name || '') + '</small></div>' +
        '<div class="sp-item-price">' + inr(i.price) + '</div>' +
        '<button type="button" class="sp-item-remove" data-key="' + escapeHtml(i.key) + '" aria-label="Remove">&times;</button></div>';
    }).join('');
    list.querySelectorAll('.sp-item-remove').forEach(function (b) {
      b.addEventListener('click', function () {
        removeItem(b.getAttribute('data-key'));
        if (!cart.items.length) { if (stashedCart) { endDirect(); } if (MODE === 'home' && pick.appliance) showTypeStep(); else closeSheet(); return; }
        appliedCoupon = null; setMsg($('spCouponMsg'), '');
        renderItems(); loadSlots(false);
      });
    });
    updateTotal();
  }
  function updateTotal() {
    var sub = cartTotal();
    var disc = appliedCoupon ? Math.min(appliedCoupon.discountAmount, sub) : 0;
    $('spTotal').innerHTML = disc ? '<s style="color:#7b8794;font-weight:500;font-size:.9rem;margin-right:6px;">' + inr(sub) + '</s>' + inr(sub - disc) : inr(sub);
    $('spConfirm').textContent = cart.items.length ? 'Confirm Booking · ' + inr(sub - disc) : 'Confirm Booking';
  }

  var detailsEdited = false;     // customer typed/changed details — never overwrite them
  var detailsFromAccount = false;
  function prefillDetails() {
    if (detailsEdited) { $('spSaved').hidden = true; $('spDetailFields').hidden = false; return; }
    var acc = getAccount();
    if (pendingDetails) {
      if (pendingDetails.name) $('spName').value = pendingDetails.name;
      if (pendingDetails.phone) $('spPhone').value = pendingDetails.phone;
      if (pendingDetails.address) $('spAddress').value = pendingDetails.address;
      pendingDetails = null;
      if ($('spName').value || $('spAddress').value) { detailsEdited = true; $('spSaved').hidden = true; $('spDetailFields').hidden = false; return; }
    }
    if (!acc && detailsFromAccount) { $('spName').value = ''; $('spPhone').value = ''; $('spAddress').value = ''; detailsFromAccount = false; }
    var sameCity = acc && (!acc.cityId || acc.cityId === city.id);
    if (acc && acc.name && /^[0-9]{10}$/.test(acc.phone || '') && acc.address && sameCity) {
      $('spName').value = acc.name; $('spPhone').value = acc.phone; $('spAddress').value = acc.address;
      detailsFromAccount = true;
      $('spSavedName').textContent = acc.name;
      $('spSavedPhone').textContent = acc.phone;
      $('spSavedAddr').textContent = acc.address;
      $('spSaved').hidden = false;
      $('spDetailFields').hidden = true;
    } else {
      if (acc) {
        if (!$('spName').value) $('spName').value = acc.name || '';
        if (!$('spPhone').value) $('spPhone').value = acc.phone || '';
        detailsFromAccount = true;
      }
      $('spSaved').hidden = true;
      $('spDetailFields').hidden = false;
    }
  }

  function renderDates() {
    var wrap = $('spDates');
    var html = '';
    for (var i = 0; i < 7; i++) {
      var iso = istDate(i);
      html += '<button type="button" class="sp-chip" data-date="' + iso + '">' + dateLabel(iso, i) + '<small>' + dateSub(iso) + '</small></button>';
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('.sp-chip').forEach(function (b) {
      b.addEventListener('click', function () { selectDate(b.getAttribute('data-date'), false); });
    });
    var valid = selectedDate && wrap.querySelector('[data-date="' + selectedDate + '"]');
    // Today may have filled up / run out of time since it was picked —
    // let it jump to the next day with a free slot again.
    selectDate(valid ? selectedDate : istDate(0), !valid || selectedDate === istDate(0));
  }
  function selectDate(iso, autoAdvance) {
    selectedDate = iso;
    $('spDates').querySelectorAll('.sp-chip').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-date') === iso); });
    loadSlots(autoAdvance);
  }

  var slotReq = 0;
  function loadSlots(autoAdvance, noAutoPick) {
    if (!selectedDate) return;
    var wrap = $('spSlots');
    if (!city.id) { wrap.innerHTML = '<span class="sp-muted">Please choose a city.</span>'; return; }
    var reqId = ++slotReq;
    var ids = Array.from(new Set(cart.items.map(function (i) { return i.applianceId; }))).join(',');
    wrap.innerHTML = '<span class="sp-muted">Loading slots…</span>';
    fetchJSON('/api/slots?date=' + encodeURIComponent(selectedDate) + '&cityId=' + encodeURIComponent(city.id) + '&applianceIds=' + encodeURIComponent(ids))
      .then(function (slots) {
        if (reqId !== slotReq) return;
        var anyOpen = slots.some(function (s) { return s.available; });
        if (!anyOpen && autoAdvance) {
          var chips = Array.from($('spDates').querySelectorAll('.sp-chip'));
          var idx = chips.findIndex(function (c) { return c.getAttribute('data-date') === selectedDate; });
          if (idx > -1 && idx < chips.length - 1) {
            if (idx === 0) chips[0].disabled = true;
            selectDate(chips[idx + 1].getAttribute('data-date'), true);
            return;
          }
        }
        if (!slots.some(function (s) { return s.id === selectedSlot && s.available; })) selectedSlot = null;
        wrap.innerHTML = slots.map(function (s) {
          var why = s.expired ? 'Time passed' : (s.blocked ? 'Unavailable' : (!s.available ? 'Full' : 'Available'));
          return '<button type="button" class="sp-chip" data-slot="' + escapeHtml(s.id) + '"' + (s.available ? '' : ' disabled') + '>' +
            escapeHtml(s.label) + '<small>' + why + '</small></button>';
        }).join('') || '<span class="sp-muted">No slots configured.</span>';
        if (!selectedSlot && !noAutoPick) { var first = slots.find(function (s) { return s.available; }); if (first) selectedSlot = first.id; }
        wrap.querySelectorAll('.sp-chip').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-slot') === selectedSlot);
          b.addEventListener('click', function () {
            selectedSlot = b.getAttribute('data-slot');
            wrap.querySelectorAll('.sp-chip').forEach(function (x) { x.classList.toggle('active', x === b); });
          });
        });
        if (!anyOpen) wrap.insertAdjacentHTML('beforeend', '<span class="sp-muted" style="align-self:center;">No free slot on this day — pick another date.</span>');
      })
      .catch(function (err) {
        if (reqId !== slotReq) return;
        wrap.innerHTML = '<span class="sp-muted">' + escapeHtml(err.message) + '</span>';
      });
  }

  function checkBookingStatus() {
    fetchJSON('/api/booking-status').then(function (st) {
      bookingStatus = st;
      var el = $('spPausedMsg');
      if (st.bookingPaused) { el.hidden = false; el.textContent = st.bookingPausedMessage || "We're not accepting new bookings right now. Please call us."; }
      else el.hidden = true;
      $('spConfirm').disabled = !!st.bookingPaused;
    }).catch(function () { /* server re-checks at submit */ });
  }

  // ------------------------------------------------------------------ OTP
  var OTP_URLS = ['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js'];
  var otpCfgPromise = null;
  var otpScriptPromise = null;
  var otpSession = null;
  function getOtpConfig() {
    if (!otpCfgPromise) otpCfgPromise = fetchJSON('/api/otp-config').catch(function (e) { otpCfgPromise = null; throw e; });
    return otpCfgPromise;
  }
  function loadOtpScript() {
    if (typeof window.initSendOTP === 'function') return Promise.resolve();
    if (otpScriptPromise) return otpScriptPromise;
    otpScriptPromise = new Promise(function (resolve, reject) {
      var i = 0;
      (function attempt() {
        var s = document.createElement('script');
        s.src = OTP_URLS[i]; s.async = true;
        s.onload = function () { typeof window.initSendOTP === 'function' ? resolve() : reject(new Error('OTP service did not load.')); };
        s.onerror = function () { i++; if (i < OTP_URLS.length) attempt(); else reject(new Error('Could not load OTP service. Check your internet connection.')); };
        document.head.appendChild(s);
      })();
    }).catch(function (e) { otpScriptPromise = null; throw e; });
    return otpScriptPromise;
  }
  function prewarmOtp() { getOtpConfig().then(function (c) { if (c && c.enabled !== false) return loadOtpScript(); }).catch(function () {}); }
  function waitForOtpMethods(ms) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function poll() {
        if (typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function') resolve();
        else if (Date.now() - start > ms) reject(new Error('OTP service did not start. Please try again or call us to book.'));
        else setTimeout(poll, 150);
      })();
    });
  }
  function errText(e) { return (e && (e.message || e.type || (typeof e === 'string' ? e : ''))) || 'Unknown error'; }

  function verifyWithOtp(phone, forCancel) {
    return new Promise(function (resolve, reject) {
      $('spOtpWhy').textContent = forCancel ? 'Enter it to confirm the cancellation (needed because this is a different phone/computer).' : 'Enter it to confirm your booking (only needed on your first booking).';
      $('spOtpBack').textContent = forCancel ? '← Back' : '← Change details';
      var verifyLabel = forCancel ? 'Verify & Cancel' : 'Verify & Book';
      var done = false;
      var msg = $('spOtpMsg');
      function finish(ok, val) {
        if (done) return; done = true;
        $('spOtpVerify').removeEventListener('click', onVerify);
        $('spOtpResend').removeEventListener('click', onResend);
        $('spOtpBack').removeEventListener('click', onBack);
        otpSession = null;
        ok ? resolve(val) : reject(val);
      }
      function onVerify() {
        var code = $('spOtpCode').value.trim();
        if (!/^[0-9]{4,6}$/.test(code)) { setMsg(msg, 'Please enter the code you received.', 'error'); return; }
        if (typeof window.verifyOtp !== 'function') { setMsg(msg, 'Please wait a moment — the code is still being sent.', 'error'); return; }
        unlockAudio();
        var b = $('spOtpVerify'); b.disabled = true; b.textContent = 'Verifying…';
        window.verifyOtp(code, function (data) {
          b.disabled = false; b.textContent = verifyLabel;
          var token = data && (data.message || data.token || data['access-token']);
          if (token) finish(true, token); else setMsg(msg, 'Verification failed. Please try again.', 'error');
        }, function () {
          b.disabled = false; b.textContent = verifyLabel;
          setMsg(msg, 'Incorrect or expired code. Please try again.', 'error');
        });
      }
      function onResend() {
        if (typeof window.retryOtp !== 'function') { setMsg(msg, 'Please wait a moment — the code is still being sent.', 'error'); return; }
        var b = $('spOtpResend'); b.disabled = true; b.textContent = 'Resending…';
        window.retryOtp(null, function () { b.disabled = false; b.textContent = 'Resend code'; setMsg(msg, 'A new code has been sent.', 'success'); },
          function (e) { b.disabled = false; b.textContent = 'Resend code'; setMsg(msg, 'Could not resend: ' + errText(e), 'error'); });
      }
      function onBack() { finish(false, Object.assign(new Error('cancelled'), { cancelled: true })); }
      otpSession = { cancel: onBack };
      ['spOtpVerify', 'spOtpResend'].forEach(function (id) { $(id).disabled = false; });
      $('spOtpVerify').textContent = verifyLabel; $('spOtpResend').textContent = 'Resend code';
      $('spOtpVerify').addEventListener('click', onVerify);
      $('spOtpResend').addEventListener('click', onResend);
      $('spOtpBack').addEventListener('click', onBack);
      $('spOtpCode').onkeydown = function (e) { if (e.key === 'Enter') onVerify(); };

      getOtpConfig().then(function (cfg) {
        if (!cfg.widgetId || !cfg.tokenAuth) throw new Error('OTP is not set up yet. Please call us to book.');
        return loadOtpScript().then(function () { return cfg; });
      }).then(function (cfg) {
        $('spOtpPhone').textContent = phone;
        $('spOtpCode').value = '';
        showStep('spStepOtp');
        setMsg(msg, 'Sending code…');
        window.initSendOTP({ widgetId: cfg.widgetId, tokenAuth: cfg.tokenAuth, exposeMethods: true,
          success: function (data) { var t = data && (data.message || data.token || data['access-token']); if (t) finish(true, t); },
          failure: function () {} });
        return waitForOtpMethods(10000);
      }).then(function () {
        window.sendOtp('91' + phone, function () { setMsg(msg, ''); $('spOtpCode').focus(); },
          function (e) { setMsg(msg, 'Could not send the code: ' + errText(e) + '. Tap "Resend code".', 'error'); });
      }).catch(function (e) { finish(false, e); });
    });
  }

  // ------------------------------------------------------------------ success chime + tick
  var audioCtx = null;
  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio — fine */ }
  }
  // A short, pleasant two-note "ding-ding" made in the browser — no sound
  // file to download.
  function playChime() {
    if (!audioCtx) return;
    try {
      var now = audioCtx.currentTime;
      [[880, 0], [1318.5, 0.14]].forEach(function (n) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, now + n[1]);
        g.gain.exponentialRampToValueAtTime(0.35, now + n[1] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + n[1] + 0.55);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(now + n[1]); o.stop(now + n[1] + 0.6);
      });
    } catch (e) { /* ignore */ }
  }
  function celebrate() {
    var wrap = document.querySelector('.sp-tick-wrap');
    if (wrap) { wrap.classList.remove('play'); void wrap.offsetWidth; wrap.classList.add('play'); }
    playChime();
    try { if (navigator.vibrate) navigator.vibrate([90, 60, 140]); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ submit
  var submitting = false;
  function readDetails() {
    return { name: $('spName').value.trim(), phone: normalizePhone($('spPhone').value), address: $('spAddress').value.trim() };
  }

  // ---- Optional exact location (GPS pin) for the technician's Map ----
  var pickedLoc = null;
  var LOC_KEY = 'seerua_loc_v1';
  function showLoc() {
    var msg = $('spLocMsg'), btn = $('spLocBtn'); if (!msg || !btn) return;
    if (pickedLoc) {
      msg.innerHTML = '✓ Location pinned — the technician can navigate straight to you. <a href="#" id="spLocRemove">Remove</a>';
      msg.className = 'sp-loc-msg ok'; btn.textContent = '📍 Use current location'; if ($('spMapBtn')) $('spMapBtn').textContent = '🗺️ Check / move pin';
      var rm = $('spLocRemove'); if (rm) rm.onclick = function (e) { e.preventDefault(); pickedLoc = null; try { localStorage.removeItem(LOC_KEY); } catch (er) { /* ignore */ } showLoc(); };
    } else {
      msg.textContent = 'Optional — helps the technician find your home exactly.'; msg.className = 'sp-loc-msg'; btn.textContent = '📍 Use my current location'; if ($('spMapBtn')) $('spMapBtn').textContent = '🗺️ Pick on map';
    }
  }
  function restoreLoc() {
    // reuse a saved pin only for the same address it was taken for
    try {
      var s = JSON.parse(localStorage.getItem(LOC_KEY) || 'null');
      var addr = ($('spAddress') && $('spAddress').value.trim()) || '';
      pickedLoc = (s && addr && s.address === addr) ? s : null;
    } catch (e) { pickedLoc = null; }
    showLoc();
  }
  function pickLocation() {
    var msg = $('spLocMsg'), btn = $('spLocBtn');
    if (!navigator.geolocation) { msg.textContent = 'Your browser does not support location. The address is enough.'; msg.className = 'sp-loc-msg err'; return; }
    btn.disabled = true; msg.textContent = 'Getting your location…'; msg.className = 'sp-loc-msg';
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.disabled = false;
      pickedLoc = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), accuracy: Math.round(pos.coords.accuracy || 0), address: $('spAddress').value.trim() };
      try { localStorage.setItem(LOC_KEY, JSON.stringify(pickedLoc)); } catch (e) { /* ignore */ }
      showLoc();
      if (mapState.wrap && !mapState.wrap.hidden && mapState.map) mapState.map.setView([pickedLoc.lat, pickedLoc.lng], 18);
    }, function (err) {
      btn.disabled = false;
      msg.textContent = err && err.code === 1 ? 'Location permission is off. You can still book with the address.' : 'Could not get your location. You can still book with the address.';
      msg.className = 'sp-loc-msg err';
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  // ---- "Pick on map": the pin stays in the middle, the customer moves the map ----
  var mapState = { wrap: null, map: null, loading: null, layers: null };
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    if (mapState.loading) return mapState.loading;
    mapState.loading = new Promise(function (res, rej) {
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css?v=194'; document.head.appendChild(css);
      var js = document.createElement('script'); js.src = '/vendor/leaflet/leaflet.js?v=194';
      js.onload = function () { res(); }; js.onerror = function () { mapState.loading = null; rej(new Error('map')); };
      document.head.appendChild(js);
    });
    return mapState.loading;
  }
  function mapWrap() {
    if (mapState.wrap) return mapState.wrap;
    var w = document.createElement('div');
    w.className = 'sp-map-wrap'; w.id = 'spMapWrap'; w.hidden = true;
    w.innerHTML =
      '<div class="sp-map-box" role="dialog" aria-label="Pick your location on the map">' +
      ' <div class="sp-map-head"><div><b>Move the map to your home</b><small>The pin stays in the middle. Zoom in for accuracy.</small></div><button type="button" class="sp-map-x" id="spMapClose" aria-label="Close">✕</button></div>' +
      ' <div class="sp-map-area"><div class="sp-map" id="spMap"></div><div class="sp-map-pin" aria-hidden="true">📍</div>' +
      '  <div class="sp-map-layers"><button type="button" data-l="map" class="on">Map</button><button type="button" data-l="sat">Satellite</button></div></div>' +
      ' <div class="sp-map-foot"><button type="button" class="sp-loc-btn" id="spMapGps">📍 My location</button><button type="button" class="sp-map-ok" id="spMapOk">✓ Confirm this location</button></div>' +
      ' <div class="sp-map-msg" id="spMapMsg"></div>' +
      '</div>';
    document.body.appendChild(w);
    mapState.wrap = w;
    w.addEventListener('click', function (e) { if (e.target === w) closeMap(); });
    $('spMapClose').addEventListener('click', function () { closeMap(); });
    $('spMapGps').addEventListener('click', function () {
      var m = $('spMapMsg');
      if (!navigator.geolocation) { m.textContent = 'Your browser does not support location.'; return; }
      m.textContent = 'Getting your location…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        m.textContent = '';
        if (mapState.map) mapState.map.setView([pos.coords.latitude, pos.coords.longitude], 18);
      }, function (err) { m.textContent = err && err.code === 1 ? 'Location permission is off — move the map by hand.' : 'Could not get your location — move the map by hand.'; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
    $('spMapOk').addEventListener('click', function () {
      if (!mapState.map) return;
      var c = mapState.map.getCenter();
      if (!(c.lat > 6 && c.lat < 38 && c.lng > 68 && c.lng < 98)) { $('spMapMsg').textContent = 'Please place the pin inside India.'; return; }
      if (mapState.map.getZoom() < 15) { $('spMapMsg').textContent = 'Please zoom in closer to your home, then confirm.'; return; }
      pickedLoc = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6), accuracy: null, address: ($('spAddress') && $('spAddress').value.trim()) || '' };
      try { localStorage.setItem(LOC_KEY, JSON.stringify(pickedLoc)); } catch (e) { /* ignore */ }
      showLoc();
      closeMap();
    });
    w.querySelector('.sp-map-layers').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-l]'); if (!b || !mapState.layers) return;
      var sat = b.getAttribute('data-l') === 'sat';
      mapState.map.removeLayer(sat ? mapState.layers.map : mapState.layers.sat);
      mapState.map.addLayer(sat ? mapState.layers.sat : mapState.layers.map);
      w.querySelectorAll('.sp-map-layers button').forEach(function (x) { x.classList.toggle('on', x === b); });
    });
    return w;
  }
  function cityCenter() {
    // rough centre for the chosen city (OpenStreetMap search), India if unknown
    var name = city.name || '';
    if (!name || !window.fetch) return Promise.resolve(null);
    return fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=' + encodeURIComponent(name + ', India'))
      .then(function (r) { return r.json(); })
      .then(function (d) { return d && d[0] ? [Number(d[0].lat), Number(d[0].lon)] : null; })
      .catch(function () { return null; });
  }
  function openMap() {
    var w = mapWrap();
    w.hidden = false; document.body.classList.add('sp-map-open');
    $('spMapMsg').textContent = '';
    loadLeaflet().then(function () {
      var start = pickedLoc ? { c: [pickedLoc.lat, pickedLoc.lng], z: 18 } : null;
      var fresh = !mapState.map;
      if (!mapState.map) {
        mapState.map = L.map('spMap', { zoomControl: true, attributionControl: true }).setView([22.6, 79.0], 5);
        mapState.layers = {
          map: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
          sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' })
        };
        mapState.layers.map.addTo(mapState.map);
      }
      setTimeout(function () { mapState.map.invalidateSize(); }, 50);
      if (start) return mapState.map.setView(start.c, start.z);
      if (!fresh) return; // reopened — keep where the customer left the map
      $('spMapMsg').textContent = 'Finding ' + (city.name || 'your city') + '…';
      cityCenter().then(function (c) {
        $('spMapMsg').textContent = '';
        mapState.map.setView(c || [22.6, 79.0], c ? 13 : 5);
      });
    }).catch(function () {
      $('spMapMsg').textContent = 'The map could not load. Check your internet — you can still book with the address.';
    });
  }
  function closeMap() {
    if (mapState.wrap) mapState.wrap.hidden = true;
    document.body.classList.remove('sp-map-open');
  }
  function mapIsOpen() { return !!(mapState.wrap && !mapState.wrap.hidden); }
  function validate(d) {
    if (!city.id) return 'Please choose your city.';
    if (!cart.items.length) return 'Please choose a service first.';
    if (!d.name) return 'Please enter your name.';
    if (!/^[6-9][0-9]{9}$/.test(d.phone)) return 'Please enter a valid 10 digit mobile number.';
    if (cart.cityId && city.id && cart.cityId !== city.id) return 'Your services are priced for another city — please pick them again.';
    if (d.address.length < 8) return 'Please enter your full address (house no., area, landmark).';
    if (!selectedDate || !selectedSlot) return 'Please choose a date and time slot.';
    return null;
  }

  function onConfirm() {
    if (submitting) return;
    unlockAudio();
    var d = readDetails();
    var err = validate(d);
    var msg = $('spFormMsg');
    if (err) {
      if (/name|mobile|address/.test(err)) { $('spSaved').hidden = true; $('spDetailFields').hidden = false; }
      setMsg(msg, err, 'error'); return;
    }
    if (bookingStatus && bookingStatus.bookingPaused) { setMsg(msg, bookingStatus.bookingPausedMessage || 'Bookings are paused right now.', 'error'); return; }
    submitting = true;
    var btn = $('spConfirm'); btn.disabled = true; btn.textContent = 'Confirming…';
    setMsg(msg, '');
    Promise.all([
      getOtpConfig().catch(function () { return { enabled: true }; }),
      fetchJSON('/api/phone-verified?phone=' + d.phone).catch(function () { return { verified: false }; })
    ]).then(function (r) {
      var needOtp = r[0].enabled !== false && !r[1].verified;
      return needOtp ? verifyWithOtp(d.phone) : null;
    }).then(function (token) {
      showStep('spStepForm');
      return submitBooking(d, token);
    }).catch(function (e) {
      showStep('spStepForm');
      if (!e || !e.cancelled) setMsg(msg, (e && e.message) || 'Could not confirm. Please try again.', 'error');
    }).then(function () {
      submitting = false; btn.disabled = !!(bookingStatus && bookingStatus.bookingPaused); updateTotal();
    });
  }

  var posting = false;
  function submitBooking(d, accessToken) {
    $('spConfirm').textContent = 'Booking…';
    posting = true;
    $('spSheetClose').disabled = true;
    var ref = null; try { ref = sessionStorage.getItem(REF_KEY); } catch (e) { /* ignore */ }
    var payload = {
      name: d.name, phone: d.phone, address: d.address, cityId: city.id,
      bookingDate: selectedDate, timeSlotId: selectedSlot,
      accessToken: accessToken || undefined,
      couponCode: appliedCoupon ? appliedCoupon.code : undefined,
      referralCode: ref || undefined,
      location: pickedLoc ? { lat: pickedLoc.lat, lng: pickedLoc.lng, accuracy: pickedLoc.accuracy } : undefined,
      items: cart.items.map(function (i) {
        var generic = i.skuId === 'svc-service' || i.skuId === 'svc-repair';
        return { applianceId: i.applianceId, typeId: i.typeId, serviceType: i.serviceType, qty: 1, skuId: i.skuId, problem: generic ? '' : i.skuName + ' requested.' };
      })
    };
    // 30 s timeout — a stuck request no longer leaves "Booking…" forever.
    // (A retry of the same booking is recognised by the server, not doubled.)
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;
    var done = function () { posting = false; $('spSheetClose').disabled = false; if (timer) clearTimeout(timer); };
    return fetchJSON('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      done();
      var b = res.booking || {};
      if (res.cancelKey && b.id) saveCancelKey(b.id, res.cancelKey);
      lastBooked = b;
      $('spDoneCancel').hidden = b.canCancel === false;
      saveAccount({ phone: d.phone, name: d.name, address: d.address, cityId: city.id, accessToken: null });
      postJSON('/api/customer-profile', { phone: d.phone, name: d.name, address: d.address, cityId: city.id }).catch(function () {});
      try { sessionStorage.removeItem(REF_KEY); } catch (e) { /* ignore */ }
      // Remove exactly what was booked. After a one-off "Book", the real
      // cart comes back minus that item; after a cart booking, it's empty.
      var bookedKeys = cart.items.map(function (i) { return i.key; });
      if (stashedCart) {
        cart = stashedCart; stashedCart = null;
        if (cart.cityId === city.id) cart.items = cart.items.filter(function (i) { return bookedKeys.indexOf(i.key) === -1; });
      } else {
        cart = { cityId: city.id, items: [] };
      }
      writeCart(); refreshCartUi();
      detailsEdited = false;
      appliedCoupon = null; $('spCoupon').value = ''; setMsg($('spCouponMsg'), '');
      $('spDoneId').textContent = b.id || '—';
      $('spDoneWhen').textContent = (b.bookingDate || selectedDate) + ' · ' + (b.timeSlot || '') + ' · Total ' + inr(b.totalPrice);
      showStep('spStepDone');
      celebrate();
      if (typeof window.gtag === 'function') { try { window.gtag('event', 'purchase', { value: b.totalPrice, currency: 'INR', transaction_id: b.id }); } catch (e) { /* ignore */ } }
    }).catch(function (e) {
      done();
      if (e && e.name === 'AbortError') throw new Error('Network is slow — we could not confirm. Please check My Bookings before trying again, or call us.');
      if (e.status === 409) { selectedSlot = null; loadSlots(false, true); }
      if (/verify your mobile/i.test(e.message || '') && !accessToken) {
        return verifyWithOtp(d.phone).then(function (t) { showStep('spStepForm'); return submitBooking(d, t); });
      }
      throw e;
    });
  }

  // ------------------------------------------------------------------ customer cancellation
  // The device that made a booking keeps its secret cancel key and can
  // cancel directly; any other phone/computer must pass an OTP first.
  var CANCEL_KEYS = 'seerua_cancel_keys_v1';
  var lastBooked = null;
  var cancelTarget = null;
  function readCancelKeys() { try { return JSON.parse(localStorage.getItem(CANCEL_KEYS) || '{}') || {}; } catch (e) { return {}; } }
  function saveCancelKey(id, key) {
    var all = readCancelKeys(); all[id] = { k: key, t: Date.now() };
    var ids = Object.keys(all).sort(function (a, b) { return all[b].t - all[a].t; });
    ids.slice(40).forEach(function (x) { delete all[x]; }); // keep the latest 40
    try { localStorage.setItem(CANCEL_KEYS, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }
  function cancelKeyFor(id) { var r = readCancelKeys()[id]; return r ? r.k : null; }

  function openCancel(b) {
    ensureMarkup(); bindOnce();
    if (!b || !b.id) return;
    cancelTarget = b;
    var items = (b.items || []).map(function (i) { return escapeHtml((i.typeName || '') + ' ' + (i.serviceName || (i.serviceType === 'repair' ? 'Repair' : 'Service'))); }).join(', ');
    $('spCancelSum').innerHTML = '<strong>Booking ' + escapeHtml(b.id) + '</strong><br>' + items +
      (b.bookingDate ? '<br>🕐 ' + escapeHtml(b.bookingDate) + (b.timeSlot ? ' · ' + escapeHtml(b.timeSlot) : '') : '') +
      (b.totalPrice != null ? '<br>Total ' + inr(b.totalPrice) : '');
    $('spCancelForm').hidden = false; $('spCancelDone').hidden = true;
    $('spCancelReason').selectedIndex = 0; $('spCancelNote').value = '';
    setMsg($('spCancelMsg'), '');
    var sheet = $('spSheet');
    if (!sheet.classList.contains('open')) {
      pushSheetState();
      sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); document.body.classList.add('sp-sheet-open');
    }
    showStep('spStepCancel');
  }
  function doCancel(extra) {
    var b = cancelTarget;
    var body = Object.assign({ phone: b.phone, reason: $('spCancelReason').value, note: $('spCancelNote').value.trim(), cancelKey: cancelKeyFor(b.id) || undefined }, extra || {});
    return postJSON('/api/bookings/' + encodeURIComponent(b.id) + '/cancel', body);
  }
  function onCancelConfirm() {
    if (!cancelTarget) return;
    var btn = $('spCancelConfirm'); var msg = $('spCancelMsg');
    btn.disabled = true; btn.textContent = 'Cancelling…'; setMsg(msg, '');
    doCancel().catch(function (e) {
      if (e.status !== 401) throw e;
      // Different device -> OTP on the booking's number.
      return getOtpConfig().then(function (cfg) {
        if (!cfg || !cfg.widgetId || !cfg.tokenAuth) throw new Error('To cancel from this phone/computer, please call us on ' + (CFG.phone || '9389585479') + '. (Or cancel from the phone you booked on.)');
        return verifyWithOtp(cancelTarget.phone, true).then(function (token) { showStep('spStepCancel'); return doCancel({ accessToken: token }); });
      });
    }).then(function () {
      var all = readCancelKeys(); delete all[cancelTarget.id]; try { localStorage.setItem(CANCEL_KEYS, JSON.stringify(all)); } catch (e) { /* ignore */ }
      $('spCancelForm').hidden = true; $('spCancelDone').hidden = false;
      try { window.dispatchEvent(new CustomEvent('seerua:booking-cancelled', { detail: { id: cancelTarget.id } })); } catch (e) { /* ignore */ }
    }).catch(function (e) {
      showStep('spStepCancel');
      if (!e || !e.cancelled) setMsg(msg, (e && e.message) || 'Could not cancel. Please call us.', 'error');
    }).then(function () { btn.disabled = false; btn.textContent = 'Cancel Booking'; });
  }

  // ------------------------------------------------------------------ wiring
  var bound = false;
  function bindOnce() {
    if (bound) return; bound = true;
    $('spSheetClose').addEventListener('click', closeSheet);
    $('spDoneClose').addEventListener('click', closeSheet);
    $('spDoneCancel').addEventListener('click', function () { if (lastBooked) openCancel(Object.assign({ phone: normalizePhone($('spPhone').value) }, lastBooked)); });
    $('spCancelConfirm').addEventListener('click', onCancelConfirm);
    $('spCancelKeep').addEventListener('click', closeSheet);
    $('spCancelDoneClose').addEventListener('click', closeSheet);
    $('spSheet').addEventListener('click', function (e) { if (e.target === $('spSheet')) closeSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('spSheet').classList.contains('open')) closeSheet(); });
    $('spAddMore').addEventListener('click', function () {
      if (MODE === 'home' && pick.appliance) { showTypeStep(); return; }
      closeSheet(); var s = $('services'); if (s) s.scrollIntoView({ behavior: 'smooth' });
    });
    $('spPickChange').addEventListener('click', function () { if (pick.appliance) showTypeStep(); });
    $('spCardBarBtn').addEventListener('click', function () { endDirect(); if (cart.items.length) goToForm(); });
    $('spEditDetails').addEventListener('click', function () { detailsEdited = true; $('spSaved').hidden = true; $('spDetailFields').hidden = false; $('spName').focus(); });
    $('spConfirm').addEventListener('click', onConfirm);
    $('spPhone').addEventListener('input', function () { var v = normalizePhone(this.value); if (v !== this.value) this.value = v; });
    ['spName', 'spPhone', 'spAddress'].forEach(function (id) { $(id).addEventListener('input', function () { detailsEdited = true; }); });
    if ($('spLocBtn')) $('spLocBtn').addEventListener('click', pickLocation);
    if ($('spMapBtn')) $('spMapBtn').addEventListener('click', openMap);
    if ($('spAddress')) $('spAddress').addEventListener('change', function () { if (pickedLoc) { pickedLoc.address = $('spAddress').value.trim(); try { localStorage.setItem(LOC_KEY, JSON.stringify(pickedLoc)); } catch (e) { /* ignore */ } } });
    $('spOtpCode').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });
    $('spCouponApply').addEventListener('click', function () {
      var code = $('spCoupon').value.trim();
      var msg = $('spCouponMsg');
      if (!code) { setMsg(msg, 'Enter a coupon code.', 'error'); return; }
      setMsg(msg, 'Checking…');
      postJSON('/api/coupons/validate', { code: code, totalPrice: cartTotal(), phone: $('spPhone').value.trim() })
        .then(function (r) { appliedCoupon = { code: r.code, discountAmount: r.discountAmount }; setMsg(msg, '✅ ' + r.code + ' applied — you save ' + inr(r.discountAmount), 'success'); updateTotal(); })
        .catch(function (err) { appliedCoupon = null; setMsg(msg, err.message, 'error'); updateTotal(); });
    });
  }

  // "Book Again" (My Account / Track Booking list) -> the SAME popup form,
  // pre-filled with that past booking's services at today's prices for its
  // city. Old bookings don't store which exact service card was picked, so
  // it's matched by service kind + old price (falls back to plain
  // Service / Repair). The customer's cart is left untouched.
  function openWithItems(cityId, pastItems, details) {
    ensureMarkup(); bindOnce();
    return Promise.all([loadCities(), loadAppliances(), loadPhotoMap()]).then(function (r) {
      pick.cities = r[0]; pick.photos = r[2] || {};
      var c = r[0].find(function (x) { return x.id === cityId; });
      if (!c) { var g = guessCityId(r[0]); c = r[0].find(function (x) { return x.id === g; }); }
      if (!c) throw new Error('Booking is not available right now.');
      setCity(c.id, c.name);
      var jobs = (pastItems || []).map(function (p) {
        var appl = r[1].find(function (a) { return a.id === p.applianceId; });
        var type = appl && appl.types.find(function (t) { return t.id === p.typeId; });
        if (!appl || !type || (appl.disabledCities || []).indexOf(c.id) > -1) return Promise.resolve(null);
        return loadPrice(c.id, appl.id, type.id).then(function (row) {
          var opts = servicesOf(type).map(function (sv) { return { svc: sv, price: priceForSku(row, sv.id) }; })
            .filter(function (x) { return typeof x.price === 'number'; });
          var want = p.serviceType === 'repair' ? 'repair' : 'service';
          var same = opts.filter(function (x) { return bookingServiceType(x.svc.id) === want; });
          var best = same.find(function (x) { return x.price === Number(p.unitPrice); }) ||
            same.find(function (x) { return x.svc.id === (want === 'repair' ? 'svc-repair' : 'svc-service'); }) || same[0] || opts[0];
          return best ? cardItem(appl, type, best.svc, best.price) : null;
        }).catch(function () { return null; });
      });
      return Promise.all(jobs).then(function (found) {
        var items = [];
        found.forEach(function (it) { if (it && !items.some(function (i) { return i.key === it.key; })) items.push(it); });
        if (!items.length) { toast('Those services are not available right now — please pick again.'); return; }
        if (!stashedCart) stashedCart = cart;
        cart = { cityId: c.id, items: items };
        var last = items[items.length - 1];
        pick.appliance = r[1].find(function (a) { return a.id === last.applianceId; }) || null;
        pick.typeId = last.typeId;
        if (pick.appliance) renderPickCities();
        var multi = items.some(function (i) { return i.applianceId !== items[0].applianceId; });
        $('spPickName').textContent = multi || !pick.appliance ? 'Book again' : pick.appliance.name;
        var img = $('spPickImg');
        if (!multi && pick.appliance && pick.appliance.photoUrl) { img.src = pick.appliance.photoUrl; img.hidden = false; } else img.hidden = true;
        openSheet('spStepForm');
        goToForm();
        if (details && !$('spDetailFields').hidden) {
          if (!$('spName').value) $('spName').value = details.name || '';
          if (!$('spPhone').value) $('spPhone').value = details.phone || '';
          if (!$('spAddress').value && details.cityId === c.id) $('spAddress').value = details.address || '';
        }
        setMsg($('spFormMsg'), 'Your past services and details are filled in — just pick a date & time slot and confirm.', 'success');
      });
    }).catch(function (err) { toast(err.message || 'Could not open booking.'); });
  }

  if (MODE === 'page') {
    ensureMarkup(); bindOnce();
    var openCart = function () { endDirect(); openSheet('spStepForm'); };
    var cb = $('spCartBarBtn'); if (cb) cb.addEventListener('click', openCart);
    var hc = $('spHeaderCart'); if (hc) hc.addEventListener('click', openCart);
    var nc = $('bottomNavCartBtn'); if (nc) nc.addEventListener('click', openCart);
    refreshCartUi();
  } else {
    // Homepage: every appliance tile (photo, name or "Book Now") opens the
    // popup with that appliance pre-selected, instead of the old multi-step
    // flow. The tile's <a href> stays in the HTML for Google.
    window.openApplianceBoxesPanel = function (id) { openForAppliance(id); };
    // Cart icon (bottom nav / desktop header) -> booking form with every
    // service in the cart. Runs before the old homepage cart handler.
    var openCartForm = function (e) {
      endDirect();
      if (!cart.items.length) return; // empty -> leave the old behaviour alone
      e.preventDefault(); e.stopImmediatePropagation();
      ensureMarkup(); bindOnce();
      Promise.all([loadCities(), loadAppliances()]).then(function (r) {
        pick.cities = r[0];
        var c = pick.cities.find(function (x) { return x.id === cart.cityId; }) || {};
        setCity(c.id || null, c.name || '');
        var ids = cart.items.map(function (i) { return i.applianceId; });
        pick.appliance = r[1].find(function (a) { return a.id === ids[ids.length - 1]; }) || pick.appliance;
        if (pick.appliance) {
          if (!pick.typeId || !pick.appliance.types.some(function (t) { return t.id === pick.typeId; })) pick.typeId = pick.appliance.types[0].id;
          renderPickCities();
        }
        var multi = ids.some(function (x) { return x !== ids[0]; });
        $('spPickName').textContent = multi ? 'Your cart' : (pick.appliance ? pick.appliance.name : 'Your cart');
        var img = $('spPickImg');
        if (!multi && pick.appliance && pick.appliance.photoUrl) { img.src = pick.appliance.photoUrl; img.hidden = false; } else img.hidden = true;
        openSheet('spStepForm');
        goToForm();
      }).catch(function (err) { toast(err.message || 'Could not open cart.'); });
    };
    ['bottomNavCartBtn', 'headerCartBtn'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('click', openCartForm, true); });
    window.addEventListener('load', function () { refreshCartUi(); setTimeout(refreshCartUi, 800); });
    document.addEventListener('click', function (e) {
      var link = e.target.closest && e.target.closest('#servicesGrid .service-card-link');
      if (!link) return;
      var card = link.closest('.service-card');
      if (card && card.getAttribute('data-coming-soon')) {
        e.preventDefault();
        ensureMarkup();
        toast((card.querySelector('h3') || {}).textContent + ' service is coming soon — booking is not open yet.');
        return;
      }
      var id = card && card.getAttribute('data-appliance');
      if (!id) return;
      e.preventDefault();
      openForAppliance(id);
    });
  }
  updateHeaderInitial();
  // Old homepage form entry points (#book links from city/blog pages,
  // "Book Again") now all land in this popup instead.
  var lastOldEntry = 0;
  function openFromOldEntry() {
    if (Date.now() - lastOldEntry < 1500) return; // /#book used to fire this twice
    lastOldEntry = Date.now();
    ensureMarkup(); bindOnce();
    endDirect();
    if (MODE === 'home' && cart.items.length) {
      var hb = $('headerCartBtn') || $('bottomNavCartBtn');
      if (hb) { hb.click(); return; }
    }
    var s = $('services');
    if (s) s.scrollIntoView({ behavior: 'smooth' });
    toast('👇 Tap the appliance you want to book');
  }
  window.SeeruaBooking = { openForAppliance: openForAppliance, open: openSheet, close: closeSheet, openWithItems: openWithItems, openFromOldEntry: openFromOldEntry, openCancel: openCancel,
    refreshBadges: function () { refreshCartUi(); },
    onLogout: function () {
      detailsEdited = false; detailsFromAccount = false; pendingDetails = null;
      ['spName', 'spPhone', 'spAddress'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
      var sv = $('spSaved'); if (sv) sv.hidden = true;
      var df = $('spDetailFields'); if (df) df.hidden = false;
      updateHeaderInitial();
    } };

  // ------------------------------------------------------------------ auto-scrolling photo strips
  // Photos glide slowly right-to-left in a loop. Stops while the customer
  // touches / hovers / scrolls it, resumes a moment later. Off for people
  // who've asked their phone for reduced motion. The original links stay
  // in the HTML (the loop copies are hidden from Google & screen readers).
  function autoScroll(el) {
    if (!el || el.dataset.autoscroll) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.dataset.autoscroll = '1';
    var SPEED = 28; // px per second
    var paused = false, resumeTimer = null, visible = true, pos = 0, last = 0, loopWidth = 0, cloning = false;

    function originals() { return Array.prototype.filter.call(el.children, function (c) { return !c.hasAttribute('data-clone'); }); }
    function setup() {
      cloning = true;
      Array.prototype.slice.call(el.querySelectorAll(':scope > [data-clone]')).forEach(function (c) { c.remove(); });
      loopWidth = 0;
      var orig = originals();
      if (orig.length && el.scrollWidth > el.clientWidth + 8) {
        orig.forEach(function (c) {
          var copy = c.cloneNode(true);
          copy.setAttribute('data-clone', '1');
          copy.setAttribute('aria-hidden', 'true');
          copy.querySelectorAll('a, button').forEach(function (x) { x.setAttribute('tabindex', '-1'); });
          el.appendChild(copy);
        });
        var firstClone = el.querySelector(':scope > [data-clone]');
        loopWidth = firstClone.offsetLeft - orig[0].offsetLeft;
      }
      pos = el.scrollLeft;
      setTimeout(function () { cloning = false; }, 0);
    }
    function pause() { paused = true; clearTimeout(resumeTimer); }
    function resumeLater() { clearTimeout(resumeTimer); resumeTimer = setTimeout(function () { pos = el.scrollLeft; paused = false; }, 2500); }
    ['touchstart', 'pointerdown', 'mouseenter', 'focusin', 'wheel'].forEach(function (ev) { el.addEventListener(ev, pause, { passive: true }); });
    ['touchend', 'pointerup', 'mouseleave', 'focusout'].forEach(function (ev) { el.addEventListener(ev, resumeLater, { passive: true }); });
    el.addEventListener('scroll', function () { if (paused) { pos = el.scrollLeft; resumeLater(); } }, { passive: true });
    if ('IntersectionObserver' in window) new IntersectionObserver(function (en) { visible = en[0].isIntersecting; }).observe(el);
    if ('MutationObserver' in window) {
      new MutationObserver(function () { if (!cloning) setup(); }).observe(el, { childList: true });
    }
    window.addEventListener('resize', function () { clearTimeout(el._rt); el._rt = setTimeout(setup, 300); });
    function frame(t) {
      var dt = last ? Math.min(0.05, (t - last) / 1000) : 0; last = t;
      if (!paused && visible && loopWidth > 0 && !document.hidden && !document.body.classList.contains('sp-sheet-open')) {
        pos += SPEED * dt;
        if (pos >= loopWidth) pos -= loopWidth;
        el.scrollLeft = pos;
      }
      requestAnimationFrame(frame);
    }
    setup();
    requestAnimationFrame(frame);
  }
  function startStrips() {
    autoScroll(document.querySelector('.sp-strip'));
    autoScroll($('servicesGrid'));
  }
  if (document.readyState === 'complete') startStrips(); else window.addEventListener('load', startStrips);
})();
