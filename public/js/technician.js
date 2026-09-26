// ------------------------------------------------------------------
// Seerua Appliance Care — Technician Panel logic
// ------------------------------------------------------------------
let ORDERS = [];
let CURRENT_TECH = null;
let PHOTO_UPLOAD_DISABLED = false; // fetched once at login — see checkLogin()
let GOOGLE_REVIEW_URL = null; // Admin's verified Google Business profile link (Admin Panel > Site Rating) — null until loaded, or if Admin hasn't set one up

// SECURITY: customer-supplied text (name, address, problem description)
// must be escaped before going into innerHTML, or a booking made with a
// malicious name/address could run JS in the technician's logged-in app.
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// "Today" in India (IST) as YYYY-MM-DD — toISOString() is UTC, which is
// still yesterday between midnight and 5:30 AM IST.
function istToday() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
}

// SUGGESTION IMPLEMENTED: amounts were shown as plain digits (₹125000)
// with no thousands separator, hard to read at a glance. This formats
// them the Indian way (₹1,25,000) everywhere a ₹ amount is displayed.
function fmtInr(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Shows the customer's number partially hidden (privacy) but still tappable
// to call directly — the full number is only ever used in the tel: link,
// never shown as plain text on screen.
function maskPhone(phone) {
  const p = String(phone || '');
  if (!/^[0-9]{10}$/.test(p)) return p; // unexpected format — show as-is rather than mangle it
  return `${p.slice(0, 2)}••••••${p.slice(-2)}`;
}
function phoneLink(phone) {
  const p = String(phone || '');
  const digits = p.replace(/\D/g, '');
  const tel = digits.length === 10 ? `+91${digits}` : digits;
  return `<a href="tel:${tel}" class="phone-link" title="Tap to call">📞 ${maskPhone(p)}</a>`;
}

// Shows a local date/time — e.g. "15 Aug, 2:30 pm".
function formatAssignedAt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

async function checkLogin() {
  const data = await api('/api/technician/check');
  if (data.loggedIn) {
    CURRENT_TECH = data.technician;
    document.getElementById('loginWrap').style.display = 'none';
    document.getElementById('appShell').classList.add('active');
    document.getElementById('whoAmI').textContent = `Hello, ${CURRENT_TECH.name}`;
    // ADDED: fetched once here so setProgress()'s completion-photo check
    // (below) knows whether the admin has turned photo uploads off —
    // without this, the requirement stayed hardcoded on client-side even
    // after the toggle was switched off, making it impossible to ever
    // mark a job complete while photos were disabled.
    try {
      const toggleData = await api('/api/technician/photo-toggle');
      PHOTO_UPLOAD_DISABLED = !!toggleData.technicianPhotoUploadDisabled;
    } catch (e) { /* default false is a safe fallback either way */ }
    await Promise.all([loadOrders(true), loadGoogleReviewUrl()]);
    switchView('orders');
    sendHeartbeat();
    startAlertPolling();
    if (Notification && Notification.permission === 'granted') {
      document.getElementById('enableAlertsBtn').textContent = '🔔 On';
    }
  } else {
    document.getElementById('loginWrap').style.display = 'flex';
    document.getElementById('appShell').classList.remove('active');
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  try {
    await api('/api/technician/login', {
      method: 'POST',
      body: JSON.stringify({
        phone: document.getElementById('techPhoneLogin').value,
        password: document.getElementById('techPassLogin').value
      })
    });
    await checkLogin();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  // BUG FIX: if the logout API call ever failed for any reason (network
  // hiccup, session already gone, etc.), the button did nothing visible
  // at all — no error, no reload, nothing — which looked exactly like a
  // broken button. Now it always gets the technician back to the login
  // screen either way, and only surfaces an error if the reload itself
  // somehow doesn't happen.
  try {
    await api('/api/technician/logout', { method: 'POST' });
  } catch (err) {
    console.log('Logout API call failed, reloading anyway:', err.message);
  }
  location.reload();
});

document.getElementById('sideNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) switchView(btn.getAttribute('data-view'));
});

function switchView(view) {
  document.querySelectorAll('.panel-view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('#sideNav button').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === view));
  if (view === 'orders') renderOrders();
  if (view === 'reports') renderReport();
  if (view === 'rating') renderMyRating();
}

async function loadOrders(isFirstLoad) {
  const previousAssignedIds = new Set(
    ORDERS.filter(o => o.itemStatus === 'assigned').map(o => o.taskId)
  );
  const before = JSON.stringify(ORDERS);
  ORDERS = await api('/api/technician/orders');

  if (!isFirstLoad) {
    const newlyAssigned = ORDERS.filter(o => o.itemStatus === 'assigned' && !previousAssignedIds.has(o.taskId));
    newlyAssigned.forEach(o => notifyNewJob(o));
    // something changed at the office (reassigned, cancelled…) — refresh the
    // list, but not while the technician is typing a note
    const typing = document.activeElement && /^report-/.test(document.activeElement.id || '');
    if (!newlyAssigned.length && before !== JSON.stringify(ORDERS) && !typing) renderOrders();
  }
}

// Same public, no-login-needed endpoint the homepage uses for its Google
// rating badge — reused here just to read the Admin-verified profile link
// (Admin Panel > Site Rating). Stays null if Admin hasn't turned it on.
async function loadGoogleReviewUrl() {
  try {
    const stats = await api('/api/stats/public');
    GOOGLE_REVIEW_URL = (stats.googleRating && stats.googleRating.profileUrl) || null;
  } catch (e) {
    GOOGLE_REVIEW_URL = null;
  }
}

// ---------------- Job alert (beep + browser notification) ----------------
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.55);
    // second beep
    setTimeout(() => {
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = 1046;
      gain2.gain.setValueAtTime(0.001, ctx.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start();
      osc2.stop(ctx.currentTime + 0.45);
    }, 250);
  } catch (e) { /* audio not available, ignore */ }
}

