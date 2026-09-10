// Seerua Appliance Care — AI chat assistant ("Priya").
// SUGGESTION IMPLEMENTED: the old version of this file was a rule-based /
// menu-driven widget (quick-reply buttons only, no free text
// understanding). It's now fully replaced by a single, always-open AI
// chat — no button menu, no "Aur poochein" needed to reopen typing each
// time. The AI (see lib/ai-assistant.js on the server) can answer
// questions AND create real bookings through natural conversation; the
// old guided booking form is kept as a one-tap fallback (see
// startBookFlow/goToBooking below) for whenever the AI can't gather
// clean enough details to book automatically.
// It works on both the homepage (views/index.template.html) and every
// city page (views/city.template.html); it only needs a
// <div id="chatWidgetRoot"> present on the page and this script loaded
// after it.

(function () {
  const WHATSAPP_URL = 'https://wa.me/919389585479';
  const PHONE_TEL = 'tel:+919389585479';
  const ASSISTANT_NAME = 'Bella';

  let citiesCache = null;
  let appliancesCache = null; // full, unfiltered list
  let otpConfigCache = null;
  let otpScriptLoaded = false;

  let panelOpen = false;

  // Self-contained copies of main.js's fetchJSON/OTP helpers — chatbot.js
  // is loaded on pages that DON'T load main.js (city pages, appliance+
  // city SEO pages), so it can never assume those functions exist on
  // window. Kept behaviorally identical to main.js's versions.
  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

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
    if (!otpConfigCache) otpConfigCache = await fetchJSON('/api/otp-config');
    return otpConfigCache;
  }

  // BUG FIX: same root cause as main.js — window.sendOtp doesn't exist
  // synchronously right after initSendOTP({exposeMethods:true, ...}); the
  // widget needs a moment to finish its own async setup first. Polls
  // briefly until it's actually ready instead of calling it immediately.
  function waitForOtpMethods(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (typeof window.sendOtp === 'function' && typeof window.verifyOtp === 'function') {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('OTP service did not initialize in time. Please try again.'));
        } else {
          setTimeout(poll, 150);
        }
      })();
    });
  }

  // FLOW CHANGE / BUG FIX: same underlying bug as main.js's
  // verifyPhoneWithOtp — `exposeMethods: false` relies on MSG91's own
  // built-in popup to show the OTP entry box, and that popup reliably
  // sends the SMS but never actually renders any visible UI. Chatbot.js
  // has no modal of its own to fall back on (city pages don't have
  // #otpEntryModal), so instead it asks for the code as a normal chat
  // message — a natural fit for a chat interface. See the
  // `pendingOtpVerify` check at the top of sendChatMessage() below,
  // which intercepts the next message as the OTP code instead of
  // sending it to the AI.
  let pendingOtpVerify = null; // { resolve, reject } while waiting for the customer to type their OTP
  function verifyPhoneWithOtp(phone) {
    return new Promise(async (resolve, reject) => {
      try {
        const cfg = await ensureOtpConfig();
        if (!cfg.widgetId || !cfg.tokenAuth) {
          pendingOtpVerify = null;
          reject(new Error('OTP is turned ON but the Widget ID / Token are not set in Admin Panel > OTP Settings. Add them there first.'));
          return;
        }
        await loadOtpScript(['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js']);
        const identifier = '91' + phone;
        window.initSendOTP({
          widgetId: cfg.widgetId,
          tokenAuth: cfg.tokenAuth,
          identifier,
          exposeMethods: true,
          success: (data) => {
            // Some widget versions call this directly rather than via
            // the verifyOtp callback in sendChatMessage() — handled the
            // same way either way.
            const accessToken = data && (data.message || data.token || data['access-token']);
            if (accessToken && pendingOtpVerify) {
              pendingOtpVerify = null;
              resolve(accessToken);
            }
          },
          failure: (error) => { console.log('OTP failure:', error); }
        });
        pendingOtpVerify = { resolve, reject };
        await waitForOtpMethods(10000);
        window.sendOtp(identifier, () => {
          addBotMessage('📲 Aapke number par ek OTP bhej diya hai. Wo code yahan type karke bhej dein (agar na mile to "resend" likhein).');
        }, (error) => {
          pendingOtpVerify = null;
          console.log('OTP send failure:', error);
          reject(new Error('Could not send the OTP. Please try again.'));
        });
      } catch (err) {
        pendingOtpVerify = null;
        reject(err);
      }
    });
  }

  // Mirrors slugify() in server.js exactly — used to link to city pages
  // from the bottom-nav City sheet.
  function slugify(name) {
    return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  async function fetchCities() {
    if (citiesCache) return citiesCache;
    const res = await fetch('/api/cities');
    citiesCache = await res.json();
    return citiesCache;
  }

  async function fetchAppliances() {
    if (appliancesCache) return appliancesCache;
    const res = await fetch('/api/appliances');
    appliancesCache = await res.json();
    return appliancesCache;
  }

  function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // SECURITY: addBotMessage() renders via innerHTML — safe for this
  // file's own hardcoded strings, but NOT safe for the AI's reply text
  // (which is influenced by whatever the customer typed, and could in
  // theory be tricked into echoing an HTML/script tag). Always pass AI
  // text through this first. Turns real newlines into <br> so multi-line
  // answers still read naturally.
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  function scrollToBottom() {
    // Double rAF: waits until the browser has actually finished laying
    // out and painting the newly-added message before scrolling —
    // scrolling immediately/synchronously could act on a layout that
    // hasn't settled yet (e.g. a tall multi-line booking confirmation
    // card still reflowing), leaving the new message only partially
    // visible or cut off.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const body = document.getElementById('chatPanelBody');
        if (!body) return;
        const last = body.lastElementChild;
        // scrollIntoView on the actual last message is more reliable
        // than computing scrollTop = scrollHeight by hand — it directly
        // expresses "make sure this specific element is visible" and
        // isn't thrown off by a still-settling layout the way a raw
        // height calculation can be.
        if (last && last.scrollIntoView) {
          last.scrollIntoView({ block: 'end', inline: 'nearest' });
        } else {
          body.scrollTop = body.scrollHeight;
        }
      });
    });
  }

  function addBotMessage(html) {
    const body = document.getElementById('chatPanelBody');
    const msg = el('div', 'chat-msg bot', html);
    body.appendChild(msg);
    scrollToBottom();
    if (voiceEnabled) speakText(msg.textContent);
    return msg;
  }

  // Text-to-voice for Bella's replies (per request) — off by default (an
  // AI chat suddenly talking without being asked is jarring), toggled via
  // the speaker button in the chat header, remembered for the session so
  // it doesn't reset every time the panel's closed and reopened.
  let voiceEnabled = sessionStorage.getItem('bellaVoiceEnabled') === 'true';
  let hindiVoice = null;
  if ('speechSynthesis' in window) {
    const pickHindiVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      hindiVoice = voices.find(v => v.lang === 'hi-IN') || voices.find(v => v.lang && v.lang.startsWith('hi')) || null;
    };
    pickHindiVoice();
    // Voice list loads asynchronously on first page visit in most
    // browsers — this fires once it's actually populated.
    window.speechSynthesis.onvoiceschanged = pickHindiVoice;
  }
  function speakText(text) {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel(); // don't let replies queue up and speak on top of each other
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = hindiVoice ? hindiVoice.lang : 'hi-IN';
    if (hindiVoice) utterance.voice = hindiVoice;
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }
  // Voice INPUT (per request, in addition to voice replies above) —
  // speech-to-text via the browser's SpeechRecognition API so the
  // customer can speak their message instead of typing it. Hidden
  // entirely if the browser doesn't support it at all (older/less common
  // mobile browsers), rather than showing a mic button that does nothing.
  function wireMicButton() {
    const micBtn = document.getElementById('chatMicBtn');
    const input = document.getElementById('chatMainInput');
    if (!micBtn || !input) return;
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      micBtn.style.display = 'none';
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'hi-IN';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    let listening = false;
    recognition.addEventListener('result', (e) => {
      const transcript = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript;
      if (transcript) input.value = transcript;
      input.focus();
    });
    const stopListeningUi = () => {
      listening = false;
      micBtn.classList.remove('listening');
    };
    recognition.addEventListener('end', stopListeningUi);
    recognition.addEventListener('error', stopListeningUi);
    micBtn.addEventListener('click', () => {
      if (listening) {
        recognition.stop();
        return;
      }
      // Stop Bella's own voice reply first — trying to listen while she's
      // still talking would just pick up her own voice as the "input".
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      listening = true;
      micBtn.classList.add('listening');
      try {
        recognition.start();
      } catch (e) {
        stopListeningUi(); // already running, or genuinely unavailable right now
      }
    });
  }

  function wireVoiceToggle() {
    const btn = document.getElementById('chatVoiceBtn');
    if (!btn) return;
    const updateIcon = () => { btn.textContent = voiceEnabled ? '🔊' : '🔇'; };
    updateIcon();
    btn.addEventListener('click', () => {
      voiceEnabled = !voiceEnabled;
      sessionStorage.setItem('bellaVoiceEnabled', String(voiceEnabled));
      updateIcon();
      if (!voiceEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    });
  }

  function addUserMessage(text) {
    const body = document.getElementById('chatPanelBody');
    const msg = el('div', 'chat-msg user');
    msg.textContent = text;
    body.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function addQuickReplies(options) {
    const body = document.getElementById('chatPanelBody');
    const row = el('div', 'chat-quick-replies');
    let answered = false;
    options.forEach((opt) => {
      const btn = el('button', 'chat-quick-btn', opt.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        row.remove();
        addUserMessage(opt.label);
        opt.onClick();
      });
      row.appendChild(btn);
    });
    body.appendChild(row);
    scrollToBottom();
  }

  function goToBooking(details) {
    const { cityId, applianceId, typeId, name, phone, address, bookingDate, timeSlotId } = details || {};
    const quickBookModal = document.getElementById('quickBookModal');
    if (quickBookModal && applianceId) {
      // Already on the homepage, which has the actual booking UI — pre-fill
      // everything we already know from the chat conversation, so once the
      // customer picks their specific service card and taps "Book", the
      // checkout form that opens is already filled in rather than blank.
      if (cityId && document.getElementById('fCity')) document.getElementById('fCity').value = cityId;
      if (typeId) qbSelectedTypeId = typeId; // pre-select the specific type (e.g. "Window AC"), not just the appliance category
      if (name && document.getElementById('fName')) document.getElementById('fName').value = name;
      if (phone) {
        if (document.getElementById('fPhone')) document.getElementById('fPhone').value = phone;
        if (document.getElementById('qbPhone')) document.getElementById('qbPhone').value = phone; // the Quick Book modal's own phone field, checked before its "Book"/"Add" buttons will proceed
      }
      if (address && document.getElementById('fAddress')) document.getElementById('fAddress').value = address;
      if (bookingDate && document.getElementById('fDate')) {
        document.getElementById('fDate').value = bookingDate;
        if (typeof refreshSlots === 'function') {
          if (timeSlotId) selectedSlotId = timeSlotId; // pre-select the time slot — refreshSlots() below will render it as already-selected once the real slot list loads
          refreshSlots();
        }
      }
      closeChatPanel(true);
      openQuickBookModal(applianceId);
      return;
    }
    if (quickBookModal && !applianceId) {
      // Already on the homepage, but no specific appliance known — just
      // scroll to where the customer can pick one themselves, no reload.
      closeChatPanel(true);
      document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    // On a page without the booking modal (city/appliance-city pages don't
    // have it) — navigate to the homepage. If an appliance is known,
    // autoOpenBookingFromUrlParams() (in main.js) picks these params up on
    // load and opens the modal automatically; otherwise it just scrolls to
    // the services section so the customer can pick one themselves. (Name/
    // phone/address/date/slot aren't carried through this URL-redirect
    // path — only the city/appliance/type identifiers, which are short,
    // safe values for a URL; the rest would need a different mechanism to
    // survive a full page navigation, like sessionStorage, which isn't
    // implemented here since this redirect path is for the rarer case of
    // chatting from a city/appliance-city page rather than the homepage.)
    const params = new URLSearchParams();
    if (cityId) params.set('city', cityId);
    if (applianceId) params.set('appliance', applianceId);
    const query = params.toString();
    window.location.href = `/${query ? '?' + query : ''}#services`;
  }

  // Fallback only — offered when the AI can't cleanly gather/match
  // enough booking detail (see presentBookingConfirmation below). Opens
  // the site's own structured booking form instead.
  function startBookFlow() {
    addBotMessage('Chaliye booking form khol dete hain — city, appliance aur date/time chunkar seedha book kar sakte hain.');
    addQuickReplies([{ label: '🛒 Booking Form Kholein', onClick: () => goToBooking({}) }]);
  }

  // ---------------- AI chat (free-text, always open) ----------------
  let aiChatHistory = [];
  let aiRequestInFlight = false;

  // RELIABILITY FIX: don't leave "does this customer's address get
  // auto-filled" entirely up to the AI model correctly following a system
  // prompt instruction and later correctly echoing it back into its own
  // BOOKING_READY JSON — that's two separate places an LLM can slip.
  // Instead: as soon as the server tells us (via knownCustomer in the
  // response) that this phone number belongs to a past customer, ask a
  // simple yes/no quick-reply directly in plain JS. A "yes" is stored
  // client-side and force-filled into the final draft further down,
  // regardless of whatever the model itself produces.
  let knownCustomerInfo = null;
  let knownCustomerPromptShown = false;
  let confirmedCustomerDetails = null;

  async function sendChatMessage(text) {
    if (!text || !text.trim() || aiRequestInFlight) return;
    text = text.trim();
    // While waiting for an OTP code (see verifyPhoneWithOtp above), the
    // next message typed is treated as that code instead of being sent
    // to the AI — this IS the OTP entry UI for the chat interface.
    if (pendingOtpVerify) {
      addUserMessage(text);
      if (/^(resend|dobara|phir se bhejo)/i.test(text)) {
        addBotMessage('🔁 Dobara OTP bhej rahe hain...');
        window.retryOtp(null, () => {
          addBotMessage('📲 Naya code bhej diya hai — kripya wo yahan type karein.');
        }, () => {
          addBotMessage('❌ Dobara bhejne mein dikkat aayi. Kripya thodi der baad try karein.');
        });
        return;
      }
      const code = text.replace(/\D/g, '');
      if (!/^[0-9]{4,6}$/.test(code)) {
        addBotMessage('Ye OTP jaisa nahi lag raha — kripya SMS mein aaya hua 4-6 digit ka code type karein, ya "resend" likhein.');
        return;
      }
      const { resolve, reject } = pendingOtpVerify;
      addBotMessage('⏳ Verify kar rahe hain...');
      window.verifyOtp(code, (data) => {
        const accessToken = data && (data.message || data.token || data['access-token']);
        pendingOtpVerify = null;
        if (!accessToken) {
          addBotMessage('Verify to ho gaya lekin token nahi mila. Kripya dobara try karein.');
          reject(new Error('No access token received.'));
          return;
        }
        addBotMessage('✅ Number verify ho gaya!');
        resolve(accessToken);
      }, () => {
        addBotMessage('❌ Code galat ya expire ho gaya hai. Kripya SMS wala code dubara type karein, ya "resend" likhein.');
        // pendingOtpVerify stays set so the customer can retry
      });
      return;
    }
    addUserMessage(text);
    setInputEnabled(false);
    const typingRow = addBotMessage('<span class="chat-thinking"><svg class="chat-thinking-star" viewBox="0 0 24 24" width="20" height="20"><path d="M12 1.5l3.15 7.2L23 9.55l-5.6 5.3L19.5 23 12 18.6 4.5 23l2.1-8.15L1 9.55l7.85-.85L12 1.5z" fill="currentColor" stroke="currentColor" stroke-width="0.5" stroke-linejoin="miter"/></svg></span>');
    aiRequestInFlight = true;
    try {
      const res = await fetch('/api/chatbot/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: aiChatHistory })
      });
      const data = await res.json();
      typingRow.remove();
      if (!res.ok) {
        addBotMessage(data.error || `Maaf kijiye, ${ASSISTANT_NAME} abhi jawab nahi de pa rahi. Thodi der baad try karein, ya humse call pe baat karein: 📞 <a href="${PHONE_TEL}">9389585479</a>`);
      } else {
        if (data.knownCustomer) knownCustomerInfo = data.knownCustomer;
        // Tolerant of the model using either 1 or 2 brackets on either tag
        // (e.g. "[[BOOKING_READY]]...[/BOOKING_READY]") and any whitespace/
        // newlines around the JSON — models don't always follow an exact
        // bracket-count instruction perfectly, and a strict regex here
        // means the raw block leaks through as visible text to the
        // customer instead of being silently parsed into the confirmation
        // card, which is worse than being a little lenient about the format.
        const match = data.reply.match(/\[{1,2}BOOKING_READY\]{1,2}\s*([\s\S]*?)\s*\[{1,2}\/BOOKING_READY\]{1,2}/);
        const visibleReply = data.reply.replace(/\[{1,2}BOOKING_READY\]{1,2}\s*[\s\S]*?\s*\[{1,2}\/BOOKING_READY\]{1,2}/, '').trim();
        if (visibleReply) addBotMessage(escapeHtml(visibleReply));
        aiChatHistory.push({ role: 'user', content: text });
        aiChatHistory.push({ role: 'assistant', content: data.reply });

        if (match) {
          let draft;
          try { draft = JSON.parse(match[1]); } catch (e) { draft = null; }
          if (draft) {
            // Deterministic safety net: fill in anything still missing
            // from a confirmed known-customer, regardless of what the
            // model itself put (or didn't put) in the draft.
            if (confirmedCustomerDetails) {
              if (!draft.address && confirmedCustomerDetails.address) draft.address = confirmedCustomerDetails.address;
              if (!draft.name && confirmedCustomerDetails.name) draft.name = confirmedCustomerDetails.name;
              if (!draft.cityName && confirmedCustomerDetails.cityName) draft.cityName = confirmedCustomerDetails.cityName;
            }
            aiRequestInFlight = false;
            await presentBookingConfirmation(draft);
            setInputEnabled(true);
            return;
          }
        }

        // First time we learn this phone belongs to a returning customer
        // in this conversation, and we don't already have a confirmed
        // address for it — offer it back directly, independent of
        // whether the model itself mentioned it in visibleReply above.
        if (knownCustomerInfo && !knownCustomerPromptShown && !confirmedCustomerDetails) {
          knownCustomerPromptShown = true;
          if (knownCustomerInfo.address) {
            addBotMessage(`Waise, humein aapka pichla address mila: <b>${escapeHtml(knownCustomerInfo.address)}</b>${knownCustomerInfo.cityName ? ` (${escapeHtml(knownCustomerInfo.cityName)})` : ''}. Kya isi pe booking karni hai?`);
            addQuickReplies([
              { label: '✅ Haan, yahi address hai', onClick: () => {
                confirmedCustomerDetails = knownCustomerInfo;
                // RELIABILITY FIX: sending just "haan, wahi address hai"
                // made the model loop forever asking for the address again
                // — an indirect reference to "the address I already told
                // you about" isn't something it reliably resolves back to
                // an actual value it can put in its own draft JSON.
                // Spelling the literal address (and name/city) out as if
                // the customer typed it themselves gives the model
                // unambiguous text to extract, the same way it would from
                // a first-time customer typing their address directly.
                const parts = [];
                if (knownCustomerInfo.name) parts.push(`mera naam ${knownCustomerInfo.name} hai`);
                parts.push(`mera address hai: ${knownCustomerInfo.address}`);
                if (knownCustomerInfo.cityName) parts.push(`city ${knownCustomerInfo.cityName} hai`);
                sendChatMessage(parts.join(', ') + '.');
              } },
              { label: '📝 Naya address dena hai', onClick: () => {
                sendChatMessage('Nahi, is baar ka address different hai — main naya address deta/deti hoon.');
              } }
            ]);
          }
        }
      }
    } catch (e) {
      typingRow.remove();
      addBotMessage('Network mein dikkat aa rahi hai — thodi der baad try karein.');
    }
    aiRequestInFlight = false;
    setInputEnabled(true);
  }

  // Normalizes a name for comparison — lowercase, trimmed, punctuation and
  // extra whitespace collapsed — so "Split AC", "split ac", " Split-AC ",
  // and "Split  AC" are all treated as the same thing. Small LLMs are
  // reliably close but not always byte-for-byte exact, and an unnecessary
  // fallback to the manual form for a purely cosmetic mismatch is a worse
  // experience than being a little lenient here.
  function normalizeForMatch(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Exact normalized match first; if that fails, a bidirectional
  // "contains" check as a safety net (e.g. the AI saying just "AC" when
  // the real type is "Split AC" would still resolve sensibly here).
  function findBestMatch(list, nameGetter, targetName) {
    const target = normalizeForMatch(targetName);
    if (!target) return null;
    const exact = list.find(item => normalizeForMatch(nameGetter(item)) === target);
    if (exact) return exact;
    return list.find(item => {
      const itemName = normalizeForMatch(nameGetter(item));
      return itemName.includes(target) || target.includes(itemName);
    }) || null;
  }

  // Maps the AI's morning/afternoon/evening wording to this site's actual
  // slot IDs/labels (see TIME_SLOTS in server.js) — kept here rather than
  // fetched from an API since these 3 windows are fixed, not admin-editable.
  const TIME_SLOT_MAP = {
    morning: { id: 'slot1', label: '8:00 AM - 11:00 AM' },
    afternoon: { id: 'slot2', label: '12:00 PM - 3:00 PM' },
    evening: { id: 'slot3', label: '4:00 PM - 7:00 PM' }
  };

  async function presentBookingConfirmation(draft) {
    const cities = await fetchCities();
    const appliances = await fetchAppliances();
    const city = findBestMatch(cities, c => c.name, draft.cityName);
    const appliance = findBestMatch(appliances, a => a.name, draft.applianceName);
    const type = appliance ? findBestMatch(appliance.types || [], t => t.name, draft.typeName) : null;
    const phoneOk = /^[0-9]{10}$/.test(String(draft.phone || ''));
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(draft.bookingDate || ''));
    const serviceType = String(draft.serviceType || '').toLowerCase().includes('repair') ? 'repair' : 'service';
    const timeKey = String(draft.timeSlot || '').toLowerCase().trim();
    const timeSlot = TIME_SLOT_MAP[timeKey];

    if (!city || !appliance || !type || !phoneOk || !dateOk || !timeSlot || !draft.name || !draft.address) {
      addBotMessage('Kuch details match nahi ho paayi (jaise city, appliance, type, ya time slot) — ek baar phir se bata dein, ya seedha booking form use kar lein.');
      addQuickReplies([{ label: '🛒 Booking Form Kholein', onClick: startBookFlow }]);
      return;
    }

    // BUG FIX: this used to only find out an appliance/type has no
    // pricing set up for the chosen city right at the very end — after
    // the whole conversation, name/phone/address/date/time and all —
    // when the actual POST to /api/bookings failed. Checking here instead,
    // BEFORE showing the confirmation summary, means the customer finds
    // out immediately if what they asked for genuinely isn't available in
    // their city, rather than after going through the entire exchange.
    try {
      await fetchJSON(`/api/price?cityId=${city.id}&applianceId=${appliance.id}&typeId=${type.id}`);
    } catch (e) {
      // DEFENSIVE FIX: falls back to a generic message instead of ever
      // showing a literal "undefined" if either name is somehow
      // missing/empty on the matched object.
      const unavailableMsg = (appliance.name && type.name && city.name)
        ? `Maaf kijiye, <strong>${escapeHtml(appliance.name)} — ${escapeHtml(type.name)}</strong> abhi <strong>${escapeHtml(city.name)}</strong> mein available nahi hai. Hum jald hi is service ko yahan bhi shuru karenge!`
        : 'Maaf kijiye, ye service abhi aapke shahar mein available nahi hai. Hum jald hi shuru karenge!';
      addBotMessage(unavailableMsg);
      addQuickReplies([{ label: '🛒 Kisi aur city/appliance ke liye try karein', onClick: startBookFlow }]);
      return;
    }

    const summaryHtml = `
      <strong>Booking ki details confirm karein:</strong><br>
      👤 ${escapeHtml(draft.name)}<br>
      📞 ${escapeHtml(draft.phone)}<br>
      📍 ${escapeHtml(draft.address)}<br>
      🏙️ ${escapeHtml(city.name)}<br>
      🔧 ${escapeHtml(appliance.name)} — ${escapeHtml(type.name)} (${serviceType === 'repair' ? 'Repair' : 'Service/AMC'})<br>
      Date: ${escapeHtml(draft.bookingDate)}<br>
      🕐 ${escapeHtml(timeSlot.label)}${draft.problem ? `<br>📝 ${escapeHtml(draft.problem)}` : ''}
    `;
    addBotMessage(summaryHtml);

    const body = document.getElementById('chatPanelBody');
    const row = el('div', 'chat-quick-replies');
    const confirmBtn = el('button', 'chat-quick-btn', '✅ Confirm & Book Karein');
    const editBtn = el('button', 'chat-quick-btn', '✏️ Kuch Badalna Hai');
    row.appendChild(confirmBtn);
    row.appendChild(editBtn);
    body.appendChild(row);
    scrollToBottom();

    // Same double-tap guard as addQuickReplies (mobile browsers can
    // occasionally deliver a duplicate/ghost click on a fast tap) — extra
    // important here specifically since this button creates a real
    // booking, not just a UI state change.
    let answered = false;
    editBtn.addEventListener('click', () => {
      if (answered) return;
      answered = true;
      row.remove();
      addBotMessage('Theek hai, bataiye kya badalna hai.');
    });

    confirmBtn.addEventListener('click', async () => {
      if (answered) return;
      answered = true;
      row.remove();
      await submitAiGatheredBooking({ ...draft, cityId: city.id, applianceId: appliance.id, typeId: type.id, serviceType, timeSlotId: timeSlot.id });
    });
  }

  async function submitAiGatheredBooking(info) {
    const statusMsg = addBotMessage('⏳ Booking process shuru kar rahe hain...');
    try {
      let phoneAlreadyVerified = false;
      try {
        const check = await fetchJSON(`/api/phone-verified?phone=${info.phone}`);
        phoneAlreadyVerified = !!check.verified;
      } catch (e) { /* fall back to normal OTP flow */ }

      let otpEnabled = true;
      try {
        const cfg = await ensureOtpConfig();
        otpEnabled = cfg.enabled !== false;
      } catch (e) { /* fall back to normal OTP flow */ }

      const payload = {
        name: info.name, phone: info.phone, address: info.address, cityId: info.cityId,
        items: [{ applianceId: info.applianceId, typeId: info.typeId, serviceType: info.serviceType, qty: 1, problem: info.problem || '' }],
        bookingDate: info.bookingDate
      };

      const slots = await fetchJSON(`/api/slots?date=${info.bookingDate}&cityId=${info.cityId}&applianceIds=${info.applianceId}`);
      const chosenSlot = (slots || []).find(s => s.id === info.timeSlotId);
      if (!chosenSlot || !chosenSlot.available) {
        statusMsg.remove();
        addBotMessage('Maaf kijiye, ye time slot ab available nahi hai (kisi aur ne book kar liya, ya time nikal gaya). Kripya booking form se doosra time/date try karein.');
        addQuickReplies([{ label: '🛒 Booking Form Kholein', onClick: () => { addBotMessage('Chaliye — jo details aapne di thi wahi rakh ke form khol dete hain, bas doosra time/date chunkar book kar lein.'); goToBooking({ cityId: info.cityId, applianceId: info.applianceId, typeId: info.typeId, name: info.name, phone: info.phone, address: info.address }); } }]);
        return;
      }
      payload.timeSlotId = info.timeSlotId;

      if (otpEnabled && !phoneAlreadyVerified) {
        statusMsg.remove();
        addBotMessage('Aapke number pe OTP bhej rahe hain — jo popup khule usme verify kar dein.');
        try {
          payload.accessToken = await verifyPhoneWithOtp(info.phone);
        } catch (err) {
          addBotMessage(err.message || 'OTP verification fail ho gaya. Dobara try karein ya booking form use karein.');
          addQuickReplies([{ label: '🛒 Booking Form Kholein', onClick: () => { addBotMessage('Chaliye — jo details aapne di thi wahi rakh ke form khol dete hain, bas OTP dobara verify karke book kar lein.'); goToBooking({ cityId: info.cityId, applianceId: info.applianceId, typeId: info.typeId, name: info.name, phone: info.phone, address: info.address, bookingDate: info.bookingDate, timeSlotId: info.timeSlotId }); } }]);
          return;
        }
      }

      const data = await fetchJSON('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (document.body.contains(statusMsg)) statusMsg.remove();
      addBotMessage(`✅ Booking confirm ho gayi! Booking ID: <strong>${escapeHtml(data.booking.id)}</strong><br>Visit: ${escapeHtml(data.booking.bookingDate)}, ${escapeHtml(data.booking.timeSlot)}<br>Total: ₹${data.booking.totalPrice}`);
      // FLOW CHANGE: a chatbot booking already gives the server everything
      // it needs to recognize this customer next time (name/address/city
      // saved on the booking itself — see /api/customer-lookup), but this
      // browser's own Account Gate (header avatar) wouldn't know that yet
      // without asking for the mobile number again. Saving it directly
      // here — main.js's saveAccount()/updateHeaderAccountUI(), both
      // plain globals since chatbot.js loads after main.js — means the
      // very same visit already shows the account avatar and skips
      // straight through if they tap Booking/My Account again right after.
      if (typeof saveAccount === 'function') {
        saveAccount({
          phone: info.phone, name: info.name, address: info.address, cityId: info.cityId,
          accessToken: payload.accessToken || (typeof verifiedBookingAccessToken !== 'undefined' ? verifiedBookingAccessToken : undefined)
        });
      }
    } catch (err) {
      if (document.body.contains(statusMsg)) statusMsg.remove();
      addBotMessage(err.message || 'Booking create nahi ho paayi. Kripya booking form se try karein ya humse call karein.');
    }
  }

  // ---------------- Persistent input bar ----------------
  // Lives OUTSIDE .chat-panel-body (a fixed sibling, not part of the
  // scrolling message list) so it never scrolls away and never needs to
  // be re-added after each reply.
  function setInputEnabled(enabled) {
    const input = document.getElementById('chatMainInput');
    const btn = document.getElementById('chatMainSendBtn');
    awaitingReply = !enabled;
    if (btn) {
      btn.style.opacity = enabled ? '' : '0.5';
      btn.style.pointerEvents = enabled ? '' : 'none';
    }
    // Deliberately never sets input.disabled — on mobile browsers that
    // force-closes the on-screen keyboard the instant it's set (since a
    // disabled input can't hold focus), which is exactly what was causing
    // the keyboard to snap shut on every send and reopen once Bella's
    // reply came back. Leaving the input itself always enabled means the
    // keyboard stays open and steady through the whole exchange; the
    // awaitingReply guard above is what actually stops a duplicate send.
  }

  let awaitingReply = false; // guards against sending a 2nd message while Bella is still replying — deliberately NOT using input.disabled for this (see setInputEnabled below)

  function wireInputBar() {
    const input = document.getElementById('chatMainInput');
    const btn = document.getElementById('chatMainSendBtn');
    if (!input || !btn) return;
    const submit = () => {
      if (awaitingReply) return; // silently ignore — button is visually dimmed as the cue, no need for an alert
      const val = input.value.trim();
      if (!val) return;
      input.value = '';
      // BUG FIX: this used to unconditionally blur() the input after every
      // send — deliberately done for mobile (closes the on-screen keyboard
      // so it doesn't cover the chat), but that same blur() was ALSO
      // running on desktop, where there's no keyboard to worry about —
      // it just kicked focus out of the box, forcing a click back in
      // before typing the next message. Only blur on touch/mobile devices
      // now; desktop (mouse + hover capable) keeps focus so someone can
      // keep typing straight through a whole conversation.
      const isDesktopPointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      if (isDesktopPointer) {
        input.focus();
      } else {
        input.blur();
      }
      sendChatMessage(val);
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    // When the on-screen keyboard opens, nudge the input bar into view —
    // simpler and far more robust than trying to keep the whole panel's
    // height in sync with the keyboard via JS (that approach turned out
    // fragile in real-world use: things like Chrome's own autofill
    // suggestion bar could get misread as "the keyboard opened", shrinking
    // the panel to an incorrect height and leaking the page behind it
    // below the input bar). This only scrolls the input into view, never
    // touches the panel's actual size, so it can't cause that class of bug.
    input.addEventListener('focus', () => {
      setTimeout(() => input.scrollIntoView({ block: 'end', inline: 'nearest' }), 300);
    });
  }

  // ---------------- Panel open/close ----------------
  let savedScrollY = 0; // remembers where the page was scrolled to before the chat locked it, so closing restores exactly there

  function openChatPanel() {
    const panel = document.getElementById('chatPanel');
    panel.classList.add('open');
    panelOpen = true;
    // overflow:hidden alone doesn't reliably block touch-driven background
    // scrolling on mobile Chrome/Safari — pinning the body with
    // position:fixed at its current scroll offset is the standard, actually
    // effective technique. Without this, scrolling inside the (now smaller,
    // floating) chat panel could "leak" and scroll the main page behind it
    // too, since the panel no longer covers the full screen.
    savedScrollY = window.scrollY;
    document.body.classList.add('chat-open-lock');
    document.body.style.top = `-${savedScrollY}px`;
    const teaser = document.getElementById('chatTeaser');
    if (teaser) teaser.classList.remove('show');
    const body = document.getElementById('chatPanelBody');
    if (body) body.innerHTML = '';
    aiChatHistory = [];
    addBotMessage(`👋 Namaskar! Seerua Appliance Care mein aapka swagat hai. Main ${ASSISTANT_NAME}, aapki kya seva kar sakti hoon? 🙂`);
    setInputEnabled(true);
  }

  function closeChatPanel(skipScrollRestore) {
    const panel = document.getElementById('chatPanel');
    panel.classList.remove('open');
    panelOpen = false;
    document.body.classList.remove('chat-open-lock');
    document.body.style.top = '';
    if (skipScrollRestore === true) return; // strict check on purpose — closeChatPanel is also used directly as an event listener (e.g. the X close button), where the browser automatically passes the click Event as this argument; a loose truthy check would wrongly treat every ordinary close-button click as "skip the restore" too, since Event objects are truthy
    // requestAnimationFrame ensures this runs after the browser has fully
    // reflowed from removing position:fixed — calling scrollTo immediately
    // (synchronously) risked the browser's own layout recalculation
    // overriding it a moment later, landing on the wrong final position.
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
  }

  function initChatWidget() {
    const root = document.getElementById('chatWidgetRoot');
    if (!root) return;
    // SUGGESTION IMPLEMENTED: the standalone floating chat button (and
    // its teaser bubble) is retired here — chat is now opened via the
    // bottom-nav's "Support" sheet (Call/WhatsApp/Chat all in one place,
    // see the bottom-nav markup in views/index.template.html) instead of
    // a separate floating icon competing for the same corner of the
    // screen as WhatsApp. The panel itself is unchanged; only how it's
    // launched has moved.
    root.innerHTML = `
      <div class="chat-panel" id="chatPanel">
        <div class="chat-panel-head">
          <div><strong>${ASSISTANT_NAME}</strong><span class="chat-sub">Seerua AI Assistant · Usually replies instantly</span></div>
          <div class="chat-panel-head-actions">
            <button class="chat-voice-btn" id="chatVoiceBtn" type="button" aria-label="Toggle voice replies" title="Bella ke jawab bolke sunein">🔇</button>
            <button class="chat-close-btn" id="chatCloseBtn" aria-label="Close chat" type="button">✕</button>
          </div>
        </div>
        <div class="chat-panel-body" id="chatPanelBody"></div>
        <div class="chat-panel-input">
          <input type="text" id="chatMainInput" maxlength="500" placeholder="Apna sawaal ya booking likhein..." autocomplete="off">
          <button id="chatMicBtn" type="button" aria-label="Bolkar type karein" title="Bolkar type karein">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
          </button>
          <button id="chatMainSendBtn" type="button" aria-label="Send message">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
      </div>
    `;
    wireMicButton();
    wireVoiceToggle();
    wireInputBar();
    document.getElementById('chatCloseBtn').addEventListener('click', closeChatPanel);
    // Exposed so the bottom-nav Support sheet can open/close this panel.
    window.openBellaChat = openChatPanel;
    window.closeBellaChat = closeChatPanel;

    bindUniversalBottomNav();
  }

  // SUGGESTION IMPLEMENTED: Support/City/Menu sheet wiring lives here
  // (not in main.js) because chatbot.js is the one script loaded on
  // EVERY page — homepage, city pages, and appliance+city SEO pages —
  // so the bottom nav works identically everywhere. Only the Cart
  // button's behavior (badge count, scroll-to-form) is homepage-
  // specific and wired separately by main.js, since only the homepage
  // actually has a cart; elsewhere "Cart" is just a plain link to the
  // homepage's booking section.
  function bindUniversalBottomNav() {
    function openSheet(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
    function closeSheet(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
    function closeAllSheets() { ['supportSheetBackdrop', 'citySheetBackdrop', 'menuSheetBackdrop'].forEach(closeSheet); }

    function closeSupportFan() {
      const btn = document.getElementById('bottomNavSupportBtn');
      const fan = document.getElementById('supportFanOut');
      if (btn) btn.classList.remove('open');
      if (fan) fan.classList.remove('open');
    }

    document.querySelectorAll('.bottom-sheet-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(backdrop.id); });
    });

    const supportBtn = document.getElementById('bottomNavSupportBtn');
    if (supportBtn) {
      supportBtn.addEventListener('click', () => {
        closeAllSheets();
        const fan = document.getElementById('supportFanOut');
        const isOpen = supportBtn.classList.toggle('open');
        if (fan) fan.classList.toggle('open', isOpen);
      });
    }
    // Tapping anywhere else on the page collapses the fan-out, same as
    // tapping outside any other menu would.
    document.addEventListener('click', (e) => {
      const fan = document.getElementById('supportFanOut');
      if (fan && fan.classList.contains('open') && !fan.contains(e.target) && e.target !== supportBtn && !supportBtn.contains(e.target)) {
        closeSupportFan();
      }
    });
    const fanAiBtn = document.getElementById('supportFanAiBtn');
    if (fanAiBtn) {
      fanAiBtn.addEventListener('click', () => {
        closeSupportFan();
        if (window.openBellaChat) window.openBellaChat();
      });
    }

    const cityBtn = document.getElementById('bottomNavCityBtn');
    if (cityBtn) {
      cityBtn.addEventListener('click', async () => {
        closeSupportFan();
        const grid = document.getElementById('bottomSheetCityGrid');
        if (grid && !grid.dataset.filled) {
          const cities = await fetchCities();
          const hasCityField = !!document.getElementById('fCity');
          grid.innerHTML = cities.map(c =>
            hasCityField
              ? `<button type="button" class="bottom-sheet-city-btn" data-city-id="${c.id}">${c.name}</button>`
              : `<a href="/appliance-repair/${slugify(c.name)}">${c.name}</a>`
          ).join('');
          if (hasCityField) {
            grid.querySelectorAll('button[data-city-id]').forEach(btn => {
              btn.addEventListener('click', () => {
                const cityField = document.getElementById('fCity');
                cityField.value = btn.getAttribute('data-city-id');
                cityField.dispatchEvent(new Event('change', { bubbles: true }));
                closeAllSheets();
              });
            });
          }
          grid.dataset.filled = '1';
        }
        closeAllSheets();
        openSheet('citySheetBackdrop');
      });
    }

    const menuBtn = document.getElementById('bottomNavMenuBtn');
    if (menuBtn) menuBtn.addEventListener('click', () => { closeSupportFan(); closeAllSheets(); openSheet('menuSheetBackdrop'); });

    // BUG FIX: these are all #anchor links to sections on the same page
    // (Our Services, FAQ, etc.) — clicking one correctly scrolled to that
    // section, but the sheet itself just stayed open on top of it, so
    // the customer had to separately tap the backdrop or the handle to
    // dismiss it before they could actually see what they'd just picked.
    const menuSheet = document.getElementById('menuSheetBackdrop');
    if (menuSheet) {
      menuSheet.querySelectorAll('a.bottom-sheet-option').forEach(link => {
        link.addEventListener('click', () => closeSheet('menuSheetBackdrop'));
      });
    }

    const chatBtn = document.getElementById('supportSheetChatBtn');
    if (chatBtn) chatBtn.addEventListener('click', () => { closeAllSheets(); openChatPanel(); });

    // Cart: on the homepage (which has a real cart) this button is
    // marked data-has-cart in the HTML, and main.js binds its own
    // cart-aware click handler (badge sync, scroll within the page) —
    // skip binding anything here to avoid a duplicate/racy handler.
    // Elsewhere (city pages, appliance+city pages) there's no cart at
    // all, so this is just a safe, simple link to the homepage's
    // booking section.
    const cartBtn = document.getElementById('bottomNavCartBtn');
    if (cartBtn && cartBtn.dataset.hasCart !== 'true') {
      cartBtn.addEventListener('click', () => { window.location.href = '/#book'; });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatWidget);
  } else {
    initChatWidget();
  }
})();
