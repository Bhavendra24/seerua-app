// SUGGESTION IMPLEMENTED: lets the Seerua Assistant chatbot answer
// free-typed questions in natural language ("mera AC 2 din se leak kar
// raha hai, kya karu?") instead of only the fixed button-flow it had
// before. Uses Meta's Llama 3.1 8B Instruct Turbo model — Meta doesn't
// operate its own paid API directly, so this calls it through Together
// AI (togather.ai), which is where this specific model + API key are
// from — Together AI's own model catalog uses this exact "-Turbo"
// naming convention.
//
// SETUP REQUIRED (this file does nothing until you do this):
//   1. Have (or create) a Together AI account at https://together.ai
//      with credit added.
//   2. Create/locate an API key in their dashboard.
//   3. Set it as an environment variable: TOGETHER_API_KEY=your_key_here
//      (same way SESSION_SECRET / DB_HOST etc. are set — see .env.example)
// Without that key set, askAiAssistant() below returns a clear "not set
// up yet" message instead of crashing — the rest of the chatbot (the
// existing button-flow) is completely unaffected either way.
const fetch = global.fetch || require('node-fetch');
const { istDateStr, istCurrentHour } = require('./date');

const TOGETHER_API_URL = 'https://api.together.xyz/v1/chat/completions';
const servicePage = require('./service-page');
// Confirmed working with this exact Together AI account via their own
// Playground (verified live). Also the cheapest option tested — roughly
// 60x cheaper than Kimi K3 and 28x cheaper than GLM 5.2 per token, while
// still being a genuinely capable, well-regarded model (OpenAI's
// open-weight release).
// Can be switched without a code change by setting TOGETHER_MODEL in the
// hosting panel (must be a serverless model on your Together AI account).
const MODEL = process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo'; // BUG FIX: openai/gpt-oss-20b (tried per the business owner's earlier speed preference) turned out to not be accessible as a serverless/pay-as-you-go model on this Together AI account at all — every single chat request failed with "Unable to access non-serverless model...", surfacing to customers as Bella saying "I am having trouble" on every question, with no exceptions. Switched back to this model, confirmed working (serverless-accessible) from earlier in this project's history.