function notifyNewJob(order) {
  playBeep();
  JOB_TAB = 'new';
  if (window.Notification && Notification.permission === 'granted') {
    new Notification('New job assigned!', {
      body: `${order.qty}x ${order.applianceName} (${order.typeName}) — ${order.cityName}`,
      icon: '/images/logo.png'
    });
  }
  renderOrders();
}

document.getElementById('enableAlertsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('enableAlertsBtn');
  if (!window.Notification) {
    alert('Your browser does not support notifications, but the sound alert will still work while this page is open.');
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    btn.textContent = '🔔 On';
    playBeep();
  } else {
    btn.textContent = '🔕 Blocked';
  }
});

// Tells the server "I'm still here" — this is what powers the Online/Offline
// indicator Admin sees in the Technicians list and Assign Technician picker.
// Failures are silent (e.g. a brief network hiccup) since this just affects
// a status badge, never the technician's actual job data.
async function sendHeartbeat() {
  try { await api('/api/technician/heartbeat', { method: 'PUT' }); } catch (e) { /* ignore */ }
}

let alertPollTimer = null;
function startAlertPolling() {
  if (alertPollTimer) return;
  // Checks for newly assigned jobs every 25 seconds while the panel is open,
  // and piggybacks the online heartbeat on the same tick.
  alertPollTimer = setInterval(() => { loadOrders(false); sendHeartbeat(); }, 25000);
}

// ---------------- JOBS (simple mobile layout) ----------------
// Three tabs: New (just assigned — accept or turn down), Active (accepted /
// in progress, soonest visit first), Done (latest first).
let JOB_TAB = null;
const TAB_OF = { assigned: 'new', accepted: 'active', 'in-progress': 'active', completed: 'done' };

