// ------------------------------------------------------------------
// Seerua Appliance Care — EN / Hindi language toggle
// Covers the static page chrome (nav, hero, section headers, booking
// form labels, footer, etc). Content that's rendered dynamically from
// live data (service cards, testimonials, cart items, FAQ answers,
// Admin/Technician panels) stays in English for now — translating that
// would mean maintaining two copies of every piece of live data, which
// is a much bigger project than this first pass.
// ------------------------------------------------------------------

const I18N = {
  en: {
    'nav.services': 'Services',
    'nav.track': 'Track',
    'nav.faq': 'FAQ',
    'nav.careers': '👷 Careers',
    'nav.careers2': 'Careers',
    'nav.bookNow': 'Book Now',
    'hero.eyebrow': 'Doorstep appliance service',
    'hero.titlePrefix': 'Appliance repair & service at the',
    'hero.titleHighlight': 'right price',
    'hero.titleSuffix': 'for your city',
    'stats.cities': 'Cities served',
    'stats.appliances': 'Appliance categories',
    'stats.verified': 'Verified Technicians',
    'stats.sameDay': 'Same Day',
    'stats.doorstep': 'Doorstep visit',
    'services.eyebrow': 'Our services',
    'services.title': 'One place for every appliance need',
    'brands.eyebrow': 'All brands welcome',
    'brands.title': 'We repair and service every major brand',
    'how.eyebrow': 'How it works',
    'how.title': 'Get service done in 3 easy steps',
    'how.step1Title': 'Book online',
    'how.step1Desc': 'Share your city, appliance and problem, and complete your booking in a few minutes.',
    'how.step2Title': 'Technician visits',
    'how.step2Desc': 'A verified technician reaches your home at the scheduled time and inspects the appliance.',
    'how.step3Title': 'Pay after the job is done',
    'how.step3Desc': 'Pay only once the repair or service is complete — fully transparent, no surprises.',
    'why.eyebrow': 'Why Seerua Appliance Care',
    'why.title': 'The service to trust, every time',
    'why.item1Title': 'Verified Technicians',
    'why.item1Desc': 'Every technician is trained and background verified.',
    'why.item2Title': 'Transparent City-wise Pricing',
    'why.item2Desc': 'Each city has its own fair price, with no hidden charges.',
    'why.item3Title': 'Choose Your Time Slot',
    'why.item3Desc': 'Pick a morning, afternoon or evening slot that works for you — most visits happen the same day or the next.',
    'cities.eyebrow': 'Service areas',
    'cities.title': 'We currently serve these cities',
    'booking.eyebrow': 'Book a service',
    'booking.verified': 'Trained Technicians',
    'booking.payAfter': 'Pay After Service',
    'booking.cityLabel': 'City *',
    'booking.addTitle': 'Add an appliance to this booking',
    'booking.applianceLabel': 'Appliance',
    'booking.typeLabel': 'Type',
    'booking.needLabel': 'What do you need?',
    'booking.serviceOption': 'Service / AMC',
    'booking.repairOption': 'Repair',
    'booking.qtyLabel': 'Quantity',
    'booking.problemLabel': 'Problem / Notes (optional)',
    'booking.problemPlaceholder': 'e.g. Not cooling properly',
    'booking.photoLabel': 'Photo of the appliance/issue (optional)',
    'booking.photoHelp': 'Helps the technician arrive prepared with the right spare part.',
    'booking.addBtn': '+ Add to Booking',
    'booking.emptyCart': 'No appliances added yet. Add at least one above.',
    'booking.submitBtn': 'Submit',
    'track.eyebrow': 'Check your order',
    'track.title': 'My Booking',
    'track.sub': 'See the live status of every appliance in your booking, and quickly rebook with the same details.',
    'track.phoneLabel': 'Registered Mobile Number',
    'track.phonePlaceholder': '10 digit number',
    'track.checkBtn': 'Check Status',
    'refer.phoneLabel': 'Your Mobile Number',
    'refer.getLinkBtn': 'Get My Referral Link',
    'refer.cardTitle': '🎁 Refer a Friend',
    'refer.cardSub': "Share your link — you both get ₹100 off.",
    'faq.eyebrow': 'Frequently asked questions',
    'faq.title': 'FAQ',
    'about.eyebrow': 'About Us',
    'about.title': "Built to be your city's most trusted appliance care partner",
    'about.item1Title': 'Who We Are',
    'about.item1Desc': 'A growing appliance care company built for the modern home, expanding city by city with one goal — bringing dependable, doorstep service to more households every month.',
    'about.item2Title': 'Our Technicians',
    'about.item2Desc': "Every technician on our platform is individually screened, trained, and background-verified before they're ever allowed into a customer's home — so you can trust the person at your door.",
    'about.item3Title': 'Our Promise',
    'about.item3Desc': 'Just like the platforms you already trust for everyday services, Seerua is built around speed, transparency, and customer-first support — because great service should never be complicated.',
    'footer.quickLinks': 'Quick Links',
    'footer.servicesHeading': 'Services',
    'footer.contact': 'Contact',
    'footer.terms': 'Terms & Conditions',
    'mobile.call': '📞 Call'
  },
  hi: {
    'nav.services': 'सेवाएं',
    'nav.track': 'ट्रैक करें',
    'nav.faq': 'सामान्य सवाल',
    'nav.careers': '👷 करियर',
    'nav.careers2': 'करियर',
    'nav.bookNow': 'अभी बुक करें',
    'hero.eyebrow': 'घर बैठे अप्लायंस सर्विस',
    'hero.titlePrefix': 'अपने शहर में अप्लायंस रिपेयर और सर्विस',
    'hero.titleHighlight': 'सही कीमत पर',
    'hero.titleSuffix': '',
    'stats.cities': 'शहरों में सेवा',
    'stats.appliances': 'अप्लायंस केटेगरी',
    'stats.verified': 'सत्यापित तकनीशियन',
    'stats.sameDay': 'उसी दिन',
    'stats.doorstep': 'घर पर विजिट',
    'services.eyebrow': 'हमारी सेवाएं',
    'services.title': 'हर अप्लायंस की जरूरत, एक ही जगह',
    'brands.eyebrow': 'सभी ब्रांड्स स्वीकार्य',
    'brands.title': 'हम हर बड़े ब्रांड की रिपेयर और सर्विस करते हैं',
    'how.eyebrow': 'कैसे काम करता है',
    'how.title': '3 आसान स्टेप्स में सर्विस पूरी करें',
    'how.step1Title': 'ऑनलाइन बुक करें',
    'how.step1Desc': 'अपना शहर, अप्लायंस और समस्या बताएं, और कुछ ही मिनटों में बुकिंग पूरी करें।',
    'how.step2Title': 'तकनीशियन विजिट करेगा',
    'how.step2Desc': 'एक सत्यापित तकनीशियन तय समय पर आपके घर आएगा और अप्लायंस की जांच करेगा।',
    'how.step3Title': 'काम पूरा होने के बाद भुगतान करें',
    'how.step3Desc': 'सिर्फ तभी भुगतान करें जब रिपेयर या सर्विस पूरी हो जाए — पूरी पारदर्शिता, कोई छिपा खर्च नहीं।',
    'why.eyebrow': 'क्यों चुनें Seerua Appliance Care',
    'why.title': 'हर बार भरोसा करने लायक सेवा',
    'why.item1Title': 'सत्यापित तकनीशियन',
    'why.item1Desc': 'हर तकनीशियन प्रशिक्षित और बैकग्राउंड-वेरिफाइड है।',
    'why.item2Title': 'पारदर्शी शहर-वार कीमत',
    'why.item2Desc': 'हर शहर की अपनी उचित कीमत है, कोई छिपा खर्च नहीं।',
    'why.item3Title': 'अपना समय चुनें',
    'why.item3Desc': 'सुबह, दोपहर या शाम — जो समय आपको सही लगे वो चुनें। ज़्यादातर विजिट उसी दिन या अगले दिन हो जाती हैं।',
    'cities.eyebrow': 'सेवा क्षेत्र',
    'cities.title': 'हम अभी इन शहरों में सेवा देते हैं',
    'booking.eyebrow': 'सर्विस बुक करें',
    'booking.verified': 'प्रशिक्षित तकनीशियन',
    'booking.payAfter': 'सर्विस के बाद भुगतान',
    'booking.cityLabel': 'शहर *',
    'booking.addTitle': 'इस बुकिंग में अप्लायंस जोड़ें',
    'booking.applianceLabel': 'अप्लायंस',
    'booking.typeLabel': 'टाइप',
    'booking.needLabel': 'आपको क्या चाहिए?',
    'booking.serviceOption': 'सर्विस / AMC',
    'booking.repairOption': 'रिपेयर',
    'booking.qtyLabel': 'मात्रा',
    'booking.problemLabel': 'समस्या / नोट्स (वैकल्पिक)',
    'booking.problemPlaceholder': 'जैसे: ठंडक नहीं हो रही',
    'booking.photoLabel': 'अप्लायंस/समस्या की फोटो (वैकल्पिक)',
    'booking.photoHelp': 'इससे तकनीशियन सही स्पेयर पार्ट लेकर आ पाएगा।',
    'booking.addBtn': '+ बुकिंग में जोड़ें',
    'booking.emptyCart': 'अभी तक कोई अप्लायंस नहीं जोड़ा गया। ऊपर से कम से कम एक जोड़ें।',
    'booking.submitBtn': 'सबमिट करें',
    'track.eyebrow': 'अपना ऑर्डर चेक करें',
    'track.title': 'मेरी बुकिंग',
    'track.sub': 'अपनी बुकिंग के हर अप्लायंस का लाइव स्टेटस देखें, और उन्हीं डिटेल्स से जल्दी दोबारा बुक करें।',
    'track.phoneLabel': 'रजिस्टर्ड मोबाइल नंबर',
    'track.phonePlaceholder': '10 अंकों का नंबर',
    'track.checkBtn': 'स्टेटस चेक करें',
    'refer.phoneLabel': 'आपका मोबाइल नंबर',
    'refer.getLinkBtn': 'मेरा रेफरल लिंक पाएं',
    'refer.cardTitle': '🎁 दोस्त को रेफर करें',
    'refer.cardSub': 'अपना लिंक शेयर करें — दोनों को ₹100 की छूट मिलेगी।',
    'faq.eyebrow': 'अक्सर पूछे जाने वाले सवाल',
    'faq.title': 'सामान्य सवाल',
    'about.eyebrow': 'हमारे बारे में',
    'about.title': 'आपके शहर का सबसे भरोसेमंद अप्लायंस केयर पार्टनर',
    'about.item1Title': 'हम कौन हैं',
    'about.item1Desc': 'आधुनिक घरों के लिए बना एक बढ़ता हुआ अप्लायंस केयर प्लेटफॉर्म, जो हर महीने ज्यादा घरों तक भरोसेमंद, घर-पर सेवा पहुंचाने के लक्ष्य के साथ शहर-दर-शहर बढ़ रहा है।',
    'about.item2Title': 'हमारे तकनीशियन',
    'about.item2Desc': 'हमारे प्लेटफॉर्म पर हर तकनीशियन को ग्राहक के घर जाने से पहले व्यक्तिगत रूप से जांचा, प्रशिक्षित और बैकग्राउंड-वेरिफाइड किया जाता है — ताकि आप दरवाजे पर आने वाले व्यक्ति पर भरोसा कर सकें।',
    'about.item3Title': 'हमारा वादा',
    'about.item3Desc': 'जिन प्लेटफॉर्म्स पर आप रोजमर्रा की सेवाओं के लिए पहले से भरोसा करते हैं, उन्हीं की तरह Seerua भी स्पीड, पारदर्शिता और ग्राहक-प्राथमिकता वाले सपोर्ट पर बना है — क्योंकि अच्छी सेवा कभी भी जटिल नहीं होनी चाहिए।',
    'footer.quickLinks': 'क्विक लिंक्स',
    'footer.servicesHeading': 'सेवाएं',
    'footer.contact': 'संपर्क करें',
    'footer.terms': 'नियम एवं शर्तें',
    'mobile.call': '📞 कॉल करें'
  }
};

function applyLanguage(lang) {
  const dict = I18N[lang] || I18N.en;
  document.documentElement.lang = lang === 'hi' ? 'hi' : 'en';

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key] !== undefined) el.setAttribute('placeholder', dict[key]);
  });

  document.querySelectorAll('.lang-toggle .lang-opt').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-lang') === lang);
  });

  try { localStorage.setItem('seerua_lang', lang); } catch (e) { /* private browsing etc — just skip persisting */ }
}

function initLanguageToggle() {
  const toggle = document.getElementById('langToggle');
  if (!toggle) return;

  let saved = 'en';
  try { saved = localStorage.getItem('seerua_lang') || 'en'; } catch (e) { /* ignore */ }
  applyLanguage(saved);

  toggle.addEventListener('click', () => {
    const current = document.documentElement.lang === 'hi' ? 'hi' : 'en';
    applyLanguage(current === 'hi' ? 'en' : 'hi');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLanguageToggle);
} else {
  initLanguageToggle();
}