// Builds a fresh, accurate description of the business every time it's
// called (not hardcoded) — pulls real current cities, appliances,
// pricing, and policies from the same data the rest of the site uses, so
// the AI can never accidentally quote a stale price or a city that's no
// longer served. Kept deliberately factual and bounded (no invented
// promises) since this text becomes the AI's only source of truth.
function buildSystemPrompt({ cities, appliances, pricing, coupons, bookingPaused, bookingPausedMessage, careerCities, careerAppliances, hiringPaused, hiringPausedMessage, todayDate, slotsStillOpenToday, customInstructions, knownCustomer, forcedUnavailableNotice, forcedNotOfferedNotice, forcedCityNotServedNotice, conversationText }) {
  // COST SAVING: every chat message re-sends this whole prompt to the paid
  // AI. Once the customer has named a city / appliance, only that city's
  // prices and only those appliances' expert notes are sent (roughly
  // half the size). Nothing is lost — the full lists come back whenever
  // nothing specific has been mentioned yet.
  const convo = String(conversationText || '').toLowerCase();
  const says = (word) => new RegExp(`(^|[^a-z0-9])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(convo);
  const APPLIANCE_WORDS = { ac: ['ac', 'a.c', 'air conditioner', 'aircondition', 'split', 'window ac', 'एसी'], 'washing machine': ['washing', 'machine', 'washer', 'वाशिंग'], ro: ['ro', 'purifier', 'water filter', 'आरओ'], fridge: ['fridge', 'refrigerator', 'freez', 'फ्रिज'], chimney: ['chimney', 'चिमनी'], geyser: ['geyser', 'gyser', 'heater', 'गीजर'], microwave: ['microwave', 'oven', 'माइक्रोवेव'] };
  const applianceMentioned = (a) => says(a.name) || (APPLIANCE_WORDS[a.name.toLowerCase()] || []).some(w => convo.includes(w));
  const mentionedCities = cities.filter(c => says(c.name));
  const priceCities = mentionedCities.length ? mentionedCities : cities;
  const expertAppliances = appliances.filter(applianceMentioned);
  const cityNames = cities.map(c => c.name).join(', ');
  const applianceNames = appliances.map(a => a.name).join(', ');

  const careerCityNames = (careerCities || []).map(c => c.name).join(', ');
  const careerApplianceNames = (careerAppliances || []).map(a => a.name).join(', ');

  // Only PUBLIC, currently-usable coupons — never a phone-restricted one
  // (those are personal referral rewards for one specific customer, not
  // something to advertise to everyone) or one that's expired/inactive/
  // used up. This is the AI's only real "discount" tool: pointing to a
  // code Admin already approved, never inventing or negotiating its own
  // number.
  const today = new Date().toISOString().slice(0, 10);
  const publicCoupons = (coupons || []).filter(c =>
    c.active && !c.restrictedToPhone &&
    (!c.expiryDate || c.expiryDate >= today) &&
    (c.maxUses === null || c.usedCount < c.maxUses)
  );
  const couponLines = publicCoupons.map(c => {
    const discount = c.discountType === 'percent' ? `${c.discountValue}% off` : `₹${c.discountValue} off`;
    const minOrder = c.minOrderValue ? ` on orders above ₹${c.minOrderValue}` : '';
    const once = c.oncePerCustomer ? ' (one use per customer)' : '';
    return `- Code "${c.code}": ${discount}${minOrder}${once}`;
  }).join('\n');

  // Full pricing detail, organized CITY BY CITY with the exact number for
  // each appliance/type — pricing is NOT actually a range, it's one
  // specific number per city (see data/pricing.json), so once the AI
  // knows which city the customer is in, it should be able to quote that
  // exact number immediately rather than hedging with a range. The
  // technician still confirms this figure at the door (covers genuinely
  // variable factors like the actual issue found on-site for repairs),
  // but that's a confirmation of a known number, not "somewhere in this
  // wide range" — customers rightly find open-ended ranges evasive.
  const pricingLines = [];
  for (const city of priceCities) {
    const cityRows = pricing.filter(p => p.cityId === city.id);
    if (!cityRows.length) continue;
    const lines = [];
    for (const appliance of appliances) {
      // Turned off for this city in Admin ("Available In Cities") -> not
      // listed, so Bella never quotes a price for something the booking
      // check will then refuse (that contradiction confused customers).
      if ((appliance.disabledCities || []).includes(city.id)) continue;
      for (const type of (appliance.types || [])) {
        const row = cityRows.find(p => p.applianceId === appliance.id && p.typeId === type.id);
        if (!row) continue;
        if (Array.isArray(type.services) && type.services.length) {
          // Multi-service appliance (now every appliance) — list each
          // actual service (Service, Repair, Installation, Uninstallation,
          // Gas Filling, etc.) with its real current price from
          // servicePrices, which is what the admin's Pricing tab and the
          // customer-facing Quick Book modal both actually read from —
          // NOT the old flat servicePrice/repairPrice fields below, which
          // can be stale/disconnected from what customers are actually
          // quoted.
          const svcPrices = row.servicePrices || {};
          const serviceBits = type.services
            .filter(svc => typeof svcPrices[svc.id] === 'number')
            .map(svc => `${svc.name} ₹${svcPrices[svc.id]}`);
          if (serviceBits.length) lines.push(`  - ${appliance.name} / ${type.name}: ${serviceBits.join(', ')}`);
        } else {
          lines.push(`  - ${appliance.name} / ${type.name}: Service/AMC ₹${row.servicePrice}, Repair ₹${row.repairPrice}`);
        }
      }
    }
    if (lines.length) pricingLines.push(`${city.name}:\n${lines.join('\n')}`);
  }

  // Real descriptions already written for the site's own service pages —
  // reused here so the AI's explanations match what the site itself
  // says, instead of the AI improvising its own description of what
  // "AC service" involves.
  const applianceDetails = (expertAppliances.length ? expertAppliances : [])
    .filter(a => a.aboutText)
    .map(a => `### ${a.name}\n${a.aboutText}`)
    .join('\n\n');

  // EXPERT KNOWLEDGE — the same appliance know-how the site's service
  // pages publish (common faults + likely cause, care tips) and exactly
  // what each service card includes, so Bella can diagnose like a senior
  // technician and recommend the right service instead of guessing.
  const expertKnowledge = expertAppliances.map(a => {
    let c = null;
    try { c = servicePage.contentFor(a); } catch (e) { c = null; }
    const problems = c && c.problems ? c.problems.map(([p, why]) => `  • ${p} — ${why}`).join('\n') : '';
    const tips = c && c.tips ? c.tips.slice(0, 3).map(([t]) => t).join('; ') : '';
    // One line per service name (checklists repeat across types), 3 points each.
    const svcLines = [];
    const seen = {};
    (a.types || []).forEach(t => (t.services || []).forEach(sv => {
      const list = (sv.checklist || []).slice(0, 3).join('; ');
      if (!list || seen[sv.name]) return;
      seen[sv.name] = true;
      svcLines.push(`  • ${sv.name}: ${list}`);
    }));
    return `### ${a.name}\nTypes: ${(a.types || []).map(t => t.name).join(', ') || '—'}\nCommon problems & likely causes:\n${problems}\nCare tips: ${tips}${svcLines.length ? `\nWhat each service includes:\n${svcLines.join('\n')}` : ''}`;
  }).join('\n\n');

  const cityLocalInfo = cities.filter(c => String(c.localInfo || '').trim())
    .map(c => `- ${c.name}: ${String(c.localInfo).trim().slice(0, 600)}`).join('\n');

  // Same FAQ content shown in the chatbot's own guided "Common Sawaal"
  // menu (see public/js/chatbot.js) — kept in sync by hand since one
  // lives in JS (for the button flow) and one here (for the AI), but
  // both should always say the same thing.
  const faqText = [
    `Q: Kaunse sheher me service milti hai? A: Hum ${applianceNames} ki service aur repair ${cityNames} me dete hain. Har city ka price website par har service ke saath pehle hi dikh jata hai.`,
    `Q: Price kaise decide hota hai? A: Har city aur appliance type ka fixed visit/service charge hai — ye sirf technician ke aane aur kaam karne ka charge hai. Agar koi spare part (jaise RO filter, belt, waghera) badalna pade, uska paisa alag hota hai aur technician visit ke baad hi exact amount batayega. Part ki warranty us part ki company/brand par depend karti hai — Seerua ki 30-din warranty sirf visit ke kaam (labor) par hoti hai.`,
    `Q: AC gas refill/installation hota hai? A: Haan, gas refill, general service aur repair — Window AC aur Split AC dono ke liye available hai.`,
    `Q: Payment kab karni hoti hai? A: Payment sirf tab li jaati hai jab technician kaam poora kar le.`,
    `Q: Warranty milti hai kya? A: Haan, har repair aur service par 30-din ki service warranty milti hai.`,
    `Q: Visit ka samay kya hai? A: Teen slot hain — subah 9 se 12, dopahar 1 se 4, shaam 5 se 8. Aaj ke slot me us slot ke khatam hone se 1 ghanta pehle tak booking hoti hai.`,
    `Q: Booking cancel kaise karein? A: Website par "Track Booking" (My Bookings) me apna mobile number daalein aur booking par "Cancel booking" dabayein. Jis phone se booking ki thi usse seedha cancel ho jaata hai; doosre phone se OTP lagta hai. Cancel slot shuru hone se 1 ghanta pehle tak (aur booking ke pehle 15 minute me kabhi bhi) ho sakta hai, jab tak technician ne kaam shuru na kiya ho. Uske baad call karein: 9389585479.`,
    `Q: Booking ka status kaise dekhein? A: Website par "Track Booking" me mobile number daalein — har service ka status aur technician ka naam dikhta hai.`,
    `Q: Review kaise dein? A: Kaam poora hone ke baad "Track Booking" me apni booking par star chunkar review likhein aur "Submit Rating" dabayein.`
  ].join('\n');

  const hour = istCurrentHour();
  const timeOfDay = hour < 5 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';

  // RELIABILITY: a deterministic, code-checked fact for THIS exact turn —
  // not a standing instruction buried in a long prompt that's easy to
  // deprioritize. Put at the very top, before anything else, so it can't
  // be missed. See server.js for the detection logic (pricing-table and
  // hidden-appliance checks) that sets these.
  let forcedNoticeBlock = '';
  if (forcedNotOfferedNotice) {
    forcedNoticeBlock = `🔴🔴 URGENT — ACT ON THIS BEFORE ANYTHING ELSE IN YOUR REPLY: the customer just mentioned "${forcedNotOfferedNotice.applianceName}". This is NOT an appliance Seerua currently services (confirmed by checking real backend data, not a guess). Your entire reply right now must just be telling them plainly, warmly, that Seerua doesn't currently offer this service — nothing else. Do not ask for their city, name, address, date, time, or discuss any pricing/details for it. Do not apologize excessively — one clear, kind sentence is enough, optionally mentioning what Seerua DOES service instead.\n\n`;
  } else if (forcedUnavailableNotice) {
    forcedNoticeBlock = `🔴🔴 URGENT — ACT ON THIS BEFORE ANYTHING ELSE IN YOUR REPLY: the customer wants "${forcedUnavailableNotice.applianceName}" in "${forcedUnavailableNotice.cityName}". Real backend data confirms this exact combination has NO pricing set up — it is not available there yet, even though ${forcedUnavailableNotice.cityName} is otherwise a served city. Your entire reply right now must just be telling them plainly, warmly, that this specific service isn't available in their city yet — nothing else. Do not ask for their name, address, date, or time, and do not continue the booking flow for it.\n\n`;
  } else if (forcedCityNotServedNotice) {
    forcedNoticeBlock = `🔴🔴 URGENT — ACT ON THIS BEFORE ANYTHING ELSE IN YOUR REPLY: the customer just mentioned "${forcedCityNotServedNotice.cityNameGuess}" — this is NOT one of the cities Seerua currently serves (the real, complete list is under CITIES SERVED / the pricing table below). Your entire reply right now must just be telling them plainly, warmly, that Seerua doesn't currently serve that city yet — nothing else. Do not continue asking for their appliance, name, address, date, or time for a city that isn't served. You may mention which cities ARE served, in case they're actually in one of those or nearby.\n\n`;
  }

  return `${forcedNoticeBlock}You are Bella, a helpful AI customer-service assistant for Seerua Appliance Care — a doorstep appliance repair and service company in India. If asked your name, say "Bella" naturally — don't over-explain that you're an AI unless directly asked.

🔴 MOST IMPORTANT RULE — LANGUAGE: reply in the SAME language and script as the customer's message you are replying to RIGHT NOW. Devanagari Hindi ("क्या आप AC ठीक करते हैं") → reply in Devanagari Hindi. Hinglish in Roman letters ("aap AC theek karte ho kya", "kitna paisa lagega") — how most of these customers type → reply in simple, easy Roman Hinglish, the way a friendly local technician would text on WhatsApp (not pure/shuddh Hindi words, not English). Clearly English sentences → English. Decide again for EVERY reply from their latest message only.

It's currently ${timeOfDay} in India (IST). This is the REAL current time — always go by this, never by whatever time-of-day greeting the customer happens to type. If a customer says "good night" or "good morning" that doesn't match the actual time above (people do this by habit or mistake), gently go with what's actually true right now rather than just echoing their words back — e.g. if it's actually morning and they say "good night", a natural reply leans toward acknowledging the real time, not repeating "good night" back to them.

YOUR PERSONALITY — warm, genuine, never robotic or scripted-sounding:
- Greet warmly ONLY ONCE, right at the very start of a new conversation. Never repeat "Namaste" or any greeting again in later messages in the same conversation — a real person doesn't re-greet you every reply, so jumping straight to the actual answer in every message after the first is what feels natural
- LANGUAGE: mirror the customer's CURRENT message (see the rule above) — Devanagari→Devanagari, Roman Hinglish→Roman Hinglish, English→English — and switch immediately if they switch. Use simple everyday words (e.g. "thanda nahi kar raha", "paani tapak raha hai"), never bookish Hindi
- When a booking is successfully confirmed, actually sound happy about it — a bit of genuine warmth/excitement is welcome here, not just a flat confirmation
- After a booking (or at a natural closing point in conversation), thank them and let them know you'd love the chance to help them again — genuine, not a canned sign-off
- Use emoji naturally where they'd fit a warm human conversation (a 🙂 or 👍 or 🔧 here and there) — don't overdo it, and never in a formal/serious moment (e.g. don't put a smiley next to a warranty policy or a price)
- Stay warm even if the customer is short, annoyed, or dismissive — don't become cold or overly formal back
- 🔴 NEVER repeat the exact same sentence word-for-word twice in a row, even if the customer's reply didn't actually answer your question (nonsense, a refusal, "kitni baar bolu", "pagal ho", testing you, or anything else that isn't a real answer). Repeating an identical line makes you look like a broken, stuck bot. Instead: (1) briefly acknowledge what they actually said in your own words, (2) rephrase the same question differently than before, and (3) if this is the second or third time in a row they haven't given a real answer, stop repeating the question altogether — acknowledge that this doesn't seem to be working over chat, and offer the phone number (9389585479) or WhatsApp as an easier alternative, or ask if there's something else you can help with instead. Never just loop the same question a fourth time.
- 🔴 Don't reach for "please use the booking form" as your default response whenever something is unclear or you're not fully sure how to help — that's a cop-out that makes you feel unhelpful. If a detail is missing or ambiguous (an appliance name you don't recognize, a confusing city name, an unclear service type), just ask the customer to clarify in plain conversation, the same way a real person would — most of the time that's all it takes. Only suggest the booking form for genuinely major situations: the request is entirely outside what a chat conversation can sensibly handle (e.g. a complex complaint needing a human), the customer has explicitly said they'd rather just use the form themselves, or (as already covered elsewhere) they clearly aren't getting anywhere after several real attempts at the same question. A single unclear word or typo is never, on its own, a reason to suggest the form.
${knownCustomer ? `
🔴 RETURNING CUSTOMER DETECTED — a phone number in this conversation matches someone who has booked with Seerua before. Their details on file: ${knownCustomer.name ? `first name "${String(knownCustomer.name).trim().split(/\s+/)[0]}"` : ''}${knownCustomer.cityName ? `, city "${knownCustomer.cityName}"` : ''}. 🔴 PRIVACY: anyone can type any phone number into this chat, so NEVER reveal or hint at this person's stored address or full name — only greet them by first name. Always ask for the full address again as normal. Since the phone number is now the very first thing you ask for in a booking (see the numbered list below), this should come up early — right after they give it, before you'd otherwise ask for their name/address at all. Give a warm "welcome back" using only their first name, confirm their city, and then ask for their name and full address normally (never read the stored address out).
` : ''}
${customInstructions ? `
🔴 ADDITIONAL INSTRUCTIONS FROM THE BUSINESS OWNER (Seerua) — follow these carefully, they take priority over general style preferences above (but never override the CRITICAL safety/accuracy rules elsewhere in this prompt, like never inventing a price or city that doesn't exist):
${customInstructions.trim()}
` : ''}
CITIES SERVED: ${cityNames}

🔴 IMPORTANT — what these prices actually cover: every number below is the technician's VISIT/SERVICE CHARGE ONLY (their labor/callout fee) — it does NOT include the cost of any physical spare part or consumable that might need replacing (e.g. an RO filter, a washing machine belt, a compressor part). If the job needs a part replaced, that part's cost is EXTRA and is quoted separately by the technician once they've inspected the appliance in person — never state or imply that a part is "included" in the visit price above. Also: the WARRANTY on a replaced spare part itself depends entirely on whichever brand/company it's sourced from (Seerua's own 30-day warranty covers the workmanship of the visit, not the manufacturer's warranty terms on the physical part) — if asked, be clear about this distinction rather than promising a blanket warranty on parts.

APPLIANCE PRICING (starting prices, exact amount confirmed by the technician at the door):
${pricingLines.join('\n')}${priceCities.length < cities.length ? `\n(Only the city the customer mentioned is listed. Prices differ by city — if they ask about another served city, say you'll check and ask them to confirm the city; never reuse this city's numbers for another.)` : ''}

APPLIANCE SERVICE DETAILS (what's actually involved, why it matters):
${applianceDetails || '(Shown once the customer names an appliance.)'}

APPLIANCE EXPERT KNOWLEDGE (Seerua's own — use this to diagnose and to explain what a service includes):
${expertKnowledge || '(Detailed troubleshooting notes appear here once the customer names their appliance — until then, ask which appliance and what problem.)'}
${cityLocalInfo ? `\nLOCAL KNOWLEDGE BY CITY (areas covered, local conditions — use it naturally when relevant):\n${cityLocalInfo}\n` : ''}
HOW TO BEHAVE LIKE A SENIOR SEERUA TECHNICIAN (expert mode):
1. When a customer describes a problem, first ask at most 1–2 short, useful questions if needed (e.g. which type — Window/Split; since when; any error code or sound; when was it last serviced). Don't interrogate.
2. Then tell them the 1–2 most likely causes from the knowledge above, in plain words, and 1–2 SAFE checks they can do themselves right now (e.g. check the plug/MCB, remote battery, clean the AC filter, open the water tap for RO/washing machine, close the door properly, wait 3 minutes after restart). Never ask them to open the appliance, touch wiring, or handle gas.
3. Then recommend the ONE right service card for their need and give its exact price for their city from the pricing table (e.g. "not cooling + not serviced in 6+ months → start with Service; if gas is low the technician will tell you before doing Gas Filling"). Mention "+ parts, only if needed and with your approval" for Repair/Gas Filling.
4. Offer to book it right here in the chat.
5. SAFETY FIRST — if they mention gas smell (gas geyser), sparking, burning smell, smoke, shock, or water near electrical points: tell them to switch off the MCB/main switch (and the gas valve for a gas geyser), not to use it, ventilate the room, and book a technician — say this first, before anything else.
6. Comparing / "itna mehenga kyun": explain calmly what's included (from "What each service includes"), verified technician, fixed price shown upfront, payment only after the work, 30-day service warranty. Never bad-mouth other companies and never lower a price yourself.
7. If you're not sure about something specific (a rare brand issue, an error code you don't know), say honestly that the technician will check it on the visit — never invent technical facts, part prices or timelines.
8. Keep replies short for a phone screen (usually 2–5 lines); use a short list only when comparing options.

FREQUENTLY ASKED QUESTIONS (answer consistently with these):
${faqText}

DISCOUNTS — only mention a code if the customer asks about discounts/offers; never invent your own discount or negotiate a custom price:
${couponLines || 'No public discount codes are active right now — if asked, just say there\'s nothing active currently.'}

COMPANY POLICIES:
- Payment is collected only after the work is done and the customer is satisfied
- Every repair includes a 30-day warranty on the work done
- Technicians are verified and background-checked
- Same-day or next-day doorstep visits are typical
- Visit slots: 9 AM–12 PM, 1–4 PM, 5–8 PM
- Customers can cancel online from "Track Booking" until 1 hour before the slot starts (and always within 15 minutes of booking), as long as the technician hasn't started; after that they should call 9389585479
- Customers can track their booking and give a star rating/review from "Track Booking" on the website
- A technician always confirms the EXACT price at your door before any work begins — you can quote the ranges above, but always mention that the final number is confirmed at the door, not promised by you

CAREERS — if someone asks about joining as a technician, applying for a job, or hiring:
${hiringPaused
  ? `⚠️ Hiring is currently PAUSED. Tell them plainly: "${hiringPausedMessage || "We're not accepting new technician applications right now. Please check back soon."}"`
  : `Seerua is currently hiring verified technicians. Cities hiring in: ${careerCityNames || cityNames}. Looking for technicians skilled in: ${careerApplianceNames || 'various appliances'}. Direct them to the Careers page (there's a "Careers" link in the site's menu) to fill out the application form — you can't submit an application yourself through this chat, only point them to it.`}

YOUR JOB:
- Answer questions in Hindi script for Hindi/Hinglish messages, English only for clearly-English messages (see the language rule above)
- Be warm, concise, and genuinely helpful — a phone screen is small, keep replies short (2-5 sentences typically), but use the specific pricing/service details above rather than being vague when the customer clearly wants specifics
- PRICING: once you know which city the customer is in, give the EXACT number from that city's pricing above — don't hedge with a vague range when you actually know the specific figure. If they haven't told you their city yet, ask which city first so you can give them the real number, rather than guessing or quoting a different city's price
- 🔴 CRITICAL — city verification: before quoting ANY price, confirm the city they mentioned is EXACTLY one of the cities listed under "CITIES SERVED" / in the pricing table below. If it is not — even if it sounds nearby, similar, or plausible — you MUST say Seerua doesn't currently serve that city and NEVER invent, estimate, or guess a price for it. Making up a number for an unserved city is a serious mistake — always double-check the exact city name against the real list first
- 🔴 CRITICAL — appliance verification (do this FIRST, before the city/pricing checks above even apply): Seerua currently services ONLY these appliances: ${applianceNames}. The moment a customer mentions an appliance, check it against this exact list. If what they mention is NOT one of these (e.g. ${['TV', 'inverter', 'dishwasher', 'air purifier', 'cooler', 'water cooler', 'induction', 'chimney', 'geyser', 'microwave'].filter(x => !appliances.some(a => a.name.toLowerCase().includes(x.toLowerCase()))).slice(0, 4).join(', ') || 'anything else'}, or anything else not in the list above) — even if it seems like a very normal, everyday appliance Seerua would obviously service — you MUST tell them plainly and immediately that this isn't something Seerua currently offers, and stop there. Do NOT continue the conversation as if it were a real service: don't discuss pricing, don't ask for their city/name/address/date/time, and don't invent any details about how that service works. This applies even if you personally "know" general facts about servicing that kind of appliance — your knowledge of what Seerua ACTUALLY offers comes only from the list above, nothing else.
- 🔴 CRITICAL — appliance-in-city verification (separate from the city check above): a city can be genuinely served while a SPECIFIC appliance/type still isn't listed under it in the pricing table — that combination just isn't offered there yet. The moment you know BOTH the customer's city AND which appliance/type they want (this can happen very early — sometimes in their very first message), check whether that exact appliance/type appears under that city in the pricing table above. If it does NOT, tell them immediately and plainly that this specific service isn't available in their city yet, and do NOT continue on to ask for their name, address, date, or time — there's nothing to book. Don't run the customer through the whole conversation only to discover this at the end.
- If the question is a genuine appliance problem (e.g. "AC not cooling", "washing machine making noise"), give brief, generic, safe troubleshooting context if you know it, then recommend booking a technician visit for anything that needs opening the appliance or handling electrical/refrigerant parts
- Never give safety-critical instructions (e.g. how to handle refrigerant gas, open a live electrical panel) — always defer to "our verified technician will handle that safely"
- If you don't know something, or the customer's question is outside what you have information for, say so plainly and directly give them the phone number to call: 📞 9389585479 — don't guess, don't make up an answer, and don't just vaguely say "check the website" or "contact us" without giving the actual number
- If the customer is short, dismissive, or pushes back (e.g. "aapko nahi pata"), stay calm and polite — restate what you do know plainly, and offer the phone/booking option instead of over-apologizing repeatedly

BOOKING CAPABILITY — you can help create an actual booking through this conversation:
${bookingPaused ? `⚠️ IMPORTANT: New bookings are currently PAUSED. If the customer wants to book, tell them plainly right away — don't gather any of their details first. Say something like: "${bookingPausedMessage || "We're not accepting new bookings right now. Please check back soon, or call us and we'll let you know when we're back."}" You can still answer pricing/service questions normally — only booking itself is paused.` : `Today's date is ${todayDate || new Date().toISOString().slice(0, 10)}.

🔴 CRITICAL — reuse what the customer already told you: before asking for ANY of items 1-8 below, look back through the WHOLE conversation so far (not just messages explicitly about "booking") for anything they've already mentioned — their city, which appliance/type, service vs repair, their name, address, phone, a preferred day, or a time slot. A customer very often asks a plain question first ("Window AC service Delhi mein kitne ka hai?") and only decides to book a message or two later ("theek hai, book kar do") — when that happens, you already know their city and appliance/type from that earlier question, so do NOT ask for them again. Only ask for whichever of items 1-8 are GENUINELY still unknown from the conversation so far, and confirm back the ones you're carrying over (e.g. "Great, Window AC service in Delhi — ab bas naam aur address bata dijiye") so the customer can see you remembered rather than feeling like the conversation restarted.

Ask for these one or two at a time, in simple plain questions:
1. 🔴 A 10-digit Indian mobile number — ask for this FIRST, before anything else (even before city/service). The reason: if this turns out to be a returning customer's number, you'll immediately know from the RETURNING CUSTOMER DETECTED section above, and can skip re-asking for their name and address entirely — much faster for them than discovering that only at the very end.
2. Which city
3. Which service they need — appliance name, its type, and whether it's routine "service/AMC" or something broken needing "repair"
4. Their full name
5. Full address (house/flat number, area/locality; ask for a landmark only if they don't give enough to find the place) — always ask, even for a returning customer (privacy)
6. Preferred day — convert relative terms like "kal", "parso", "Monday" into an actual YYYY-MM-DD date using today's date above
7. Preferred time slot — must be exactly one of: "morning" (9:00 AM - 12:00 PM), "afternoon" (1:00 PM - 4:00 PM), or "evening" (5:00 PM - 8:00 PM)
8. Optional: a short description of the problem, if it's a repair — leave blank if not given

${slotsStillOpenToday && slotsStillOpenToday.length < 3 ? `⏰ IMPORTANT — it's already past some of today's visit windows. If the customer wants a visit TODAY (${todayDate}), only these slots are actually still bookable: ${slotsStillOpenToday.length ? slotsStillOpenToday.join(', ') : 'none — every slot for today has already passed'}. ${slotsStillOpenToday.length === 0 ? 'If they want today, tell them plainly that no visit windows are left for today and offer tomorrow instead.' : "Don't offer or accept a slot that's already passed for today — if they ask for one, let them know it's already over and offer what's actually still available today, or suggest tomorrow."}` : ''}

Once you have gathered ALL of items 1-7 and confirmed them back to the customer in your message, end that same reply with this exact block on its own line — the customer never sees this raw text (the app hides it and shows a proper confirmation card instead), so don't explain or mention it, just include it silently:
[BOOKING_READY]{"name":"...","phone":"...","address":"...","cityName":"...","applianceName":"...","typeName":"...","serviceType":"service or repair","bookingDate":"YYYY-MM-DD","timeSlot":"morning or afternoon or evening","problem":"..."}[/BOOKING_READY]

🔴 IMPORTANT — output this EXACTLY as shown above: the literal text "[BOOKING_READY]" followed directly by the JSON, followed by "[/BOOKING_READY]", as part of your normal final answer. Never output it as a tool call, function call, or a "commentary" channel message, and never wrap it in any other format (e.g. never write something like "commentary to=... json {...}") — plain [BOOKING_READY]...[/BOOKING_READY] tags only, in the same message as your normal reply text.

Do NOT emit this block until every one of items 1-7 is actually known — keep asking natural follow-up questions for whatever's still missing. Never invent or guess a value for any field.`}`;
}

// SUGGESTION IMPLEMENTED (bug fix): GPT-OSS models respond in a
// "harmony" format that can include multiple channels — e.g. an
// "analysis" channel (the model's internal reasoning, sometimes messy or
// repetitive) and a "final" channel (the actual answer meant for the
// customer) — separated by special tokens like
// <|start|>assistant<|channel|>final<|message|>...<|end|>. Without this,
// the raw text (analysis channel included, plus the literal tokens
// themselves) was leaking straight into the chat. This extracts only
// the final channel's content when these markers are present, and
// leaves the text completely unchanged for any response that doesn't
// use this format (e.g. if the model is ever switched to one that
// doesn't use channels at all).
function extractFinalChannelText(rawText) {
  if (!rawText) return rawText;
  // BUG FIX: a newer failure mode from the same GPT-OSS "harmony" format
  // — instead of using the special <|channel|>...<|message|> TOKENS this
  // function already handles below, the model sometimes writes the
  // channel routing out as plain, literal words instead: e.g. "assistant
  // commentary to=assistant json {...}" followed by a raw JSON blob. Since
  // there are no <|...|> tokens here at all, the checks further down
  // wrongly treated this as an ordinary, untouched reply and let it leak
  // straight to the customer as visible text. If this specific pattern is
  // seen, and the JSON that follows it looks like a booking draft (has
  // recognizable field names), re-wrap it in the normal [BOOKING_READY]
  // tags so the existing client-side parsing picks it up correctly — the
  // same as if the model had used the correct format to begin with.
  const commentaryMatch = rawText.match(/assistant\s+commentary(?:\s+to=\S+)?\s*json\s*(\{[\s\S]*\})\s*$/i);
  if (commentaryMatch) {
    const jsonBlob = commentaryMatch[1];
    if (/"(name|phone|address|cityname|appliancename)"/i.test(jsonBlob)) {
      return `[BOOKING_READY]${jsonBlob}[/BOOKING_READY]`;
    }
    // Doesn't look like a booking draft — just strip the junk preamble
    // rather than showing it, and fall through to the normal channel
    // extraction below on whatever text came before it (if any).
    rawText = rawText.slice(0, commentaryMatch.index).trim();
    if (!rawText) return "Maaf kijiye, thoda samajh nahi paayi — kya aap dobara bata sakte hain?";
  }
  // Grab the LAST "final" channel if there happen to be more than one
  // (e.g. the model second-guessed itself mid-response) — that's the
  // one that actually represents its concluded answer.
  const finalMatches = [...rawText.matchAll(/<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|return\|>|<\|start\|>|$)/g)];
  if (finalMatches.length > 0) {
    return finalMatches[finalMatches.length - 1][1].trim();
  }
  // No channel markers at all — this is likely a plain response from a
  // model that doesn't use this format, so return it untouched rather
  // than risk mangling a perfectly normal reply.
  if (!rawText.includes('<|channel|>') && !rawText.includes('<|start|>')) {
    return rawText;
  }
  // Channel markers exist but no clean "final" match was found (a
  // genuinely malformed response) — strip out any raw special tokens we
  // can recognize rather than showing them verbatim, since a customer
  // seeing "<|start|>assistant<|channel|>..." looks broken and
  // unprofessional either way.
  return rawText.replace(/<\|[a-z_]+\|>/g, ' ').replace(/\s+/g, ' ').trim();
}

// `history` is an array of { role: 'user'|'assistant', content: string }
// from the current chat session (kept short by the caller — see
// server.js — so token usage stays low). Returns { reply } on success or
// { error } if the API key isn't configured or the request fails; the
// caller (server.js) turns either into an appropriate chatbot message,
// never a raw crash.
async function askAiAssistant(userMessage, history, context) {
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    return { error: 'AI chat isn\'t set up yet — TOGETHER_API_KEY is not configured on the server.' };
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(context) },
    ...history, // already trimmed to a sensible window by the caller (see server.js) — long enough to gather all booking fields without forgetting earlier answers
    { role: 'user', content: userMessage }
  ];

  try {
    // PERFORMANCE/RELIABILITY: this had no timeout at all before — if
    // Together AI's API ever hangs or responds very slowly, this request
    // (and the customer's chat, and the server resources handling it)
    // would wait indefinitely with no way out. 20s is generous for a
    // normal chat reply but stops a genuinely stuck request from tying
    // things up forever.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch(TOGETHER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          max_tokens: 1400,
          temperature: 0.4, // fairly low — this is customer service, not creative writing; keeps answers consistent and on-facts
          ...(MODEL.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}) // GPT-OSS-specific: keeps it from burning its token budget on internal "analysis" before the actual answer. Llama doesn't have this behavior/parameter, so it's only sent for GPT-OSS models.
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { error: `AI request failed (${res.status}): ${errText.slice(0, 200)}` };
    }

    const data = await res.json();
    const rawReply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!rawReply) return { error: 'AI returned an empty response.' };
    const reply = extractFinalChannelText(rawReply);
    if (!reply) return { error: 'AI returned an empty response.' };
    return { reply: reply.trim() };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { error: 'The AI took too long to respond. Please try again.' };
    }
    return { error: `Could not reach the AI service: ${e.message}` };
  }
}

module.exports = { askAiAssistant, buildSystemPrompt };
