// ------------------------------------------------------------------
// Seerua Appliance Care — Sub-Admin Panel logic
// A limited staff panel: assign technicians, control time slots, and
// register new customers only. Uses the same "/api/admin/..." endpoints
// as the full Admin Panel, but those routes only allow a Sub-Admin
// session onto the handful of endpoints this panel actually calls —
// everything else (pricing, coupons, technician records, maintenance
// mode, deleting bookings, etc.) is rejected server-side for Sub-Admins.
// ------------------------------------------------------------------
let CITIES = [], APPLIANCES = [], BOOKINGS = [], UNLOCKED_DATES = [];
let assignBookingId = null, assignItemId = null;
let SLOTS_CONFIG = null;
let CUSTOMERS = [];

// Mirrors the same rule enforced server-side (and in admin.js) — a
// booking's date is locked if it's strictly before today and hasn't been
// explicitly unlocked by the Super Admin.
function isBookingDateLocked(dateStr) {
  if (!dateStr) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr >= today) return false;
  return !UNLOCKED_DATES.includes(dateStr);
}

// SECURITY: see the matching comment in admin.js — customer-supplied text
// (booking name/address/problem) must be escaped before going into
// innerHTML, or a booking made with a malicious name could run JS in this
// staff member's logged-in session.
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// SUGGESTION IMPLEMENTED: see the matching comment in admin.js — Indian
// comma grouping (₹1,25,000) instead of plain digits (₹125000).
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
  return `<a href="tel:${tel}" class="phone-link" title="Tap to call" onclick="event.stopPropagation()">📞 ${maskPhone(p)}</a>`;
}

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ---------------- AUTH ----------------
async function checkLogin() {
  const { loggedIn, subAdmin } = await api('/api/subadmin/check');
  if (loggedIn) {
    document.getElementById('loginWrap').style.display = 'none';
    document.getElementById('appShell').classList.add('active');
    document.getElementById('whoAmI').textContent = `Logged in as ${subAdmin.name}`;
    await loadAll();
    switchView('orders');
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
    await api('/api/subadmin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('saUser').value,
        password: document.getElementById('saPass').value
      })
    });
    await checkLogin();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  // BUG FIX: same issue as the admin/technician panels — if the logout
  // API call ever failed for any reason, the button did nothing visible
  // at all. Now it always gets back to the login screen either way.
  try {
    await api('/api/subadmin/logout', { method: 'POST' });
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
  document.querySelectorAll('.panel-view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('#sideNav button').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === view));
  if (view === 'orders') renderOrders();
  if (view === 'slots') renderSlots();
  if (view === 'customers') renderCustomers();
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }

async function loadAll() {
  [CITIES, APPLIANCES, BOOKINGS] = await Promise.all([
    api('/api/admin/cities'),
    api('/api/admin/appliances'),
    api('/api/admin/bookings')
  ]);
  try {
    const res = await api('/api/admin/unlocked-dates');
    UNLOCKED_DATES = res.unlockedDates || [];
  } catch (e) { UNLOCKED_DATES = []; }
}

function cityName(id) { const c = CITIES.find(x => x.id === id); return c ? c.name : '-'; }
function applianceName(id) { const a = APPLIANCES.find(x => x.id === id); return a ? a.name : '-'; }
function itemsSummary(booking) {
  if (!booking.items || !booking.items.length) return '-';
  return booking.items.map(it => `${it.qty}x ${it.applianceName} (${it.typeName}, ${it.serviceType === 'repair' ? 'Repair' : 'Service'})`).join(', ');
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
// made), newest first — matches the Super Admin panel's Orders page.
function sortOrdersByBookingTime(list) {
  return [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ---------------- ORDERS / ASSIGN ----------------
// ASSIGNMENT LOCK: session-only set of "bookingId__itemId" keys that have
// been explicitly unlocked for reassignment — resets on page reload, so
// every fresh visit starts locked-by-default for anything already
// assigned. Matches the Super Admin panel's behaviour.
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
      <td>${esc(b.name)} ${b.source === 'phone' ? '<span class="pill pill-assigned" title="Booked via phone call">📞 Phone</span>' : ''}<br><small style="color:var(--slate)">${phoneLink(b.phone)}</small><br><small style="color:var(--slate)">${esc(b.address)}</small></td>
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
                  <small style="color:#b45309;display:block;margin-top:6px;">🔒 This booking is from ${b.bookingDate}, a locked past date — ask Super Admin to unlock it to reactivate this job.</small>
                ` : `
                ${it.technicianId ? `
                  <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:0.8rem;cursor:${it.reviewVerifiedByStaff ? 'default' : 'pointer'};">
                    <input type="checkbox" ${it.reviewBrought ? 'checked' : ''} ${it.reviewVerifiedByStaff ? 'disabled' : ''} onchange="flagGoogleReview('${b.id}','${it.id}', this.checked)">
                    📍 Google Review: ${it.reviewVerifiedByStaff ? `✅ Confirmed by Super Admin <small style="color:var(--green)">(commission waived)</small>` : (it.reviewBrought ? '⏳ Flagged — pending Super Admin confirmation' : '<small style="color:var(--slate)">Not yet flagged</small>')}
                  </label>
                  ${!it.reviewVerifiedByStaff ? `<small style="color:var(--slate);display:block;margin-top:2px;">Tick if the customer left/mentioned a review — Super Admin still needs to confirm it before commission is waived.</small>` : ''}
                ` : ''}
                <button class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="reactivateItem('${b.id}','${it.id}')" title="Reopens this job if it genuinely needs to be redone">🔓 Reactivate</button>
                `}
              </div>
            ` : `
              <div style="margin-top:8px;">
                ${isBookingDateLocked(b.bookingDate) ? `
                  <small style="color:#b45309;">🔒 This booking is from ${b.bookingDate}, a locked past date — ask Super Admin to unlock it to assign a technician.</small>
                ` : (it.technicianName && !assignmentUnlocked.has(`${b.id}__${it.id}`) ? `
                  <div style="padding:8px 10px;background:var(--mist);border-radius:8px;">
                    <small style="color:var(--slate);">🔒 Locked — already assigned to ${it.technicianName}.</small><br>
                    <button class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="unlockAssignment('${b.id}','${it.id}')">🔓 Unlock to Reassign</button>
                  </div>
                ` : `
                <button class="btn btn-outline btn-sm" onclick="openAssign('${b.id}','${it.id}')">${it.technicianName ? 'Reassign' : 'Assign'}</button>
                ${it.itemStatus !== 'rejected' ? `<button class="btn btn-primary btn-sm" style="margin-left:6px;" onclick="autoAssign('${b.id}','${it.id}')" title="Assigns the top-ranked eligible technician for this appliance instantly">⚡ Auto-Assign Best</button>` : ''}
                `)}
              </div>
            `}
          </div>
        `).join('')}
      </td>
      <td>${b.cityName}</td>
      <td>₹${fmtInr(b.totalPrice)}</td>
    </tr>
  `).join('') : `<tr class="empty-row"><td colspan="5">No orders found.</td></tr>`;
}

async function reactivateItem(bookingId, itemId) {
  if (!confirm('Reactivate this completed job? It will go back to "In Progress" so it can be worked on / reassigned again. Any existing rating on it will be cleared.')) return;
  try {
    await api(`/api/admin/bookings/${bookingId}/items/${itemId}/reactivate`, { method: 'PUT' });
    await loadAll();
    renderOrders();
  } catch (e) { alert(e.message); }
}

// FLAGGING a Google review — Sub-Admin (and Super Admin) can mark that a
// customer left/mentioned one, but this only sets reviewBrought (a claim,
// shows as "pending"). It does NOT waive commission — that's a separate,
// more privileged confirmation step Super Admin does elsewhere. Splitting
// it this way means a limited Sub-Admin account can flag what they hear
// from customers without being able to unilaterally waive real company
// commission themselves.
async function flagGoogleReview(bookingId, itemId, checked) {
  try {
    await api(`/api/admin/bookings/${bookingId}/items/${itemId}/review-brought`, { method: 'PUT', body: JSON.stringify({ submitted: checked }) });
    await loadAll();
    renderOrders();
  } catch (e) { alert(e.message); }
}

async function autoAssign(bookingId, itemId) {
  try {
    const eligible = await api(`/api/admin/bookings/${bookingId}/items/${itemId}/eligible-technicians`);
    if (!eligible.length) {
      alert('No eligible technician found for this appliance in this city. Use manual Assign to see why.');
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
    if (!confirm(`Auto-assign ${top.name} — ${apRatingText}${liveText}?${capacityWarn}`)) return;
    await api(`/api/admin/bookings/${bookingId}/items/${itemId}/assign`, { method: 'PUT', body: JSON.stringify({ technicianId: top.id }) });
    BOOKINGS = await api('/api/admin/bookings');
    renderOrders();
  } catch (e) { alert(e.message); }
}
document.getElementById('orderStatusFilter').addEventListener('change', renderOrders);
document.getElementById('orderSearch').addEventListener('input', renderOrders);

async function openAssign(bookingId, itemId) {
  assignBookingId = bookingId;
  assignItemId = itemId;
  const booking = BOOKINGS.find(b => b.id === bookingId);
  const item = booking ? booking.items.find(it => it.id === itemId) : null;
  const sel = document.getElementById('assignTechSelect');
  const infoEl = document.getElementById('assignBookingInfo');
  const warnEl = document.getElementById('assignWarning');
  const confirmBtn = document.getElementById('assignConfirmBtn');
  warnEl.style.display = 'none';
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

  try {
    const eligible = await api(`/api/admin/bookings/${bookingId}/items/${itemId}/eligible-technicians`);
    if (!eligible.length) {
      sel.innerHTML = '<option disabled>No eligible technician</option>';
      sel.disabled = true;
      confirmBtn.disabled = true;
      warnEl.style.display = 'block';
      warnEl.textContent = `No active technician in ${booking.cityName} lists ${item.applianceName} as a speciality.`;
    } else {
      sel.innerHTML = eligible.map(t => {
        // Prioritize the rating for THIS appliance specifically over their
        // blended overall rating — same logic used in the Admin Panel.
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

document.getElementById('assignConfirmBtn').addEventListener('click', async () => {
  const technicianId = document.getElementById('assignTechSelect').value;
  if (!technicianId) return;
  try {
    await api(`/api/admin/bookings/${assignBookingId}/items/${assignItemId}/assign`, { method: 'PUT', body: JSON.stringify({ technicianId }) });
    BOOKINGS = await api('/api/admin/bookings');
    renderOrders();
    closeModal('assignModal');
  } catch (e) { alert(e.message); }
});

// ---------------- TIME SLOTS ----------------
async function renderSlots() {
  SLOTS_CONFIG = await api('/api/admin/slots-config');
  document.getElementById('slotCapacity').value = SLOTS_CONFIG.capacityPerSlot;
  document.getElementById('dailyJobLimit').value = SLOTS_CONFIG.dailyJobLimit || '';

  const citySel = document.getElementById('blockCity');
  citySel.innerHTML = CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const slotSel = document.getElementById('blockSlotId');
  slotSel.innerHTML = SLOTS_CONFIG.timeSlots.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
  const applianceSel = document.getElementById('blockAppliance');
  applianceSel.innerHTML = '<option value="">All Appliances</option>' + APPLIANCES.map(a => `<option value="${a.id}">${a.name}</option>`).join('');

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
        applianceId: document.getElementById('blockAppliance').value
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
  await api('/api/admin/slots-config/blocked', { method: 'DELETE', body: JSON.stringify({ date, slotId, cityId, applianceId: applianceId || '' }) });
  await renderSlots();
}

// ---------------- CUSTOMERS ----------------
async function renderCustomers() {
  CUSTOMERS = await api('/api/admin/customers');
  drawCustomers(CUSTOMERS);
}
function drawCustomers(list) {
  document.getElementById('customersTable').innerHTML = list.length ? list.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${phoneLink(c.phone)}</td>
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
  document.getElementById('customerModalName').innerHTML = `${esc(c.name)} — ${phoneLink(c.phone)}`;
  document.getElementById('customerModalBody').innerHTML = `
    <p style="color:var(--slate);font-size:0.88rem;">${esc(c.address || '')}${c.source === 'manual' ? ' <span class="pill" style="background:var(--mist);">Registered manually — no booking yet</span>' : ''}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Appliance</th><th>Status</th><th>Price</th></tr></thead>
      <tbody>
        ${c.orders.length ? c.orders.map(o => `<tr><td>${new Date(o.createdAt).toLocaleDateString('en-IN')}</td><td>${itemsSummary(o)}</td><td>${o.items.map(it => `<span class="pill pill-${it.itemStatus}">${it.itemStatus.replace('-', ' ')}</span>`).join(' ')}</td><td>₹${fmtInr(o.totalPrice)}</td></tr>`).join('') : `<tr class="empty-row"><td colspan="4">No bookings yet.</td></tr>`}
      </tbody>
    </table></div>
  `;
  openModal('customerModal');
}

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
  // Don't let staff pick a past date in the calendar (server also rejects
  // it, but the picker should behave like a real calendar).
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
const newBookingBtnFromCustomers = document.getElementById('newBookingBtnFromCustomers');
if (newBookingBtnFromCustomers) newBookingBtnFromCustomers.addEventListener('click', openNewBookingModal);

// SUGGESTION IMPLEMENTED: same auto-fill as the Super Admin panel — as
// soon as a full 10-digit phone number is typed into "New Booking (Phone
// Call)", check whether it belongs to an existing customer and, if so,
// fill in their name/address/city so staff don't have to ask a returning
// customer for their address again. Only fills fields still blank.
async function tryAutoFillFromPhone(rawValue) {
  // ROBUSTNESS FIX: normalize the typed value first — strips spaces,
  // dashes, and a leading "91" country code (e.g. pasted from a call log
  // as "+91 99988 87771") so the lookup still fires.
  let phone = String(rawValue || '').replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (!/^[0-9]{10}$/.test(phone)) return;
  const nameEl = document.getElementById('nbName');
  const addressEl = document.getElementById('nbAddress');
  const cityEl = document.getElementById('nbCity');
  const msgEl = document.getElementById('nbMsg');
  // UX FIX: give immediate feedback that a lookup is in progress — the
  // network round trip takes a moment, and without this notice staff who
  // start typing the address right away could "race" the auto-fill,
  // which looked like the feature randomly not working.
  msgEl.className = 'msg-inline';
  msgEl.textContent = 'Checking if this number has booked before…';
  try {
    const match = await api(`/api/admin/customers/lookup/${phone}`);
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
    msgEl.className = 'msg-inline';
    msgEl.textContent = '';
  }
}
document.getElementById('nbPhone').addEventListener('input', (e) => tryAutoFillFromPhone(e.target.value));
document.getElementById('nbPhone').addEventListener('blur', (e) => tryAutoFillFromPhone(e.target.value));

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
  // BUG FIX: Visit Date and Time Slot used to be optional — see the
  // matching fix in the Super Admin panel for why that's a problem.
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
        bookingDate: document.getElementById('nbDate').value,
        timeSlotId: document.getElementById('nbSlotId').value
      })
    });
    BOOKINGS = await api('/api/admin/bookings');
    renderOrders();
    closeModal('newBookingModal');
  } catch (err) {
    msg.className = 'msg-inline error';
    msg.textContent = err.message || 'Could not create booking.';
  }
});

checkLogin();
