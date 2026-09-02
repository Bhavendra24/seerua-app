// ------------------------------------------------------------------
// Seerua Appliance Care — Technician Panel logic
// ------------------------------------------------------------------
let ORDERS = [];
let CURRENT_TECH = null;
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
    document.getElementById('whoAmI').textContent = `Logged in as ${CURRENT_TECH.name}`;
    await Promise.all([loadOrders(true), loadGoogleReviewUrl()]);
    switchView('orders');
    sendHeartbeat();
    startAlertPolling();
    if (Notification && Notification.permission === 'granted') {
      document.getElementById('enableAlertsBtn').textContent = '🔔 Alerts On';
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
  await api('/api/technician/logout', { method: 'POST' });
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
  ORDERS = await api('/api/technician/orders');

  if (!isFirstLoad) {
    const newlyAssigned = ORDERS.filter(o => o.itemStatus === 'assigned' && !previousAssignedIds.has(o.taskId));
    newlyAssigned.forEach(o => notifyNewJob(o));
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
    btn.textContent = '🔔 Alerts On';
    playBeep();
  } else {
    btn.textContent = '🔕 Alerts Blocked';
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

function renderOrders() {
  const filter = document.getElementById('techOrderFilter').value;
  let list = ORDERS;
  if (filter) list = list.filter(o => o.itemStatus === filter);
  list = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const wrap = document.getElementById('ordersList');
  if (!list.length) {
    wrap.innerHTML = `<div class="card" style="text-align:center;color:var(--slate);">No orders found.</div>`;
    return;
  }

  wrap.innerHTML = list.map(o => `
    <div class="order-card">
      <div class="top-row">
        <div>
          <h4>${o.qty}x ${o.applianceName} (${o.typeName}) <span class="pill pill-${o.itemStatus}">${o.itemStatus.replace('-', ' ')}</span></h4>
          <div class="meta">👤 ${esc(o.name)} · ${phoneLink(o.phone)}</div>
          <div class="meta">📍 ${esc(o.address)}, ${esc(o.cityName)}</div>
          <div class="meta">🛠️ ${o.serviceType === 'repair' ? 'Repair' : 'Service'}${o.problem ? `: ${esc(o.problem)}` : ''}</div>
          ${o.photoUrl ? `<div class="meta"><a href="${o.photoUrl}" target="_blank" rel="noopener">📷 View customer's photo</a></div>` : ''}
          <div class="meta">💰 Visit Charge: ₹${fmtInr(o.lineTotal)} ${o.timeSlot ? `· 🕐 ${esc(o.bookingDate)} · ${esc(o.timeSlot)}` : ''}</div>
          ${o.rejectionHistory && o.rejectionHistory.length ? `<div class="meta" style="color:var(--red);">⚠️ Earlier turned down by: ${o.rejectionHistory.map(r => `${r.technicianName} (${formatAssignedAt(r.rejectedAt)})`).join(', ')}</div>` : ''}
        </div>
      </div>

      ${o.itemStatus === 'assigned' ? `
        <div class="actions">
          <button class="btn btn-success btn-sm" onclick="acceptOrder('${o.bookingId}','${o.itemId}')">Accept</button>
          <button class="btn btn-danger btn-sm" onclick="rejectOrder('${o.bookingId}','${o.itemId}')">Reject</button>
        </div>
      ` : ''}

      ${o.itemStatus === 'accepted' ? `
        <div class="actions">
          <button class="btn btn-outline btn-sm" onclick="setProgress('${o.bookingId}','${o.itemId}', 'in-progress')">Start Job</button>
        </div>
      ` : ''}

      ${o.itemStatus === 'in-progress' ? `
        <textarea id="report-${o.taskId}" placeholder="Progress report (e.g. gas refill done, part replaced, etc.)">${o.technicianReport || ''}</textarea>
        <div class="meta" style="margin-top:8px;">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--blue-600);font-weight:600;">
            📷 <span id="photoLabel-${o.taskId}">${o.completionPhotoUrl ? 'Photo attached ✓ — tap to replace' : 'Add photo of completed work (required)'}</span>
            <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="uploadCompletionPhoto('${o.bookingId}','${o.itemId}', this)">
          </label>
        </div>
        <div class="actions">
          <button class="btn btn-outline btn-sm" onclick="saveReport('${o.bookingId}','${o.itemId}')">Save Report</button>
          <button class="btn btn-success btn-sm" onclick="setProgress('${o.bookingId}','${o.itemId}', 'completed')">Mark as Completed</button>
        </div>
      ` : ''}

      ${o.itemStatus === 'completed' && o.technicianReport ? `<div class="meta" style="margin-top:8px;">📝 Report: ${esc(o.technicianReport)}</div>` : ''}
      ${o.itemStatus === 'completed' && o.completionPhotoUrl ? `<div class="meta"><a href="${o.completionPhotoUrl}" target="_blank" rel="noopener">📷 View completion photo</a></div>` : ''}
      ${o.itemStatus === 'completed' && !o.completionPhotoUrl && o.completionPhotoExpired ? `<div class="meta" style="color:var(--slate);">📷 Completion photo auto-removed after 35 days</div>` : ''}

      ${o.itemStatus === 'completed' && GOOGLE_REVIEW_URL ? `
        <div class="actions" style="align-items:center;">
          <button class="btn btn-outline btn-sm" onclick="sendGoogleReviewLink('${o.bookingId}','${o.itemId}')">💬 Send Google Review Link</button>
          <span class="meta" style="margin:0;">Sending to: ${maskPhone(o.phone)}</span>
        </div>
      ` : ''}
    </div>
  `).join('');
}
document.getElementById('techOrderFilter').addEventListener('change', renderOrders);

async function acceptOrder(bookingId, itemId) {
  await api(`/api/technician/orders/${bookingId}/items/${itemId}/accept`, { method: 'PUT' });
  await loadOrders(); renderOrders();
}
async function rejectOrder(bookingId, itemId) {
  if (!confirm('Are you sure you want to reject this order?')) return;
  await api(`/api/technician/orders/${bookingId}/items/${itemId}/reject`, { method: 'PUT' });
  await loadOrders(); renderOrders();
}
// Per-task cache of the uploaded completion photo URL, keyed by
// "bookingId__itemId" — filled in by uploadCompletionPhoto() below, read
// by setProgress() when the technician actually taps "Mark as Completed".
// Cleared implicitly whenever loadOrders()/renderOrders() re-fetches from
// the server (a fresh render always reflects o.completionPhotoUrl instead).
const pendingCompletionPhotos = {};

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
    if (label) label.textContent = 'Photo attached ✓ — tap to replace';
  } catch (e) {
    if (label) label.textContent = 'Add photo of completed work (required)';
    alert(e.message || 'Could not upload photo. Please try again.');
  }
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
  if (status === 'completed') {
    if (!pendingCompletionPhotos[taskId]) {
      alert('Please add a photo of the completed work first — tap "Add photo of completed work" above.');
      return;
    }
    body.completionPhotoUrl = pendingCompletionPhotos[taskId];
  }
  try {
    await api(`/api/technician/orders/${bookingId}/items/${itemId}/progress`, { method: 'PUT', body: JSON.stringify(body) });
    delete pendingCompletionPhotos[taskId];
  } catch (e) {
    alert(e.message || 'Could not update this job. Please try again.');
    return;
  }
  await loadOrders(); renderOrders();
}
async function saveReport(bookingId, itemId) {
  const taskId = `${bookingId}__${itemId}`;
  const report = document.getElementById(`report-${taskId}`).value;
  await api(`/api/technician/orders/${bookingId}/items/${itemId}/progress`, { method: 'PUT', body: JSON.stringify({ report }) });
  await loadOrders(); renderOrders();
  alert('Report saved successfully!');
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
  if (!confirm(`Send Google review link on WhatsApp to ${o.name} (${maskPhone(o.phone)})?`)) return;
  const message = `Hi ${o.name}, thank you for choosing Seerua Appliance Care! We hope you're happy with the ${o.applianceName} ${o.serviceType === 'repair' ? 'repair' : 'service'}. If you have a moment, it would really help us if you could share a quick review on Google: ${GOOGLE_REVIEW_URL}`;
  const waPhone = /^[0-9]{10}$/.test(o.phone) ? `91${o.phone}` : o.phone;
  window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`, '_blank');
}

async function renderReport() {
  const dateInput = document.getElementById('techReportDate');
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
  document.getElementById('techExportBtn').href = `/api/technician/reports/daily/export?date=${dateInput.value}`;
  const data = await api(`/api/technician/reports/daily?date=${dateInput.value}`);
  document.getElementById('techReportStats').innerHTML = `
    <div class="stat-card"><div class="val">${data.totalAssigned}</div><div class="lbl">Total Assigned Orders</div></div>
    <div class="stat-card"><div class="val">${data.completedToday}</div><div class="lbl">Completed Today</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.earningsToday)}</div><div class="lbl">Today's Earnings</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.commissionOwedToday)}</div><div class="lbl">Commission Owed Today</div></div>
  `;
  document.getElementById('techReportTable').innerHTML = data.orders.length ? data.orders.map(o => `
    <tr>
      <td>${o.bookingId}</td>
      <td>${esc(o.name)}</td>
      <td>${o.qty}x ${esc(o.applianceName)}</td>
      <td><span class="pill pill-${o.itemStatus}">${o.itemStatus.replace('-', ' ')}</span></td>
      <td>₹${fmtInr(o.lineTotal)}</td>
      <td>${o.itemStatus === 'completed' ? `₹${fmtInr(o.commission)}${o.reviewVerifiedByStaff ? ' <span style="color:var(--green);font-size:0.78rem;">(waived)</span>' : (o.reviewBrought ? ' <span style="color:var(--amber);font-size:0.78rem;">(pending admin confirmation)</span>' : '')}` : '—'}</td>
      <td>${o.itemStatus === 'completed' ? `
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;cursor:pointer;white-space:nowrap;">
          <input type="checkbox" ${o.reviewBrought ? 'checked' : ''} onchange="toggleReviewBrought('${o.bookingId}','${o.id}',this.checked)">
          Google review liya
        </label>
      ` : ''}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="7">No activity on this date.</td></tr>`;
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
    <div class="stat-card"><div class="val">${stats.avgRating ? `⭐ ${stats.avgRating}` : 'Not rated yet'}</div><div class="lbl">Overall Rating</div></div>
    <div class="stat-card"><div class="val">${stats.completedJobs}</div><div class="lbl">Completed Jobs</div></div>
    <div class="stat-card"><div class="val">${stats.rejectedJobs}</div><div class="lbl">Rejected Jobs</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(stats.totalEarningsGenerated)}</div><div class="lbl">Total Earnings Generated</div></div>
  `;

  // The company keeps a commission out of every completed job — EXCEPT
  // jobs where staff has verified a Google review, where this technician
  // keeps 100%. Verification is done manually by Super Admin/Admin in
  // Orders/Commission (ticking "Google review liya" here only sends a
  // claim for them to confirm — see the Daily Report note above). This
  // section makes the current rate and the incentive to ask for a review
  // visible to the technician.
  const rateLabel = stats.variableAmountMode === 'percent' ? `${stats.variableAmount}%` : `₹${fmtInr(stats.variableAmount)}`;
  document.getElementById('techEarningsStats').innerHTML = `
    <div class="stat-card"><div class="val">${stats.variableAmount !== null ? rateLabel : 'Shared rate'}</div><div class="lbl">Your Commission Rate</div></div>
    <div class="stat-card"><div class="val">${stats.googleReviewJobs} / ${stats.completedJobs}</div><div class="lbl">Jobs with a Verified Google Review</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(stats.adminCommission)}</div><div class="lbl">Total Commission Deducted</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(stats.technicianEarning)}</div><div class="lbl">Your Net Earning</div></div>
  `;
  document.getElementById('techEarningsNote').textContent = stats.adminCommission > 0
    ? `Tip: Ask every customer to leave you a Google review after the job. Once your office confirms it, you keep the full amount for that job instead of paying the usual commission.`
    : `Your commission is currently ₹0 — you keep 100% of every completed job.`;

  const appliances = Object.keys(stats.applianceBreakdown || {});
  document.getElementById('techRatingByApplianceTable').innerHTML = appliances.length ? appliances.map(id => {
    const a = stats.applianceBreakdown[id];
    return `
      <tr>
        <td>${a.applianceName}</td>
        <td>${a.avgRating ? `⭐ ${a.avgRating}` : '<span style="color:var(--slate)">Not rated yet</span>'}</td>
        <td>${a.ratingCount}</td>
        <td>${a.completedJobs}</td>
      </tr>
    `;
  }).join('') : `<tr class="empty-row"><td colspan="4">No completed jobs yet. Once you complete a job, it'll show up here by appliance.</td></tr>`;
}

checkLogin();
