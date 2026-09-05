// ------------------------------------------------------------------
// Seerua Appliance Care — Admin Panel logic
// ------------------------------------------------------------------
let CITIES = [], APPLIANCES = [], PRICING = [], TECHNICIANS = [], BOOKINGS = [], EDUCATION_LEVELS = [], CAREER_CITIES = [], CAREER_APPLIANCES = [], UNLOCKED_DATES = [];
let assignBookingId = null;
let typeApplianceId = null;

// SECURITY: customer-supplied fields (booking name, address, problem
// description, technician application notes, etc.) are rendered straight
// into innerHTML throughout this file. Without escaping, a booking made
// with a name like `<img src=x onerror=fetch('/api/admin/...')>`` would
// execute arbitrary JS in whichever staff member's browser opens the
// Bookings/Customers list — a stored XSS that could act as that logged-in
// Admin (e.g. change prices, add coupons, export data) since it runs with
// their session. Every place below that interpolates user-entered text
// into an innerHTML template now runs it through esc() first.
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// SUGGESTION IMPLEMENTED: ₹ amounts were shown as plain digits (₹125000),
// hard to read at a glance. This formats them the Indian way (₹1,25,000)
// everywhere a currency amount is displayed.
function fmtInr(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// A commission rate is always {mode:'flat'|'percent', value}. Renders it
// the way Admin actually reads it: "₹50" or "10%".
function fmtRate(rate) {
  if (!rate) return '—';
  return rate.mode === 'percent' ? `${rate.value}%` : `₹${fmtInr(rate.value)}`;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ---------------- AUTH ----------------
let currentView = 'dashboard';
async function checkLogin() {
  const { loggedIn } = await api('/api/admin/check');
  if (loggedIn) {
    document.getElementById('loginWrap').style.display = 'none';
    document.getElementById('appShell').classList.add('active');
    await loadAll();
    switchView('dashboard');
    startAutoRefresh();
  } else {
    document.getElementById('loginWrap').style.display = 'flex';
    document.getElementById('appShell').classList.remove('active');
  }
}

// ADDED: nothing ever refreshed on its own before this — a new booking
// coming in, a technician accepting a job, anything at all, only ever
// showed up after the admin manually reloaded the whole page. Every 15
// seconds, quietly re-fetches just the bookings (the thing that actually
// changes minute-to-minute) and re-renders only if currently looking at
// a view that shows booking data — never interrupts whatever else the
// admin might be doing on another tab (editing pricing, etc.).
let autoRefreshTimer = null;
function startAutoRefresh() {
  if (autoRefreshTimer) return; // already running — don't stack multiple intervals
  autoRefreshTimer = setInterval(async () => {
    try {
      BOOKINGS = await api('/api/admin/bookings');
      if (currentView === 'orders') { renderOrders(); }
      if (currentView === 'dashboard') { renderDashboard(); }
    } catch (e) { /* a single missed refresh isn't worth bothering the admin about — it'll just try again in 25s */ }
  }, 15000);
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('adminUser').value,
        password: document.getElementById('adminPass').value
      })
    });
    await checkLogin();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  // BUG FIX: same issue as the technician panel — if the logout API call
  // ever failed for any reason, the button did nothing visible at all.
  // Now it always gets back to the login screen either way.
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch (err) {
    console.log('Logout API call failed, reloading anyway:', err.message);
  }
  location.reload();
});

// ---------------- NAV ----------------
document.getElementById('sideNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) switchView(btn.getAttribute('data-view'));
});

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.panel-view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('#sideNav button').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === view));
  if (view === 'dashboard') renderDashboard();
  if (view === 'analytics') renderAnalytics();
  if (view === 'orders') { renderOrders(); renderUnlockedDates(); }
  if (view === 'cities') renderCities();
  if (view === 'appliances') renderAppliances();
  if (view === 'pricing') renderPricing();
  if (view === 'referrals') renderReferrals();
  if (view === 'notifications') renderNotifications();
  if (view === 'rating') renderSiteRating();
  if (view === 'slots') renderSlots();
  if (view === 'technicians') { renderTechnicians(); }
  if (view === 'applications') renderApplications();
  if (view === 'customers') renderCustomers();
  if (view === 'subadmins') renderSubAdmins();
  if (view === 'reports') renderReport();
  if (view === 'commission') renderCommission();
  if (view === 'sitecontent') renderSiteContent();
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }

async function loadAll() {
  [CITIES, APPLIANCES, PRICING, TECHNICIANS, BOOKINGS, EDUCATION_LEVELS, CAREER_CITIES, CAREER_APPLIANCES] = await Promise.all([
    api('/api/admin/cities'),
    api('/api/admin/appliances'),
    api('/api/admin/pricing'),
    api('/api/admin/technicians'),
    api('/api/admin/bookings'),
    api('/api/admin/education-levels'),
    api('/api/admin/career-cities'),
    api('/api/admin/career-appliances')
  ]);
  try {
    const res = await api('/api/admin/unlocked-dates');
    UNLOCKED_DATES = res.unlockedDates || [];
  } catch (e) { UNLOCKED_DATES = []; }
}

// A booking's date is locked if it's strictly before today AND not in the
// explicitly-unlocked list — mirrors the same rule enforced server-side in
// isDateLocked(), used here just to decide what the UI shows/hides.
function isBookingDateLocked(dateStr) {
  if (!dateStr) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr >= today) return false;
  return !UNLOCKED_DATES.includes(dateStr);
}

function findType(applianceId, typeId) {
  const a = APPLIANCES.find(x => x.id === applianceId);
  return a ? a.types.find(t => t.id === typeId) : null;
}

function itemsSummary(booking) {
  if (!booking.items || !booking.items.length) return '-';
  return booking.items.map(it => `${it.qty}x ${it.applianceName} (${it.typeName}, ${it.serviceType === 'repair' ? 'Repair' : 'Service'})`).join(', ');
}

function itemStatusCounts(bookings) {
  let pending = 0, completed = 0;
  let revenue = 0;
  bookings.forEach(b => {
    b.items.forEach(it => {
      if (it.itemStatus === 'pending') pending++;
      if (it.itemStatus === 'completed') { completed++; revenue += it.lineTotal; }
    });
  });
  return { pending, completed, revenue };
}

// ---------------- BOOKING STATUS (pause new bookings without taking the site down) ----------------
async function renderBookingStatusCard() {
  const data = await api('/api/admin/booking-status');
  const toggle = document.getElementById('bookingPausedToggle');
  const label = document.getElementById('bookingPausedStatusLabel');
  const card = document.getElementById('bookingStatusCard');
  toggle.checked = data.bookingPaused;
  document.getElementById('bookingPausedMessage').value = data.bookingPausedMessage || '';
  if (data.bookingPaused) {
    label.textContent = '⏸️ Bookings Paused';
    card.style.borderLeftColor = 'var(--amber)';
  } else {
    label.textContent = '✅ Accepting Bookings';
    card.style.borderLeftColor = 'var(--green)';
  }
}

