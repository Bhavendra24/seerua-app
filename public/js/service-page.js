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
  function istDate(offsetDays) {
    var d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
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
  function getAccount() { try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null'); } catch (e) { return null; } }
  function saveAccount(acc) { try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acc)); } catch (e) { /* ignore */ } }

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
      '     <label class="sp-label" for="spPhone">Mobile number</label><div class="sp-phone-wrap"><span>+91</span><input class="sp-input" id="spPhone" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="10 digit mobile number" maxlength="10"></div>' +
      '     <label class="sp-label" for="spAddress" id="spAddressLabel">Full address</label><textarea class="sp-input" id="spAddress" rows="2" autocomplete="street-address" placeholder="House no., street, area, landmark" maxlength="300"></textarea>' +
      '    </div>' +
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
      '   <p>We sent a code to <strong>+91 <span id="spOtpPhone"></span></strong>. Enter it to confirm your booking (only needed on your first booking).</p>' +
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
    if (MODE !== 'page') return { cityId: city.id, items: [] };
    try {
      var c = JSON.parse(sessionStorage.getItem(CART_KEY) || 'null');
      if (c && c.cityId === city.id && Array.isArray(c.items)) return c;
    } catch (e) { /* ignore */ }
    return { cityId: city.id, items: [] };
  }
  function writeCart() { if (MODE === 'page') { try { sessionStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) { /* ignore */ } } }
  var cart = readCart();
  try {
    var urlRef = new URLSearchParams(location.search).get('ref');
    if (urlRef) sessionStorage.setItem(REF_KEY, urlRef.trim().toUpperCase());
  } catch (e) { /* ignore */ }

  function inCart(key) { return cart.items.some(function (i) { return i.key === key; }); }
  function cartTotal() { return cart.items.reduce(function (s, i) { return s + i.price; }, 0); }
  function addItem(item) { if (inCart(item.key)) return false; cart.items.push(item); writeCart(); refreshCartUi(); return true; }
  function removeItem(key) { cart.items = cart.items.filter(function (i) { return i.key !== key; }); writeCart(); refreshCartUi(); }

  function refreshCartUi() {
    if (MODE !== 'page') return;
    var n = cart.items.length;
    var hb = $('spHeaderCartBadge'); if (hb) { hb.textContent = String(n); hb.hidden = n === 0; }
    var bb = $('bottomNavCartBadge'); if (bb) { bb.textContent = String(n); bb.hidden = n === 0; }
    var bar = $('spCartBar');
    if (bar) {
      bar.hidden = n === 0 || ($('spSheet') && $('spSheet').classList.contains('open'));
      $('spCartBarCount').textContent = n + (n === 1 ? ' service' : ' services') + ' added';
      $('spCartBarTotal').textContent = 'Total ' + inr(cartTotal());
    }
    document.querySelectorAll('.sp-card').forEach(function (card) {
      var btn = card.querySelector('.sp-btn-add'); if (!btn) return;
      var added = inCart(itemFromCard(card).key);
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
      if (btn.getAttribute('data-action') === 'add') {
        if (inCart(item.key)) { removeItem(item.key); toast('Removed from cart'); }
        else { addItem(item); toast('✅ ' + item.title + ' added'); }
      } else {
        addItem(item);
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

  function openForAppliance(applianceId, typeId) {
    ensureMarkup(); bindOnce();
    Promise.all([loadCities(), loadAppliances(), loadPhotoMap()]).then(function (r) {
      pick.cities = r[0];
      pick.photos = r[2] || {};
      var appl = r[1].find(function (a) { return a.id === applianceId; });
      if (!appl || !appl.types.length) { toast('This service is not available right now.'); return; }
      pick.appliance = appl;
      var cid = guessCityId(pick.cities);
      var c = pick.cities.find(function (x) { return x.id === cid; }) || {};
      setCity(c.id || null, c.name || '');
      cart = { cityId: city.id, items: [] };
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
        var added = inCart(it.key);
        return '<article class="sp-card" data-idx="' + idx + '">' +
          '<div class="sp-card-img">' + (photo ? '<img src="' + escapeHtml(photo) + '" alt="' + escapeHtml(it.title) + '" loading="lazy">' : '<span class="sp-strip-fallback">🔧</span>') +
          '<span class="sp-badge">' + inr(x.price) + '/-</span></div>' +
          '<div class="sp-card-body"><h3 class="sp-card-title">' + escapeHtml(it.title) + ' In ' + escapeHtml(city.name) + '</h3>' +
          '<div class="sp-price">' + TAG + '<s>' + inr(Math.round((x.price * 1.2) / 10) * 10) + '</s><strong>' + inr(x.price) + '</strong></div>' +
          '<ul class="sp-checks">' + checks + '</ul></div>' +
          '<div class="sp-actions"><button type="button" class="sp-btn sp-btn-add' + (added ? ' added' : '') + '" data-act="add">' + CART_SVG + '<span>' + (added ? 'Added ✓' : 'Add') + '</span></button>' +
          '<button type="button" class="sp-btn sp-btn-book" data-act="book">Book</button></div></article>';
      }).join('');
      list.querySelectorAll('.sp-card').forEach(function (card) {
        var x = svcs[+card.getAttribute('data-idx')];
        var it = cardItem(appl, type, x.svc, x.price);
        card.querySelector('[data-act="add"]').addEventListener('click', function () {
          if (inCart(it.key)) removeItem(it.key); else { addItem(it); toast('✅ ' + it.title + ' added'); }
          renderCards();
        });
        card.querySelector('[data-act="book"]').addEventListener('click', function () {
          addItem(it);
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
    var n = cart.items.length;
    bar.hidden = n === 0;
    $('spCardBarText').innerHTML = '<strong>' + n + (n === 1 ? ' service' : ' services') + '</strong> · ' + inr(cartTotal());
  }

  function goToForm() {
    $('spPickChange').hidden = false;
    $('spPickChange').textContent = 'Change';
    showStep('spStepForm');
    appliedCoupon = null; setMsg($('spCouponMsg'), '');
    prefillDetails();
    renderDates();
    afterItemsChange();
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
      cart = { cityId: city.id, items: [] }; // prices differ per city
      appliedCoupon = null; setMsg($('spCouponMsg'), '');
      prefillDetails();
      renderCards();
    };
  }

  function updatePickSummary() {
    var el = $('spPickSummary'); if (!el) return;
    el.innerHTML = cart.items.map(function (i) { return escapeHtml(i.title) + ' — <b>' + inr(i.price) + '</b>'; }).join('<br>') +
      '<small>📍 ' + escapeHtml(city.name || '') + '</small>';
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
    $('spItems').hidden = MODE === 'home';
    $('spAddMore').hidden = MODE === 'home';
    if (MODE === 'page') { setCity(city.id, city.name); $('spSheetTitle').textContent = 'Book Service'; }
    showStep(step);
    renderItems();
    prefillDetails();
    renderDates();
    $('spSheet').classList.add('open');
    $('spSheet').setAttribute('aria-hidden', 'false');
    document.body.classList.add('sp-sheet-open');
    refreshCartUi();
    setMsg($('spFormMsg'), '');
    checkBookingStatus();
    prewarmOtp();
  }
  function closeSheet() {
    var sheet = $('spSheet'); if (!sheet) return;
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sp-sheet-open');
    if (otpSession) otpSession.cancel();
    refreshCartUi();
  }
  function showStep(id) {
    ['spStepForm', 'spStepType', 'spStepOtp', 'spStepDone'].forEach(function (s) { $(s).hidden = s !== id; });
    if (id === 'spStepOtp') $('spSheetTitle').textContent = 'Verify mobile number';
    else if (id === 'spStepDone') $('spSheetTitle').textContent = '';
    else if (id === 'spStepType' && pick.appliance) $('spSheetTitle').textContent = pick.appliance.name + ' Service';
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
        if (!cart.items.length) { closeSheet(); return; }
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

  function prefillDetails() {
    var acc = getAccount();
    var sameCity = acc && (!acc.cityId || acc.cityId === city.id);
    if (acc && acc.name && /^[0-9]{10}$/.test(acc.phone || '') && acc.address && sameCity) {
      $('spName').value = acc.name; $('spPhone').value = acc.phone; $('spAddress').value = acc.address;
      $('spSavedName').textContent = acc.name;
      $('spSavedPhone').textContent = acc.phone;
      $('spSavedAddr').textContent = acc.address;
      $('spSaved').hidden = false;
      $('spDetailFields').hidden = true;
    } else {
      if (acc) {
        if (!$('spName').value) $('spName').value = acc.name || '';
        if (!$('spPhone').value) $('spPhone').value = acc.phone || '';
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
    selectDate(valid ? selectedDate : istDate(0), !valid);
  }
  function selectDate(iso, autoAdvance) {
    selectedDate = iso;
    $('spDates').querySelectorAll('.sp-chip').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-date') === iso); });
    loadSlots(autoAdvance);
  }

  var slotReq = 0;
  function loadSlots(autoAdvance) {
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
        if (!selectedSlot) { var first = slots.find(function (s) { return s.available; }); if (first) selectedSlot = first.id; }
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

  function verifyWithOtp(phone) {
    return new Promise(function (resolve, reject) {
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
        unlockAudio();
        var b = $('spOtpVerify'); b.disabled = true; b.textContent = 'Verifying…';
        window.verifyOtp(code, function (data) {
          b.disabled = false; b.textContent = 'Verify & Book';
          var token = data && (data.message || data.token || data['access-token']);
          if (token) finish(true, token); else setMsg(msg, 'Verification failed. Please try again.', 'error');
        }, function () {
          b.disabled = false; b.textContent = 'Verify & Book';
          setMsg(msg, 'Incorrect or expired code. Please try again.', 'error');
        });
      }
      function onResend() {
        var b = $('spOtpResend'); b.disabled = true; b.textContent = 'Resending…';
        window.retryOtp(null, function () { b.disabled = false; b.textContent = 'Resend code'; setMsg(msg, 'A new code has been sent.', 'success'); },
          function (e) { b.disabled = false; b.textContent = 'Resend code'; setMsg(msg, 'Could not resend: ' + errText(e), 'error'); });
      }
      function onBack() { finish(false, Object.assign(new Error('cancelled'), { cancelled: true })); }
      otpSession = { cancel: onBack };
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
    return { name: $('spName').value.trim(), phone: $('spPhone').value.replace(/\D/g, '').slice(-10), address: $('spAddress').value.trim() };
  }
  function validate(d) {
    if (!city.id) return 'Please choose your city.';
    if (!cart.items.length) return 'Please choose a service first.';
    if (!d.name) return 'Please enter your name.';
    if (!/^[0-9]{10}$/.test(d.phone)) return 'Please enter a valid 10 digit mobile number.';
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

  function submitBooking(d, accessToken) {
    $('spConfirm').textContent = 'Booking…';
    var ref = null; try { ref = sessionStorage.getItem(REF_KEY); } catch (e) { /* ignore */ }
    var payload = {
      name: d.name, phone: d.phone, address: d.address, cityId: city.id,
      bookingDate: selectedDate, timeSlotId: selectedSlot,
      accessToken: accessToken || undefined,
      couponCode: appliedCoupon ? appliedCoupon.code : undefined,
      referralCode: ref || undefined,
      items: cart.items.map(function (i) {
        var generic = i.skuId === 'svc-service' || i.skuId === 'svc-repair';
        return { applianceId: i.applianceId, typeId: i.typeId, serviceType: i.serviceType, qty: 1, skuId: i.skuId, problem: generic ? '' : i.skuName + ' requested.' };
      })
    };
    return postJSON('/api/bookings', payload).then(function (res) {
      var b = res.booking || {};
      saveAccount({ phone: d.phone, name: d.name, address: d.address, cityId: city.id, accessToken: null });
      postJSON('/api/customer-profile', { phone: d.phone, name: d.name, address: d.address, cityId: city.id }).catch(function () {});
      try { sessionStorage.removeItem(REF_KEY); } catch (e) { /* ignore */ }
      cart = { cityId: city.id, items: [] }; writeCart(); refreshCartUi();
      appliedCoupon = null; $('spCoupon').value = ''; setMsg($('spCouponMsg'), '');
      $('spDoneId').textContent = b.id || '—';
      $('spDoneWhen').textContent = (b.bookingDate || selectedDate) + ' · ' + (b.timeSlot || '') + ' · Total ' + inr(b.totalPrice);
      showStep('spStepDone');
      celebrate();
      if (typeof window.gtag === 'function') { try { window.gtag('event', 'purchase', { value: b.totalPrice, currency: 'INR', transaction_id: b.id }); } catch (e) { /* ignore */ } }
    }).catch(function (e) {
      if (e.status === 409) loadSlots(false);
      if (/verify your mobile/i.test(e.message || '') && !accessToken) {
        return verifyWithOtp(d.phone).then(function (t) { showStep('spStepForm'); return submitBooking(d, t); });
      }
      throw e;
    });
  }

  // ------------------------------------------------------------------ wiring
  var bound = false;
  function bindOnce() {
    if (bound) return; bound = true;
    $('spSheetClose').addEventListener('click', closeSheet);
    $('spDoneClose').addEventListener('click', closeSheet);
    $('spSheet').addEventListener('click', function (e) { if (e.target === $('spSheet')) closeSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('spSheet').classList.contains('open')) closeSheet(); });
    $('spAddMore').addEventListener('click', function () { closeSheet(); var s = $('services'); if (s) s.scrollIntoView({ behavior: 'smooth' }); });
    $('spPickChange').addEventListener('click', function () { if (pick.appliance) showTypeStep(); });
    $('spCardBarBtn').addEventListener('click', function () { if (cart.items.length) goToForm(); });
    $('spEditDetails').addEventListener('click', function () { $('spSaved').hidden = true; $('spDetailFields').hidden = false; $('spName').focus(); });
    $('spConfirm').addEventListener('click', onConfirm);
    $('spPhone').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 10); });
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

  if (MODE === 'page') {
    ensureMarkup(); bindOnce();
    var cb = $('spCartBarBtn'); if (cb) cb.addEventListener('click', openSheet);
    var hc = $('spHeaderCart'); if (hc) hc.addEventListener('click', openSheet);
    var nc = $('bottomNavCartBtn'); if (nc) nc.addEventListener('click', openSheet);
    refreshCartUi();
  } else {
    // Homepage: every appliance tile (photo, name or "Book Now") opens the
    // popup with that appliance pre-selected, instead of the old multi-step
    // flow. The tile's <a href> stays in the HTML for Google.
    window.openApplianceBoxesPanel = function (id) { openForAppliance(id); };
    document.addEventListener('click', function (e) {
      var link = e.target.closest && e.target.closest('#servicesGrid .service-card-link');
      if (!link) return;
      var card = link.closest('.service-card');
      var id = card && card.getAttribute('data-appliance');
      if (!id) return;
      e.preventDefault();
      openForAppliance(id);
    });
  }
  window.SeeruaBooking = { openForAppliance: openForAppliance, open: openSheet, close: closeSheet };

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