function slotStartHour(slot) {
  const m = String(slot || '').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return 0;
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  return h + (Number(m[2]) || 0) / 60;
}
function visitKey(o) { return `${o.bookingDate || '9999-12-31'}_${slotStartHour(o.timeSlot).toFixed(2).padStart(5, '0')}`; }
function niceVisit(o) {
  if (!o.bookingDate) return { text: 'Visit time not set', today: false };
  const today = istToday();
  const tmr = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const d = new Date(o.bookingDate + 'T00:00:00Z');
  const dm = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const day = o.bookingDate === today ? `Today, ${dm}` : o.bookingDate === tmr ? `Tomorrow, ${dm}` : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { text: `${day}${o.timeSlot ? ' · ' + String(o.timeSlot).replace(' - ', ' – ') : ''}`, today: o.bookingDate <= today };
}
function mapLink(o) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${o.address || ''}, ${o.cityName || ''}`)}`; }
function waLink(o) {
  const p = String(o.phone || '').replace(/\D/g, '');
  const me = CURRENT_TECH ? CURRENT_TECH.name : 'your technician';
  const msg = `Hello ${o.name}, this is ${me} from Seerua Appliance Care. I'm coming for your ${o.applianceName} ${o.serviceName || (o.serviceType === 'repair' ? 'repair' : 'service')}.`;
  return `https://wa.me/${p.length === 10 ? '91' + p : p}?text=${encodeURIComponent(msg)}`;
}
function collectHtml(o) {
  const parts = o.serviceType === 'repair' || /repair|gas/i.test(o.serviceName || '');
  let amount = Number(o.lineTotal) || 0;
  let note = '';
  if (o.bookingDiscount > 0) {
    if (o.bookingItemCount <= 1) { amount = Math.max(0, amount - o.bookingDiscount); note = `₹${fmtInr(o.bookingDiscount)} coupon already taken off.`; }
    else note = `This booking has a ₹${fmtInr(o.bookingDiscount)} coupon on the full bill (total ₹${fmtInr(o.bookingTotal)}).`;
  }
  return `<div class="job-money">Collect <b>₹${fmtInr(amount)}</b>${parts ? ' + parts (only if customer agrees)' : ''}${note ? `<small>${esc(note)}</small>` : ''}</div>`;
}

// Completion photo + note survive a page refresh / app switch (kept per job on this phone).
const PHOTO_KEY = 'seerua_tech_photos_v1';
function loadPendingPhotos() { try { return JSON.parse(localStorage.getItem(PHOTO_KEY) || '{}') || {}; } catch (e) { return {}; } }
function savePendingPhotos() { try { localStorage.setItem(PHOTO_KEY, JSON.stringify(pendingCompletionPhotos)); } catch (e) { /* ignore */ } }
const NOTE_KEY = 'seerua_tech_notes_v1';
function loadNotes() { try { return JSON.parse(localStorage.getItem(NOTE_KEY) || '{}') || {}; } catch (e) { return {}; } }
function saveNote(taskId, val) { const n = loadNotes(); if (val) n[taskId] = val; else delete n[taskId]; try { localStorage.setItem(NOTE_KEY, JSON.stringify(n)); } catch (e) { /* ignore */ } }

