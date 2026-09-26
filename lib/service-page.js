// =======================================================================
// Appliance + City service page ("AC Service in Moradabad") — HTML builders
//
// Layout (per request, modelled on the reference screenshots):
//   1. "Select a Product" strip — every appliance served in this city,
//      one tap to jump to that appliance's page in the same city.
//   2. Type tabs (Window AC / Split AC / Cassette AC ...) — all types are
//      rendered server-side (crawlable), tabs only switch which is shown.
//   3. One card per priced service: photo + price badge, strike/real
//      price, 5-point checklist, "Know more", and Add / Book buttons.
//      No "Review" button.
//   4. A long, city-specific article below the cards (SEO), built entirely
//      from live data — so the moment Admin adds a city, every appliance
//      and type page for it exists with complete content; delete the city
//      and they're gone. Nothing here is a static file.
//
// All wording here is Seerua's own.
// =======================================================================

function slugify(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function applianceSlug(name) {
  return `${slugify(name)}-service`;
}
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toWebpUrl(url) {
  return String(url || '').replace(/\.(jpe?g|png)$/i, '.webp');
}
function pictureHtml(photoUrl, attrs) {
  return `<picture><source srcset="${esc(toWebpUrl(photoUrl))}" type="image/webp"><img src="${esc(photoUrl)}" ${attrs}></picture>`;
}
function inr(n) {
  return '₹' + Number(n).toLocaleString('en-IN');
}

// Type names aren't consistent about including the appliance name
// ("Split AC" does, "Top Load" doesn't, "Chimney" == appliance) — only
// append when it isn't already there.
function typeDisplayName(type, appliance) {
  if (!type) return appliance.name;
  return type.name.toLowerCase().includes(appliance.name.toLowerCase())
    ? type.name
    : `${type.name} ${appliance.name}`;
}

// Install/uninstall/gas-fill/repair are stored as 'repair' on the booking
// record, everything else as 'service' — identical mapping to the
// homepage's qbAddService() so bookings look the same from either path.
function bookingServiceType(skuId) {
  return ['svc-repair', 'svc-install', 'svc-uninstall', 'svc-gasfill'].includes(skuId) ? 'repair' : 'service';
}

function priceForSku(row, svcId) {
  if (!row) return null;
  if (row.servicePrices && typeof row.servicePrices[svcId] === 'number') return row.servicePrices[svcId];
  if (svcId === 'svc-service' && typeof row.servicePrice === 'number') return row.servicePrice;
  if (svcId === 'svc-repair' && typeof row.repairPrice === 'number') return row.repairPrice;
  return null;
}

// Repair / gas filling may need a spare part — say so on the card so the
// final bill never surprises the customer. Fixed-price jobs get no note.
function needsPartsNote(svc) {
  return svc.id === 'svc-repair' || svc.id === 'svc-gasfill' || /repair|gas/i.test(svc.name || '');
}

function servicesOf(type) {
  return (Array.isArray(type.services) && type.services.length)
    ? type.services
    : [{ id: 'svc-service', name: 'Service', checklist: [] }, { id: 'svc-repair', name: 'Repair', checklist: [] }];
}

// -----------------------------------------------------------------------
// Appliance-specific content for the article. Keyed by slugify(name).
// An appliance Admin adds later that isn't listed here still gets a full
// article from the generic fallback — never an empty section.
// -----------------------------------------------------------------------
const APPLIANCE_CONTENT = {
  'ac': {
    problems: [
      ['Weak or no cooling', 'usually a choked filter, dirty cooling coil or low refrigerant.'],
      ['Water dripping indoors', 'a blocked drain pipe or a tilted indoor unit is the common cause.'],
      ['AC trips or won\'t start', 'often a failed capacitor, loose wiring or a voltage problem.'],
      ['Bad smell or noisy fan', 'mould on the coil, a dirty blower or a worn fan motor bearing.'],
      ['Ice on the pipes or coil', 'a sign of low gas or restricted airflow that needs checking early.']
    ],
    tips: [
      ['Clean the filter every 2–3 weeks', 'in the summer — a dusty filter alone can cut cooling noticeably.'],
      ['Book a full service before summer', 'so the coil and drain are clean before the heavy-use months start.'],
      ['Keep 24–26°C as your default', 'it cools comfortably and reduces load on the compressor.'],
      ['Keep the outdoor unit clear', 'leaves, cartons or a wall too close restrict airflow and raise power use.'],
      ['Use a stabiliser if voltage fluctuates', 'it protects the compressor and PCB from sudden surges.']
    ],
    nearMe: ['AC service near me', 'AC repair near me', 'AC gas filling near me', 'split AC service near me']
  },
  'washing-machine': {
    problems: [
      ['Drum not spinning', 'a worn belt, faulty motor or a door-lock/lid switch issue.'],
      ['Water not draining', 'a clogged filter or drain pump, or a kinked outlet hose.'],
      ['Leaking water', 'loose hose connections, a damaged door gasket or a cracked tub seal.'],
      ['Loud noise or shaking', 'uneven loading, worn drum bearings or broken shock absorbers.'],
      ['Machine not starting', 'power supply, control board or inlet valve faults.']
    ],
    tips: [
      ['Don\'t overload the drum', 'overloading strains the motor, belt and bearings.'],
      ['Clean the lint/drain filter monthly', 'it keeps drainage quick and stops bad smells.'],
      ['Run an empty hot tub-clean cycle', 'once a month to clear detergent and scale buildup.'],
      ['Leave the door or lid open after washing', 'so the drum dries and mould doesn\'t form.'],
      ['Keep the machine level', 'a level machine vibrates less and lasts longer.']
    ],
    nearMe: ['washing machine repair near me', 'washing machine service near me', 'front load washing machine repair near me', 'top load washing machine repair near me']
  },
  'ro': {
    problems: [
      ['Low water flow', 'a clogged pre-filter or an ageing RO membrane.'],
      ['Water tastes or smells odd', 'filters past their life or a tank that needs cleaning.'],
      ['High TDS in output water', 'a worn membrane or an incorrectly set TDS controller.'],
      ['Leakage from the unit', 'loose fittings, a cracked housing or a faulty valve.'],
      ['Purifier not starting', 'adapter, pump, float switch or SMPS faults.']
    ],
    tips: [
      ['Service every 3–6 months', 'depending on how hard your local water is.'],
      ['Change sediment and carbon filters on time', 'old filters let impurities through and slow the flow.'],
      ['Check the TDS level regularly', 'it tells you early when the membrane needs attention.'],
      ['Clean the storage tank', 'during every service so no residue builds up.'],
      ['Don\'t leave it unused for long', 'if you\'re away, flush the tank before using it again.']
    ],
    nearMe: ['RO service near me', 'water purifier service near me', 'RO repair near me', 'RO filter change near me']
  },
  'fridge': {
    problems: [
      ['Fridge not cooling', 'a gas leak, weak compressor, faulty thermostat or fan.'],
      ['Freezer icing up heavily', 'a defrost timer, heater or sensor problem.'],
      ['Water collecting inside', 'a blocked defrost drain line.'],
      ['Loud or clicking noise', 'compressor relay, fan motor or a loose component.'],
      ['Door not sealing', 'a worn gasket lets warm air in and overworks the compressor.']
    ],
    tips: [
      ['Keep space behind the fridge', 'a few inches of gap lets the condenser release heat.'],
      ['Don\'t put hot food straight in', 'let it cool first so the compressor isn\'t overworked.'],
      ['Check the door gasket', 'if a sheet of paper slides out easily, the seal needs replacing.'],
      ['Defrost manual-defrost models regularly', 'thick ice reduces cooling and raises power use.'],
      ['Use a stabiliser', 'voltage swings are a leading cause of compressor failure.']
    ],
    nearMe: ['fridge repair near me', 'refrigerator service near me', 'fridge gas filling near me', 'double door fridge repair near me']
  },
  'chimney': {
    problems: [
      ['Low suction', 'grease-clogged filters or a blocked duct.'],
      ['Loud motor noise', 'grease on the blower or a worn motor.'],
      ['Oil dripping', 'saturated filters or a full oil collector.'],
      ['Lights or buttons not working', 'control panel, switch or wiring faults.'],
      ['Chimney not starting', 'power supply, capacitor or motor problems.']
    ],
    tips: [
      ['Clean baffle/mesh filters every 2–3 weeks', 'more often if you cook with a lot of oil.'],
      ['Empty the oil collector', 'before it overflows back into the unit.'],
      ['Run the chimney 5 minutes after cooking', 'to clear remaining smoke and moisture.'],
      ['Wipe the outer body weekly', 'a mild soap solution keeps grease from hardening.'],
      ['Get a deep service every 6–12 months', 'so the motor and duct stay clean.']
    ],
    nearMe: ['chimney service near me', 'kitchen chimney cleaning near me', 'chimney repair near me', 'chimney installation near me']
  },
  'geyser': {
    problems: [
      ['Water not heating', 'a failed heating element or thermostat.'],
      ['Water too hot or thermostat not cutting off', 'a faulty thermostat — this needs quick attention.'],
      ['Leaking tank or pipes', 'loose connections, a worn valve or a corroded tank.'],
      ['Tripping the MCB', 'an element short or a wiring fault.'],
      ['Gas geyser not igniting', 'battery, igniter, gas valve or water-flow sensor problems.']
    ],
    tips: [
      ['Descale the tank yearly', 'hard water scale slows heating and raises the bill.'],
      ['Don\'t keep it on all day', 'switch off once the water is hot.'],
      ['Check the pressure release valve', 'it\'s a key safety part and should never be blocked.'],
      ['Ensure ventilation for gas geysers', 'never install a gas geyser inside a closed bathroom.'],
      ['Service before winter', 'so it\'s ready for the months you depend on it.']
    ],
    nearMe: ['geyser repair near me', 'geyser service near me', 'geyser installation near me', 'water heater repair near me']
  },
  'microwave': {
    problems: [
      ['Not heating', 'magnetron, high-voltage diode, capacitor or fuse faults.'],
      ['Sparking inside', 'a damaged waveguide cover or metal/foil inside the cavity.'],
      ['Turntable not rotating', 'a worn coupler or turntable motor.'],
      ['Stops mid-cooking', 'door switch, thermal cut-off or control board issues.'],
      ['Buttons or display not working', 'keypad membrane or control board faults.']
    ],
    tips: [
      ['Wipe the inside after spills', 'dried food absorbs energy and can cause sparking.'],
      ['Never run it empty', 'running with nothing inside can damage the magnetron.'],
      ['Use microwave-safe containers only', 'no metal, foil or metal-rimmed plates.'],
      ['Keep the vents clear', 'blocked vents make it overheat and cut off.'],
      ['Check the door closes firmly', 'a loose door affects heating and safety switches.']
    ],
    nearMe: ['microwave repair near me', 'oven repair near me', 'microwave service near me', 'convection microwave repair near me']
  },
  // Ready for appliances Admin may add later — each gets its own real
  // content the moment it's added (no thin, generic page).
  'tv': {
    problems: [
      ['No picture but sound works', 'backlight LED strips or the power board are the usual cause.'],
      ['TV not turning on', 'power supply board, standby circuit or a blown fuse.'],
      ['Lines or patches on screen', 'panel cable, T-con board or panel faults.'],
      ['No sound or distorted sound', 'speaker, audio IC or main board issues.'],
      ['Remote / buttons not responding', 'IR sensor, keypad or software faults.']
    ],
    tips: [
      ['Use a surge protector or stabiliser', 'voltage spikes are the top cause of TV board failures.'],
      ['Keep vents free of dust', 'heat shortens the life of LED strips and boards.'],
      ['Switch off from the wall during storms', 'lightning surges can damage the main board.'],
      ['Clean the screen with a dry microfibre cloth', 'sprays can seep inside and damage the panel.'],
      ['Don\'t keep brightness at 100% all day', 'it wears out backlight LEDs faster.']
    ],
    nearMe: ['TV repair near me', 'LED TV repair near me', 'smart TV repair near me', 'TV service near me']
  },
  'inverter': {
    problems: [
      ['Short backup time', 'a weak battery, low distilled water or a charging fault.'],
      ['Inverter beeping continuously', 'overload, low battery or a wiring fault.'],
      ['Not charging the battery', 'charging circuit, fuse or MCB problems.'],
      ['No output during power cut', 'relay, board or battery connection faults.'],
      ['Battery terminals corroded', 'loose, dirty terminals reduce charging and backup.']
    ],
    tips: [
      ['Top up distilled water every 2–3 months', 'for tubular batteries — never tap water.'],
      ['Keep the battery in an airy place', 'heat and closed boxes shorten battery life.'],
      ['Clean terminals and apply petroleum jelly', 'it stops corrosion and poor contact.'],
      ['Don\'t overload it', 'run only the fans and lights it was sized for.'],
      ['Let the battery discharge once a month', 'a full cycle keeps it healthy.']
    ],
    nearMe: ['inverter repair near me', 'inverter battery service near me', 'inverter service near me', 'UPS repair near me']
  },
  'cooler': {
    problems: [
      ['Not cooling properly', 'dry or choked cooling pads, or a weak water pump.'],
      ['Water not flowing to pads', 'a blocked pump, pipe or distributor.'],
      ['Fan running slowly or noisy', 'a worn motor, capacitor or loose blade.'],
      ['Water leaking', 'a cracked tank, loose drain plug or overflow.'],
      ['Bad smell', 'stagnant water or old pads growing algae.']
    ],
    tips: [
      ['Change the water every 2–3 days', 'stagnant water smells and breeds mosquitoes.'],
      ['Replace cooling pads every season', 'old pads cool poorly and smell.'],
      ['Keep the cooler near a window', 'fresh air in makes it cool much better.'],
      ['Clean the tank before summer', 'so the pump doesn\'t choke on dirt.'],
      ['Get the motor checked before summer', 'a tired capacitor is cheap to replace early.']
    ],
    nearMe: ['cooler repair near me', 'air cooler service near me', 'cooler motor repair near me', 'cooler pump repair near me']
  },
  'water-cooler': {
    problems: [
      ['Water not getting cold', 'gas leak, compressor or thermostat faults.'],
      ['Leakage from the tap or tank', 'worn taps, seals or joints.'],
      ['Compressor running non-stop', 'low gas, a dirty condenser or thermostat issues.'],
      ['Noisy running', 'loose parts, fan or compressor mounting.'],
      ['Water tastes odd', 'the tank and filter need cleaning.']
    ],
    tips: [
      ['Clean the tank regularly', 'it keeps the water safe and fresh.'],
      ['Keep space around the condenser', 'it needs airflow to cool efficiently.'],
      ['Use a stabiliser', 'protects the compressor from voltage swings.'],
      ['Replace the filter on time', 'if your cooler has a built-in purifier.'],
      ['Book a service before summer', 'peak use is when breakdowns hurt most.']
    ],
    nearMe: ['water cooler repair near me', 'water cooler service near me', 'drinking water cooler repair near me']
  },
  'dishwasher': {
    problems: [
      ['Dishes not getting clean', 'blocked spray arms, filter or low water pressure.'],
      ['Water not draining', 'a clogged filter, drain hose or drain pump.'],
      ['Not starting', 'door latch, control board or power issues.'],
      ['Leaking water', 'door gasket, hoses or overfilling.'],
      ['Not drying dishes', 'heater, rinse aid or fan faults.']
    ],
    tips: [
      ['Clean the filter every week', 'it\'s the most common cause of dirty dishes.'],
      ['Scrape food off plates first', 'large bits clog the filter and pump.'],
      ['Use the right detergent and rinse aid', 'hard water leaves white marks otherwise.'],
      ['Run a hot empty cleaning cycle monthly', 'clears grease and scale.'],
      ['Don\'t overload the racks', 'water can\'t reach every dish.']
    ],
    nearMe: ['dishwasher repair near me', 'dishwasher service near me', 'dishwasher installation near me']
  },
  'induction': {
    problems: [
      ['Not heating', 'IGBT, coil or control board faults.'],
      ['Showing an error code', 'overheating, voltage or sensor problems.'],
      ['Fan not running', 'a blocked or failed cooling fan.'],
      ['Turns off by itself', 'overheating or wrong cookware.'],
      ['Buttons not responding', 'touch panel or keypad faults.']
    ],
    tips: [
      ['Use induction-friendly flat cookware', 'the base must be magnetic.'],
      ['Keep the air vents open', 'the fan needs space to cool the board.'],
      ['Use a stable power supply', 'voltage swings damage the board.'],
      ['Wipe spills after it cools', 'liquid can seep into the vents.'],
      ['Don\'t heat an empty pan', 'it can overheat the glass and sensor.']
    ],
    nearMe: ['induction repair near me', 'induction cooktop repair near me', 'induction chulha repair near me']
  }
};

// Other common names Admin might type for the same appliance.
const CONTENT_ALIASES = {
  'refrigerator': 'fridge', 'fridge-refrigerator': 'fridge', 'double-door-fridge': 'fridge',
  'air-conditioner': 'ac', 'air-conditioning': 'ac', 'split-ac': 'ac', 'window-ac': 'ac',
  'water-purifier': 'ro', 'ro-water-purifier': 'ro', 'ro-purifier': 'ro', 'purifier': 'ro', 'ro-uv': 'ro',
  'water-heater': 'geyser', 'geysers': 'geyser', 'microwave-oven': 'microwave', 'oven': 'microwave', 'otg': 'microwave',
  'kitchen-chimney': 'chimney', 'led-tv': 'tv', 'smart-tv': 'tv', 'television': 'tv', 'lcd-tv': 'tv',
  'inverter-battery': 'inverter', 'ups': 'inverter', 'battery': 'inverter',
  'air-cooler': 'cooler', 'desert-cooler': 'cooler', 'induction-cooktop': 'induction', 'induction-chulha': 'induction',
  'washer': 'washing-machine', 'washing': 'washing-machine'
};

function contentFor(appliance) {
  let key = slugify(appliance.name);
  if (!APPLIANCE_CONTENT[key] && CONTENT_ALIASES[key]) key = CONTENT_ALIASES[key];
  if (!APPLIANCE_CONTENT[key]) key = key.replace(/-(repair|service|services)$/, '');
  if (!APPLIANCE_CONTENT[key] && CONTENT_ALIASES[key]) key = CONTENT_ALIASES[key];
  const name = appliance.name;
  return APPLIANCE_CONTENT[key] || {
    problems: [
      [`${name} not working at all`, 'power supply, wiring, fuse or control board faults.'],
      ['Unusual noise or burning smell', 'a worn part or loose component — switch it off and get it checked early.'],
      ['Weak performance', 'dirt buildup, a clogged part or a component nearing the end of its life.'],
      ['Leakage', 'loose connections, a cracked part or a worn seal.'],
      ['Stops or trips in between', 'overheating, voltage problems or a faulty sensor.']
    ],
    tips: [
      [`Keep your ${name.toLowerCase()} clean`, 'regular cleaning prevents most everyday problems.'],
      ['Book a routine service once or twice a year', 'small issues are much cheaper to fix early.'],
      ['Use a stable power supply or stabiliser', 'voltage swings are a common cause of board failures.'],
      ['Don\'t ignore small warning signs', 'a new noise, smell or error code usually gets worse, not better.'],
      ['Use genuine spare parts', 'cheap parts fail sooner and can damage other components.']
    ],
    nearMe: [`${name.toLowerCase()} repair near me`, `${name.toLowerCase()} service near me`]
  };
}

// -----------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------

// Resolves every priced (type, service) combination for this appliance in
// this city. Types with no pricing row (not set up for this city) are
// dropped entirely, so a customer never sees a card they can't book.
function resolveTypeRows(appliance, city, pricing) {
  return appliance.types.map(t => {
    const row = pricing.find(p => p.cityId === city.id && p.applianceId === appliance.id && p.typeId === t.id);
    if (!row) return null;
    const services = servicesOf(t)
      .map(svc => ({ svc, price: priceForSku(row, svc.id) }))
      .filter(x => typeof x.price === 'number');
    if (!services.length) return null;
    return { type: t, services };
  }).filter(Boolean);
}

function buildStripHtml(allAppliances, currentAppliance, city) {
  return allAppliances.map(a => {
    const href = `/appliance-repair/${slugify(city.name)}/${applianceSlug(a.name)}`;
    const active = a.id === currentAppliance.id;
    const img = a.photoUrl
      ? pictureHtml(a.photoUrl, `alt="${esc(a.name)} repair in ${esc(city.name)}" loading="lazy" width="96" height="96"`)
      : `<span class="sp-strip-fallback" aria-hidden="true">🔧</span>`;
    return `<a href="${href}" class="sp-strip-item${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>${img}<span>${esc(a.name)}</span></a>`;
  }).join('');
}

function buildTabsHtml(typeRows, appliance, city, activeTypeId) {
  if (typeRows.length < 2) return '';
  return `<div class="sp-tabs" role="tablist" aria-label="${esc(appliance.name)} type">` + typeRows.map(({ type }) => {
    const href = `/appliance-repair/${slugify(city.name)}/${applianceSlug(appliance.name)}/${slugify(type.name)}`;
    const active = type.id === activeTypeId;
    return `<a href="${href}" class="sp-tab${active ? ' active' : ''}" role="tab" aria-selected="${active}" data-tab="${esc(type.id)}">${esc(type.name)}</a>`;
  }).join('') + `</div>`;
}

const CHECK_SVG = '<svg class="sp-check" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/><path d="M5.5 10.3l3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TAG_SVG = '<svg class="sp-tag" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12V4a1 1 0 011-1h8l9 9-9 9-9-9z"/><circle cx="7.5" cy="7.5" r="1.6" fill="#fff"/></svg>';

function buildPanelsHtml(typeRows, appliance, city, activeTypeId, photoUrlFor) {
  return typeRows.map(({ type, services }) => {
    const typeName = typeDisplayName(type, appliance);
    const anchor = `about-${slugify(type.name)}`;
    const cards = services.map(({ svc, price }) => {
      const title = `${typeName} ${svc.name} In ${city.name}`;
      const checklist = (svc.checklist && svc.checklist.length)
        ? svc.checklist
        : ['Trained, verified technician', 'Price confirmed before work starts', 'Genuine spare parts', 'Performance checked after work', '30-day service warranty'];
      const items = checklist.slice(0, 5).map((item, i, arr) =>
        `<li>${CHECK_SVG}<span>${esc(item)}${i === arr.length - 1 ? ` <a href="#${anchor}" class="sp-know">Know more</a>` : ''}</span></li>`
      ).join('');
      // A photo uploaded for this exact type + service (Admin → Appliances →
      // Service Photos) wins; otherwise the appliance's general photo.
      const ownPhoto = typeof photoUrlFor === 'function' ? photoUrlFor(appliance.id, type.id, svc.id) : null;
      const img = ownPhoto
        ? `<img src="${esc(ownPhoto)}" alt="${esc(title)}" loading="lazy" width="300" height="300">`
        : appliance.photoUrl
        ? pictureHtml(appliance.photoUrl, `alt="${esc(title)}" loading="lazy" width="300" height="300"`)
        : `<span class="sp-strip-fallback" aria-hidden="true">🔧</span>`;
      const data = [
        `data-appliance-id="${esc(appliance.id)}"`,
        `data-appliance-name="${esc(appliance.name)}"`,
        `data-type-id="${esc(type.id)}"`,
        `data-type-name="${esc(type.name)}"`,
        `data-sku-id="${esc(svc.id)}"`,
        `data-sku-name="${esc(svc.name)}"`,
        `data-service-type="${bookingServiceType(svc.id)}"`,
        `data-price="${price}"`,
        `data-title="${esc(`${typeName} ${svc.name}`)}"`
      ].join(' ');
      return `
        <article class="sp-card" ${data}>
          <div class="sp-card-img">${img}<span class="sp-badge">${inr(price)}/-</span></div>
          <div class="sp-card-body">
            <h3 class="sp-card-title">${esc(title)}</h3>
            <div class="sp-price">${TAG_SVG}<strong>${inr(price)}</strong>${needsPartsNote(svc) ? '<span class="sp-parts">+ parts, if needed (with your OK)</span>' : ''}</div>
            <ul class="sp-checks">${items}</ul>
          </div>
          <div class="sp-actions">
            <button type="button" class="sp-btn sp-btn-add" data-action="add"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a2 2 0 100 4 2 2 0 000-4zm10 0a2 2 0 100 4 2 2 0 000-4zM5.2 4l.4 2H21l-2 8H7.4l-.3 1.5H19v2H4.7L6.2 11 4.4 4H2V2h3.9z"/></svg><span>Add</span></button>
            <button type="button" class="sp-btn sp-btn-book" data-action="book">Book</button>
          </div>
        </article>`;
    }).join('');
    const hidden = type.id !== activeTypeId;
    return `<div class="sp-panel" role="tabpanel" data-panel="${esc(type.id)}"${hidden ? ' hidden' : ''}>${cards}</div>`;
  }).join('');
}

function priceTableHtml(typeRows, appliance, city) {
  const rows = typeRows.flatMap(({ type, services }) => services.map(({ svc, price }) =>
    `<tr><td>${esc(typeDisplayName(type, appliance))} ${esc(svc.name)} in ${esc(city.name)}</td><td><strong>${inr(price)}</strong></td></tr>`
  )).join('');
  return `<div class="sp-table-wrap"><table class="sp-table"><thead><tr><th>Service</th><th>Starting price</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function listHtml(pairs) {
  return `<ul class="sp-list">${pairs.map(([b, t]) => `<li><strong>${esc(b)}:</strong> ${esc(t)}</li>`).join('')}</ul>`;
}

// The long-form article under the cards. `focusType` narrows the headings
// to one type on a type page ("Split AC Service in Noida") so each URL has
// its own distinct title/H2s instead of duplicating the appliance page.
function localInfoHtml(city, A, C) {
  const text = String(city.localInfo || '').trim();
  if (!text) return '';
  const paras = text.split(/\n\s*\n/).map(p => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
  return `\n    <h2>${A} Service Across ${C}</h2>\n    ${paras}\n`;
}

function buildArticleHtml({ appliance, city, typeRows, focusType, displayName, phoneDisplay, serviceProcessHtml, aboutText }) {
  const content = contentFor(appliance);
  const C = esc(city.name);
  const N = esc(displayName);
  const A = esc(appliance.name);
  const scoped = focusType ? typeRows.filter(r => r.type.id === focusType.id) : typeRows;
  const allPrices = scoped.flatMap(r => r.services.map(s => s.price));
  const minPrice = allPrices.length ? Math.min(...allPrices) : null;
  const typeNames = typeRows.map(r => esc(r.type.name));
  const typeListText = typeNames.length > 1
    ? typeNames.slice(0, -1).join(', ') + ' and ' + typeNames[typeNames.length - 1]
    : (typeNames[0] || A);
  const skuNames = [...new Set(scoped.flatMap(r => r.services.map(s => s.svc.name.toLowerCase())))];
  const skuText = skuNames.length > 1 ? skuNames.slice(0, -1).join(', ') + ' and ' + skuNames[skuNames.length - 1] : (skuNames[0] || 'service');

  const typeSections = (focusType ? typeRows.filter(r => r.type.id === focusType.id) : typeRows).map(({ type, services }) => {
    const tn = esc(typeDisplayName(type, appliance));
    const svcList = services.map(({ svc }) => `<li><strong>${tn} ${esc(svc.name)}</strong>${svc.checklist && svc.checklist[0] ? ' — ' + esc(svc.checklist[0].replace(/\.$/, '')).toLowerCase() : ''}</li>`).join('');
    return `
      <h3 id="about-${slugify(type.name)}">${tn} Repair and Service in ${C}</h3>
      <p>Whether your ${tn.toLowerCase()} needs a routine clean-up or a proper repair, our ${C} technician comes to your home, checks it in front of you and tells you the exact cost before touching anything. The work starts only after you say yes.</p>
      <ul class="sp-list">${svcList}</ul>`;
  }).join('');

  return `
    <h2>${N} Service in ${C}: Book a Trusted ${N} Technician at Your Doorstep</h2>
    <p>${aboutText ? esc(aboutText) + ' ' : ''}Seerua Appliance Care brings verified ${A} technicians to homes across ${C} for ${esc(skuText)}${minPrice !== null ? `, with prices starting at just <strong>${inr(minPrice)}</strong>` : ''}. You pick the service and a time slot above, and a technician visits the same day or at the time you choose — no call-centre runaround.</p>

${localInfoHtml(city, A, C)}
    <h2>Types of ${A} Service We Offer in ${C}</h2>
    <p>We work on ${typeListText}${typeRows.length > 1 ? ' models' : ''} of every major brand. Here is what each booking covers and what it costs in ${C}:</p>
    ${typeSections}
    ${priceTableHtml(focusType ? typeRows.filter(r => r.type.id === focusType.id) : typeRows, appliance, city)}
    <p class="sp-note">Spare parts, if any are needed, are billed separately at market price — always shown to you and approved by you first.</p>

    <h2>Common ${A} Problems We Fix in ${C}</h2>
    <p>These are the issues our ${C} technicians see most often. If you notice any of them, booking early usually keeps the repair small:</p>
    ${listHtml(content.problems)}

    <h2>How Our ${N} Service Works in ${C}</h2>
    ${serviceProcessHtml || ''}
    <ol class="sp-steps">
      <li><strong>Book in under a minute</strong> — tap Book on the service you need, choose a date and time slot.</li>
      <li><strong>Technician visits</strong> — a verified ${C} technician arrives in your chosen slot.</li>
      <li><strong>Check and quote</strong> — the problem is explained to you and the price confirmed before work starts.</li>
      <li><strong>Work and testing</strong> — the job is done and the appliance is tested in front of you.</li>
      <li><strong>30-day warranty</strong> — if the same issue returns within 30 days, we come back at no visit charge.</li>
    </ol>

    <h2>Tips to Keep Your ${A} Working Longer</h2>
    ${listHtml(content.tips)}

    <h2>How to Find the Best ${N} Service Near Me in ${C}</h2>
    <p>Searching for ${content.nearMe.map(q => `“${esc(q)}”`).join(', ')} in ${C} gives you a long list of names. A few things help separate a reliable service from a risky one:</p>
    <ul class="sp-list">
      <li><strong>Clear prices upfront:</strong> you should know the visit and service charge before booking — ours are listed right on this page.</li>
      <li><strong>Verified technicians:</strong> ask whether the person coming to your home is trained and ID-verified.</li>
      <li><strong>Warranty on work:</strong> a good service stands behind its repair; ours carries a 30-day warranty.</li>
      <li><strong>No work without approval:</strong> parts should only be changed after you agree to the price.</li>
    </ul>

    <h2>Why Choose Seerua for ${N} Service in ${C}?</h2>
    <ul class="sp-list">
      <li><strong>Local ${C} technicians:</strong> same-day visits for most bookings.</li>
      <li><strong>Fixed, visible pricing:</strong> the price you see here is the price you pay for the service.</li>
      <li><strong>All brands:</strong> LG, Samsung, Voltas, Whirlpool, IFB, Godrej, Haier, Bosch, Panasonic, Blue Star, Daikin, Kent and more.</li>
      <li><strong>Genuine parts:</strong> quality-checked spares at market rate, with no hidden markup.</li>
      <li><strong>Support after the visit:</strong> call or WhatsApp us any time about your booking.</li>
    </ul>

    <h2>Book Your ${N} Service in ${C} Today</h2>
    <p>Tap <strong>Book</strong> on any service above to confirm your visit in a few seconds, or call us at <a href="tel:+91${esc(phoneDisplay)}"><strong>${esc(phoneDisplay)}</strong></a>. Seerua Appliance Care — honest ${A} repair and service in ${C}.</p>
  `;
}

function buildFaqs({ appliance, city, displayName, typeRows }) {
  const allPrices = typeRows.flatMap(r => r.services.map(s => s.price));
  const range = allPrices.length ? `${inr(Math.min(...allPrices))} to ${inr(Math.max(...allPrices))}` : '';
  return [
    {
      q: `How much does ${displayName} service cost in ${city.name}?`,
      a: range
        ? `${displayName} services in ${city.name} range from ${range} depending on the job — every price is listed above. The technician confirms the final amount before starting, and spare parts (if needed) are charged only after your approval.`
        : `The technician gives you an exact quote after inspecting the appliance, before any work begins.`
    },
    {
      q: `Do I have to pay anything if the technician only inspects?`,
      a: `If you decide not to go ahead after the inspection, only the visit/inspection charge applies — nothing else is charged without your approval.`
    },
    {
      q: `How soon can a technician visit for ${displayName} service in ${city.name}?`,
      a: `Most ${city.name} bookings get a same-day visit. You choose the date and time slot yourself while booking.`
    },
    {
      q: `Do you service all ${appliance.name} brands in ${city.name}?`,
      a: `Yes — our ${city.name} technicians work on all major brands and models. If a part has to be ordered, we tell you the expected time upfront.`
    },
    {
      q: `Is there a warranty on ${displayName} repair in ${city.name}?`,
      a: `Yes, every job carries a 30-day service warranty. If the same problem comes back within 30 days, we send a technician again with no visit charge.`
    },
    {
      q: `How do I book ${displayName} service in ${city.name}?`,
      a: `Tap Book on the service you need, enter your name, mobile number and address, pick a time slot and confirm. Your mobile number is verified by OTP only on your very first booking.`
    }
  ];
}

module.exports = {
  contentFor,
  slugify,
  applianceSlug,
  typeDisplayName,
  resolveTypeRows,
  buildStripHtml,
  buildTabsHtml,
  buildPanelsHtml,
  buildArticleHtml,
  buildFaqs,
  inr
};