document.getElementById('saveBookingStatusBtn').addEventListener('click', async () => {
  const msg = document.getElementById('bookingStatusMsg');
  msg.className = 'msg-inline';
  const bookingPaused = document.getElementById('bookingPausedToggle').checked;
  const bookingPausedMessage = document.getElementById('bookingPausedMessage').value.trim();
  try {
    await api('/api/admin/booking-status', { method: 'PUT', body: JSON.stringify({ bookingPaused, bookingPausedMessage }) });
    msg.className = 'msg-inline success';
    msg.textContent = bookingPaused ? 'Bookings paused — the site stays fully live, only the booking form is hidden.' : 'Bookings reopened — customers can book normally again.';
    await renderBookingStatusCard();
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

// ---------------- DASHBOARD ----------------
async function renderMaintenanceCard() {
  const data = await api('/api/admin/maintenance');
  const toggle = document.getElementById('maintenanceToggle');
  const label = document.getElementById('maintenanceStatusLabel');
  const card = document.getElementById('maintenanceCard');
  toggle.checked = data.maintenanceMode;
  document.getElementById('maintenanceMessage').value = data.maintenanceMessage || '';
  document.getElementById('maintenanceExpectedHours').value = data.maintenanceExpectedHours || 2;
  if (data.maintenanceMode) {
    label.textContent = '🔴 Site is in Maintenance Mode';
    card.style.borderLeftColor = 'var(--red)';
  } else {
    label.textContent = '🟢 Site is Live';
    card.style.borderLeftColor = 'var(--green)';
  }
}

document.getElementById('saveMaintenanceBtn').addEventListener('click', async () => {
  const msg = document.getElementById('maintenanceMsg');
  msg.className = 'msg-inline';
  const maintenanceMode = document.getElementById('maintenanceToggle').checked;
  const maintenanceMessage = document.getElementById('maintenanceMessage').value.trim();
  const maintenanceExpectedHours = document.getElementById('maintenanceExpectedHours').value;
  try {
    await api('/api/admin/maintenance', { method: 'PUT', body: JSON.stringify({ maintenanceMode, maintenanceMessage, maintenanceExpectedHours }) });
    msg.className = 'msg-inline success';
    msg.textContent = maintenanceMode ? 'Maintenance mode is now ON — visitors will see the notice.' : 'Maintenance mode is now OFF — the site is live again.';
    await renderMaintenanceCard();
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

// ---------------- DATA BACKUP / RESTORE ----------------
document.getElementById('restoreBackupBtn').addEventListener('click', async () => {
  const msg = document.getElementById('restoreMsg');
  const fileInput = document.getElementById('restoreFileInput');
  const file = fileInput.files[0];
  if (!file) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Please choose a backup file first.';
    return;
  }
  if (!confirm('This will overwrite current data with the contents of this backup file. Continue?')) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const result = await api('/api/admin/restore', { method: 'POST', body: JSON.stringify(parsed) });
    msg.className = 'msg-inline success';
    msg.textContent = `Restored ${result.restoredCount} data files. Reloading...`;
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Could not restore: ' + (err.message || 'invalid file');
  }
});

// ---------------- TECHNICIAN PHOTO UPLOAD TOGGLE ----------------
async function renderTechPhotoCard() {
  const data = await api('/api/admin/technician-photo-toggle');
  const toggle = document.getElementById('techPhotoToggle');
  const label = document.getElementById('techPhotoStatusLabel');
  toggle.checked = !data.technicianPhotoUploadDisabled;
  label.textContent = data.technicianPhotoUploadDisabled ? 'Off' : 'Allowed';
}
document.getElementById('techPhotoToggle').addEventListener('change', async (e) => {
  const disabled = !e.target.checked;
  const msg = document.getElementById('techPhotoMsg');
  try {
    await api('/api/admin/technician-photo-toggle', { method: 'PUT', body: JSON.stringify({ technicianPhotoUploadDisabled: disabled }) });
    document.getElementById('techPhotoStatusLabel').textContent = disabled ? 'Off' : 'Allowed';
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved.';
  } catch (err) {
    e.target.checked = !e.target.checked;
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});
renderTechPhotoCard();

// ---------------- OTP VERIFICATION TOGGLE ----------------
async function renderOtpCard() {
  const data = await api('/api/admin/otp-config');
  const toggle = document.getElementById('otpToggle');
  const label = document.getElementById('otpStatusLabel');
  const card = document.getElementById('otpCard');
  toggle.checked = data.enabled;
  // ADDED: pre-fill the Widget ID / Token Auth fields with whatever is
  // currently saved, so opening this page shows the real current state
  // instead of always looking blank/unset.
  const widgetIdInput = document.getElementById('otpWidgetId');
  const tokenAuthInput = document.getElementById('otpTokenAuth');
  if (widgetIdInput) widgetIdInput.value = data.widgetId || '';
  if (tokenAuthInput) tokenAuthInput.value = data.tokenAuth || '';
  if (data.enabled) {
    label.textContent = '🟢 OTP Enabled';
    card.style.borderLeftColor = 'var(--green)';
  } else {
    label.textContent = '🔴 OTP Disabled';
    card.style.borderLeftColor = 'var(--red)';
  }
}

// ADDED: previously there was no way to actually set/update the MSG91
// Widget ID or Token Auth anywhere in the Admin Panel — this is what was
// silently breaking OTP verification (it was stuck on old/wrong values
// with no way to fix them without editing the server's data file by
// hand). Get the current values from MSG91 Dashboard → OTP → your widget.
document.getElementById('saveOtpCredsBtn').addEventListener('click', async () => {
  const msg = document.getElementById('otpCredsMsg');
  msg.className = 'msg-inline';
  const widgetId = document.getElementById('otpWidgetId').value.trim();
  const tokenAuth = document.getElementById('otpTokenAuth').value.trim();
  if (!widgetId || !tokenAuth) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Both Widget ID and Token Auth are required.';
    return;
  }
  try {
    await api('/api/admin/otp-config', { method: 'PUT', body: JSON.stringify({ widgetId, tokenAuth }) });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved! New OTP attempts will use these credentials right away — no restart needed.';
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

document.getElementById('otpToggle').addEventListener('change', async (e) => {
  const msg = document.getElementById('otpMsg');
  msg.className = 'msg-inline';
  const enabled = e.target.checked;
  try {
    await api('/api/admin/otp-config', { method: 'PUT', body: JSON.stringify({ enabled }) });
    msg.className = 'msg-inline success';
    msg.textContent = enabled ? 'OTP verification is now ON — new customers must verify their number before booking.' : 'OTP verification is now OFF — customers can book without OTP verification.';
    await renderOtpCard();
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
    e.target.checked = !enabled; // revert the checkbox since the save failed
  }
});

function renderDashboard() {
  renderMaintenanceCard();
  renderBookingStatusCard();
  renderOtpCard();
  const totalOrders = BOOKINGS.length;
  const { pending, completed, revenue } = itemStatusCounts(BOOKINGS);

  document.getElementById('dashStats').innerHTML = `
    <div class="stat-card"><div class="val">${totalOrders}</div><div class="lbl">Total Orders</div></div>
    <div class="stat-card"><div class="val">${pending}</div><div class="lbl">Pending Items</div></div>
    <div class="stat-card"><div class="val">${completed}</div><div class="lbl">Completed Items</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(revenue)}</div><div class="lbl">Total Revenue</div></div>
  `;

  const latest = sortOrdersByBookingTime(BOOKINGS).slice(0, 8);
  document.getElementById('dashLatestOrders').innerHTML = latest.length ? latest.map(b => `
    <tr>
      <td>${b.id}<br><small style="color:var(--slate)">Booked: ${new Date(b.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${new Date(b.createdAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}</small>${b.timeSlot ? `<br><small style="color:var(--blue-700);font-weight:700;">🕐 Visit: ${new Date(b.bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${b.timeSlot}</small>` : ''}</td>
      <td>${esc(b.name)}<br><small style="color:var(--slate)">${esc(b.phone)}</small></td>
      <td>${itemsSummary(b)}</td>
      <td>${b.cityName}</td>
      <td>₹${fmtInr(b.totalPrice)}</td>
      <td>${b.items.map(it => `<span class="pill pill-${it.itemStatus}">${it.itemStatus.replace('-', ' ')}</span>${it.technicianName ? `<br><small style="color:var(--slate)">→ ${it.technicianName}${it.assignedAt ? ` · assigned ${formatAssignedAt(it.assignedAt)}` : ''}</small>` : ''}`).join('<br>')}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="6">No bookings yet.</td></tr>`;
}

// Shows the technician's own local time it was assigned — e.g. "15 Aug, 2:30 pm".
function formatAssignedAt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// "Important work first": orders that still need action (nothing assigned
// yet, or a technician turned it down and it's waiting to be reassigned)
// float to the top so nothing gets missed. Orders already moving
// (assigned/accepted/in-progress) come next, and finished + locked orders
// sink to the bottom since there's nothing left to do on them.
const ORDER_STATUS_RANK = { pending: 0, assigned: 1, accepted: 2, 'in-progress': 3, completed: 4 };
function bookingUrgencyRank(b) {
  const minRank = Math.min(...b.items.map(it => ORDER_STATUS_RANK[it.itemStatus] ?? 5));
  const wasRejected = b.items.some(it => it.rejectionHistory && it.rejectionHistory.length);
  return [minRank, wasRejected ? 0 : 1];
}
function sortByUrgency(list) {
  return [...list].sort((a, b) => {
    const [ra1, ra2] = bookingUrgencyRank(a);
    const [rb1, rb2] = bookingUrgencyRank(b);
    if (ra1 !== rb1) return ra1 - rb1;
    if (ra2 !== rb2) return ra2 - rb2;
    return new Date(b.createdAt) - new Date(a.createdAt); // newest first within the same urgency
  });
}

// Orders list order: simply sorted by booking time (when the booking was
// made), newest first — no special-casing of a single "pinned" item and
// no separate slot-based ordering.
function sortOrdersByBookingTime(list) {
  return [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ---------------- ANALYTICS ----------------
const CHART_COLORS = ['#1b6fb0', '#f7941d', '#1f9d55', '#d64545', '#7c5cff', '#0f2a43'];

function barChartHtml(dataObj, colorClass) {
  const entries = Object.entries(dataObj);
  if (!entries.length) return '<p style="color:var(--slate);font-size:0.85rem;">No data yet.</p>';
  const max = Math.max(...entries.map(e => e[1]), 1);
  return entries.sort((a, b) => b[1] - a[1]).map(([label, value]) => `
    <div class="bar-row">
      <div class="bar-label" title="${label}">${label}</div>
      <div class="bar-track"><div class="bar-fill ${colorClass || ''}" style="width:${Math.round((value / max) * 100)}%;"></div></div>
      <div class="bar-value">${value}</div>
    </div>
  `).join('');
}

async function renderAnalytics() {
  const data = await api('/api/admin/analytics');

  document.getElementById('analyticsStats').innerHTML = `
    <div class="stat-card"><div class="val">₹${fmtInr(data.totalRevenue)}</div><div class="lbl">Total Revenue</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.monthRevenue)}</div><div class="lbl">This Month's Revenue</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.avgOrderValue)}</div><div class="lbl">Avg Order Value</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.totalDiscount)}</div><div class="lbl">Total Discounts Given</div></div>
  `;

  document.getElementById('revenueByCityChart').innerHTML = barChartHtml(
    Object.fromEntries(Object.entries(data.revenueByCity).map(([k, v]) => [k, v])), ''
  );
  document.getElementById('bookingsByApplianceChart').innerHTML = barChartHtml(data.bookingsByAppliance, 'accent');

  const trendMax = Math.max(...data.dailyRevenue.map(d => d.revenue), 1);
  document.getElementById('trendChart').innerHTML = data.dailyRevenue.map(d => {
    const dt = new Date(d.date);
    const label = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const h = Math.max(2, Math.round((d.revenue / trendMax) * 100));
    return `
      <div class="trend-bar-wrap" title="${label}: ₹${fmtInr(d.revenue)}">
        <div class="trend-bar" style="height:${h}%;"></div>
        <div class="trend-label">${label}</div>
      </div>
    `;
  }).join('');

  // Same 14-day timeline as Revenue above, in its own chart (rather than
  // stacked into the same bars) since commission is usually a much
  // smaller number than revenue — sharing one scale would flatten it to
  // near-invisible slivers next to the revenue bars.
  const commissionMax = Math.max(...data.dailyRevenue.map(d => d.commission), 1);
  document.getElementById('commissionTrendChart').innerHTML = data.dailyRevenue.map(d => {
    const dt = new Date(d.date);
    const label = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const h = Math.max(2, Math.round((d.commission / commissionMax) * 100));
    return `
      <div class="trend-bar-wrap" title="${label}: ₹${fmtInr(d.commission)}">
        <div class="trend-bar commission" style="height:${h}%;"></div>
        <div class="trend-label">${label}</div>
      </div>
    `;
  }).join('');

  const statusLabels = { pending: 'Pending', assigned: 'Assigned', accepted: 'Accepted', 'in-progress': 'In Progress', completed: 'Completed', rejected: 'Rejected' };
  // Fixed, meaningful colors instead of an arbitrary rotating palette —
  // red for pending (needs attention), yellow/amber for assigned (in
  // motion), green for completed (done). Other statuses get a sensible
  // color of their own so nothing is left unstyled.
  const STATUS_COLORS = {
    pending: 'var(--red)',
    assigned: 'var(--amber)',
    accepted: 'var(--blue-700)',
    'in-progress': 'var(--accent-600)',
    completed: 'var(--green)',
    rejected: 'var(--slate)'
  };
  const statusEntries = Object.entries(data.statusBreakdown).filter(([, v]) => v > 0);
  const statusTotal = statusEntries.reduce((s, [, v]) => s + v, 0) || 1;
  document.getElementById('statusMixBar').innerHTML = statusEntries.map(([k, v]) =>
    `<div class="status-mix-seg" style="width:${(v / statusTotal) * 100}%;background:${STATUS_COLORS[k] || 'var(--line)'};" title="${statusLabels[k]}: ${v}"></div>`
  ).join('') || '<div class="status-mix-seg" style="width:100%;background:var(--line);"></div>';
  document.getElementById('statusLegend').innerHTML = statusEntries.map(([k, v]) =>
    `<span><span class="dot" style="background:${STATUS_COLORS[k] || 'var(--line)'};"></span>${statusLabels[k]}: ${v}</span>`
  ).join('') || '<span>No orders yet.</span>';

  document.getElementById('topTechTable').innerHTML = data.topTechnicians.length ? data.topTechnicians.map(t => `
    <tr>
      <td>${t.name}</td>
      <td>${t.avgRating ? `⭐ ${t.avgRating}` : '-'}</td>
      <td>${t.completedJobs}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="3">No completed jobs yet.</td></tr>`;

  const applianceRatingEntries = Object.entries(data.ratingByAppliance || {}).sort((a, b) => b[1].avgRating - a[1].avgRating);
  document.getElementById('ratingByApplianceTable').innerHTML = applianceRatingEntries.length ? applianceRatingEntries.map(([name, r]) => `
    <tr>
      <td>${name}</td>
      <td>⭐ ${r.avgRating}</td>
      <td>${r.ratingCount}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="3">No rated jobs yet.</td></tr>`;
}

// ---------------- ORDERS ----------------
// ASSIGNMENT LOCK: session-only set of "bookingId__itemId" keys that have
// been explicitly unlocked for reassignment — resets on page reload, so
// every fresh visit starts locked-by-default for anything already
// assigned. Any Admin or Super Admin using this panel can unlock; this is
// a deliberate confirmation step, not a role restriction.
const assignmentUnlocked = new Set();
function unlockAssignment(bookingId, itemId) {
  assignmentUnlocked.add(`${bookingId}__${itemId}`);
  renderOrders();
}

function renderOrders() {
  const statusFilter = document.getElementById('orderStatusFilter').value;
  const search = document.getElementById('orderSearch').value.trim().toLowerCase();
  let list = BOOKINGS;
  // A rejected item doesn't stay "Rejected" — it goes straight back to
  // "Pending" so it can be reassigned right away (see the rejectionHistory
  // note below). So this filter looks for items with rejection history
  // instead of a status value that's never actually stored.
  if (statusFilter === 'rejected') {
    list = list.filter(b => b.items.some(it => it.rejectionHistory && it.rejectionHistory.length));
  } else if (statusFilter) {
    list = list.filter(b => b.items.some(it => it.itemStatus === statusFilter));
  }
  if (search) list = list.filter(b => b.name.toLowerCase().includes(search) || b.phone.includes(search));
  list = sortOrdersByBookingTime(list);

  document.getElementById('ordersTable').innerHTML = list.length ? list.map(b => `
    <tr>
      <td>${b.id}${isBookingDateLocked(b.bookingDate) ? ' <span class="pill" style="background:#fef3c7;color:#b45309;" title="Locked past date">🔒 Locked</span>' : ''}<br><small style="color:var(--slate)">Booked: ${new Date(b.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${new Date(b.createdAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}</small>${b.timeSlot ? `<br><small style="color:var(--blue-700);font-weight:700;">🕐 Visit: ${new Date(b.bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${b.timeSlot}</small>` : ''}</td>
      <td>${esc(b.name)} ${b.source === 'phone' ? '<span class="pill pill-assigned" title="Booked via phone call by Admin">📞 Phone</span>' : ''}<br><small style="color:var(--slate)">${esc(b.phone)}</small><br><small style="color:var(--slate)">${esc(b.address)}</small></td>
      <td>
        ${b.items.map(it => `
          <div style="padding:8px 0;border-bottom:1px dashed var(--line);">
            <div>${it.qty}x ${it.applianceName} (${it.typeName}) — ${it.serviceType === 'repair' ? 'Repair' : 'Service'}</div>
            ${it.problem ? `<small style="color:var(--slate)">${esc(it.problem)}</small><br>` : ''}
            ${it.photoUrl ? `<a href="${it.photoUrl}" target="_blank" rel="noopener" style="font-size:0.82rem;color:var(--blue-600);">📷 View customer's photo</a><br>` : ''}
            ${it.completionPhotoUrl ? `<a href="${it.completionPhotoUrl}" target="_blank" rel="noopener" style="font-size:0.82rem;color:var(--green);">✅ View completion photo</a><br>` : (it.itemStatus === 'completed' && it.completionPhotoExpired ? `<small style="color:var(--slate);">📷 Completion photo auto-removed after 35 days</small><br>` : '')}
            <span class="pill pill-${it.itemStatus}">${it.itemStatus.replace('-', ' ')}</span>
            ${it.technicianName ? ` <small style="color:var(--slate)">→ ${it.technicianName}${it.assignedAt ? ` · assigned ${formatAssignedAt(it.assignedAt)}` : ''}</small>` : ''}
            ${it.rejectionHistory && it.rejectionHistory.length ? `<br><small style="color:var(--red);">⚠️ Previously rejected by: ${it.rejectionHistory.map(r => `${r.technicianName} (${formatAssignedAt(r.rejectedAt)})`).join(', ')}</small>` : ''}
            <br>
            ${it.itemStatus === 'completed' ? `
              <!-- Completed jobs are locked — no Reassign/Auto-Assign here,
                   so a finished job can't be accidentally re-touched. The
                   only way back in is the explicit Reactivate button below. -->
              <div style="margin-top:6px;padding:8px 10px;background:var(--mist);border-radius:8px;">
                <small style="color:var(--slate);">🔒 Locked — job is completed.</small><br>
                ${isBookingDateLocked(b.bookingDate) ? `
                  <small style="color:#b45309;display:block;margin-top:6px;">🔒 This booking is from ${b.bookingDate}, a locked past date — ask Super Admin to unlock it to rate or reactivate this job.</small>
                ` : `
                <select style="margin-top:6px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-size:0.8rem;" onchange="rateItem('${b.id}','${it.id}', this.value)">
                  <option value="">${it.rating ? `Rated ⭐${it.rating} (${it.ratingSource === 'customer' ? 'by customer' : 'by admin'})` : 'Rate this job'}</option>
                  <option value="5">⭐⭐⭐⭐⭐ Excellent</option>
                  <option value="4">⭐⭐⭐⭐ Good</option>
                  <option value="3">⭐⭐⭐ Average</option>
                  <option value="2">⭐⭐ Below Average</option>
                  <option value="1">⭐ Poor</option>
                </select><br>
                ${it.technicianId ? `
                  <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:0.8rem;cursor:pointer;">
                    <input type="checkbox" ${it.reviewVerifiedByStaff ? 'checked' : ''} onchange="toggleGoogleReview('${b.id}','${it.id}', this.checked)">
                    📍 Google Review Received${it.reviewVerifiedByStaff ? ` <small style="color:var(--green);">(waived)</small>` : (it.reviewBrought ? ' <small style="color:var(--amber);">(pending)</small>' : '')}
                  </label>
                ` : ''}
                <button class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="reactivateItem('${b.id}','${it.id}')" title="Reopens this job if it genuinely needs to be redone">🔓 Reactivate</button>
                `}
              </div>
            ` : `
              <div style="margin-top:8px;">
                ${isBookingDateLocked(b.bookingDate) ? `
                  <small style="color:#b45309;">🔒 This booking is from ${b.bookingDate}, a locked past date — ask Super Admin to unlock it to assign a technician.</small>
                ` : (it.technicianName && !assignmentUnlocked.has(`${b.id}__${it.id}`) ? `
                  <!-- ASSIGNMENT LOCK: once a technician is assigned, the
                       Reassign/Auto-Assign buttons stay behind an explicit
                       Unlock click — protects against an accidental
                       reassignment of a technician who may already be on
                       their way to the job. Any Admin or Super Admin logged
                       into this panel can unlock it; it's a deliberate
                       "are you sure" step, not a permission restriction. -->
                  <div style="padding:8px 10px;background:var(--mist);border-radius:8px;">
                    <small style="color:var(--slate);">🔒 Locked — already assigned to ${esc(it.technicianName)}.</small><br>
                    <button class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="unlockAssignment('${b.id}','${it.id}')">🔓 Unlock to Reassign</button>
                  </div>
                ` : `
                <button class="btn btn-outline btn-sm" onclick="openAssign('${b.id}','${it.id}')">${it.technicianName ? 'Reassign' : 'Assign'}</button>
                ${it.itemStatus !== 'rejected' ? `<button class="btn btn-primary btn-sm" style="margin-left:6px;" onclick="autoAssign('${b.id}','${it.id}')" title="Assigns the top-ranked eligible technician for this appliance instantly, based on their rating for this exact appliance">⚡ Auto-Assign Best</button>` : ''}
                `)}
              </div>
            `}
          </div>
        `).join('')}
      </td>
      <td>${b.cityName}</td>
      <td>₹${fmtInr(b.totalPrice)}</td>
      <td>
        ${isBookingDateLocked(b.bookingDate) ? '<small style="color:#b45309;">🔒 Locked</small>' : `<button class="btn btn-danger btn-sm" onclick="deleteBooking('${b.id}')">Delete</button>`}
      </td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="6">No orders found.</td></tr>`;
}
document.getElementById('orderStatusFilter').addEventListener('change', renderOrders);

async function rateItem(bookingId, itemId, rating) {
  if (!rating) return;
  try {
    await api(`/api/admin/bookings/${bookingId}/items/${itemId}/rate`, { method: 'PUT', body: JSON.stringify({ rating }) });
    BOOKINGS = await api('/api/admin/bookings');
    TECHNICIANS = await api('/api/admin/technicians');
    renderOrders();
  } catch (e) { alert(e.message); }
}

async function reactivateItem(bookingId, itemId) {
  if (!confirm('Reactivate this completed job? It will go back to "In Progress" so it can be worked on / reassigned again. Any existing rating on it will be cleared.')) return;
  try {
    await api(`/api/admin/bookings/${bookingId}/items/${itemId}/reactivate`, { method: 'PUT' });
    await loadAll();
    renderOrders();
    renderDashboard();
  } catch (e) { alert(e.message); }
}

// Manual, auditable confirmation that the customer actually left a Google
// review for this job — only Super Admin/Admin can set this (never the
// technician), and it's what waives the company's per-job commission for
// this specific item. See computeTechCommission() in server.js.
async function toggleGoogleReview(bookingId, itemId, checked) {
  try {
    await api(`/api/admin/bookings/${bookingId}/items/${itemId}/google-review`, { method: 'PUT', body: JSON.stringify({ submitted: checked }) });
    await loadAll();
    renderOrders();
  } catch (e) {
    alert(e.message);
    renderOrders();
  }
}
document.getElementById('orderSearch').addEventListener('input', renderOrders);

let assignItemId = null;

// Finds other bookings from the same phone number, on the same visit date,
// as the given booking (excluding itself) — used to flag repeat same-day
// bookings to the Admin at the moment they're assigning a technician, so a
// possible duplicate/mistaken booking (or a customer with multiple urgent
// jobs the same day) doesn't go unnoticed.
function findSameDayRepeatBookings(booking) {
  if (!booking || !booking.phone || !booking.bookingDate) return [];
  return BOOKINGS.filter(b =>
    b.id !== booking.id && b.phone === booking.phone && b.bookingDate === booking.bookingDate
  );
}

async function openAssign(bookingId, itemId) {
  assignBookingId = bookingId;
  assignItemId = itemId;
  const booking = BOOKINGS.find(b => b.id === bookingId);
  const item = booking ? booking.items.find(it => it.id === itemId) : null;
  const sel = document.getElementById('assignTechSelect');
  const infoEl = document.getElementById('assignBookingInfo');
  const warnEl = document.getElementById('assignWarning');
  const repeatWarnEl = document.getElementById('assignRepeatWarning');
  const confirmBtn = document.getElementById('assignConfirmBtn');
  warnEl.style.display = 'none';
  repeatWarnEl.style.display = 'none';
  sel.innerHTML = '<option>Loading...</option>';
  sel.disabled = true;
  confirmBtn.disabled = true;
  openModal('assignModal');

  if (!booking || !item) {
    infoEl.innerHTML = 'Item not found.';
    sel.innerHTML = '<option disabled>-</option>';
    return;
  }

  infoEl.innerHTML = `<b>${esc(booking.name)}</b> · ${item.qty}x ${esc(item.applianceName)} (${esc(item.typeName)}) · City: <b>${esc(booking.cityName)}</b>`;

  const repeats = findSameDayRepeatBookings(booking);
  if (repeats.length) {
    repeatWarnEl.style.display = 'block';
    repeatWarnEl.textContent = `⚠️ Repeat booking: ${booking.name} (${booking.phone}) has ${repeats.length} other booking${repeats.length === 1 ? '' : 's'} on ${booking.bookingDate} (ID${repeats.length === 1 ? '' : 's'}: ${repeats.map(r => r.id).join(', ')}). Please confirm this isn't a duplicate before assigning.`;
  }

  try {
    const eligible = await api(`/api/admin/bookings/${bookingId}/items/${itemId}/eligible-technicians`);
    if (!eligible.length) {
      sel.innerHTML = '<option disabled>No eligible technician</option>';
      sel.disabled = true;
      confirmBtn.disabled = true;
      warnEl.style.display = 'block';
      warnEl.textContent = `No active technician in ${booking.cityName} lists ${item.applianceName} as a speciality. Add or update a technician first — assignment is blocked until an exact match exists.`;
    } else {
      sel.innerHTML = eligible.map(t => {
        // Prioritize the rating for THIS appliance specifically (e.g. their
        // Washing Machine rating) over their blended overall rating — that's
        // the number that actually predicts how they'll do on this job.
        const apRatingText = t.applianceRating
          ? `⭐${t.applianceRating} for ${item.applianceName} (${t.applianceJobs} job${t.applianceJobs === 1 ? '' : 's'})`
          : `new to ${item.applianceName} (0 jobs yet)`;
        const overallText = t.avgRating ? `, overall ⭐${t.avgRating}` : '';
        const expText = `${t.experienceYears || 0} yr${t.experienceYears === 1 ? '' : 's'} exp.`;
        const liveText = t.isOnline ? ', 🟢 online now' : '';
        const capacityText = t.atCapacity ? ` — ⚠️ at daily limit (${t.jobsOnDate}/${t.dailyLimit} jobs on ${booking.bookingDate || 'this date'})` : '';
        return `<option value="${t.id}">${t.name} — ${apRatingText}${overallText}, ${expText}${liveText}${capacityText}</option>`;
      }).join('');
      sel.disabled = false;
      confirmBtn.disabled = false;
    }
  } catch (e) {
    sel.innerHTML = '<option disabled>Error loading technicians</option>';
    confirmBtn.disabled = true;
  }
}

// One-click version of the Assign flow: skips the modal entirely and
// assigns the technician the eligible-technicians endpoint already ranks
// #1 for this appliance (highest rating for THIS appliance, then most jobs
// done on it, then overall rating/history) — the same ranking shown in the
// manual Assign dropdown, just applied automatically.
async function autoAssign(bookingId, itemId) {
  try {
    const eligible = await api(`/api/admin/bookings/${bookingId}/items/${itemId}/eligible-technicians`);
    if (!eligible.length) {
      alert('No eligible technician found for this appliance in this city. Add or update a technician first, or use manual Assign to see why.');
      return;
    }
    // Prefer a technician who still has room today; only fall back to an
    // at-capacity technician (with a clear warning) if every eligible
    // technician is already full for this date.
    const notFull = eligible.filter(t => !t.atCapacity);
    const top = notFull.length ? notFull[0] : eligible[0];
    const booking = BOOKINGS.find(b => b.id === bookingId);
    const item = booking ? booking.items.find(it => it.id === itemId) : null;
    const apRatingText = top.applianceRating ? `⭐${top.applianceRating} for ${item ? item.applianceName : 'this appliance'} (${top.applianceJobs} jobs)` : `new to this appliance (0 jobs yet)`;
    const liveText = top.isOnline ? ', currently online' : ', currently offline';
    const capacityWarn = top.atCapacity ? `\n\n⚠️ All eligible technicians are already at their daily job limit for ${booking && booking.bookingDate ? booking.bookingDate : 'this date'}. ${top.name} is at ${top.jobsOnDate}/${top.dailyLimit} jobs — assigning anyway may cause delay.` : '';
    const repeats = booking ? findSameDayRepeatBookings(booking) : [];
    const repeatWarn = repeats.length ? `\n\n⚠️ Repeat booking: ${booking.name} (${booking.phone}) has ${repeats.length} other booking${repeats.length === 1 ? '' : 's'} on ${booking.bookingDate} (ID${repeats.length === 1 ? '' : 's'}: ${repeats.map(r => r.id).join(', ')}). Please confirm this isn't a duplicate.` : '';
    if (!confirm(`Auto-assign ${top.name} — ${apRatingText}${liveText}?${capacityWarn}${repeatWarn}`)) return;
    await api(`/api/admin/bookings/${bookingId}/items/${itemId}/assign`, { method: 'PUT', body: JSON.stringify({ technicianId: top.id }) });
    // BUG FIX: a successful (re)assignment never removed this item from
    // the unlocked set — so once unlocked once, an item stayed unlocked
    // forever (reassign/auto-assign buttons kept showing), defeating the
    // whole point of the lock protecting an already-working technician
    // from an accidental second reassignment.
    assignmentUnlocked.delete(`${bookingId}__${itemId}`);
    BOOKINGS = await api('/api/admin/bookings');
    renderOrders(); renderDashboard();
  } catch (e) { alert(e.message); }
}

document.getElementById('assignConfirmBtn').addEventListener('click', async () => {
  const technicianId = document.getElementById('assignTechSelect').value;
  if (!technicianId) return;
  try {
    await api(`/api/admin/bookings/${assignBookingId}/items/${assignItemId}/assign`, { method: 'PUT', body: JSON.stringify({ technicianId }) });
    // BUG FIX: same as autoAssign() above — re-lock after a successful
    // manual (re)assignment too.
    assignmentUnlocked.delete(`${assignBookingId}__${assignItemId}`);
    BOOKINGS = await api('/api/admin/bookings');
    renderOrders(); renderDashboard();
    closeModal('assignModal');
  } catch (e) { alert(e.message); }
});

async function deleteBooking(id) {
  if (!confirm('Are you sure you want to delete this booking?')) return;
  try {
    await api(`/api/admin/bookings/${id}`, { method: 'DELETE' });
    BOOKINGS = await api('/api/admin/bookings');
    renderOrders(); renderDashboard();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

function cityName(id) { const c = CITIES.find(x => x.id === id); return c ? c.name : '-'; }

// ---------------- NEW BOOKING (PHONE CALL) ----------------
let nbCartItems = [];
let nbFilteredAppliances = []; // appliances currently selectable — filtered to nbCity, so a city-disabled appliance can't be phone-booked either

async function refreshNbAppliancesForCity(cityId) {
  try {
    nbFilteredAppliances = cityId ? await api(`/api/appliances?cityId=${cityId}`) : APPLIANCES;
  } catch (e) {
    nbFilteredAppliances = APPLIANCES;
  }
  const current = document.getElementById('nbAppliance').value;
  document.getElementById('nbAppliance').innerHTML = nbFilteredAppliances.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  if (current && nbFilteredAppliances.some(a => a.id === current)) {
    document.getElementById('nbAppliance').value = current;
  }
  refreshNbTypes();
}

async function openNewBookingModal() {
  document.getElementById('nbName').value = '';
  document.getElementById('nbPhone').value = '';
  document.getElementById('nbAddress').value = '';
  document.getElementById('nbDate').value = '';
  // Same as the customer-facing booking form: don't let staff pick a past
  // date in the calendar in the first place (the server already rejects
  // it, but the picker itself should behave like a real calendar and not
  // offer dates that can never be booked).
  const todayStr = new Date().toLocaleDateString('en-CA'); // en-CA gives YYYY-MM-DD
  document.getElementById('nbDate').min = todayStr;
  document.getElementById('nbSlotId').value = '';
  document.getElementById('nbProblem').value = '';
  document.getElementById('nbQty').value = 1;
  document.getElementById('nbMsg').className = 'msg-inline';
  document.getElementById('nbMsg').textContent = '';
  nbCartItems = [];
  renderNbCart();

  document.getElementById('nbCity').innerHTML = CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('nbSlotId').innerHTML = '<option value="">Select a time slot</option>' +
    '<option value="slot1">8:00 AM - 11:00 AM</option>' +
    '<option value="slot2">12:00 PM - 3:00 PM</option>' +
    '<option value="slot3">4:00 PM - 7:00 PM</option>';
  await refreshNbAppliancesForCity(document.getElementById('nbCity').value);

  openModal('newBookingModal');
}
document.getElementById('newBookingBtn').addEventListener('click', openNewBookingModal);

// SUGGESTION IMPLEMENTED: as soon as a full 10-digit phone number is
// typed into the "New Booking (Phone Call)" form, check whether it
// already belongs to an existing customer and, if so, auto-fill their
// name/address/city — saves staff from having to ask a returning
// customer for their address again. Never overwrites anything staff has
// already typed into those fields by hand.
async function tryAutoFillFromPhone(rawValue) {
  // ROBUSTNESS FIX: normalize the typed value first — strips spaces,
  // dashes, and a leading "91" country code (e.g. someone pastes a number
  // copied from WhatsApp/call log as "+91 99988 87771") so the lookup
  // still fires instead of silently failing the strict 10-digit check.
  let phone = String(rawValue || '').replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (!/^[0-9]{10}$/.test(phone)) return;
  const nameEl = document.getElementById('nbName');
  const addressEl = document.getElementById('nbAddress');
  const cityEl = document.getElementById('nbCity');
  const msgEl = document.getElementById('nbMsg');
  // UX FIX: this lookup is a network call, so there's a brief but real
  // delay before the address actually appears — without this notice,
  // staff who don't wait a moment and start typing the address
  // themselves right away could end up "racing" the auto-fill (their own
  // typing correctly blocks it from overwriting), which looked like the
  // feature randomly not working. This tells them to wait for it.
  msgEl.className = 'msg-inline';
  msgEl.textContent = 'Checking if this number has booked before…';
  try {
    const match = await api(`/api/admin/customers/lookup/${phone}`);
    // The lookup could resolve after the field has since been edited/cleared
    // (fast typer, or they changed the number) — re-check right before
    // filling anything in, and only fill fields still blank.
    const currentDigits = document.getElementById('nbPhone').value.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (currentDigits !== phone) return;
    let filledSomething = false;
    if (!nameEl.value.trim() && match.name) { nameEl.value = match.name; filledSomething = true; }
    if (!addressEl.value.trim() && match.address) { addressEl.value = match.address; filledSomething = true; }
    if (match.cityId && [...cityEl.options].some(o => o.value === match.cityId)) {
      cityEl.value = match.cityId;
      await refreshNbAppliancesForCity(cityEl.value);
    }
    if (filledSomething) {
      msgEl.className = 'msg-inline success';
      msgEl.textContent = 'Existing customer found — address filled in from their last booking. Please confirm before saving.';
    } else {
      msgEl.className = 'msg-inline';
      msgEl.textContent = '';
    }
  } catch (e) {
    // 404 (no existing customer) is expected — clear the "checking…"
    // notice rather than leaving it stuck on screen.
    msgEl.className = 'msg-inline';
    msgEl.textContent = '';
  }
}
// Fires on every keystroke (normal typing) AND on blur (covers paste /
// autofill / mobile-keyboard edge cases where 'input' may not have fired
// for every character).
document.getElementById('nbPhone').addEventListener('input', (e) => tryAutoFillFromPhone(e.target.value));
document.getElementById('nbPhone').addEventListener('blur', (e) => tryAutoFillFromPhone(e.target.value));

// ---------- Day Lock UI (Orders tab) ----------
function renderUnlockedDates() {
  const el = document.getElementById('unlockedDatesList');
  if (!el) return; // this element only exists on the Super Admin panel, not Sub-Admin
  if (!UNLOCKED_DATES.length) {
    el.innerHTML = '<small style="color:var(--slate);">No dates are currently unlocked — everything before today is protected.</small>';
    return;
  }
  const sorted = [...UNLOCKED_DATES].sort().reverse();
  el.innerHTML = '<small style="color:var(--slate);display:block;margin-bottom:6px;">Currently unlocked (editable):</small><div class="chip-list">' +
    sorted.map(d => `
      <span class="chip" style="background:#fef3c7;color:#b45309;">
        ${new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        <button onclick="relockDate('${d}')" title="Re-lock this date">✕</button>
      </span>
    `).join('') + '</div>';
}

async function relockDate(date) {
  if (!confirm(`Re-lock ${date}? Bookings from this date will become protected again.`)) return;
  try {
    const res = await api('/api/admin/lock-date', { method: 'POST', body: JSON.stringify({ date }) });
    UNLOCKED_DATES = res.unlockedDates || [];
    renderUnlockedDates();
    renderOrders();
  } catch (e) { alert(e.message); }
}

const unlockDateBtn = document.getElementById('unlockDateBtn');
if (unlockDateBtn) {
  unlockDateBtn.addEventListener('click', async () => {
    const input = document.getElementById('unlockDateInput');
    const msg = document.getElementById('dayLockMsg');
    if (!input.value) return;
    if (!confirm(`Unlock ${input.value}? Bookings from this date can then be reassigned, reactivated, rated, or deleted until you re-lock it.`)) return;
    try {
      const res = await api('/api/admin/unlock-date', { method: 'POST', body: JSON.stringify({ date: input.value }) });
      UNLOCKED_DATES = res.unlockedDates || [];
      msg.className = 'msg-inline success';
      msg.textContent = `${input.value} is now unlocked.`;
      input.value = '';
      renderUnlockedDates();
      renderOrders();
    } catch (e) {
      msg.className = 'msg-inline error';
      msg.textContent = e.message;
    }
  });
}
renderUnlockedDates();

document.getElementById('archiveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('archiveMsg');
  const beforeDate = document.getElementById('archiveBeforeDate').value;
  if (!confirm(`Archive all fully-finished bookings created before ${beforeDate}? This just moves them out of the main list — nothing is deleted.`)) return;
  msg.className = 'msg-inline';
  msg.textContent = 'Archiving...';
  try {
    const res = await api('/api/admin/bookings/archive-old', { method: 'POST', body: JSON.stringify({ beforeDate }) });
    msg.className = 'msg-inline success';
    msg.textContent = res.archivedCount > 0 ? `Archived ${res.archivedCount} booking(s). ${res.remainingActive} remain active.` : res.message;
    if (res.archivedCount > 0) { await loadAll(); renderOrders(); }
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

document.getElementById('nbCity').addEventListener('change', () => refreshNbAppliancesForCity(document.getElementById('nbCity').value));
document.getElementById('nbAppliance').addEventListener('change', refreshNbTypes);
function refreshNbTypes() {
  const applianceId = document.getElementById('nbAppliance').value;
  const appliance = nbFilteredAppliances.find(a => a.id === applianceId);
  document.getElementById('nbType').innerHTML = appliance ? appliance.types.map(t => `<option value="${t.id}">${t.name}</option>`).join('') : '';
}

function renderNbCart() {
  const list = document.getElementById('nbCartList');
  const empty = document.getElementById('nbCartEmpty');
  if (!nbCartItems.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  const total = nbCartItems.reduce((s, it) => s + it.lineTotal, 0);
  list.innerHTML = nbCartItems.map((it, idx) => `
    <div class="cart-item">
      <div class="cart-item-info"><strong>${it.qty}x ${it.applianceName}</strong> — ${it.typeName}, ${it.serviceType === 'repair' ? 'Repair' : 'Service'}</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="cart-item-price">₹${fmtInr(it.lineTotal)}</span>
        <button type="button" class="cart-item-remove" onclick="removeNbCartItem(${idx})">✕</button>
      </div>
    </div>
  `).join('') + `<div class="cart-total-row"><span>Total (${nbCartItems.length} item${nbCartItems.length > 1 ? 's' : ''})</span><span class="amount">₹${fmtInr(total)}</span></div>`;
}
function removeNbCartItem(idx) {
  nbCartItems.splice(idx, 1);
  renderNbCart();
}

document.getElementById('nbAddItemBtn').addEventListener('click', async () => {
  const msg = document.getElementById('nbMsg');
  msg.className = 'msg-inline';
  const cityId = document.getElementById('nbCity').value;
  const applianceId = document.getElementById('nbAppliance').value;
  const typeId = document.getElementById('nbType').value;
  const serviceType = document.getElementById('nbServiceType').value;
  const qty = Math.max(1, parseInt(document.getElementById('nbQty').value, 10) || 1);
  const problem = document.getElementById('nbProblem').value.trim();

  if (!cityId || !applianceId || !typeId) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Please select city, appliance and type.';
    return;
  }
  if (!nbFilteredAppliances.some(a => a.id === applianceId)) {
    msg.className = 'msg-inline error';
    msg.textContent = 'This appliance is currently not available in the selected city.';
    return;
  }
  try {
    const row = await api(`/api/price?cityId=${cityId}&applianceId=${applianceId}&typeId=${typeId}`);
    const unitPrice = serviceType === 'repair' ? row.repairPrice : row.servicePrice;
    const appliance = nbFilteredAppliances.find(a => a.id === applianceId);
    const type = appliance ? appliance.types.find(t => t.id === typeId) : null;
    nbCartItems.push({
      applianceId, applianceName: appliance ? appliance.name : '',
      typeId, typeName: type ? type.name : '',
      serviceType, qty, problem, unitPrice, lineTotal: unitPrice * qty
    });
    renderNbCart();
    document.getElementById('nbProblem').value = '';
    document.getElementById('nbQty').value = 1;
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Could not get price for this selection.';
  }
});

document.getElementById('nbSubmitBtn').addEventListener('click', async () => {
  const msg = document.getElementById('nbMsg');
  msg.className = 'msg-inline';

  const name = document.getElementById('nbName').value.trim();
  const phone = document.getElementById('nbPhone').value.trim();
  const address = document.getElementById('nbAddress').value.trim();
  const cityId = document.getElementById('nbCity').value;

  if (!name || !address || !cityId) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Please fill in the customer name, address and city.';
    return;
  }
  if (!/^[0-9]{10}$/.test(phone)) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Please enter a valid 10 digit mobile number.';
    return;
  }
  const bookingDate = document.getElementById('nbDate').value;
  const timeSlotId = document.getElementById('nbSlotId').value;
  // BUG FIX: Visit Date and Time Slot used to be optional here, which
  // meant a lot of phone bookings ended up with no bookingDate/timeSlot
  // at all — and therefore no visit time ever showed anywhere (Orders
  // list, dashboard, customer history). Now required, same as the
  // customer-facing booking form.
  if (!bookingDate || !timeSlotId) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Please choose a visit date and time slot.';
    return;
  }
  if (!nbCartItems.length) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Please add at least one appliance to the booking.';
    return;
  }

  try {
    await api('/api/admin/bookings', {
      method: 'POST',
      body: JSON.stringify({
        name, phone, address, cityId,
        items: nbCartItems.map(it => ({ applianceId: it.applianceId, typeId: it.typeId, serviceType: it.serviceType, qty: it.qty, problem: it.problem })),
        bookingDate,
        timeSlotId
      })
    });
    BOOKINGS = await api('/api/admin/bookings');
    renderOrders(); renderDashboard();
    closeModal('newBookingModal');
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message || 'Could not create booking.';
  }
});

// ---------------- CITIES ----------------
function renderCities() {
  document.getElementById('citiesTable').innerHTML = CITIES.length ? CITIES.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td><span class="pill ${c.active ? 'pill-completed' : 'pill-rejected'}">${c.active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="toggleCity('${c.id}', ${!c.active})">${c.active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCity('${c.id}')">Delete</button>
      </td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="3">No cities found.</td></tr>`;
}

let addingCity = false;
document.getElementById('cityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addingCity) return; // ignore an extra click/Enter while the first add is still in flight — was creating duplicate cities (and a full duplicate set of pricing rows for every appliance)
  addingCity = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const msg = document.getElementById('cityMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/cities', { method: 'POST', body: JSON.stringify({ name: document.getElementById('newCityName').value }) });
    document.getElementById('newCityName').value = '';
    msg.className = 'msg-inline success'; msg.textContent = 'City added successfully!';
    await loadAll(); renderCities();
  } catch (err) {
    msg.className = 'msg-inline error'; msg.textContent = err.message;
  } finally {
    addingCity = false;
    submitBtn.disabled = false;
  }
});

async function toggleCity(id, active) {
  try {
    await api(`/api/admin/cities/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
    await loadAll(); renderCities();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}
async function deleteCity(id) {
  if (!confirm('Deleting this city will also delete all its pricing. Continue?')) return;
  try {
    await api(`/api/admin/cities/${id}`, { method: 'DELETE' });
    await loadAll(); renderCities();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// ---------------- APPLIANCES ----------------
function renderAppliances() {
  const wrap = document.getElementById('appliancesList');
  wrap.innerHTML = APPLIANCES.map(a => {
    const disabledCities = a.disabledCities || [];
    const isHidden = !!a.hidden;
    return `
    <div class="card">
      <div class="card-head">
        <h3>${a.name} ${isHidden ? '<span style="font-size:0.72rem;font-weight:700;color:#b45309;background:#fef3c7;padding:2px 8px;border-radius:999px;margin-left:6px;">HIDDEN</span>' : ''}</h3>
        <div>
          <button class="btn ${isHidden ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="toggleApplianceHidden('${a.id}', ${!isHidden})">
            ${isHidden ? '👁️ Show on Website' : '🙈 Hide from Website'}
          </button>
          <button class="btn btn-outline btn-sm" onclick="openTypeModal('${a.id}')">+ Add Type</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAppliance('${a.id}')">Appliance Delete</button>
        </div>
      </div>
      ${isHidden ? `<p style="font-size:0.82rem;color:#b45309;background:#fffbeb;border:1px solid #fde68a;padding:8px 12px;border-radius:8px;margin:0 0 12px;">This appliance is currently hidden — customers can't see or book it anywhere on the site (homepage, SEO pages, chatbot, sitemap). Click "Show on Website" above when it's ready to launch.</p>` : ''}
      <div class="chip-list">
        ${a.types.map(t => `<span class="chip">${t.name} <button onclick="deleteType('${a.id}','${t.id}')" title="Delete type">✕</button></span>`).join('') || '<span style="color:var(--slate);font-size:0.85rem;">No types added yet</span>'}
      </div>
      <div class="field" style="margin-top:14px;">
        <label>Available In Cities — uncheck a city to stop offering ${a.name} there (hidden from that city's page &amp; booking form)</label>
        <div class="chip-list">
          ${CITIES.map(c => `
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:0.85rem;background:var(--mist);padding:6px 10px;border-radius:6px;">
              <input type="checkbox" ${disabledCities.includes(c.id) ? '' : 'checked'} onchange="toggleApplianceCity('${a.id}','${c.id}', !this.checked)">
              ${c.name}
            </label>
          `).join('')}
        </div>
      </div>
      <div class="field" style="margin-top:14px;">
        <label>About This Service (shown in the "Appliance care, explained" section on the homepage — leave blank to hide this appliance from that section)</label>
        <textarea id="about-${a.id}" rows="4" placeholder="A short, customer-facing paragraph about this appliance's service — why it matters, common issues, what Seerua offers. Shown automatically on the homepage; leave blank and no block appears for this appliance.">${a.aboutText || ''}</textarea>
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px;">
          <button class="btn btn-outline btn-sm" onclick="saveApplianceAboutText('${a.id}')">Save About Text</button>
          <span class="msg-inline" id="aboutMsg-${a.id}" style="margin:0;"></span>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

// Toggles whether an appliance shows anywhere on the customer-facing
// site (homepage grid, SEO pages, sitemap, chatbot) — the same "hidden"
// flag already supported server-side, now with a one-click button here
// instead of needing to call the API directly.
async function toggleApplianceHidden(applianceId, hidden) {
  try {
    await api(`/api/admin/appliances/${applianceId}`, {
      method: 'PUT',
      body: JSON.stringify({ hidden })
    });
    const appliance = APPLIANCES.find(a => a.id === applianceId);
    if (appliance) appliance.hidden = hidden;
    renderAppliances();
  } catch (e) {
    alert('Could not update visibility: ' + e.message);
  }
}

async function toggleApplianceCity(applianceId, cityId, disabled) {
  try {
    await api(`/api/admin/appliances/${applianceId}/city-availability`, {
      method: 'PUT',
      body: JSON.stringify({ cityId, disabled })
    });
    await loadAll();
    renderAppliances();
  } catch (err) {
    alert(err.message || 'Could not update availability.');
    await loadAll();
    renderAppliances();
  }
}

async function saveApplianceAboutText(applianceId) {
  const textarea = document.getElementById(`about-${applianceId}`);
  const msg = document.getElementById(`aboutMsg-${applianceId}`);
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api(`/api/admin/appliances/${applianceId}`, {
      method: 'PUT',
      body: JSON.stringify({ aboutText: textarea.value })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    await loadAll();
    const a = APPLIANCES.find(x => x.id === applianceId);
    if (a) a.aboutText = textarea.value;
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
}

let addingAppliance = false;
document.getElementById('applianceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addingAppliance) return; // ignore an extra click/Enter while the first add is still in flight — was creating duplicate appliances
  addingAppliance = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const msg = document.getElementById('applianceMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/appliances', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('newApplianceName').value,
        aboutText: document.getElementById('newApplianceAboutText').value
      })
    });
    document.getElementById('newApplianceName').value = '';
    document.getElementById('newApplianceAboutText').value = '';
    msg.className = 'msg-inline success'; msg.textContent = 'Appliance added successfully!';
    await loadAll(); renderAppliances();
  } catch (err) {
    msg.className = 'msg-inline error'; msg.textContent = err.message;
  } finally {
    addingAppliance = false;
    submitBtn.disabled = false;
  }
});

async function deleteAppliance(id) {
  if (!confirm('Deleting this appliance will also delete all its types and pricing. Continue?')) return;
  try {
    await api(`/api/admin/appliances/${id}`, { method: 'DELETE' });
    await loadAll(); renderAppliances();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

function openTypeModal(applianceId) {
  typeApplianceId = applianceId;
  document.getElementById('newTypeName').value = '';
  openModal('typeModal');
}
let addingType = false;
document.getElementById('typeConfirmBtn').addEventListener('click', async () => {
  const name = document.getElementById('newTypeName').value.trim();
  if (!name) return;
  if (addingType) return; // ignore an extra click while the first add is still in flight — each type creates one pricing row PER CITY, so a duplicate click here was silently doubling up pricing rows for every city
  addingType = true;
  const btn = document.getElementById('typeConfirmBtn');
  btn.disabled = true;
  try {
    await api(`/api/admin/appliances/${typeApplianceId}/types`, { method: 'POST', body: JSON.stringify({ name }) });
    await loadAll(); renderAppliances();
    closeModal('typeModal');
  } finally {
    addingType = false;
    btn.disabled = false;
  }
});
async function deleteType(applianceId, typeId) {
  if (!confirm('Delete this type?')) return;
  try {
    await api(`/api/admin/appliances/${applianceId}/types/${typeId}`, { method: 'DELETE' });
    await loadAll(); renderAppliances();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// ---------------- PRICING ----------------
// BUGFIX: this used to rebuild the <select> options (and therefore reset the
// selection back to "All Cities"/"All Appliances") every single time
// renderPricing() ran — including right after the user picked a specific
// city/appliance, since that "change" event itself calls renderPricing().
// That made it look like nothing except "All" could ever be selected. Now
// we remember and restore the current selection across rebuilds.
function renderPricingFilters() {
  const citySel = document.getElementById('priceCityFilter');
  const applianceSel = document.getElementById('priceApplianceFilter');
  const prevCity = citySel.value;
  const prevAppliance = applianceSel.value;
  citySel.innerHTML = '<option value="">All Cities</option>' + CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  applianceSel.innerHTML = '<option value="">All Appliances</option>' + APPLIANCES.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  citySel.value = prevCity;
  applianceSel.value = prevAppliance;
}

function renderPricing() {
  renderPricingFilters();
  const cityFilter = document.getElementById('priceCityFilter').value;
  const applianceFilter = document.getElementById('priceApplianceFilter').value;
  let list = PRICING;
  if (cityFilter) list = list.filter(p => p.cityId === cityFilter);
  if (applianceFilter) list = list.filter(p => p.applianceId === applianceFilter);

  document.getElementById('pricingTable').innerHTML = list.length ? list.map(p => {
    const t = findType(p.applianceId, p.typeId);
    const appliance = APPLIANCES.find(a => a.id === p.applianceId);
    // Appliances with a defined services list (Service/Repair/
    // Installation/Uninstallation/Gas Filling etc. — this now covers every
    // appliance) are actually priced per-SKU via servicePrices, not the
    // old flat servicePrice/repairPrice fields — editing THOSE wouldn't
    // change anything the customer sees. Show one input per real service
    // instead, so every price shown to customers is actually editable here.
    const hasServices = t && Array.isArray(t.services) && t.services.length;
    const priceCell = hasServices
      ? `<div style="display:flex;flex-direction:column;gap:6px;min-width:220px;">
          ${t.services.map(svc => `
            <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;">
              <span style="flex:1;color:var(--slate);">${esc(svc.name)}</span>
              <input type="number" min="0" value="${(p.servicePrices && p.servicePrices[svc.id]) ?? ''}" id="sku-${p.id}-${svc.id}" style="width:90px;padding:5px 7px;border:1px solid var(--line);border-radius:6px;">
            </label>
          `).join('')}
        </div>`
      : `<input type="number" min="0" value="${p.servicePrice}" id="svc-${p.id}" style="width:90px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">`;
    const repairCell = hasServices
      ? `<span style="color:var(--slate);font-size:0.78rem;">— set per-service ↑</span>`
      : `<input type="number" min="0" value="${p.repairPrice}" id="rep-${p.id}" style="width:90px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">`;
    return `
      <tr>
        <td>${cityName(p.cityId)}</td>
        <td>${appliance ? appliance.name : '-'}</td>
        <td>${t ? t.name : '-'}</td>
        <td>${priceCell}</td>
        <td>${repairCell}</td>
        <td><button class="btn btn-success btn-sm" onclick="savePrice('${p.id}', '${hasServices ? (t.services || []).map(s => s.id).join(',') : ''}')">Save</button></td>
      </tr>
    `;
  }).join('') : `<tr class="empty-row"><td colspan="6">No price rows found.</td></tr>`;
}
document.getElementById('priceCityFilter').addEventListener('change', renderPricing);
document.getElementById('priceApplianceFilter').addEventListener('change', renderPricing);

async function savePrice(id, skuIdsCsv) {
  try {
    if (skuIdsCsv) {
      // Multi-service appliance — collect each SKU's input and send them all
      // as the servicePrices object (merged server-side, so this never wipes
      // out prices for services from a DIFFERENT type sharing the same row).
      // skuIdsCsv is a plain comma-separated string (not JSON) specifically
      // so it's safe to embed directly in the onclick="..." HTML attribute
      // above without any quote-escaping conflicts.
      const skuIds = skuIdsCsv.split(',');
      const servicePrices = {};
      skuIds.forEach(skuId => {
        const el = document.getElementById(`sku-${id}-${skuId}`);
        if (el && el.value !== '') servicePrices[skuId] = Number(el.value);
      });
      await api(`/api/admin/pricing/${id}`, { method: 'PUT', body: JSON.stringify({ servicePrices }) });
    } else {
      const servicePrice = document.getElementById(`svc-${id}`).value;
      const repairPrice = document.getElementById(`rep-${id}`).value;
      await api(`/api/admin/pricing/${id}`, { method: 'PUT', body: JSON.stringify({ servicePrice, repairPrice }) });
    }
    await loadAll();
    alert('Price updated successfully!');

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// ---------------- TIME SLOTS ----------------
let SLOTS_CONFIG = null;

// ---------------- REFER & EARN ----------------
async function renderReferrals() {
  const cfg = await api('/api/admin/referral-config');
  document.getElementById('refDiscount').value = cfg.referredDiscount;
  document.getElementById('refReward').value = cfg.referrerRewardAmount;
  document.getElementById('refExpiryDays').value = cfg.rewardExpiryDays;
  document.getElementById('refActive').checked = cfg.active;

  const uses = await api('/api/admin/referral-uses');
  document.getElementById('referralUsesTable').innerHTML = uses.length ? uses.map(u => `
    <tr>
      <td>${new Date(u.createdAt).toLocaleDateString('en-IN')}</td>
      <td>${u.referrerName || '-'}<br><small style="color:var(--slate)">${u.referrerPhone}</small></td>
      <td>${u.referredName || '-'}<br><small style="color:var(--slate)">${u.referredPhone}</small></td>
      <td>${u.bookingId}</td>
      <td>₹${fmtInr(u.discountGivenToReferred)}</td>
      <td>${u.rewardStatus === 'credited'
          ? `<span class="pill pill-completed">Credited</span><br><small style="color:var(--slate)">${u.rewardCouponCode}</small>`
          : `<span class="pill pill-pending">Pending completion</span>`}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="6">No referrals yet.</td></tr>`;
}

document.getElementById('referralConfigForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('referralConfigMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/referral-config', {
      method: 'PUT',
      body: JSON.stringify({
        referredDiscount: document.getElementById('refDiscount').value,
        referrerRewardAmount: document.getElementById('refReward').value,
        rewardExpiryDays: document.getElementById('refExpiryDays').value,
        active: document.getElementById('refActive').checked
      })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Settings saved!';
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

// ---------------- NOTIFICATIONS (SMS / WHATSAPP) ----------------
async function renderNotifications() {
  const cfg = await api('/api/admin/notification-config');
  document.getElementById('notifSmsEnabled').checked = !!cfg.smsEnabled;
  document.getElementById('notifWhatsappEnabled').checked = !!cfg.whatsappEnabled;
  document.getElementById('notifAuthkey').value = cfg.authkey || '';
  document.getElementById('notifSmsTemplateId').value = cfg.smsTemplateId || '';
  document.getElementById('notifSmsSenderId').value = cfg.smsSenderId || '';
  document.getElementById('notifWaNumber').value = cfg.whatsappIntegratedNumber || '';
  document.getElementById('notifWaTemplate').value = cfg.whatsappTemplateName || '';
  document.getElementById('notifCompletionSmsTemplateId').value = cfg.completionSmsTemplateId || '';
  document.getElementById('notifCompletionWaTemplate').value = cfg.completionWhatsappTemplateName || '';
  document.getElementById('notifTestMsg').className = 'msg-inline';
  document.getElementById('notifTestMsg').textContent = '';
}

document.getElementById('notifSmsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('notifSaveMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/notification-config', {
      method: 'PUT',
      body: JSON.stringify({
        smsEnabled: document.getElementById('notifSmsEnabled').checked,
        whatsappEnabled: document.getElementById('notifWhatsappEnabled').checked,
        authkey: document.getElementById('notifAuthkey').value.trim(),
        smsTemplateId: document.getElementById('notifSmsTemplateId').value.trim(),
        smsSenderId: document.getElementById('notifSmsSenderId').value.trim(),
        whatsappIntegratedNumber: document.getElementById('notifWaNumber').value.trim(),
        whatsappTemplateName: document.getElementById('notifWaTemplate').value.trim(),
        completionSmsTemplateId: document.getElementById('notifCompletionSmsTemplateId').value.trim(),
        completionWhatsappTemplateName: document.getElementById('notifCompletionWaTemplate').value.trim()
      })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Settings saved!';
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

document.getElementById('notifTestBtn').addEventListener('click', async () => {
  const phone = document.getElementById('notifTestPhone').value.trim();
  const msg = document.getElementById('notifTestMsg');
  msg.className = 'msg-inline';
  if (!/^[0-9]{10}$/.test(phone)) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Enter a valid 10 digit mobile number.';
    return;
  }
  const btn = document.getElementById('notifTestBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const { results } = await api('/api/admin/notification-config/test', {
      method: 'POST',
      body: JSON.stringify({ phone })
    });
    const lines = [];
    if (results.sms) lines.push(`SMS: ${results.sms}`);
    if (results.whatsapp) lines.push(`WhatsApp: ${results.whatsapp}`);
    const failed = (results.sms && results.sms.startsWith('failed')) || (results.whatsapp && results.whatsapp.startsWith('failed'));
    msg.className = failed ? 'msg-inline error' : 'msg-inline success';
    msg.textContent = lines.join(' · ');
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Booking-Confirmation Test';
  }
});

document.getElementById('notifTestCompletionBtn').addEventListener('click', async () => {
  const phone = document.getElementById('notifTestPhone').value.trim();
  const msg = document.getElementById('notifTestMsg');
  msg.className = 'msg-inline';
  if (!/^[0-9]{10}$/.test(phone)) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Enter a valid 10 digit mobile number.';
    return;
  }
  const btn = document.getElementById('notifTestCompletionBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const { results } = await api('/api/admin/notification-config/test-completion', {
      method: 'POST',
      body: JSON.stringify({ phone })
    });
    const lines = [];
    if (results.sms) lines.push(`SMS: ${results.sms}`);
    if (results.whatsapp) lines.push(`WhatsApp: ${results.whatsapp}`);
    const failed = (results.sms && results.sms.startsWith('failed')) || (results.whatsapp && results.whatsapp.startsWith('failed'));
    msg.className = failed ? 'msg-inline error' : 'msg-inline success';
    msg.textContent = lines.join(' · ');
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Completion Test';
  }
});

// ---------------- SITE RATING ----------------
async function renderSiteRating() {
  const data = await api('/api/admin/site-rating');
  document.getElementById('siteRatingInternalAvg').textContent = data.internal.avgRating ? `${data.internal.avgRating}★` : 'No ratings yet';
  document.getElementById('siteRatingInternalCount').textContent = data.internal.ratingCount;

  document.getElementById('gratEnabled').checked = !!data.google.enabled;
  document.getElementById('gratRating').value = data.google.rating != null ? data.google.rating : '';
  document.getElementById('gratReviewCount').value = data.google.reviewCount != null ? data.google.reviewCount : '';
  document.getElementById('gratProfileUrl').value = data.google.profileUrl || '';
  document.getElementById('gratMsg').className = 'msg-inline';
  document.getElementById('gratMsg').textContent = '';
}

document.getElementById('googleRatingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('gratMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/google-rating', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: document.getElementById('gratEnabled').checked,
        rating: document.getElementById('gratRating').value,
        reviewCount: document.getElementById('gratReviewCount').value,
        profileUrl: document.getElementById('gratProfileUrl').value.trim()
      })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved! The homepage will show this the next time it loads.';
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

function applianceName(id) { const a = APPLIANCES.find(x => x.id === id); return a ? a.name : '-'; }

async function renderSlots() {
  SLOTS_CONFIG = await api('/api/admin/slots-config');
  document.getElementById('slotCapacity').value = SLOTS_CONFIG.capacityPerSlot;
  document.getElementById('dailyJobLimit').value = SLOTS_CONFIG.dailyJobLimit || '';

  const citySel = document.getElementById('blockCity');
  citySel.innerHTML = CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const slotSel = document.getElementById('blockSlotId');
  slotSel.innerHTML = SLOTS_CONFIG.timeSlots.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
  const applianceSel = document.getElementById('blockAppliance');
  if (applianceSel) {
    applianceSel.innerHTML = '<option value="">All Appliances</option>' + APPLIANCES.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  }

  const tbody = document.getElementById('blockedSlotsTable');
  const blocked = SLOTS_CONFIG.blockedSlots;
  tbody.innerHTML = blocked.length ? blocked.map(b => {
    const slotLabel = (SLOTS_CONFIG.timeSlots.find(s => s.id === b.slotId) || {}).label || b.slotId;
    return `
      <tr>
        <td>${b.date}</td>
        <td>${cityName(b.cityId)}</td>
        <td>${b.applianceId ? applianceName(b.applianceId) : 'All appliances'}</td>
        <td>${slotLabel}</td>
        <td><button class="btn btn-danger btn-sm" onclick="unblockSlot('${b.date}','${b.slotId}','${b.cityId}','${b.applianceId || ''}')">Unblock</button></td>
      </tr>
    `;
  }).join('') : `<tr class="empty-row"><td colspan="5">No slots are manually blocked.</td></tr>`;
}

document.getElementById('saveCapacityBtn').addEventListener('click', async () => {
  const msg = document.getElementById('capacityMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/slots-config', { method: 'PUT', body: JSON.stringify({ capacityPerSlot: document.getElementById('slotCapacity').value }) });
    msg.className = 'msg-inline success';
    msg.textContent = 'Capacity saved!';
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

document.getElementById('saveDailyLimitBtn').addEventListener('click', async () => {
  const msg = document.getElementById('dailyLimitMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/slots-config', { method: 'PUT', body: JSON.stringify({ dailyJobLimit: document.getElementById('dailyJobLimit').value }) });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

document.getElementById('blockSlotBtn').addEventListener('click', async () => {
  const msg = document.getElementById('blockMsg');
  msg.className = 'msg-inline';
  const date = document.getElementById('blockDate').value;
  if (!date) {
    msg.className = 'msg-inline error';
    msg.textContent = 'Please choose a date.';
    return;
  }
  try {
    await api('/api/admin/slots-config/blocked', {
      method: 'POST',
      body: JSON.stringify({
        date,
        cityId: document.getElementById('blockCity').value,
        slotId: document.getElementById('blockSlotId').value,
        applianceId: document.getElementById('blockAppliance') ? document.getElementById('blockAppliance').value : ''
      })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Slot blocked!';
    await renderSlots();
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

async function unblockSlot(date, slotId, cityId, applianceId) {
  try {
    await api('/api/admin/slots-config/blocked', { method: 'DELETE', body: JSON.stringify({ date, slotId, cityId, applianceId: applianceId || '' }) });
    await renderSlots();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// ---------------- TECHNICIANS ----------------
function renderTechCityOptions() {
  document.getElementById('techCity').innerHTML = CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}
function renderTechSpecialityPicker() {
  document.getElementById('techSpecialityPicker').innerHTML = APPLIANCES.map(a => `
    <label class="chip" style="cursor:pointer;">
      <input type="checkbox" value="${a.id}" style="margin-right:4px;"> ${a.name}
    </label>
  `).join('');
}

function maskId(idNumber) {
  if (!idNumber) return '-';
  const digits = idNumber.replace(/\s|-/g, '');
  if (digits.length <= 4) return idNumber;
  return 'XXXX-XXXX-' + digits.slice(-4);
}

function renderTechnicians() {
  renderTechCityOptions();
  renderTechSpecialityPicker();
  document.getElementById('techTable').innerHTML = TECHNICIANS.length ? TECHNICIANS.map((t, idx) => `
    <tr>
      <td>#${idx + 1}</td>
      <td>${t.name}</td>
      <td>${t.phone}</td>
      <td>${cityName(t.city)}</td>
      <td>${(t.specialities || []).length ? (t.specialities || []).map(id => {
        const ap = (t.applianceBreakdown || {})[id];
        const label = ap && ap.avgRating ? `${applianceName(id)} ⭐${ap.avgRating}` : applianceName(id);
        return `<span class="chip" style="padding:2px 8px;font-size:0.76rem;" title="${ap ? `${ap.completedJobs} completed job${ap.completedJobs === 1 ? '' : 's'}${ap.avgRating ? `, rated ${ap.avgRating}/5` : ', not rated yet'}` : 'No completed jobs yet for this appliance'}">${label}</span>`;
      }).join(' ') : '<span style="color:var(--slate)">None set</span>'}</td>
      <td>${t.experienceYears || 0} yrs</td>
      <td>${t.idType ? `${t.idType}<br><small style="color:var(--slate)">${maskId(t.idNumber)}</small>` : '<span style="color:var(--slate)">Not provided</span>'}</td>
      <td>${t.completedJobs || 0} / ${t.rejectedJobs || 0}</td>
      <td>${t.avgRating ? `⭐ ${t.avgRating} <span style="color:var(--slate);font-size:0.76rem;">overall</span>` : '<span style="color:var(--slate)">Not rated</span>'}</td>
      <td>${liveStatusHtml(t)}</td>
      <td><span class="pill ${t.active ? 'pill-completed' : 'pill-rejected'}">${t.active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <button class="btn btn-outline btn-icon" onclick="openEditTech('${t.id}')" title="Edit">✏️</button>
        <button class="btn btn-outline btn-icon" onclick="viewTechPassword('${t.id}','${(t.name || '').replace(/'/g, "\\'")}')" title="View Password">👁️</button>
        <button class="btn btn-outline btn-icon" onclick="toggleTech('${t.id}', ${!t.active})" title="${t.active ? 'Deactivate' : 'Activate'}">${t.active ? '🚫' : '✅'}</button>
        <button class="btn btn-danger btn-icon" onclick="deleteTech('${t.id}')" title="Delete">🗑️</button>
      </td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="12">No technicians found.</td></tr>`;
}

// "Online" means their Technician Panel has pinged the server in the last
// ~90 seconds (see ONLINE_THRESHOLD_MS server-side) — a real presence signal,
// not just whether Admin has enabled their account (that's the separate
// Active/Inactive column). Helps decide who's likely to respond fast right now.
function liveStatusHtml(t) {
  if (t.isOnline) return `<span class="pill pill-completed" title="Pinged the server within the last 90 seconds">🟢 Online</span>`;
  if (!t.lastSeenAt) return `<span style="color:var(--slate);font-size:0.8rem;">Never logged in</span>`;
  const mins = Math.round((Date.now() - new Date(t.lastSeenAt).getTime()) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `<span style="color:var(--slate);font-size:0.8rem;" title="${new Date(t.lastSeenAt).toLocaleString('en-IN')}">⚪ Offline · ${ago}</span>`;
}

// Per-technician commission report — how much of each technician's
// completed-job revenue the company kept (their fixed ₹ rate) vs. how much
// they actually earned, with jobs the customer reviewed keeping the
// technician's full share. Loaded alongside the Technicians list.
let addingTechnician = false;
document.getElementById('techForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addingTechnician) return;
  addingTechnician = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  const msg = document.getElementById('techMsg');
  msg.className = 'msg-inline';
  const specialities = Array.from(document.querySelectorAll('#techSpecialityPicker input:checked')).map(i => i.value);
  try {
    await api('/api/admin/technicians', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('techName').value,
        phone: document.getElementById('techPhone').value,
        email: document.getElementById('techEmail').value,
        password: document.getElementById('techPassword').value,
        city: document.getElementById('techCity').value,
        specialities,
        experienceYears: document.getElementById('techExperience').value,
        idType: document.getElementById('techIdType').value,
        idNumber: document.getElementById('techIdNumber').value,
        dailyJobLimit: document.getElementById('techDailyLimit').value
      })
    });
    document.getElementById('techForm').reset();
    msg.className = 'msg-inline success'; msg.textContent = 'Technician added successfully!';
    // If this technician was added via "Make Partner" from a career
    // application, mark that application Hired now — so it's obvious at
    // a glance it's already been actioned, and nobody accidentally hits
    // "Make Partner" on the same application a second time.
    if (pendingHireApplicationId) {
      const appId = pendingHireApplicationId;
      pendingHireApplicationId = null;
      try { await updateApplicationStatus(appId, 'hired'); } catch (e) { /* non-critical — technician is already added either way */ }
    }
    await loadAll(); renderTechnicians();
  } catch (err) {
    msg.className = 'msg-inline error'; msg.textContent = err.message;
  } finally {
    addingTechnician = false;
    if (submitBtn) submitBtn.disabled = false;
  }
});

async function toggleTech(id, active) {
  try {
    await api(`/api/admin/technicians/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
    await loadAll(); renderTechnicians();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}
async function deleteTech(id) {
  if (!confirm('Delete this technician?')) return;
  try {
    await api(`/api/admin/technicians/${id}`, { method: 'DELETE' });
    await loadAll(); renderTechnicians();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// Fetches a technician's current login password on demand (a dedicated
// endpoint, not part of the main technician list) and shows it in a modal,
// so Admin can look it up later if they've forgotten what they set.
async function viewTechPassword(id, name) {
  const msg = document.getElementById('viewPasswordMsg');
  const valueEl = document.getElementById('viewPasswordValue');
  document.getElementById('viewPasswordTechName').textContent = name || '';
  valueEl.value = 'Loading...';
  msg.className = 'msg-inline';
  msg.textContent = '';
  openModal('viewPasswordModal');
  try {
    const data = await api(`/api/admin/technicians/${id}/password`);
    valueEl.value = data.password || '(not set)';
  } catch (e) {
    valueEl.value = '';
    msg.className = 'msg-inline error';
    msg.textContent = e.message;
  }
}

document.getElementById('copyPasswordBtn').addEventListener('click', async () => {
  const valueEl = document.getElementById('viewPasswordValue');
  const msg = document.getElementById('viewPasswordMsg');
  if (!valueEl.value || valueEl.value === 'Loading...') return;
  try {
    await navigator.clipboard.writeText(valueEl.value);
    msg.className = 'msg-inline success';
    msg.textContent = 'Copied!';
  } catch (e) {
    valueEl.select();
    msg.className = 'msg-inline';
    msg.textContent = 'Select and copy manually.';
  }
});

let editTechId = null;
function openEditTech(id) {
  const tech = TECHNICIANS.find(t => t.id === id);
  if (!tech) return;
  editTechId = id;
  document.getElementById('editTechName').value = tech.name || '';
  document.getElementById('editTechPhone').value = tech.phone || '';
  document.getElementById('editTechEmail').value = tech.email || '';
  document.getElementById('editTechPassword').value = '';
  document.getElementById('editTechExperience').value = tech.experienceYears || 0;
  document.getElementById('editTechIdType').value = tech.idType || '';
  document.getElementById('editTechIdNumber').value = tech.idNumber || '';
  document.getElementById('editTechDailyLimit').value = tech.dailyJobLimit || '';
  document.getElementById('editTechMsg').className = 'msg-inline';
  document.getElementById('editTechMsg').textContent = '';

  const citySel = document.getElementById('editTechCity');
  citySel.innerHTML = CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  citySel.value = tech.city;

  const picker = document.getElementById('editTechSpecialityPicker');
  picker.innerHTML = APPLIANCES.map(a => `
    <label class="chip" style="cursor:pointer;">
      <input type="checkbox" value="${a.id}" ${(tech.specialities || []).includes(a.id) ? 'checked' : ''} style="margin-right:4px;"> ${a.name}
    </label>
  `).join('');

  openModal('editTechModal');
}

document.getElementById('editTechConfirmBtn').addEventListener('click', async () => {
  const msg = document.getElementById('editTechMsg');
  msg.className = 'msg-inline';
  const specialities = Array.from(document.querySelectorAll('#editTechSpecialityPicker input:checked')).map(i => i.value);
  const payload = {
    name: document.getElementById('editTechName').value,
    phone: document.getElementById('editTechPhone').value,
    email: document.getElementById('editTechEmail').value,
    city: document.getElementById('editTechCity').value,
    specialities,
    experienceYears: document.getElementById('editTechExperience').value,
    idType: document.getElementById('editTechIdType').value,
    idNumber: document.getElementById('editTechIdNumber').value,
    dailyJobLimit: document.getElementById('editTechDailyLimit').value
  };
  const newPassword = document.getElementById('editTechPassword').value;
  if (newPassword) payload.password = newPassword;

  try {
    await api(`/api/admin/technicians/${editTechId}`, { method: 'PUT', body: JSON.stringify(payload) });
    await loadAll(); renderTechnicians();
    closeModal('editTechModal');
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

// ---------------- CAREER CITIES (Careers form dropdown, admin-managed, ----------------
// ---------------- separate from the main service-area Cities list) ----------------
function renderCareerCities() {
  const wrap = document.getElementById('careerCitiesList');
  wrap.innerHTML = CAREER_CITIES.length ? CAREER_CITIES.map(c => `
    <span class="chip">${c.name} <button onclick="deleteCareerCity('${c.id}')" title="Delete">✕</button></span>
  `).join('') : '<span style="color:var(--slate);font-size:0.85rem;">No cities added yet.</span>';
}

let addingCareerCity = false;
document.getElementById('careerCityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addingCareerCity) return;
  addingCareerCity = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const msg = document.getElementById('careerCityMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/career-cities', { method: 'POST', body: JSON.stringify({ name: document.getElementById('newCareerCityName').value }) });
    document.getElementById('newCareerCityName').value = '';
    msg.className = 'msg-inline success'; msg.textContent = 'Added!';
    await loadAll(); renderCareerCities();
  } catch (err) {
    msg.className = 'msg-inline error'; msg.textContent = err.message;
  } finally {
    addingCareerCity = false;
    submitBtn.disabled = false;
  }
});

async function deleteCareerCity(id) {
  if (!confirm('Delete this city? It will no longer appear as a Careers form option.')) return;
  try {
    await api(`/api/admin/career-cities/${id}`, { method: 'DELETE' });
    await loadAll(); renderCareerCities();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// ---------------- CAREER APPLIANCES (Careers form checkboxes, admin-managed, ----------------
// ---------------- separate from the main service Appliances list) ----------------
function renderCareerAppliances() {
  const wrap = document.getElementById('careerAppliancesList');
  wrap.innerHTML = CAREER_APPLIANCES.length ? CAREER_APPLIANCES.map(a => `
    <span class="chip">${a.name} <button onclick="deleteCareerAppliance('${a.id}')" title="Delete">✕</button></span>
  `).join('') : '<span style="color:var(--slate);font-size:0.85rem;">No appliances added yet.</span>';
}

let addingCareerAppliance = false;
document.getElementById('careerApplianceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addingCareerAppliance) return;
  addingCareerAppliance = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const msg = document.getElementById('careerApplianceMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/career-appliances', { method: 'POST', body: JSON.stringify({ name: document.getElementById('newCareerApplianceName').value }) });
    document.getElementById('newCareerApplianceName').value = '';
    msg.className = 'msg-inline success'; msg.textContent = 'Added!';
    await loadAll(); renderCareerAppliances();
  } catch (err) {
    msg.className = 'msg-inline error'; msg.textContent = err.message;
  } finally {
    addingCareerAppliance = false;
    submitBtn.disabled = false;
  }
});

async function deleteCareerAppliance(id) {
  if (!confirm('Delete this appliance? It will no longer appear as a Careers form option.')) return;
  try {
    await api(`/api/admin/career-appliances/${id}`, { method: 'DELETE' });
    await loadAll(); renderCareerAppliances();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// ---------------- EDUCATION LEVELS (Careers form dropdown, admin-managed) ----------------
function renderEducationLevels() {
  const wrap = document.getElementById('educationLevelsList');
  wrap.innerHTML = EDUCATION_LEVELS.length ? EDUCATION_LEVELS.map(ed => `
    <span class="chip">${ed.name} <button onclick="deleteEducationLevel('${ed.id}')" title="Delete">✕</button></span>
  `).join('') : '<span style="color:var(--slate);font-size:0.85rem;">No education levels added yet.</span>';
}

let addingEducation = false;
document.getElementById('educationForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addingEducation) return;
  addingEducation = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const msg = document.getElementById('educationMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/education-levels', { method: 'POST', body: JSON.stringify({ name: document.getElementById('newEducationName').value }) });
    document.getElementById('newEducationName').value = '';
    msg.className = 'msg-inline success'; msg.textContent = 'Added!';
    await loadAll(); renderEducationLevels();
  } catch (err) {
    msg.className = 'msg-inline error'; msg.textContent = err.message;
  } finally {
    addingEducation = false;
    submitBtn.disabled = false;
  }
});

async function deleteEducationLevel(id) {
  if (!confirm('Delete this education level? It will no longer appear as a Careers form option.')) return;
  try {
    await api(`/api/admin/education-levels/${id}`, { method: 'DELETE' });
    await loadAll(); renderEducationLevels();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// ---------------- CAREER APPLICATIONS ----------------
let APPLICATIONS = [];

async function renderApplications() {
  APPLICATIONS = await api('/api/admin/technician-applications');

  const cityFilter = document.getElementById('appCityFilter');
  if (cityFilter.options.length <= 1) {
    cityFilter.innerHTML = '<option value="">All Cities</option>' + CAREER_CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  renderCareerCities();
  renderCareerAppliances();
  renderEducationLevels();
  renderHiringStatus();
  drawApplications();
}

async function renderHiringStatus() {
  const status = await api('/api/admin/hiring-status');
  document.getElementById('hiringPausedToggle').checked = status.hiringPaused;
  document.getElementById('hiringStatusLabel').textContent = status.hiringPaused
    ? '⏸️ Hiring is PAUSED — Careers page is showing the "not hiring" notice'
    : '✅ Hiring is OPEN — Careers page is accepting applications';
  document.getElementById('hiringPausedMessageInput').value = status.hiringPausedMessage || '';
}

async function toggleHiringPaused(checked) {
  const msg = document.getElementById('hiringStatusMsg');
  try {
    await api('/api/admin/hiring-status', { method: 'PUT', body: JSON.stringify({ hiringPaused: checked }) });
    await renderHiringStatus();
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2000);
  } catch (e) {
    msg.className = 'msg-inline error';
    msg.textContent = e.message;
  }
}

async function saveHiringPausedMessage() {
  const msg = document.getElementById('hiringStatusMsg');
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api('/api/admin/hiring-status', { method: 'PUT', body: JSON.stringify({ hiringPausedMessage: document.getElementById('hiringPausedMessageInput').value }) });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2000);
  } catch (e) {
    msg.className = 'msg-inline error';
    msg.textContent = e.message;
  }
}

function drawApplications() {
  const statusFilter = document.getElementById('appStatusFilter').value;
  const cityFilterVal = document.getElementById('appCityFilter').value;
  let list = APPLICATIONS;
  if (statusFilter) {
    list = list.filter(a => a.status === statusFilter);
  } else {
    // Default view (no filter selected) hides "Hired" applicants — once
    // someone's been made a partner/technician, they're no longer a
    // pending applicant, so they shouldn't clutter this list. Select
    // "Hired" in the filter above to see them again if needed.
    list = list.filter(a => a.status !== 'hired');
  }
  if (cityFilterVal) list = list.filter(a => a.cityId === cityFilterVal);

  document.getElementById('applicationsTable').innerHTML = list.length ? list.map(a => `
    <tr>
      <td>${new Date(a.createdAt).toLocaleDateString('en-IN')}</td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.phone)}<br><small style="color:var(--slate)">${esc(a.address)}</small></td>
      <td>${a.cityName}</td>
      <td>${a.applianceNames.join(', ')}</td>
      <td>${a.educationName || '<span style="color:var(--slate)">-</span>'}</td>
      <td>${a.experienceYears} yrs</td>
      <td>${a.idType ? `${esc(a.idType)}<br><small style="color:var(--slate)">${esc(maskId(a.idNumber))}</small>` : '<span style="color:var(--slate)">-</span>'}</td>
      <td><small style="color:var(--slate)">${a.notes ? esc(a.notes) : '-'}</small></td>
      <td>
        <select onchange="updateApplicationStatus('${a.id}', this.value)" style="padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-size:0.8rem;">
          <option value="new" ${a.status === 'new' ? 'selected' : ''}>New</option>
          <option value="contacted" ${a.status === 'contacted' ? 'selected' : ''}>Contacted</option>
          <option value="hired" ${a.status === 'hired' ? 'selected' : ''}>Hired</option>
          <option value="rejected" ${a.status === 'rejected' ? 'selected' : ''}>Rejected</option>
        </select>
      </td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="convertApplicationToTechnician('${a.id}')" title="Pre-fill the Add Technician form with this applicant's details">Make Partner</button>
        <button class="btn btn-danger btn-sm" onclick="deleteApplication('${a.id}')">Delete</button>
      </td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="11">${!statusFilter && APPLICATIONS.some(a => a.status === 'hired') ? 'No pending applications — everyone who applied has already been made a partner. Select "Hired" above to see them.' : 'No applications yet.'}</td></tr>`;
}
document.getElementById('appStatusFilter').addEventListener('change', drawApplications);
document.getElementById('appCityFilter').addEventListener('change', drawApplications);

async function updateApplicationStatus(id, status) {
  try {
    await api(`/api/admin/technician-applications/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    const app = APPLICATIONS.find(a => a.id === id);
    if (app) app.status = status;
    drawApplications(); // re-render immediately so a newly-"hired" applicant disappears from the default view right away

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}
async function deleteApplication(id) {
  if (!confirm('Delete this application?')) return;
  try {
    await api(`/api/admin/technician-applications/${id}`, { method: 'DELETE' });
    await renderApplications();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

// "Make Partner" — jumps to the Technicians tab and pre-fills the Add
// Technician form with everything this applicant already gave us (name,
// phone, city, appliances, experience, ID), so the Admin only needs to set
// a login password and click Add.
let pendingHireApplicationId = null; // set by "Make Partner" so a successful Add Technician can auto-mark that application Hired

function convertApplicationToTechnician(id) {
  const app = APPLICATIONS.find(a => a.id === id);
  if (!app) return;
  pendingHireApplicationId = id;
  switchView('technicians');
  document.getElementById('techName').value = app.name || '';
  document.getElementById('techPhone').value = app.phone || '';
  document.getElementById('techExperience').value = app.experienceYears || 0;
  document.getElementById('techIdType').value = app.idType || '';
  document.getElementById('techIdNumber').value = app.idNumber || '';
  // app.cityId refers to the separate Career Cities list, not the main
  // service-area Cities list the Technician form's dropdown is built from —
  // match by name instead, and leave it blank for Admin to pick if there's
  // no matching service-area city yet.
  const citySel = document.getElementById('techCity');
  if (citySel) {
    const match = CITIES.find(c => c.name.trim().toLowerCase() === (app.cityName || '').trim().toLowerCase());
    citySel.value = match ? match.id : '';
  }
  // app.applianceIds refers to the separate Career Appliances list, not the
  // main service Appliances list the Technician form's checkboxes are built
  // from — match by name instead, since the two lists use different IDs.
  const appliedApplianceNames = new Set((app.applianceNames || []).map(n => n.trim().toLowerCase()));
  document.querySelectorAll('#techSpecialityPicker input[type="checkbox"]').forEach(cb => {
    const mainAppliance = APPLIANCES.find(a => a.id === cb.value);
    cb.checked = !!mainAppliance && appliedApplianceNames.has(mainAppliance.name.trim().toLowerCase());
  });
  const msg = document.getElementById('techMsg');
  msg.className = 'msg-inline success';
  msg.textContent = `Pre-filled from ${app.name}'s application — set a login password below, then click "Add Technician".`;
  document.getElementById('techPassword').focus();
}

// ---------------- CUSTOMERS ----------------
let CUSTOMERS = [];
async function renderCustomers() {
  CUSTOMERS = await api('/api/admin/customers');
  drawCustomers(CUSTOMERS);
}
function drawCustomers(list) {
  document.getElementById('customersTable').innerHTML = list.length ? list.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${c.phone}</td>
      <td>${c.totalOrders}</td>
      <td>₹${fmtInr(c.totalSpent)}</td>
      <td><button class="btn btn-outline btn-sm" onclick="viewCustomer('${c.phone}')">View History</button></td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="5">No customers yet.</td></tr>`;
}
document.getElementById('customerSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  drawCustomers(CUSTOMERS.filter(c => c.name.toLowerCase().includes(q) || c.phone.includes(q)));
});

function viewCustomer(phone) {
  const c = CUSTOMERS.find(x => x.phone === phone);
  if (!c) return;
  document.getElementById('customerModalName').textContent = `${c.name} — ${c.phone}`;
  document.getElementById('customerModalBody').innerHTML = `
    <p style="color:var(--slate);font-size:0.88rem;">${esc(c.address || '')}${c.source === 'manual' ? ' <span class="pill" style="background:var(--mist);">Registered manually — no booking yet</span>' : ''}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Time</th><th>Appliance</th><th>Status</th><th>Price</th></tr></thead>
      <tbody>
        ${c.orders.length ? c.orders.map(o => `<tr><td>${new Date(o.createdAt).toLocaleDateString('en-IN')}</td><td>${o.timeSlot || '-'}</td><td>${itemsSummary(o)}</td><td>${o.items.map(it => `<span class="pill pill-${it.itemStatus}">${it.itemStatus.replace('-', ' ')}</span>`).join(' ')}</td><td>₹${fmtInr(o.totalPrice)}</td></tr>`).join('') : `<tr class="empty-row"><td colspan="5">No bookings yet.</td></tr>`}
      </tbody>
    </table></div>
  `;
  openModal('customerModal');
}

// ---------------- SUB-ADMINS ----------------
let SUBADMINS = [];
function cityNamesFor(cityIds) {
  if (!cityIds || !cityIds.length) return 'All Cities';
  return cityIds.map(id => { const c = CITIES.find(x => x.id === id); return c ? c.name : id; }).join(', ');
}
async function renderSubAdmins() {
  SUBADMINS = await api('/api/admin/subadmins');

  // "Add New Admin" city picker
  document.getElementById('saCityPicker').innerHTML = CITIES.map(c => `
    <label class="chip" style="cursor:pointer;">
      <input type="checkbox" value="${c.id}" name="saCity" style="margin-right:5px;">${c.name}
    </label>
  `).join('');

  document.getElementById('subAdminsTable').innerHTML = SUBADMINS.length ? SUBADMINS.map(s => `
    <tr>
      <td>${s.name}</td>
      <td>${s.username}</td>
      <td>${cityNamesFor(s.cityIds)} <button class="btn btn-outline btn-sm" style="margin-left:4px;" onclick="openSubAdminCitiesModal('${s.id}')">Edit</button></td>
      <td><span class="pill ${s.active ? 'pill-completed' : 'pill-rejected'}">${s.active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="toggleSubAdmin('${s.id}', ${!s.active})">${s.active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSubAdmin('${s.id}')">Delete</button>
      </td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="5">No sub-admins yet.</td></tr>`;
}

document.getElementById('subAdminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('subAdminMsg');
  msg.className = 'msg-inline';
  const cityIds = Array.from(document.querySelectorAll('input[name="saCity"]:checked')).map(i => i.value);
  try {
    await api('/api/admin/subadmins', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('saName').value,
        username: document.getElementById('saUsername').value,
        password: document.getElementById('saPassword').value,
        cityIds
      })
    });
    document.getElementById('subAdminForm').reset();
    msg.className = 'msg-inline success';
    msg.textContent = 'Admin added! They can log in at /admin.';
    await renderSubAdmins();
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

async function toggleSubAdmin(id, active) {
  try {
    await api(`/api/admin/subadmins/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
    await renderSubAdmins();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

let subAdminCitiesEditId = null;
function openSubAdminCitiesModal(id) {
  const sub = SUBADMINS.find(s => s.id === id);
  if (!sub) return;
  subAdminCitiesEditId = id;
  document.getElementById('subAdminCitiesName').textContent = sub.name;
  const assigned = sub.cityIds || [];
  document.getElementById('subAdminCitiesPicker').innerHTML = CITIES.map(c => `
    <label class="chip" style="cursor:pointer;">
      <input type="checkbox" value="${c.id}" name="subAdminCity" ${assigned.includes(c.id) ? 'checked' : ''} style="margin-right:5px;">${c.name}
    </label>
  `).join('');
  openModal('subAdminCitiesModal');
}
document.getElementById('subAdminCitiesConfirmBtn').addEventListener('click', async () => {
  const cityIds = Array.from(document.querySelectorAll('input[name="subAdminCity"]:checked')).map(i => i.value);
  try {
    await api(`/api/admin/subadmins/${subAdminCitiesEditId}`, { method: 'PUT', body: JSON.stringify({ cityIds }) });
    closeModal('subAdminCitiesModal');
    await renderSubAdmins();
  } catch (err) {
    alert(err.message || 'Could not save. Please try again.');
  }
});
async function deleteSubAdmin(id) {
  if (!confirm('Delete this sub-admin?')) return;
  try {
    await api(`/api/admin/subadmins/${id}`, { method: 'DELETE' });
    await renderSubAdmins();
  } catch (err) {
    alert(err.message || 'Could not delete. Please try again.');
  }
}

// ---------------- REPORTS ----------------
async function renderReport() {
  const dateInput = document.getElementById('reportDate');
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
  document.getElementById('exportReportBtn').href = `/api/admin/reports/daily/export?date=${dateInput.value}`;
  const data = await api(`/api/admin/reports/daily?date=${dateInput.value}`);
  document.getElementById('reportStats').innerHTML = `
    <div class="stat-card"><div class="val">${data.newBookings}</div><div class="lbl">New Bookings</div></div>
    <div class="stat-card"><div class="val">${data.completedCount}</div><div class="lbl">Completed Services</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.revenue)}</div><div class="lbl">Today's Revenue</div></div>
    <div class="stat-card"><div class="val">${Object.keys(data.byAppliance).length}</div><div class="lbl">Appliance Categories</div></div>
  `;
  document.getElementById('reportCompletedTable').innerHTML = data.completed.length ? data.completed.map(it => `
    <tr>
      <td>${it.bookingId}</td>
      <td>${it.name}</td>
      <td>${it.qty}x ${it.applianceName} (${it.typeName}) — ${it.serviceType === 'repair' ? 'Repair' : 'Service'}</td>
      <td>${it.cityName}</td>
      <td>${it.technicianName || '-'}</td>
      <td>${it.rating ? `⭐${it.rating}` : '-'}</td>
      <td>₹${fmtInr(it.lineTotal)}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="7">No services were completed on this date.</td></tr>`;
}
document.getElementById('reportDate').addEventListener('change', renderReport);

// ---------------- COMMISSION ----------------
function renderCommissionApplianceRates(rateCfg) {
  const wrap = document.getElementById('commissionApplianceRatesList');
  const perAppliance = rateCfg.perApplianceRates || {};
  const defaultLabel = rateCfg.mode === 'percent' ? `${rateCfg.percentValue || 0}%` : `₹${fmtInr(rateCfg.amountPerService)}`;
  wrap.innerHTML = APPLIANCES.map(a => {
    const raw = perAppliance[a.id]; // legacy: plain number, or {mode, value}
    const existing = (raw !== undefined && raw !== null)
      ? (typeof raw === 'number' ? { mode: 'flat', value: raw } : raw)
      : null;
    const mode = existing ? existing.mode : 'flat';
    const value = existing ? existing.value : '';
    return `
    <div class="field" style="display:flex;align-items:center;gap:10px;max-width:440px;margin-bottom:10px;flex-wrap:wrap;">
      <label style="flex:1;margin:0;min-width:100px;">${esc(a.name)}</label>
      <select id="applianceRateMode-${a.id}" style="width:90px;" onchange="saveCommissionApplianceRate('${a.id}', document.getElementById('applianceRate-${a.id}').value, this.value)">
        <option value="flat" ${mode === 'flat' ? 'selected' : ''}>₹ Flat</option>
        <option value="percent" ${mode === 'percent' ? 'selected' : ''}>%</option>
      </select>
      <input type="number" min="0" step="1" id="applianceRate-${a.id}" value="${value}" placeholder="Use ${defaultLabel} default" style="width:150px;" onchange="saveCommissionApplianceRate('${a.id}', this.value, document.getElementById('applianceRateMode-${a.id}').value)">
      <span class="msg-inline" id="applianceRateMsg-${a.id}" style="margin:0;"></span>
    </div>
  `;
  }).join('');
}

async function saveCommissionApplianceRate(applianceId, value, mode) {
  const msg = document.getElementById(`applianceRateMsg-${applianceId}`);
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api('/api/admin/commission-config/appliance-rate', {
      method: 'PUT',
      body: JSON.stringify({ applianceId, amount: value, mode })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2000);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
}

// The most specific tier of the three — a technician's own rate here
// overrides both the per-appliance rate and the shared default for every
// job they do. Uses the same PUT /api/admin/technicians/:id endpoint the
// old Add/Edit Technician form used to call, just from here instead, so
// everything commission-related lives in this one tab.
function renderCommissionTechRates() {
  const wrap = document.getElementById('commissionTechRatesList');
  if (!TECHNICIANS.length) {
    wrap.innerHTML = '<p style="color:var(--slate);font-size:0.85rem;">No technicians yet.</p>';
    return;
  }
  wrap.innerHTML = TECHNICIANS.map(t => `
    <div class="field" style="display:flex;align-items:center;gap:10px;max-width:440px;margin-bottom:10px;flex-wrap:wrap;">
      <label style="flex:1;margin:0;min-width:100px;">${esc(t.name)}</label>
      <select id="techRateMode-${t.id}" style="width:90px;" onchange="saveCommissionTechRate('${t.id}', document.getElementById('techRate-${t.id}').value, this.value)">
        <option value="flat" ${(t.variableAmountMode || 'flat') === 'flat' ? 'selected' : ''}>₹ Flat</option>
        <option value="percent" ${t.variableAmountMode === 'percent' ? 'selected' : ''}>%</option>
      </select>
      <input type="number" min="0" step="1" id="techRate-${t.id}" value="${(t.variableAmount === null || t.variableAmount === undefined) ? '' : t.variableAmount}" placeholder="Use shared/appliance rate" style="width:150px;" onchange="saveCommissionTechRate('${t.id}', this.value, document.getElementById('techRateMode-${t.id}').value)">
      <span class="msg-inline" id="techRateMsg-${t.id}" style="margin:0;"></span>
    </div>
  `).join('');
}

async function saveCommissionTechRate(technicianId, value, mode) {
  const msg = document.getElementById(`techRateMsg-${technicianId}`);
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api(`/api/admin/technicians/${technicianId}`, {
      method: 'PUT',
      body: JSON.stringify({ variableAmount: value, variableAmountMode: mode })
    });
    const tech = TECHNICIANS.find(t => t.id === technicianId);
    if (tech) { tech.variableAmount = (value === '' ? null : Number(value)); tech.variableAmountMode = mode; }
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2000);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
}

// Shows each technician's "paid up to" marker plus how much commission
// has piled up since then, with a date picker + button to move the
// marker forward whenever Admin actually collects from them.
async function renderCommissionPaymentStatus() {
  const wrap = document.getElementById('commissionPaymentStatusList');
  const data = await api('/api/admin/commission/payment-status');
  if (!data.technicians.length) {
    wrap.innerHTML = '<p style="color:var(--slate);font-size:0.85rem;">No technicians yet.</p>';
    return;
  }
  wrap.innerHTML = data.technicians.map(t => `
    <div class="card" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div>
          <strong>${t.technicianName}</strong>
          <div style="font-size:0.82rem;color:var(--slate);margin-top:2px;">
            Paid up to: ${t.commissionPaidUpTo ? t.commissionPaidUpTo : '<span style="color:var(--red);">never marked</span>'}
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700;color:${t.pendingCommission > 0 ? 'var(--red)' : 'var(--green)'};">₹${fmtInr(t.pendingCommission)} pending</div>
          <div style="font-size:0.78rem;color:var(--slate);">${t.pendingJobs} unpaid job${t.pendingJobs === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <input type="date" id="paidUpTo-${t.technicianId}" value="${t.commissionPaidUpTo || new Date().toISOString().slice(0, 10)}" style="max-width:170px;">
        <button class="btn btn-primary btn-sm" onclick="saveCommissionPaidUpTo('${t.technicianId}')">Mark Paid Up To This Date</button>
        ${t.commissionPaidUpTo ? `<button class="btn btn-outline btn-sm" onclick="undoCommissionPaidUpTo('${t.technicianId}')" title="Marked the wrong date by mistake? This resets it back to 'never marked' — nothing is deleted, jobs just show as pending again until you mark the correct date.">↺ Undo</button>` : ''}
        <span class="msg-inline" id="paidUpToMsg-${t.technicianId}" style="margin:0;"></span>
      </div>
    </div>
  `).join('');
}

// Prompts for the 4-digit PIN if one has been set (see paymentPinIsSet,
// loaded once when the Commission tab renders); returns null (and does
// NOT proceed) if the person cancels, so callers can just bail out on a
// null return. If no PIN has ever been set, returns '' immediately —
// the server-side check is the same either way (see
// /api/admin/technicians/:id/commission-paid), so this is purely a nicer
// prompt, not a security boundary by itself.
function promptForPaymentPin() {
  if (!paymentPinIsSet) return '';
  const pin = prompt('Enter your 4-digit Payment Action PIN to continue:');
  if (pin === null) return null; // cancelled
  return pin;
}

async function undoCommissionPaidUpTo(technicianId) {
  if (!confirm('Undo this? The technician\'s jobs will show as pending/unpaid again until you mark a new date.')) return;
  const pin = promptForPaymentPin();
  if (pin === null) return;
  const msg = document.getElementById(`paidUpToMsg-${technicianId}`);
  msg.className = 'msg-inline';
  msg.textContent = 'Undoing...';
  try {
    await api(`/api/admin/technicians/${technicianId}/commission-paid`, {
      method: 'PUT',
      body: JSON.stringify({ paidUpToDate: '', pin })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Undone!';
    await renderCommissionPaymentStatus();
    if (document.getElementById('commissionSearchTable').innerHTML.trim()) runCommissionSearch();
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
}

async function saveCommissionPaidUpTo(technicianId) {
  const dateVal = document.getElementById(`paidUpTo-${technicianId}`).value;
  const pin = promptForPaymentPin();
  if (pin === null) return;
  const msg = document.getElementById(`paidUpToMsg-${technicianId}`);
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api(`/api/admin/technicians/${technicianId}/commission-paid`, {
      method: 'PUT',
      body: JSON.stringify({ paidUpToDate: dateVal, pin })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    await renderCommissionPaymentStatus();
    // The Full Work Report's Payment column depends on this too, so keep
    // it in sync if the admin already has results on screen.
    if (document.getElementById('commissionSearchTable').children.length) runCommissionSearch();
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
}

// Whether a Payment Action PIN has been set — checked before "Mark Paid"/
// "Undo" prompt for one (see promptForPaymentPin above). Kept as a
// module-level flag rather than re-fetched on every click so the button
// doesn't need an extra round-trip each time.
let paymentPinIsSet = false;

async function renderPaymentPinStatus() {
  const status = await api('/api/admin/payment-pin/status');
  paymentPinIsSet = status.hasPinSet;
  document.getElementById('paymentPinStatus').innerHTML = status.hasPinSet
    ? '🔒 <strong style="color:var(--green);">PIN is set</strong> — required for Mark Paid / Undo below.'
    : '🔓 <strong style="color:var(--amber);">No PIN set yet</strong> — Mark Paid / Undo currently need no extra confirmation.';
  document.getElementById('paymentPinCurrentField').style.display = status.hasPinSet ? '' : 'none';
  document.getElementById('paymentPinNewLabel').textContent = status.hasPinSet ? 'New 4-digit PIN' : 'Set 4-digit PIN';
  // Always starts back in "enter current PIN" mode on a fresh render —
  // avoids the toggle staying stuck in "forgot PIN" mode across visits.
  paymentPinRecoveryMode = false;
  document.getElementById('paymentPinCurrentLabel').textContent = 'Current PIN';
  document.getElementById('forgotPinLink').textContent = 'Forgot PIN? Use Admin password instead';
  document.getElementById('paymentPinCurrent').placeholder = '••••';
  document.getElementById('paymentPinCurrent').maxLength = 4;
  document.getElementById('paymentPinCurrent').setAttribute('pattern', '[0-9]{4}');
}

// Toggles between "enter your current PIN" and "forgot it? use your
// Admin login password instead" — the input itself is reused for both
// (only the label and what field name it gets submitted as changes),
// so this stays a single simple field rather than two separate inputs
// competing for space.
let paymentPinRecoveryMode = false;
document.getElementById('forgotPinLink').addEventListener('click', (e) => {
  e.preventDefault();
  paymentPinRecoveryMode = !paymentPinRecoveryMode;
  document.getElementById('paymentPinCurrentLabel').textContent = paymentPinRecoveryMode ? 'Your Admin Password' : 'Current PIN';
  document.getElementById('paymentPinCurrent').type = paymentPinRecoveryMode ? 'password' : 'password';
  document.getElementById('paymentPinCurrent').removeAttribute('maxlength');
  document.getElementById('paymentPinCurrent').removeAttribute('pattern');
  document.getElementById('paymentPinCurrent').placeholder = paymentPinRecoveryMode ? 'Your Admin login password' : '••••';
  document.getElementById('paymentPinCurrent').value = '';
  e.target.textContent = paymentPinRecoveryMode ? 'Have your PIN? Use it instead' : 'Forgot PIN? Use Admin password instead';
});

document.getElementById('paymentPinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('paymentPinMsg');
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  const verificationValue = document.getElementById('paymentPinCurrent').value;
  try {
    await api('/api/admin/payment-pin', {
      method: 'PUT',
      body: JSON.stringify({
        currentPin: paymentPinRecoveryMode ? undefined : verificationValue,
        adminPassword: paymentPinRecoveryMode ? verificationValue : undefined,
        newPin: document.getElementById('paymentPinNew').value
      })
    });
    document.getElementById('paymentPinForm').reset();
    msg.className = 'msg-inline success';
    msg.textContent = 'PIN saved!';
    await renderPaymentPinStatus();
    setTimeout(() => { if (msg.textContent === 'PIN saved!') msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

async function renderCommission() {
  const rateCfg = await api('/api/admin/commission-config');
  document.getElementById('commissionRateMode').value = rateCfg.mode === 'percent' ? 'percent' : 'flat';
  document.getElementById('commissionRateInput').value = rateCfg.amountPerService || 0;
  document.getElementById('commissionRatePercentInput').value = rateCfg.percentValue || 0;
  toggleCommissionRateInputs();
  renderCommissionApplianceRates(rateCfg);
  renderCommissionTechRates();
  renderCommissionPaymentStatus();
  renderPaymentPinStatus();

  // Same TECHNICIANS/CITIES already loaded by loadAll() for the rest of
  // the panel — just needs populating into these two dropdowns once.
  const techSelect = document.getElementById('commissionSearchTech');
  if (techSelect.options.length <= 1) {
    techSelect.innerHTML = '<option value="">All Technicians</option>' + TECHNICIANS.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  }
  const citySelect = document.getElementById('commissionSearchCity');
  if (citySelect.options.length <= 1) {
    citySelect.innerHTML = '<option value="">All Cities</option>' + CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  const dateInput = document.getElementById('commissionDate');
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
  const data = await api(`/api/admin/commission/report?date=${dateInput.value}`);
  document.getElementById('commissionGrandTotal').textContent = `₹${fmtInr(data.grandTotal)}`;

  const wrap = document.getElementById('commissionCityList');
  if (!data.cities.length) {
    wrap.innerHTML = '<p style="color:var(--slate);font-size:0.85rem;">No completed orders on this date.</p>';
    return;
  }
  // City row -> tap to expand technician rows -> tap a technician to expand
  // their individual completed orders. Nothing is fetched again on expand;
  // the full day's data is already loaded, so it just toggles visibility.
  wrap.innerHTML = data.cities.map((c, ci) => `
    <div class="card" style="margin-bottom:10px;padding:0;overflow:hidden;">
      <div class="commission-row" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;cursor:pointer;" onclick="toggleCommissionCity(${ci})">
        <div><strong>${c.cityName}</strong> <span style="color:var(--slate);font-size:0.82rem;">· ${c.technicians.length} technician${c.technicians.length === 1 ? '' : 's'}</span></div>
        <div style="font-weight:700;color:var(--blue-900);">₹${fmtInr(c.totalCommission)} <span id="commissionCityArrow-${ci}">▸</span></div>
      </div>
      <div id="commissionCityBody-${ci}" style="display:none;border-top:1px solid var(--line);">
        ${c.technicians.map((t, ti) => `
          <div class="commission-row" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px 12px 28px;cursor:pointer;border-bottom:1px solid var(--line);" onclick="toggleCommissionTech(${ci}, ${ti})">
            <div>${t.technicianName} <span style="color:var(--slate);font-size:0.8rem;">· ${t.items.length} order${t.items.length === 1 ? '' : 's'}</span></div>
            <div style="text-align:right;">
              <div>₹${fmtInr(t.totalCommission)} commission <span id="commissionTechArrow-${ci}-${ti}">▸</span></div>
              <div style="font-size:0.78rem;color:var(--slate);">₹${fmtInr(t.totalNetForTechnician)} net for technician</div>
            </div>
          </div>
          <div id="commissionTechBody-${ci}-${ti}" style="display:none;">
            <div class="table-wrap"><table>
              <thead><tr><th>Order</th><th>Customer</th><th>Mobile</th><th>Appliance</th><th>Price</th><th>Review</th><th>Commission</th><th>Net for Technician</th></tr></thead>
              <tbody>
                ${t.items.map(it => `
                  <tr>
                    <td>${it.bookingId}</td>
                    <td>${it.customerName}</td>
                    <td>${it.customerPhone || '—'}</td>
                    <td>${it.applianceName} (${it.serviceType === 'repair' ? 'Repair' : 'Service'})</td>
                    <td>₹${fmtInr(it.lineTotal)}</td>
                    <td>
                      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;font-size:0.85rem;" title="${it.reviewPendingVerification ? 'Technician claims a review was left — tick to confirm and waive commission' : ''}">
                        <input type="checkbox" ${it.reviewVerifiedByStaff ? 'checked' : ''} onchange="adminToggleReviewBrought('${it.bookingId}','${it.itemId}',this.checked)">
                        ${it.reviewVerifiedByStaff ? '✅ Verified' : (it.reviewPendingVerification ? '<span style="color:var(--amber);">⏳ Pending</span>' : 'No')}
                      </label>
                    </td>
                    <td>${it.reviewVerifiedByStaff ? '<span style="color:var(--green);">Waived</span>' : `₹${fmtInr(it.commission)}`}</td>
                    <td style="font-weight:600;">₹${fmtInr(it.netForTechnician)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Also refresh the searchable full report below, so its export link and
  // table have something in them the moment this tab opens, before the
  // user even touches the filters.
  runCommissionSearch();
}

// ---------------- FULL COMMISSION REPORT (search) ----------------
function buildCommissionSearchQuery() {
  const params = new URLSearchParams();
  const tech = document.getElementById('commissionSearchTech').value;
  const city = document.getElementById('commissionSearchCity').value;
  const from = document.getElementById('commissionSearchFrom').value;
  const to = document.getElementById('commissionSearchTo').value;
  if (tech) params.set('technicianId', tech);
  if (city) params.set('cityId', city);
  if (from) params.set('fromDate', from);
  if (to) params.set('toDate', to);
  return params.toString();
}

async function runCommissionSearch() {
  const query = buildCommissionSearchQuery();
  document.getElementById('commissionSearchExportBtn').href = `/api/admin/commission/search/export?${query}`;

  const data = await api(`/api/admin/commission/search?${query}`);
  document.getElementById('commissionSearchStats').innerHTML = `
    <div class="stat-card"><div class="val">${data.count}</div><div class="lbl">Completed Jobs</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.totals.totalEarning)}</div><div class="lbl">Total Earning</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.totals.technicianEarning)}</div><div class="lbl">Technician Earning</div></div>
    <div class="stat-card"><div class="val">₹${fmtInr(data.totals.commission)}</div><div class="lbl">Total Commission</div></div>
  `;
  const tbody = document.getElementById('commissionSearchTable');
  tbody.innerHTML = data.rows.length ? data.rows.map(r => `
    <tr>
      <td>${r.date}</td>
      <td>${r.technicianName}</td>
      <td>${r.cityName}</td>
      <td>${esc(r.item)}${r.reviewVerifiedByStaff ? ' <span style="color:var(--green);font-size:0.78rem;">(review — waived)</span>' : (r.reviewPendingVerification ? ' <span style="color:var(--amber);font-size:0.78rem;">(review claimed — pending verification)</span>' : '')}</td>
      <td>₹${fmtInr(r.totalEarning)}</td>
      <td>₹${fmtInr(r.technicianEarning)}</td>
      <td>${r.reviewVerifiedByStaff ? '<span style="color:var(--green);">Waived</span>' : `₹${fmtInr(r.commission)}`}</td>
      <td>${r.commissionPaid ? '<span style="color:var(--green);">✅ Paid</span>' : '<span style="color:var(--red);">⏳ Pending</span>'}</td>
      <td style="max-width:260px;white-space:normal;font-size:0.85rem;color:var(--slate);">${r.workReport ? escapeHtml(r.workReport) : '—'}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="9">No completed jobs match these filters.</td></tr>`;
}

document.getElementById('commissionSearchBtn').addEventListener('click', runCommissionSearch);

function toggleCommissionCity(ci) {
  const body = document.getElementById(`commissionCityBody-${ci}`);
  const arrow = document.getElementById(`commissionCityArrow-${ci}`);
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  arrow.textContent = open ? '▸' : '▾';
}

function toggleCommissionTech(ci, ti) {
  const body = document.getElementById(`commissionTechBody-${ci}-${ti}`);
  const arrow = document.getElementById(`commissionTechArrow-${ci}-${ti}`);
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  arrow.textContent = open ? '▸' : '▾';
}

// Admin override for a technician's self-reported review claim — most
// often used to reverse a false claim after checking the actual Google
// Business review list, which immediately restores the commission owed.
async function adminToggleReviewBrought(bookingId, itemId, checked) {
  if (!checked) {
    const ok = confirm('Mark this as NOT having a Google review? This will restore the commission owed for this order.');
    if (!ok) { await renderCommission(); return; }
  }
  try {
    await api(`/api/admin/commission/items/${bookingId}/${itemId}/review-brought`, {
      method: 'PUT',
      body: JSON.stringify({ reviewBrought: checked })
    });
    await renderCommission();
  } catch (err) {
    alert(err.message || 'Could not update. Please try again.');
    await renderCommission();
  }
}

document.getElementById('commissionDate').addEventListener('change', renderCommission);

function toggleCommissionRateInputs() {
  const mode = document.getElementById('commissionRateMode').value;
  document.getElementById('commissionRateFlatField').style.display = mode === 'percent' ? 'none' : '';
  document.getElementById('commissionRatePercentField').style.display = mode === 'percent' ? '' : 'none';
}

document.getElementById('commissionRateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('commissionRateMsg');
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  const mode = document.getElementById('commissionRateMode').value;
  try {
    await api('/api/admin/commission-config', {
      method: 'PUT',
      body: JSON.stringify(mode === 'percent'
        ? { mode: 'percent', percentValue: document.getElementById('commissionRatePercentInput').value }
        : { mode: 'flat', amountPerService: document.getElementById('commissionRateInput').value })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    await renderCommission();
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

// ---------------- SITE CONTENT (footer text + FAQ) ----------------
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let SITE_CONTENT = { footerDescription: '', faqs: [] };

async function renderSiteContent() {
  SITE_CONTENT = await api('/api/admin/site-content');
  document.getElementById('footerSloganInput').value = SITE_CONTENT.footerSlogan || '';
  document.getElementById('footerDescriptionInput').value = SITE_CONTENT.footerDescription || '';
  renderFaqList();
  try {
    const res = await api('/api/admin/ai-instructions');
    document.getElementById('aiInstructionsInput').value = res.instructions || '';
  } catch (e) { /* non-critical — just leave the box empty if this fails */ }
}

document.getElementById('saveAiInstructionsBtn').addEventListener('click', async () => {
  const msg = document.getElementById('aiInstructionsMsg');
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api('/api/admin/ai-instructions', {
      method: 'PUT',
      body: JSON.stringify({ instructions: document.getElementById('aiInstructionsInput').value })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved! Bella will follow this starting with the next message.';
    setTimeout(() => { if (msg.textContent.startsWith('Saved!')) msg.textContent = ''; }, 3500);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message || 'Could not save.';
  }
});

document.getElementById('saveFooterBtn').addEventListener('click', async () => {
  const msg = document.getElementById('footerMsg');
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api('/api/admin/site-content/footer', {
      method: 'PUT',
      body: JSON.stringify({
        footerSlogan: document.getElementById('footerSloganInput').value,
        footerDescription: document.getElementById('footerDescriptionInput').value
      })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
});

function renderFaqList() {
  const wrap = document.getElementById('faqList');
  if (!SITE_CONTENT.faqs || !SITE_CONTENT.faqs.length) {
    wrap.innerHTML = '<p style="color:var(--slate);font-size:0.85rem;">No FAQs added yet.</p>';
    return;
  }
  wrap.innerHTML = SITE_CONTENT.faqs.map(f => `
    <div class="card">
      <div class="field"><label>Question</label><input type="text" id="faqQ-${f.id}" value="${escapeHtml(f.q)}"></div>
      <div class="field"><label>Answer</label><textarea id="faqA-${f.id}" rows="3">${escapeHtml(f.a)}</textarea></div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px;">
        <button class="btn btn-outline btn-sm" onclick="saveFaq('${f.id}')">Save</button>
        <button class="btn btn-danger btn-sm" onclick="deleteFaq('${f.id}')">Delete</button>
        <span class="msg-inline" id="faqMsg-${f.id}" style="margin:0;"></span>
      </div>
    </div>
  `).join('');
}

async function saveFaq(id) {
  const msg = document.getElementById(`faqMsg-${id}`);
  msg.className = 'msg-inline';
  msg.textContent = 'Saving...';
  try {
    await api(`/api/admin/site-content/faqs/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        q: document.getElementById(`faqQ-${id}`).value,
        a: document.getElementById(`faqA-${id}`).value
      })
    });
    msg.className = 'msg-inline success';
    msg.textContent = 'Saved!';
    setTimeout(() => { if (msg.textContent === 'Saved!') msg.textContent = ''; }, 2500);
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message;
  }
}

async function deleteFaq(id) {
  if (!confirm('Delete this FAQ?')) return;
  try {
    await api(`/api/admin/site-content/faqs/${id}`, { method: 'DELETE' });
    await renderSiteContent();

  } catch (err) {
    alert(err.message || 'Something went wrong. Please try again.');
  }
}

let addingFaq = false;
document.getElementById('faqForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (addingFaq) return;
  addingFaq = true;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const msg = document.getElementById('faqMsg');
  msg.className = 'msg-inline';
  try {
    await api('/api/admin/site-content/faqs', {
      method: 'POST',
      body: JSON.stringify({
        q: document.getElementById('newFaqQ').value,
        a: document.getElementById('newFaqA').value
      })
    });
    document.getElementById('newFaqQ').value = '';
    document.getElementById('newFaqA').value = '';
    msg.className = 'msg-inline success'; msg.textContent = 'FAQ added!';
    await renderSiteContent();
  } catch (err) {
    msg.className = 'msg-inline error'; msg.textContent = err.message;
  } finally {
    addingFaq = false;
    submitBtn.disabled = false;
  }
});

checkLogin();