function jobCardHtml(o) {
  const v = niceVisit(o);
  const stLabel = { assigned: 'New job', accepted: 'Accepted', 'in-progress': 'Working', completed: 'Done' }[o.itemStatus] || o.itemStatus;
  const svc = [o.typeName, o.serviceName || (o.serviceType === 'repair' ? 'Repair' : 'Service')].filter(Boolean).join(' · ');
  const photo = pendingCompletionPhotos[o.taskId] || o.completionPhotoUrl || '';
  const notes = loadNotes();
  const tel = String(o.phone || '').replace(/\D/g, '').slice(-10);
  const contact = o.itemStatus !== 'completed' ? `
      <div class="job-contact">
        <a class="call" href="tel:+91${esc(tel)}">📞 Call</a>
        <a href="${esc(mapLink(o))}" target="_blank" rel="noopener">🗺️ Map</a>
        <a class="wa" href="${esc(waLink(o))}" target="_blank" rel="noopener">💬 WhatsApp</a>
      </div>` : '';
  let steps = '';
  if (o.itemStatus === 'assigned') {
    steps = `
      <button class="big-btn green" onclick="acceptOrder('${o.bookingId}','${o.itemId}')">✓ Accept job</button>
      <button class="link-btn" onclick="rejectOrder('${o.bookingId}','${o.itemId}')">I can't do this job</button>`;
  } else if (o.itemStatus === 'accepted') {
    steps = `
      <button class="big-btn" onclick="setProgress('${o.bookingId}','${o.itemId}', 'in-progress')">▶ Start job — I have reached</button>
      <button class="link-btn" onclick="rejectOrder('${o.bookingId}','${o.itemId}')">I can't do this job</button>`;
  } else if (o.itemStatus === 'in-progress') {
    const needPhoto = !PHOTO_UPLOAD_DISABLED;
    steps = `
      ${needPhoto ? `
      <div class="step-lbl">Step 1 · Photo of finished work</div>
      <label class="big-btn ghost ${photo ? 'ok' : ''}" style="margin-top:6px;">
        <span id="photoLabel-${o.taskId}">${photo ? '✓ Photo added — tap to change' : '📷 Take photo'}</span>
        <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="uploadCompletionPhoto('${o.bookingId}','${o.itemId}', this)">
      </label>
      ${photo ? `<img class="photo-thumb" src="${esc(photo)}" alt="Work photo">` : ''}` : ''}
      <div class="step-lbl">${needPhoto ? 'Step 2 · ' : ''}What did you do? (optional)</div>
      <textarea id="report-${o.taskId}" placeholder="e.g. Gas filled, capacitor changed ₹350" oninput="saveNote('${o.taskId}', this.value)">${esc(notes[o.taskId] != null ? notes[o.taskId] : (o.technicianReport || ''))}</textarea>
      <button class="big-btn green" ${needPhoto && !photo ? 'disabled' : ''} onclick="setProgress('${o.bookingId}','${o.itemId}', 'completed')">✓ Job complete</button>
      ${needPhoto && !photo ? '<div class="job-warn">Add the photo first, then tap Job complete.</div>' : ''}`;
  } else if (o.itemStatus === 'completed') {
    steps = `
      <div class="job-done">✅ Completed${o.completedAt ? ' · ' + esc(formatAssignedAt(o.completedAt)) : ''}</div>
      ${o.technicianReport ? `<div class="job-note">📝 ${esc(o.technicianReport)}</div>` : ''}
      ${o.completionPhotoUrl ? `<div class="job-note"><a href="${esc(o.completionPhotoUrl)}" target="_blank" rel="noopener">📷 Work photo</a></div>` : ''}
      ${GOOGLE_REVIEW_URL ? `<button class="big-btn ghost" onclick="sendGoogleReviewLink('${o.bookingId}','${o.itemId}')">⭐ Ask for Google review (WhatsApp)</button>` : ''}`;
  }
  return `
    <div class="job st-${o.itemStatus}">
      <div class="job-when"><span class="${v.today && o.itemStatus !== 'completed' ? 'today' : ''}">📅 ${esc(v.text)}</span><span class="job-st ${o.itemStatus}">${stLabel}</span></div>
      <h3>${o.qty > 1 ? o.qty + '× ' : ''}${esc(o.applianceName)}</h3>
      <div class="job-svc">${esc(svc)}</div>
      <div class="job-line">👤 ${esc(o.name)}</div>
      <div class="job-line">📍 ${esc(o.address)}, ${esc(o.cityName)}</div>
      ${o.problem ? `<div class="job-problem">🗣️ Customer says: "${esc(o.problem)}"</div>` : ''}
      ${o.photoUrl ? `<div class="job-line"><a href="${esc(o.photoUrl)}" target="_blank" rel="noopener">📷 Customer's photo</a></div>` : ''}
      ${o.itemStatus !== 'completed' ? collectHtml(o) : `<div class="job-line">💰 ₹${fmtInr(o.lineTotal)}</div>`}
      ${contact}
      ${steps}
    </div>`;
}

function renderOrders() {
  const groups = { new: [], active: [], done: [] };
  ORDERS.forEach(o => { const t = TAB_OF[o.itemStatus]; if (t) groups[t].push(o); });
  groups.new.sort((a, b) => visitKey(a).localeCompare(visitKey(b)));
  groups.active.sort((a, b) => visitKey(a).localeCompare(visitKey(b)));
  groups.done.sort((a, b) => String(b.completedAt || b.updatedAt || '').localeCompare(String(a.completedAt || a.updatedAt || '')));
  if (!JOB_TAB) { try { JOB_TAB = sessionStorage.getItem('seerua_tech_tab'); } catch (e) { /* ignore */ } }
  // a job already being worked on always wins; otherwise new jobs first
  if (!JOB_TAB) JOB_TAB = groups.active.some(o => o.itemStatus === 'in-progress') ? 'active' : (groups.new.length ? 'new' : 'active');
  try { sessionStorage.setItem('seerua_tech_tab', JOB_TAB); } catch (e) { /* ignore */ }
  document.getElementById('nNew').textContent = groups.new.length;
  document.getElementById('nActive').textContent = groups.active.length;
  document.getElementById('nDone').textContent = groups.done.length;
  document.querySelectorAll('#jobTabs button').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === JOB_TAB);
    b.classList.toggle('has-new', b.getAttribute('data-tab') === 'new' && groups.new.length > 0);
  });
  const list = JOB_TAB === 'done' ? groups.done.slice(0, 40) : groups[JOB_TAB];
  const wrap = document.getElementById('ordersList');
  const focusedId = document.activeElement && document.activeElement.id;
  if (!list.length) {
    const msg = { new: 'No new jobs right now. 🔔 You will hear a beep when one comes.', active: 'No active jobs. Accept a job from the "New" tab.', done: 'No completed jobs yet.' }[JOB_TAB];
    wrap.innerHTML = `<div class="tp-empty">${msg}</div>`;
    return;
  }
  wrap.innerHTML = list.map(jobCardHtml).join('');
  if (focusedId && focusedId.startsWith('report-')) { const t = document.getElementById(focusedId); if (t) { t.focus(); t.selectionStart = t.selectionEnd = t.value.length; } }
}
document.getElementById('jobTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  JOB_TAB = b.getAttribute('data-tab');
  renderOrders();
  window.scrollTo(0, 0);
});

async function acceptOrder(bookingId, itemId) {
  try {
    await api(`/api/technician/orders/${bookingId}/items/${itemId}/accept`, { method: 'PUT' });
    await loadOrders();
    JOB_TAB = 'active';
    renderOrders();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}
async function rejectOrder(bookingId, itemId) {
  if (!confirm("Turn down this job? The office will give it to another technician.")) return;
  try {
    await api(`/api/technician/orders/${bookingId}/items/${itemId}/reject`, { method: 'PUT' });
    await loadOrders(); renderOrders();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}
// Per-task cache of the uploaded completion photo URL, keyed by
// "bookingId__itemId" — filled in by uploadCompletionPhoto() below, read
// by setProgress() when the technician actually taps "Mark as Completed".
// Cleared implicitly whenever loadOrders()/renderOrders() re-fetches from
// the server (a fresh render always reflects o.completionPhotoUrl instead).
const pendingCompletionPhotos = loadPendingPhotos();

async function uploadCompletionPhoto(bookingId, itemId, inputEl) {
  const taskId = `${bookingId}__${itemId}`;
  const label = document.getElementById(`photoLabel-${taskId}`);
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  if (label) label.textContent = 'Uploading...';
  try {
    const formData = new FormData();
    formData.append('photo', file);
    const res = await fetch('/api/technician/upload-completion-photo', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    pendingCompletionPhotos[taskId] = data.url;
    savePendingPhotos();
    renderOrders();
  } catch (e) {
    if (label) label.textContent = '📷 Take photo';
    alert(e.message || 'Could not upload photo. Please try again.');
  }
}

// Brief success overlay (checkmark + sound + "Complete" text) shown
// right after a job is successfully marked completed — see setProgress()
// below. Sound is a short, simple generated tone (Web Audio API) rather
// than an audio file, so there's nothing extra to load/host.
function showCompleteSuccessOverlay() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
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
    }
  } catch (e) { /* Web Audio not available/blocked — the visual overlay alone is still shown */ }
  const overlay = document.getElementById('completeSuccessOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  setTimeout(() => { overlay.style.display = 'none'; }, 1400);
}

async function setProgress(bookingId, itemId, status) {
  const taskId = `${bookingId}__${itemId}`;
  const reportEl = document.getElementById(`report-${taskId}`);
  const report = reportEl ? reportEl.value : undefined;
  const body = { status, report };
  // SUGGESTION IMPLEMENTED: a completion photo is required before a job
  // can be marked done — see the matching check in server.js. Checked
  // here too (not just server-side) so the technician gets an immediate,
  // clear nudge instead of a generic failed-request error.
  // BUG FIX: this stayed required even after the admin turned photo
  // uploads off — which, since uploading was also blocked, made it
  // impossible to ever complete a job. Skipped when uploads are off.
  if (status === 'completed' && !PHOTO_UPLOAD_DISABLED) {
    if (!pendingCompletionPhotos[taskId]) {
      alert('Please take a photo of the finished work first.');
      return;
    }
    body.completionPhotoUrl = pendingCompletionPhotos[taskId];
  }
  if (status === 'completed' && !confirm('Mark this job as complete?')) return;
  try {
    await api(`/api/technician/orders/${bookingId}/items/${itemId}/progress`, { method: 'PUT', body: JSON.stringify(body) });
    if (status === 'completed') {
      delete pendingCompletionPhotos[taskId];
      savePendingPhotos();
      saveNote(taskId, '');
      showCompleteSuccessOverlay();
    }
  } catch (e) {
    alert(e.message || 'Could not update this job. Please try again.');
    return;
  }
  await loadOrders(); renderOrders();
}
async function saveReport(bookingId, itemId) {
  try {
    const taskId = `${bookingId}__${itemId}`;
    const report = document.getElementById(`report-${taskId}`).value;
    await api(`/api/technician/orders/${bookingId}/items/${itemId}/progress`, { method: 'PUT', body: JSON.stringify({ report }) });
    await loadOrders(); renderOrders();
    alert('Report saved successfully!');

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// Opens WhatsApp (app or web) with a ready-to-send message to the customer,
// pre-filled with the Admin-verified Google review link — the technician
// just has to hit Send. No SMS/WhatsApp Business API setup needed, this
// goes out from the technician's own WhatsApp.
function sendGoogleReviewLink(bookingId, itemId) {
  const o = ORDERS.find(x => x.bookingId === bookingId && x.itemId === itemId);
  if (!o) return;
  if (!GOOGLE_REVIEW_URL) {
    alert("Google review link isn't set up yet — ask Admin to add it in Admin Panel > Site Rating.");
    return;
  }
  // The technician only ever sees the masked number, here and on the order
  // card — the full number is used only internally to open WhatsApp.
  if (!confirm(`Send the Google review link to ${o.name} on WhatsApp?`)) return;
  const message = `Hi ${o.name}, thank you for choosing Seerua Appliance Care! We hope you're happy with the ${o.applianceName} ${o.serviceType === 'repair' ? 'repair' : 'service'}. If you have a moment, it would really help us if you could share a quick review on Google: ${GOOGLE_REVIEW_URL}`;
  const waPhone = /^[0-9]{10}$/.test(o.phone) ? `91${o.phone}` : o.phone;
  window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`, '_blank');
}

async function renderReport() {
  const dateInput = document.getElementById('techReportDate');
  if (!dateInput.value) dateInput.value = istToday();
  document.getElementById('techExportBtn').href = `/api/technician/reports/daily/export?date=${dateInput.value}`;
  const data = await api(`/api/technician/reports/daily?date=${dateInput.value}`);
  document.getElementById('techReportStats').innerHTML = `
    <div class="tp-stat"><div class="v">${data.completedToday}</div><div class="l">Jobs completed</div></div>
    <div class="tp-stat"><div class="v">${data.totalAssigned}</div><div class="l">Jobs given</div></div>
    <div class="tp-stat"><div class="v">₹${fmtInr(data.earningsToday)}</div><div class="l">Work done (₹)</div></div>
    <div class="tp-stat"><div class="v">₹${fmtInr(data.commissionOwedToday)}</div><div class="l">Commission to pay</div></div>
  `;
  const stName = { assigned: 'New', accepted: 'Accepted', 'in-progress': 'Working', completed: 'Done', pending: 'Pending', cancelled: 'Cancelled' };
  document.getElementById('techReportTable').innerHTML = data.orders.length ? data.orders.map(o => `
    <div class="tp-row">
      <div><b>${esc(o.name)}</b> · ${o.qty > 1 ? o.qty + '× ' : ''}${esc(o.applianceName)}<br><small>${stName[o.itemStatus] || esc(o.itemStatus)} · ₹${fmtInr(o.lineTotal)}${o.itemStatus === 'completed' ? ` · commission ₹${fmtInr(o.commission)}${o.reviewVerifiedByStaff ? ' (waived ✓)' : (o.reviewBrought ? ' (waiting for office)' : '')}` : ''}</small></div>
      ${o.itemStatus === 'completed' ? `
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;cursor:pointer;white-space:nowrap;">
          <input type="checkbox" ${o.reviewBrought ? 'checked' : ''} onchange="toggleReviewBrought('${o.bookingId}','${o.id}',this.checked)">
          Got Google review
        </label>` : ''}
    </div>
  `).join('') : `<div class="tp-muted">No work on this day.</div>`;
}
document.getElementById('techReportDate').addEventListener('change', renderReport);

// Technician self-reports (per completed order) that they got a Google
// review from that customer — waives their commission for that one order.
async function toggleReviewBrought(bookingId, itemId, checked) {
  try {
    await api(`/api/technician/orders/${bookingId}/items/${itemId}/review-brought`, {
      method: 'PUT',
      body: JSON.stringify({ reviewBrought: checked })
    });
    await renderReport();
  } catch (e) {
    alert(e.message || 'Could not update. Please try again.');
    await renderReport();
  }
}

async function renderMyRating() {
  const stats = await api('/api/technician/stats');
  document.getElementById('techRatingStats').innerHTML = `
    <div class="tp-stat"><div class="v">${stats.avgRating ? `⭐ ${stats.avgRating}` : '—'}</div><div class="l">My rating</div></div>
    <div class="tp-stat"><div class="v">${stats.completedJobs}</div><div class="l">Jobs completed</div></div>
    <div class="tp-stat"><div class="v">${stats.rejectedJobs}</div><div class="l">Jobs turned down</div></div>
    <div class="tp-stat"><div class="v">₹${fmtInr(stats.totalEarningsGenerated)}</div><div class="l">Total work (₹)</div></div>
  `;
  const rateLabel = stats.variableAmountMode === 'percent' ? `${stats.variableAmount}%` : `₹${fmtInr(stats.variableAmount)}`;
  document.getElementById('techEarningsStats').innerHTML = `
    <div class="tp-stat"><div class="v">₹${fmtInr(stats.technicianEarning)}</div><div class="l">My earning</div></div>
    <div class="tp-stat"><div class="v">₹${fmtInr(stats.adminCommission)}</div><div class="l">Commission</div></div>
    <div class="tp-stat"><div class="v">${stats.variableAmount !== null ? rateLabel : 'Standard'}</div><div class="l">Commission rate</div></div>
    <div class="tp-stat"><div class="v">${stats.googleReviewJobs} / ${stats.completedJobs}</div><div class="l">Jobs with Google review</div></div>
  `;
  document.getElementById('techEarningsNote').textContent = stats.adminCommission > 0
    ? 'Tip: ask every customer for a Google review. Once the office confirms it, you pay no commission on that job.'
    : 'Your commission is ₹0 — you keep 100% of every job.';
  const appliances = Object.keys(stats.applianceBreakdown || {});
  document.getElementById('techRatingByApplianceTable').innerHTML = appliances.length ? appliances.map(id => {
    const a = stats.applianceBreakdown[id];
    return `<div class="tp-row"><div><b>${esc(a.applianceName)}</b><br><small>${a.completedJobs} jobs · ${a.ratingCount} rated</small></div><div><b>${a.avgRating ? '⭐ ' + a.avgRating : '—'}</b></div></div>`;
  }).join('') : '<div class="tp-muted">No completed jobs yet.</div>';
}

checkLogin();
