/* Surge Watch — Mumbai hospital flow model.
   Hour-by-hour simulation of patient flow through a Mumbai hospital: Mumbai's seasonal infections,
   beds, isolation, oxygen, ambulances, laboratory, X-ray, CT/ultrasound, nursing and platelets.
   Includes Monte Carlo ensembles, syndromic outbreak detection and epidemic growth.
   Exposes window.SW. No dependencies. */
(function (global) {
  'use strict';

  const HOUR = 3600e3, DAY = 864e5;
  const MUMBAI = { name: 'Mumbai', lat: 19.08, lon: 72.88 };

  /* ---------------- Mumbai hospitals: facts from data.js (each with its source) ---------------- */
  const DATA = global.SWDATA, HF = DATA.HOSPITAL_FACTS, CF = DATA.CITY_FACTS;
  const CITY_BEDS = CF.govtBeds.v + CF.privateBeds.v; // 46,378 (BMC budget 2025-26)
  const HOSPITALS = [
    { id: 'kem', name: 'KEM Hospital', area: 'Parel', zone: 'Central Mumbai', type: 'BMC', lat: 19.0026, lon: 72.8420 },
    { id: 'jj', name: 'Sir J J Hospital', area: 'Byculla', zone: 'South Mumbai', type: 'State', lat: 18.9627, lon: 72.8337 },
    { id: 'sion', name: 'LTMG (Sion) Hospital', area: 'Sion', zone: 'Central Mumbai', type: 'BMC', lat: 19.0368, lon: 72.8597 },
    { id: 'nair', name: 'B Y L Nair Hospital', area: 'Mumbai Central', zone: 'South Mumbai', type: 'BMC', lat: 18.9719, lon: 72.8227 },
    { id: 'cooper', name: 'Dr R N Cooper Hospital', area: 'Juhu / Vile Parle', zone: 'Western suburbs', type: 'BMC', lat: 19.1069, lon: 72.8360 },
    { id: 'kokilaben', name: 'Kokilaben Dhirubhai Ambani Hospital', area: 'Andheri West', zone: 'Western suburbs', type: 'Private', lat: 19.1309, lon: 72.8253 },
    { id: 'hinduja', name: 'P D Hinduja Hospital', area: 'Mahim', zone: 'Central Mumbai', type: 'Private', lat: 19.0335, lon: 72.8388 },
    { id: 'bombay', name: 'Bombay Hospital', area: 'Marine Lines', zone: 'South Mumbai', type: 'Private', lat: 18.9415, lon: 72.8270 },
    { id: 'jaslok', name: 'Jaslok Hospital', area: 'Pedder Road', zone: 'South Mumbai', type: 'Private', lat: 18.9718, lon: 72.8094 },
    { id: 'nanavati', name: 'Nanavati Max Hospital', area: 'Vile Parle West', zone: 'Western suburbs', type: 'Private', lat: 19.0963, lon: 72.8400 },
    { id: 'lilavati', name: 'Lilavati Hospital', area: 'Bandra West', zone: 'Western suburbs', type: 'Private', lat: 19.0510, lon: 72.8288 },
    { id: 'fortis', name: 'Fortis Hospital', area: 'Mulund', zone: 'Eastern suburbs', type: 'Private', lat: 19.1612, lon: 72.9408 },
    { id: 'breach', name: 'Breach Candy Hospital', area: 'Breach Candy', zone: 'South Mumbai', type: 'Private', lat: 18.9705, lon: 72.8045 }
  ].map(h => Object.assign(h, { beds: HF[h.id].beds.v, facts: HF[h.id], src: DATA.SOURCES[HF[h.id].beds.src].title }));
  const ISOLATION_RESERVE = [
    { name: 'Kasturba Hospital for Infectious Diseases, Chinchpokli', beds: CF.kasturbaIsolation.v, note: '78 isolation beds (March 2020) and a 10-bed Ebola isolation ward (2026).' }
  ];
  const UPCOMING = { beds: CF.upcomingBeds.v, note: 'Siddharth (306), Shatabdi (324) and Harilal Bhagwati (490) BMC hospitals, reported as more than 85% complete.' };

  // Sion publishes its ward-by-ward beds (MUHS 2026-27). Where a hospital publishes only a total, Sion's mix is used as the reference.
  const SION_MIX = { MED: 331, SURG: 844, PEDS: 160, ICU: 100 }, SION_TOTAL = 1435;
  const KEMF = HF.kem;
  // Every input carries provenance: P published, D derived from this hospital's published figures,
  // R reference (another Mumbai hospital's published figure applied here), U not published (placeholder to replace).
  function setupFor(h) {
    const F = HF[h.id] || {}, prov = {};
    const put = (key, v, kind, src, note) => { prov[key] = { kind, src: src || null, note: note || '' }; return v; };
    const fact = (key, fk) => put(key, F[fk].v, F[fk].kind, F[fk].src, F[fk].note);
    const beds = fact('beds', 'beds');
    let icu, med, surg, peds;
    if (F.wardMED) { med = fact('MED', 'wardMED'); surg = fact('SURG', 'wardSURG'); peds = fact('PEDS', 'wardPEDS'); icu = fact('ICU', 'icuAdult'); }
    else {
      icu = F.icuAdult ? fact('ICU', 'icuAdult') : put('ICU', Math.round(beds * SION_MIX.ICU / SION_TOTAL), 'R', 'sionMUHS', "Sion's published adult ICU share (100 of 1,435 ward and ICU beds) applied to this hospital's beds");
      const rest = beds - icu, rs = SION_TOTAL - SION_MIX.ICU;
      med = put('MED', Math.round(rest * SION_MIX.MED / rs), 'R', 'sionMUHS', "Sion's published ward mix: Medicine group 331 of 1,335 ward beds");
      surg = put('SURG', Math.round(rest * SION_MIX.SURG / rs), 'R', 'sionMUHS', "Sion's published ward mix: surgical and obstetric group 844 of 1,335");
      peds = put('PEDS', Math.round(rest * SION_MIX.PEDS / rs), 'R', 'sionMUHS', "Sion's published ward mix: Paediatrics 160 of 1,335");
    }
    const iso = put('ISO', Math.max(4, Math.round(beds * 0.015)), 'U', null, 'Isolation beds are not published for this hospital. Placeholder: 1.5% of beds.');
    const adm = F.admissionsPerDay ? fact('admissionsPerDay', 'admissionsPerDay') : put('admissionsPerDay', +(beds * KEMF.admissionsPerDay.v / KEMF.beds.v).toFixed(1), 'R', 'kemMRD', "KEM's published admissions per bed (177 a day / 1,900 beds) x this hospital's beds");
    const arrRatio = KEMF.casualtyPerDay.v / KEMF.admissionsPerDay.v;
    const arr = F.casualtyPerDay ? put('arrPerDay', Math.round(F.casualtyPerDay.v), F.casualtyPerDay.kind, F.casualtyPerDay.src, F.casualtyPerDay.note) : put('arrPerDay', Math.round(adm * arrRatio), 'R', 'kemMRD', "KEM's published casualty attendances per admission (392 / 177 = " + arrRatio.toFixed(2) + ") x this hospital's admissions");
    const alos = F.alos ? fact('alos', 'alos') : put('alos', KEMF.alos.v, 'R', 'kemMRD', "KEM's published average stay (8.0 days, 2023)");
    const bor = F.bor ? fact('bor', 'bor') : put('bor', KEMF.bor.v, 'R', 'kemNIRF', "KEM's published occupancy (1,430 of 1,900 beds, 2024)");
    const ed = F.emergencyBeds ? fact('edSpaces', 'emergencyBeds') : put('edSpaces', Math.max(6, Math.round(beds * KEMF.emergencyBeds.v / KEMF.beds.v)), 'R', 'kemProforma', "KEM's published emergency beds per bed (40 / 1,900)");
    const edLOS = put('edLOS', 1.5, 'U', null, 'Average time a casualty patient occupies a bed is not published. Placeholder: 1.5 h.');
    const vents = put('vents', Math.round(icu * 0.75) + (F.casualtyVentilators ? F.casualtyVentilators.v : 0), 'U', F.casualtyVentilators ? 'sionMUHS' : null, F.casualtyVentilators ? 'ICU ventilators not published (placeholder 0.75 per ICU bed) + 5 in casualty (published)' : 'Not published. Placeholder: 0.75 per ICU bed.');
    const nDay = Math.round(beds * 0.2);
    const nurses = put('nurses', [Math.round(nDay * 0.74), nDay, Math.round(nDay * 0.92)], 'U', null, 'Not published. Placeholder: 0.2 nurses per bed on the day shift.');
    const docDay = Math.max(3, Math.ceil(arr / 24 * 1.5 / 3.2 * 1.5));
    const docs = put('docs', [Math.ceil(docDay / 2), docDay, Math.ceil(docDay * 0.85)], 'U', null, 'Not published. Placeholder sized to casualty attendances.');
    const labDay = Math.round(arr * 0.3 + beds * 0.12);
    const lab = put('lab', { day: labDay, night: Math.round(labDay * 0.6) }, 'U', F.xrayUnits ? 'sionMUHS' : null, 'Throughput not published (Sion lists its analysers, not tests per hour). Placeholder.');
    const xray = F.xrayUnits ? put('xray', { day: F.xrayUnits.v * 3, night: Math.round(F.xrayUnits.v * 1.2) }, 'U', 'sionMUHS', '14 working X-ray units (published) x 3 studies per unit-hour by day (throughput not published)')
      : put('xray', { day: Math.max(3, Math.round(arr * 0.034)), night: Math.max(2, Math.round(arr * 0.018)) }, 'U', null, 'X-ray units and throughput not published. Placeholder.');
    const img = F.ctUnits ? put('img', { day: (F.ctUnits.v + F.usgUnits.v) * 2, night: F.ctUnits.v + 2 }, 'U', 'sionMUHS', '2 CT + 10 ultrasound (published) x 2 studies per unit-hour (throughput not published)')
      : put('img', { day: Math.max(2, Math.round(arr * 0.02)), night: Math.max(1, Math.round(arr * 0.008)) }, 'U', null, 'CT/ultrasound units and throughput not published. Placeholder.');
    const o2Cap = F.lmoTank ? put('o2Capacity', Math.round(F.lmoTank.v * 1000 * 0.861 / 7), 'D', 'lmo', '13 kL liquid oxygen x 861 L of gas per L / 7,000 L per D-type cylinder')
      : put('o2Capacity', Math.round(beds * 2.4), 'U', null, 'Oxygen storage not published. Placeholder.');
    const o2Del = put('o2Delivery', Math.round(beds * 0.22), 'U', null, 'Oxygen refill schedule not published. Placeholder.');
    const amb = put('ambulances', Math.max(3, Math.round(arr / 25)), 'U', 'mems', 'Mumbai and per-hospital 108 allocation not published (statewide fleet: 1,756). Placeholder.');
    const pltS = F.bloodUnitsPerDay ? put('plateletSupply', Math.round(F.bloodUnitsPerDay.v * 0.25), 'U', 'sionMUHS', '75-80 blood units dispensed a day (published) x 25% platelets (split not published)')
      : put('plateletSupply', Math.round(arr * 0.11), 'U', null, 'Blood bank output not published. Placeholder.');
    const patterns = put('patterns', 'Default profile', 'U', null, 'Hour-of-day arrivals, weekday arrivals and weekday discharges are not published. Default profiles are used until learned from imported census data.');
    const pltN = put('plateletStock', Math.round(pltS * 3), 'U', null, 'Stock not published. Placeholder: 3 days of supply.');
    return { hospitalId: h.id, name: h.name + ', ' + h.area, type: h.type, totalBeds: beds,
      beds: { MED: med, SURG: surg, ICU: icu, PEDS: peds, ISO: iso },
      edSpaces: ed, edLOS, vents, arrPerDay: arr, admissionsPerDay: adm, alos, bor, startOcc: bor, nurses, docs, lab, xray, img,
      plateletSupply: pltS, plateletStock: pltN, patterns, o2Capacity: o2Cap, o2Delivery: o2Del, ambulances: amb, prov };
  }
  const DEFAULT_SETUP = setupFor(HOSPITALS[0]);

  const UNITS = [
    { id: 'ED',    name: 'Emergency',   long: 'Emergency Department', kind: 'beds',  measure: 'ED spaces in use, incl. admitted patients waiting for a bed' },
    { id: 'MED',   name: 'Medicine',    long: 'Medicine wards',       kind: 'beds',  measure: 'Beds occupied or being cleaned, plus patients waiting for a bed' },
    { id: 'SURG',  name: 'Surgery',     long: 'Surgical wards',       kind: 'beds',  measure: 'Beds occupied or being cleaned, plus patients waiting for a bed' },
    { id: 'ICU',   name: 'ICU',         long: 'Intensive care',       kind: 'beds',  measure: 'Higher of ICU bed load and ventilator load' },
    { id: 'PEDS',  name: 'Paediatrics', long: 'Paediatric wards',     kind: 'beds',  measure: 'Beds occupied or being cleaned, plus patients waiting for a bed' },
    { id: 'ISO',   name: 'Isolation',   long: 'Isolation beds',       kind: 'beds',  measure: 'Isolation beds occupied, plus infectious patients waiting for one' },
    { id: 'O2',    name: 'Oxygen',      long: 'Medical oxygen',       kind: 'stock', measure: '3 days of expected oxygen use vs stock on site (liquid tank + cylinders)' },
    { id: 'AMB',   name: 'Ambulances',  long: 'Ambulance fleet',      kind: 'fleet', measure: 'Ambulances out on trips vs fleet size' },
    { id: 'LAB',   name: 'Laboratory',  long: 'Diagnostic laboratory', kind: 'queue', measure: 'Expected result turnaround vs 2.5 h target' },
    { id: 'XRAY',  name: 'X-ray',       long: 'X-ray section',        kind: 'queue', measure: 'Expected X-ray wait vs 1.5 h target' },
    { id: 'IMG',   name: 'CT & USG',    long: 'CT and ultrasound',    kind: 'queue', measure: 'Expected CT/ultrasound wait vs 3 h target' },
    { id: 'NUR',   name: 'Nursing',     long: 'Nurse staffing cover', kind: 'staff', measure: 'Nurses required vs nurses on shift' },
    { id: 'BLOOD', name: 'Blood bank',  long: 'Blood bank: platelets', kind: 'stock', measure: '1.5 days of expected platelet use vs units in stock' }
  ];
  const WARDS = ['MED', 'SURG', 'ICU', 'PEDS', 'ISO'];

  const R = {
    // Operating rules no source publishes (listed in SWDATA.UNPUBLISHED); editable placeholders.
    edLOS: 2.6, docRate: 3.2, absence: 0.06,
    ratio: { ED: 4, MED: 6, SURG: 6, ICU: 2, PEDS: 5, ISO: 3 }, nightRelax: 1.3,
    clean: [4, 2, 2.5], icuToMed: 0, plannedSurg: 0.4,
    lab: { perArr: 2.2, perBedDay: 1.5, batch: 0.6, target: 2.5, proc: 0.8 },
    xray: { perArr: 0.30, perBedDay: 0.06, target: 1.5, proc: 0.5 },
    img: { perArr: 0.15, perBedDay: 0.02, target: 3, proc: 0.5 },
    ventPerIcuPt: 0.6,
    plt: { base: 0.3, perDengueAdm: 0.95, shelf: 5, cover: 1.5 },
    // Oxygen in D-type cylinder equivalents (7 m3). 5 L/min for a day = 7.2 m3, about 1 cylinder; ICU about 2.5.
    o2: { ward: { MED: 0.10, SURG: 0.04, PEDS: 0.05, ISO: 0.3 }, icu: 0.8, perWardPt: 1, perIcuPt: 2.5, decayDays: 5, cover: 3 },
    amb: { share: 0.16, epiShare: 0.25, trip: 1.5 },
    bg: { fever: 0.10, resp: 0.14, gi: 0.07, trauma: 0.22 }
  };

  /* ---------------- Mumbai notified diseases (monthly BMC counts in data.js) ---------------- */
  // admit / route / test rates are clinical placeholders: BMC publishes notified cases, not admissions.
  const DISEASES = [
    { id: 'dengue', name: 'Dengue', syn: 'fever', months: 'Aug - Nov (peak Sep - Oct)', admit: 0.5, route: { MED: 0.8, ICU: 0.05, PEDS: 0.15 }, lab: 4.5, xray: 0.05, img: 0.3, o2: 0.05, platelets: true,
      needs: ['Platelets', 'Lab (NS1, CBC)', 'Ultrasound', 'Medicine beds'], why: 'Aedes mosquitoes breed in stored and stagnant water; in IDSP Mumbai data for 2009-18, cases peak in September and October, about 2 months after peak rain.' },
    { id: 'malaria', name: 'Malaria', syn: 'fever', months: 'All year; rises Jun - Sep', admit: 0.3, route: { MED: 0.85, ICU: 0.05, PEDS: 0.1 }, lab: 3, xray: 0.05, img: 0.1, o2: 0.05,
      needs: ['Lab (smear, RDT)', 'Medicine beds'], why: 'Anopheles breed in construction sites, tanks and waterlogged areas; Mumbai reports malaria all year with a monsoon rise.' },
    { id: 'lepto', name: 'Leptospirosis', syn: 'fever', months: 'Jul - Sep, after flooding', admit: 0.9, route: { MED: 0.7, ICU: 0.3 }, lab: 4, xray: 0.5, img: 0.1, o2: 0.3,
      needs: ['ICU', 'Ventilators', 'Dialysis', 'X-ray'], why: 'Contact with flood water contaminated by rat urine; in a published ICU series, 26 of 60 patients needed ventilation.' },
    { id: 'gastro', name: 'Gastroenteritis', syn: 'gi', months: 'All year; peaks Jun - Jul', admit: 0.4, route: { MED: 0.4, PEDS: 0.6 }, lab: 2, xray: 0.02, img: 0.05, o2: 0,
      needs: ['Paediatric beds', 'IV fluids'], why: 'Contaminated water and food, worse in heavy rain.' },
    { id: 'hep', name: 'Hepatitis', syn: 'gi', months: 'All year', admit: 0.5, route: { MED: 0.85, PEDS: 0.15 }, lab: 3, xray: 0.02, img: 0.3, o2: 0,
      needs: ['Medicine beds', 'Ultrasound', 'Lab'], why: 'Mostly water-borne hepatitis A and E.' },
    { id: 'flu', name: 'H1N1 influenza', syn: 'resp', months: 'Jul - Sep in 2026', admit: 0.6, route: { MED: 0.5, ICU: 0.15, ISO: 0.25, PEDS: 0.1 }, lab: 2.5, xray: 0.7, img: 0.05, o2: 0.35,
      needs: ['Isolation', 'Oxygen', 'ICU', 'X-ray'], why: 'H1N1 rose sharply in the 2026 monsoon (441 cases Jun-Aug against 62 in 2025).' },
    { id: 'chik', name: 'Chikungunya', syn: 'fever', months: 'Aug - Oct', admit: 0.1, route: { MED: 1 }, lab: 2, xray: 0.05, img: 0, o2: 0,
      needs: ['Mostly outpatient'], why: 'Same Aedes mosquito as dengue; rarely needs admission.' }
  ];
  const NOT_MODELLED = [
    { name: 'Pollution-related respiratory illness (Nov - Feb)', note: 'No published Mumbai admissions data. The live AQI is shown but not turned into admissions.' },
    { name: 'Heat and humidity illness (Apr - May)', note: 'Not notifiable; no published Mumbai admission counts.' },
    { name: 'Monsoon injuries and building collapses', note: 'No published monthly counts. Use the building-collapse scenario.' },
    { name: 'Diwali burns and trauma', note: 'No published Mumbai admission counts.' },
    { name: 'Tuberculosis', note: "Year-round load, already inside the hospital's published admissions." },
    { name: 'COVID-19 and new epidemics', note: 'Watched by the outbreak detector rather than a seasonal curve.' }
  ];
  const dim = mo => new Date(DATA.YEAR, mo + 1, 0).getDate();
  const SER = {};
  for (const d of DISEASES) {
    const ms = DATA.DISEASE_SERIES[d.id].months, tot = ms.reduce((a, x) => a + x.c, 0);
    SER[d.id] = { ms, mean: tot / 365, peak: Math.max(...ms.map((x, i) => x.c / dim(i))), total: tot };
  }
  // Mumbai notified cases per day on date t (linear between month mid-points; the same months repeat each year)
  function rateAt(id, t) {
    const d = new Date(t), mo = d.getMonth(), n = dim(mo), pos = (d.getDate() - 0.5) / n - 0.5;
    const mo2 = pos >= 0 ? (mo + 1) % 12 : (mo + 11) % 12, w = Math.abs(pos);
    return SER[id].ms[mo].c / n * (1 - w) + SER[id].ms[mo2].c / dim(mo2) * w;
  }

  // Epidemic profiles: used for outbreak drills and to forecast a detected outbreak.
  const PATHOGENS = {
    novel:   { name: 'Novel respiratory virus (COVID-like)', syn: 'resp', doubling: 4, route: { MED: 0.16, ICU: 0.05, ISO: 0.14, PEDS: 0.02 }, o2: 0.5, lab: 3, xray: 0.9, img: 0.1, staff: 0.12 },
    flu:     { name: 'Pandemic influenza (H1N1-like)', syn: 'resp', doubling: 5, route: { MED: 0.14, ICU: 0.05, ISO: 0.06, PEDS: 0.10 }, o2: 0.35, lab: 2.5, xray: 0.7, img: 0.05, staff: 0.08 },
    cholera: { name: 'Cholera / acute diarrhoeal outbreak', syn: 'gi', doubling: 3, route: { MED: 0.2, PEDS: 0.22, ICU: 0.01 }, o2: 0, lab: 2, xray: 0.02, img: 0.05, staff: 0.01 },
    dengue:  { name: 'Dengue epidemic', syn: 'fever', doubling: 7, route: { MED: 0.16, ICU: 0.025, PEDS: 0.06 }, o2: 0.05, lab: 4.5, xray: 0.05, img: 0.3, platelets: true, staff: 0.02 },
    lepto:   { name: 'Leptospirosis after flooding', syn: 'fever', doubling: 3, route: { MED: 0.42, ICU: 0.12 }, o2: 0.3, lab: 4, xray: 0.5, img: 0.1, staff: 0 }
  };
  const SYNDROMES = { fever: 'Fever (malaria, dengue, leptospirosis…)', resp: 'Respiratory (influenza, pneumonia…)', gi: 'Diarrhoea & jaundice', trauma: 'Injuries & heat' };
  const SYN_TO_PATHOGEN = { resp: 'novel', fever: 'dengue', gi: 'cholera', trauma: null };

  let P = null, START = floorHour(Date.now());
  function floorHour(t) { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); }
  function setStart(t) { START = floorHour(t); }

  const norm = (a, total) => { const s = a.reduce((x, y) => x + y, 0); return a.map(v => v * total / s); };
  const HOURP = norm([.55,.45,.4,.35,.35,.4,.55,.8,1.1,1.35,1.5,1.5,1.45,1.35,1.25,1.2,1.2,1.25,1.35,1.4,1.3,1.1,.9,.7], 24);
  const DOW = [0.9, 1.15, 1.05, 1.0, 0.98, 1.0, 0.92];
  const DISP = (() => { const a = new Array(24).fill(0); [.5,1,1.4,1.6,1.6,1.4,1.2,1,.8,.5,.3].forEach((v, i) => a[9 + i] = v); return norm(a, 24); })();
  const DISDOW = [0.45, 1.12, 1.12, 1.12, 1.12, 1.12, 0.6];
  const TRAFFIC = h => (h >= 8 && h < 11) || (h >= 17 && h < 21) ? 1.3 : h >= 23 || h < 6 ? 0.8 : 1;

  const ymd = (y, m, d) => new Date(y, m - 1, d).getTime();
  const DIWALI = [ymd(2025, 10, 20), ymd(2026, 11, 8), ymd(2027, 10, 29)];
  const HOLIDAYS = [
    [ymd(2025, 10, 2), 'Gandhi Jayanti'], [ymd(2025, 10, 20), 'Diwali'], [ymd(2025, 12, 25), 'Christmas'],
    [ymd(2026, 1, 26), 'Republic Day'], [ymd(2026, 5, 1), 'Maharashtra Day'], [ymd(2026, 8, 15), 'Independence Day'], [ymd(2026, 10, 2), 'Gandhi Jayanti'],
    [ymd(2026, 10, 20), 'Dussehra'], [ymd(2026, 11, 8), 'Diwali'], [ymd(2026, 11, 24), 'Guru Nanak Jayanti'],
    [ymd(2026, 12, 25), 'Christmas'], [ymd(2027, 1, 26), 'Republic Day'], [ymd(2027, 5, 1), 'Maharashtra Day'], [ymd(2027, 8, 15), 'Independence Day'],
    [ymd(2027, 10, 2), 'Gandhi Jayanti'], [ymd(2027, 10, 29), 'Diwali'], [ymd(2027, 12, 25), 'Christmas']
  ];
  const HOLIDAY_MAP = new Map(HOLIDAYS.map(h => [h[0], h[1]]));
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function holidayOn(t) { return HOLIDAY_MAP.get(dayStart(t)) || null; }

  function configure(setup) {
    const u = setup || {};
    const s = Object.assign({}, DEFAULT_SETUP, u);
    for (const k of ['beds', 'lab', 'xray', 'img']) s[k] = Object.assign({}, DEFAULT_SETUP[k], u[k]);
    const sumBeds = WARDS.reduce((a, w) => a + s.beds[w], 0);
    const admitFrac = s.admissionsPerDay / s.arrPerDay, route = {};
    for (const w of WARDS) route[w] = admitFrac * s.beds[w] / sumBeds;
    P = { setup: s, edSpaces: s.edSpaces, beds: s.beds, vents: s.vents, arr: s.arrPerDay / 24, arrScale: 1,
      nurses: s.nurses, docs: s.docs, route, admitFrac, edLOS: s.edLOS || 1.5,
      los: { MED: s.alos, SURG: s.alos, ICU: s.alos, PEDS: s.alos, ISO: s.alos },
      lab: Object.assign({}, R.lab, s.lab), xray: Object.assign({}, R.xray, s.xray), img: Object.assign({}, R.img, s.img),
      pltSupply: s.plateletSupply / 12, pltStock: s.plateletStock, o2Cap: s.o2Capacity, o2Delivery: s.o2Delivery / 24,
      amb: s.ambulances, hourp: s.hourp || null, dow: s.dow || null, disdow: s.disdow || null, startOcc: s.startOcc || s.bor || 0.75, share: (s.totalBeds || sumBeds) / CITY_BEDS, sizeK: s.arrPerDay / 200 };
    api.P = P; api.SETUP = s;
    return P;
  }

  function dayOfYear(t) { const d = new Date(t); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / DAY); }
  // 0..1 intensity of a disease relative to its own peak month (for charts)
  function seasonRaw(s, t) { return SER[s.id] ? rateAt(s.id, t) / SER[s.id].peak : 0; }
  const nearDiwali = (t, days) => DIWALI.some(e => Math.abs((t - e) / DAY) <= days);

  /* ---------------- external signals ---------------- */
  function subIndex(c, bp) { for (const [lo, hi, ilo, ihi] of bp) if (c <= hi) return ilo + (ihi - ilo) * (c - lo) / (hi - lo); return 500; }
  const BP25 = [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 500, 400, 500]];
  const BP10 = [[0, 50, 0, 50], [50, 100, 50, 100], [100, 250, 100, 200], [250, 350, 200, 300], [350, 430, 300, 400], [430, 600, 400, 500]];
  function indianAQI(pm25, pm10) { return Math.round(Math.max(subIndex(pm25, BP25), pm10 != null ? subIndex(pm10, BP10) : 0)); }
  function aqiBand(a) { return a <= 50 ? 'Good' : a <= 100 ? 'Satisfactory' : a <= 200 ? 'Moderate' : a <= 300 ? 'Poor' : a <= 400 ? 'Very poor' : 'Severe'; }
  // IMD daily rainfall categories.
  function rainClass(mm) { return mm >= 204.5 ? 'Extremely heavy' : mm >= 115.6 ? 'Very heavy' : mm >= 64.5 ? 'Heavy' : mm >= 15.6 ? 'Moderate' : mm >= 2.5 ? 'Light' : mm > 0 ? 'Very light' : 'None'; }
  const floodFactor = mm => mm >= 204.5 ? 2.2 : mm >= 115.6 ? 1.7 : mm >= 64.5 ? 1.35 : 1;

  // v: raw readings. dengueWeekly / malariaWeekly: optional BMC weekly counts entered by staff (scale the published series).
  // Expected notified cases in Mumbai between two times, from the monthly series.
  function expectedCases(id, from, to) { let e = 0; for (let t = from; t < to; t += DAY) e += rateAt(id, t + DAY / 2); return e; }
  function feedFactors(v) {
    const now = v.now || Date.now();
    const ratio = (id, wk) => wk ? Math.max(0.2, Math.min(5, (wk / 7) / Math.max(0.1, rateAt(id, now)))) : 1;
    const out = { dengue: ratio('dengue', v.dengueWeekly), malaria: ratio('malaria', v.malariaWeekly), rainDays: v.rainDays || {}, used: {} };
    // BMC reports entered by staff: the newest report that ended within 21 days and covers at most 5 weeks rescales each disease.
    const reps = (v.reports || []).filter(r => r.to <= now && now - r.to <= 21 * DAY && r.to - r.from <= 35 * DAY).sort((a, b) => b.to - a.to);
    for (const id in SER) {
      const r = reps.find(x => x.counts && x.counts[id] != null); if (!r) continue;
      const e = expectedCases(id, r.from, r.to + DAY); if (e < 1) continue;
      out[id] = Math.max(0.2, Math.min(5, r.counts[id] / e)); out.used[id] = { report: r.id, expected: e };
    }
    return out;
  }

  /* ---------------- scenarios & actions ---------------- */
  function defaultLevers() {
    return { arrivalPct: 0, seasonScale: 1, outbreak: 'none', flood: false, nurseShortPct: 0, docShortPct: 0,
      medBedsClosed: 0, ventsDown: 0, labDownPct: 0, xrayDownPct: 0, imgDownPct: 0, plateletCutPct: 0, o2CutPct: 0, ambDownPct: 0, startHour: 0 };
  }

  const ACTIONS = [
    { id: 'surgebeds', title: 'Open surge beds in Medicine (+7%)', units: ['MED', 'ED'], lead: 24, owner: 'Nursing Superintendent',
      detail: 'Convert day-care and step-down space into extra Medicine beds. Needs 24 h to staff and equip.', apply: c => { c.medExtra += Math.round(P.beds.MED * 0.07); } },
    { id: 'weekenddc', title: 'Run a weekend and holiday discharge team', units: ['MED', 'SURG', 'PEDS', 'ED'], lead: 0, owner: 'Medical Superintendent',
      detail: 'A consultant, pharmacist and discharge nurse on Sat/Sun and public holidays lift discharges to about 70% of a weekday.', apply: c => { c.weekendDc = true; } },
    { id: 'noondc', title: 'Discharge-before-noon drive', units: ['MED', 'SURG', 'PEDS', 'ED'], lead: 12, owner: 'Ward consultants',
      detail: 'Board rounds at 08:30; discharge summaries and take-home medicines prepared the evening before.', apply: c => { c.dcBoost *= 1.12; } },
    { id: 'housekeep', title: 'Add housekeeping on evenings and nights', units: ['MED', 'SURG', 'PEDS', 'ICU', 'ISO', 'ED'], lead: 8, owner: 'Facilities Manager',
      detail: 'Turn discharged beds round in about 1.5 h at any hour.', apply: c => { c.cleanFast = true; } },
    { id: 'floatnurse', title: 'Call in float nurses (+8% per shift)', units: ['NUR', 'ICU', 'ISO'], lead: 8, owner: 'Nursing Superintendent',
      detail: 'Use the float pool and agency roster.', apply: c => { c.floatNurses += Math.round(P.nurses[1] * 0.08); } },
    { id: 'labshift', title: 'Extend lab staffing and run a 2nd haematology analyser', units: ['LAB', 'ED'], lead: 6, owner: 'Lab Director',
      detail: 'Adds about 30% lab throughput; prioritise CBC, NS1, malaria and leptospirosis tests.', apply: c => { c.labBoost *= 1.3; } },
    { id: 'phlebo', title: 'Stagger morning ward blood draws', units: ['LAB'], lead: 12, owner: 'Lab Director',
      detail: 'Spread routine inpatient samples across 05:00–14:00.', apply: c => { c.labBatch = 0.3; } },
    { id: 'xraynight', title: 'Add a night X-ray technician and a portable unit', units: ['XRAY', 'ED'], lead: 12, owner: 'Head of Radiology',
      detail: 'Adds about 35% X-ray capacity, mostly at night, and bedside films for isolation and ICU.', apply: c => { c.xrayBoost *= 1.35; } },
    { id: 'imgeve', title: 'Add an evening CT and ultrasound session', units: ['IMG', 'ED'], lead: 24, owner: 'Head of Radiology',
      detail: 'Keep CT and ultrasound staffed until 22:00.', apply: c => { c.imgEve = 1.4; } },
    { id: 'fasttrack', title: 'Open a fever fast-track clinic beside the ED', units: ['ED', 'LAB'], lead: 12, owner: 'Head of Emergency',
      detail: 'Triage stable fever patients (malaria, dengue suspects) to an OPD-style clinic; diverts about 30% of seasonal ED load.', apply: c => { c.fastTrack = 0.3; } },
    { id: 'defer', title: 'Defer non-urgent elective surgery', units: ['SURG', 'ICU', 'NUR'], lead: 24, owner: 'Head of Surgery',
      detail: 'Postpone half of planned non-urgent cases.', apply: c => { c.electiveDefer = Math.max(c.electiveDefer, 0.5); } },
    { id: 'icustep', title: 'Convert step-down beds to ICU (+15%)', units: ['ICU'], lead: 12, owner: 'Head of Critical Care',
      detail: 'Upgrade HDU beds with monitors and transport ventilators.', apply: c => { c.icuExtra += Math.max(2, Math.round(P.beds.ICU * 0.15)); c.ventExtra += Math.max(1, Math.round(P.vents * 0.1)); } },
    { id: 'donorcamp', title: 'Hold platelet donation camps', units: ['BLOOD'], lead: 48, owner: 'Blood Bank Officer',
      detail: 'Apheresis and whole-blood camps with colleges and housing societies; adds about 60% to daily platelet supply after 48 h.', apply: c => { c.pltExtra += P.pltSupply * 0.6; } },
    { id: 'plttransfer', title: 'Request platelets from the regional blood bank', units: ['BLOOD'], lead: 12, owner: 'Blood Bank Officer',
      detail: 'One-off transfer through the state blood transfusion council network.', apply: (c, k, lead) => { if (k === lead) c.pltBolus += P.pltStock * 0.7; } },
    { id: 'o2cyl', title: 'Stock up oxygen cylinders', units: ['O2'], lead: 12, owner: 'Biomedical Engineer',
      detail: 'Order filled D-type cylinders equal to about 3 days of current use as a buffer against tanker delays.', apply: (c, k, lead) => { if (k === lead) c.o2Bolus += P.o2Delivery * 24 * 3; } },
    { id: 'o2alloc', title: 'Request a higher oxygen allocation and tanker priority', units: ['O2'], lead: 24, owner: 'Medical Superintendent',
      detail: 'Through the BMC / FDA oxygen coordination desk; raises refills by about 60%.', apply: c => { c.o2Boost *= 1.6; } },
    { id: 'isoward', title: 'Open an isolation cohort ward', units: ['ISO', 'ED'], lead: 24, owner: 'Infection Control Officer',
      detail: 'Convert one Medicine ward into a well-ventilated cohort ward for infectious patients.', apply: c => { const n = Math.max(10, Math.round(P.beds.MED * 0.1)); c.isoExtra += n; c.medExtra -= n; } },
    { id: 'ambextra', title: 'Add ambulances (+50%)', units: ['AMB'], lead: 6, owner: 'Transport Officer',
      detail: 'Contract private ambulances and request extra 108 vehicles for the catchment.', apply: c => { c.ambExtra += Math.max(2, Math.round(P.amb * 0.5)); } },
    { id: 'jumbo', title: 'Refer stable epidemic patients to a city field hospital', units: ['ISO', 'MED', 'O2', 'ED'], lead: 72, owner: 'BMC Ward War Room',
      detail: 'As Mumbai did with its jumbo COVID centres: send about 35% of moderate epidemic cases to a city-run field facility.', apply: c => { c.jumbo = 0.35; } },
    { id: 'stopelective', title: 'Stop all planned surgery', units: ['SURG', 'ICU', 'NUR', 'O2'], lead: 12, owner: 'Medical Superintendent',
      detail: 'Frees surgical beds, post-op ICU beds, theatre oxygen and staff for the surge.', apply: c => { c.electiveDefer = 1; } }
  ];
  const ACTION_BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a]));

  const OUTBREAKS = {
    none:   { label: 'None' },
    dengue: { label: 'Dengue outbreak (cases ×1.5)' },
    flu:    { label: 'Early influenza wave' },
    gastro: { label: 'Cholera / gastro cluster' },
    mci:    { label: 'Mass-casualty incident (building collapse)' }
  };

  function cfgAt(run, k) {
    const L = run.levers, on = k >= (L.startHour || 0);
    const c = {
      arrMult: on ? 1 + L.arrivalPct / 100 : 1, seasonScale: on ? L.seasonScale : 1, outbreak: on ? L.outbreak : 'none',
      nurseShort: on ? L.nurseShortPct / 100 : 0, docShort: on ? L.docShortPct / 100 : 0,
      medClosed: on ? L.medBedsClosed : 0, ventsDown: on ? L.ventsDown : 0,
      labDown: on ? L.labDownPct / 100 : 0, xrayDown: on ? (L.xrayDownPct || 0) / 100 : 0, imgDown: on ? L.imgDownPct / 100 : 0,
      pltCut: on ? (L.plateletCutPct || 0) / 100 : 0, o2Cut: on ? (L.o2CutPct || 0) / 100 : 0, ambDown: on ? (L.ambDownPct || 0) / 100 : 0,
      floodH: L.flood ? k - (L.startHour || 0) : null,
      medExtra: 0, icuExtra: 0, isoExtra: 0, ventExtra: 0, weekendDc: false, dcBoost: 1, floatNurses: 0, cleanFast: false,
      labBoost: 1, labBatch: R.lab.batch, xrayBoost: 1, fastTrack: 0, electiveDefer: 0, imgEve: 1, pltExtra: 0, pltBolus: 0,
      o2Boost: 1, o2Bolus: 0, ambExtra: 0, jumbo: 0
    };
    for (const a of run.actions) if (k >= a.lead) ACTION_BY_ID[a.id].apply(c, k, a.lead);
    return c;
  }

  /* ---------------- state ---------------- */
  function initialState() {
    const k = P.sizeK, o = P.startOcc;
    return { ed: 22 * k, bd: { MED: 1, SURG: 0, ICU: 0, PEDS: 0, ISO: 0 },
      occ: { MED: P.beds.MED * o, SURG: P.beds.SURG * o, ICU: P.beds.ICU * o, PEDS: P.beds.PEDS * o, ISO: P.beds.ISO * o },
      dirty: { MED: 2 * k, SURG: k, ICU: 0, PEDS: k, ISO: 0 }, icuStep: 0, otQ: 0, labQ: 30 * k, xrayQ: 4 * k, imgQ: 3 * k,
      plt: P.pltStock, pltAvg: R.plt.base * k, pltShort: 0, o2: P.o2Cap * 0.8, o2Avg: 0, o2x: 0, o2Short: 0, amb: 2 * k, cancelled: 0 };
  }
  const cloneState = s => ({ ...s, bd: { ...s.bd }, occ: { ...s.occ }, dirty: { ...s.dirty } });

  /* ---------------- randomness ---------------- */
  function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function poisson(l, r) {
    if (l <= 0) return 0;
    if (l < 25) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }
    return Math.max(0, Math.round(l + Math.sqrt(l) * gauss(r)));
  }
  function shocks(run, t) {
    if (!run.rand || run.noShock) return [1, 1, 1];
    if (!run._sh) run._sh = { season: Math.exp(0.16 * gauss(run.rand) - 0.0128), epi: Math.exp(0.3 * gauss(run.rand)), days: {} };
    const d = Math.floor(t / DAY);
    if (run._sh.days[d] == null) run._sh.days[d] = Math.exp(0.07 * gauss(run.rand) - 0.00245);
    return [run._sh.season, run._sh.days[d], run._sh.epi];
  }
  const rainOn = (fe, t) => (fe.rainDays && fe.rainDays[dayStart(t)]) || 0;

  /* ---------------- one simulated hour ---------------- */
  function step(s, k, absHour, run) {
    const t = START + absHour * HOUR, d = new Date(t), h = d.getHours(), dow = d.getDay();
    const c = cfgAt(run, k), F = run.flags || {}, rnd = run.rand, fe = run.feeds || {};
    const HP = P.hourp || HOURP, DW = P.dow || DOW, DD = P.disdow || DISDOW;
    const hol = F.noHoliday ? null : holidayOn(t);
    const dowF = F.flatDow ? 1 : DW[dow];
    const sh = h >= 7 && h < 15 ? 1 : (h >= 15 && h < 23 ? 2 : 0);
    const [seasonShock, dayShock, epiShock] = shocks(run, t);
    const m = c.arrMult * (run.nowcast || 1) * (run.band || 1) * dayShock * P.arrScale;
    const unit = P.arr * HP[h] * dowF;
    let base = unit * m;
    const expectedBase = unit * c.arrMult * P.arrScale;

    // Rain and flooding: today's rain slows ambulances; heavy rain 7–14 days ago drives leptospirosis.
    let rainToday = rainOn(fe, t), leptoF = 1, floodExtra = 0;
    if (c.floodH != null && c.floodH >= 0) {
      if (c.floodH < 36) rainToday = Math.max(rainToday, 260);
      if (c.floodH >= 24 && c.floodH < 288) floodExtra = 1;
      if (c.floodH >= 150 && c.floodH < 360) leptoF += 3.5 * Math.exp(-Math.pow((c.floodH - 250) / 70, 2));
    }

    let seasonArr = 0, staffAbs = 0;
    const seasonBy = {}, parts = [], syn = { fever: 0, resp: 0, gi: 0, trauma: 0 }, synExp = { fever: 0, resp: 0, gi: 0, trauma: 0 };
    for (const S of DISEASES) {
      if (run.off && run.off[S.id]) { seasonBy[S.id] = 0; continue; }
      const Sx = SER[S.id];
      let r = rateAt(S.id, t) * (fe[S.id] || 1) * (run.seasonBand || 1);
      if (S.id === 'lepto') r *= leptoF;
      if (S.id === 'gastro' && floodExtra) r *= 1.8;
      if (c.outbreak === 'dengue' && S.id === 'dengue') r *= 1.5;
      if (c.outbreak === 'flu' && S.id === 'flu') r *= 3;
      if (c.outbreak === 'gastro' && S.id === 'gastro') r *= 2.5;
      // Published hospital arrivals already contain the yearly average; only the deviation from it is added.
      const dev = (r - Sx.mean) * c.seasonScale;
      const perHour = dev * P.share * HP[h] / 24;
      synExp[S.syn] += perHour * c.arrMult * P.arrScale / (run.seasonBand || 1);
      const x = perHour * seasonShock * m;
      parts.push([S, x]); seasonArr += x;
    }
    // Epidemic: an outbreak drill in the observed world, or a detected outbreak carried into the forecast.
    let epiX = 0, epiP = null;
    const ep = F.noEpi ? null : run.epi;
    if (ep && absHour >= ep.t0) {
      epiP = PATHOGENS[ep.pathogen];
      epiX = Math.min(ep.cap * P.sizeK, ep.a0 * P.sizeK * Math.exp(ep.r * epiShock * (absHour - ep.t0))) * HP[h] * (run.band || 1) * dayShock;
      if (epiP.staff && !F.noLeave) staffAbs += epiP.staff * Math.min(1, epiX / Math.max(1, P.arr));
    }
    if (rnd) {
      const lam = base + seasonArr + epiX, n = poisson(lam, rnd), f = lam > 0 ? n / lam : 0;
      base *= f; seasonArr *= f; epiX *= f; for (const p of parts) p[1] *= f;
    }
    const adm = {}; for (const u of WARDS) adm[u] = base * P.route[u];
    adm.SURG *= 1 - c.electiveDefer * R.plannedSurg;
    let labD = base * P.lab.perArr, xrayD = base * P.xray.perArr, imgD = base * P.img.perArr, dengueAdm = 0, o2New = 0;
    for (const sy in R.bg) { syn[sy] += base * R.bg[sy]; synExp[sy] += expectedBase * R.bg[sy]; }
    for (const [S, x] of parts) {
      seasonBy[S.id] = x; syn[S.syn] += x;
      let admitted = 0;
      for (const u in S.route) { const a = x * S.admit * S.route[u]; adm[u] += a; admitted += a; }
      labD += x * S.lab; xrayD += x * S.xray; imgD += x * S.img;
      if (S.platelets) dengueAdm += admitted;
      o2New += admitted * S.o2;
    }
    if (epiX > 0) {
      syn[epiP.syn] += epiX;
      const keep = 1 - c.jumbo;
      let admitted = 0;
      for (const u in epiP.route) { adm[u] += epiX * epiP.route[u] * keep; admitted += epiX * epiP.route[u] * keep; }
      labD += epiX * epiP.lab * keep; xrayD += epiX * epiP.xray * keep; imgD += epiX * epiP.img * keep;
      o2New += admitted * epiP.o2;
      if (epiP.platelets) dengueAdm += admitted;
    }
    let mci = 0;
    if (c.outbreak === 'mci' && k === (run.levers.startHour || 0)) {
      mci = 35 * Math.max(1, P.sizeK / 3); adm.SURG += mci * 0.26; adm.ICU += mci * 0.12; adm.MED += mci * 0.08;
      labD += mci * 4; xrayD += mci * 2; imgD += mci; syn.trauma += mci;
    }
    if (rnd) for (const u of WARDS) adm[u] = poisson(adm[u], rnd);
    const arrivals = base + seasonArr + epiX + mci;

    // Laboratory (backlog beyond ~8 h of capacity goes to an external reference lab)
    const wardPts = WARDS.reduce((a, u) => a + s.occ[u], 0);
    const batch = F.noBatch ? 4 / 24 : c.labBatch;
    const batchHours = batch < R.lab.batch && !F.noBatch ? 9 : 4;
    const inBatch = h >= 5 && h < 5 + batchHours;
    labD += wardPts * R.lab.perBedDay * (inBatch ? batch / batchHours : (1 - batch) / (24 - batchHours));
    const labCap = (h >= 8 && h < 20 ? P.lab.day : P.lab.night) * (1 - c.labDown) * c.labBoost;
    s.labQ += labD; s.labQ -= Math.min(s.labQ, labCap); s.labQ = Math.min(s.labQ, labCap * 8);
    const labTAT = s.labQ / Math.max(1, labCap) + R.lab.proc;

    // X-ray
    xrayD += wardPts * R.xray.perBedDay / 24;
    const xrayCap = (h >= 8 && h < 20 ? P.xray.day : P.xray.night * (c.xrayBoost > 1 ? 1.6 : 1)) * (1 - c.xrayDown) * c.xrayBoost;
    s.xrayQ += xrayD; s.xrayQ -= Math.min(s.xrayQ, xrayCap); s.xrayQ = Math.min(s.xrayQ, Math.max(xrayCap, 1) * 12);
    const xrayTAT = xrayCap > 0.05 ? s.xrayQ / xrayCap + R.xray.proc : 12;

    // CT & ultrasound
    imgD += wardPts * R.img.perBedDay / 24;
    const imgCap = (h >= 8 && h < 20 ? P.img.day : P.img.night) * (1 - c.imgDown) * (h >= 16 && h < 22 ? c.imgEve : 1);
    s.imgQ += imgD; s.imgQ -= Math.min(s.imgQ, imgCap); s.imgQ = Math.min(s.imgQ, Math.max(imgCap, 1) * 12);
    const imgTAT = imgCap > 0.05 ? s.imgQ / imgCap + R.img.proc : 12;

    // Emergency department, with ambulance diversion when far over capacity
    const slow = F.noLabSlow ? 1 : (1 + Math.max(0, labTAT - 1.5) * 0.18) * (1 + Math.max(0, Math.min(xrayTAT, 12) - 1) * 0.06) * (1 + Math.max(0, Math.min(imgTAT, 12) - 2) * 0.05);
    const edLOS = P.edLOS * slow;
    const docs = P.docs[sh] * (1 - c.docShort);
    const preBoard = WARDS.reduce((a, u) => a + s.bd[u], 0);
    const divert = (s.ed + preBoard) / P.edSpaces > 1.5 ? 0.5 : 0;
    if (divert) for (const u of WARDS) adm[u] *= 1 - divert;
    const edIn = (base + seasonArr * (1 - c.fastTrack) + epiX * (1 - c.jumbo) + mci) * (1 - divert);
    s.ed += edIn;
    s.ed -= Math.min(s.ed / edLOS, docs * R.docRate);
    const admTot = WARDS.reduce((a, u) => a + adm[u], 0);
    for (const u of WARDS) s.bd[u] += adm[u];

    // Ambulances: trips scale with arrivals; Mumbai traffic and flooding lengthen each trip.
    const tripH = R.amb.trip * TRAFFIC(h) * floodFactor(rainToday);
    const trips = (base + seasonArr) * R.amb.share + epiX * R.amb.epiShare + mci * 0.6 + (divert ? edIn * 0.2 : 0);
    s.amb += rnd ? poisson(trips, rnd) : trips;
    s.amb -= s.amb / tripH;
    const fleet = Math.max(1, (P.amb + c.ambExtra) * (1 - c.ambDown));

    // Discharges (fewer at weekends and on public holidays); each freed bed then needs cleaning
    const offDay = dow === 0 || dow === 6 || !!hol;
    const dd = hol && dow >= 1 && dow <= 5 ? 0.6 : DD[dow];
    const dF = DISP[h] * (offDay && F.noWeekendDip ? 0.95 : offDay && c.weekendDc ? Math.max(dd, 0.72) : dd) * c.dcBoost;
    const disOf = (u, x) => rnd ? Math.min(s.occ[u], poisson(x, rnd)) : x;
    let disTot = 0;
    for (const u of ['MED', 'SURG', 'PEDS', 'ISO']) { const x = disOf(u, s.occ[u] / (P.los[u] * 24) * dF); s.occ[u] -= x; s.dirty[u] += x; disTot += x; }
    const icuDis = disOf('ICU', s.occ.ICU / (P.los.ICU * 24) * (0.5 + 0.5 * dF));
    s.occ.ICU -= icuDis * (1 - R.icuToMed); s.dirty.ICU += icuDis * (1 - R.icuToMed); disTot += icuDis;
    s.icuStep += icuDis * R.icuToMed;
    const cleanH = F.noCleaning ? 0.2 : c.cleanFast ? 1.5 : R.clean[sh];
    for (const u of WARDS) s.dirty[u] -= s.dirty[u] * Math.min(1, 1 / cleanH);

    // Bed allocation
    const cap = { MED: Math.max(1, P.beds.MED - c.medClosed + c.medExtra), SURG: P.beds.SURG, ICU: P.beds.ICU + c.icuExtra, PEDS: P.beds.PEDS, ISO: P.beds.ISO + c.isoExtra };
    const freeOf = u => Math.max(0, cap[u] - s.occ[u] - s.dirty[u]);
    let free = freeOf('MED');
    let a = Math.min(s.icuStep, free); s.occ.MED += a; s.icuStep -= a; s.occ.ICU -= a; s.dirty.ICU += a; free -= a;
    a = Math.min(s.bd.MED, free); s.occ.MED += a; s.bd.MED -= a;
    free = freeOf('SURG');
    a = Math.min(s.bd.SURG, free); s.occ.SURG += a; s.bd.SURG -= a; free -= a;
    // Surgical admissions that find no bed while patients wait in ED count as planned operations at risk.
    const cancelled = s.bd.SURG > 1 && dow >= 1 && dow <= 5 && h >= 8 && h < 18 ? adm.SURG * R.plannedSurg : 0;
    s.cancelled += cancelled;
    free = freeOf('ICU');
    a = Math.min(s.bd.ICU, free); s.occ.ICU += a; s.bd.ICU -= a; free -= a;
    a = Math.min(s.otQ, free); s.occ.ICU += a; s.otQ -= a;
    free = freeOf('PEDS');
    a = Math.min(s.bd.PEDS, free); s.occ.PEDS += a; s.bd.PEDS -= a;
    free = freeOf('ISO');
    a = Math.min(s.bd.ISO, free); s.occ.ISO += a; s.bd.ISO -= a;

    // Blood bank: platelets
    const pltDemand = R.plt.base * P.sizeK + dengueAdm * R.plt.perDengueAdm;
    const pltIn = (h >= 8 && h < 20 ? P.pltSupply * (1 - c.pltCut) + c.pltExtra : 0) + c.pltBolus;
    s.plt += pltIn; s.plt -= s.plt / (R.plt.shelf * 24);
    const used = Math.min(s.plt, pltDemand); s.plt -= used; s.pltShort += pltDemand - used;
    s.pltAvg = s.pltAvg * 0.96 + pltDemand * 0.04;

    // Oxygen: patients on oxygen by ward, plus extra oxygen-dependent patients from respiratory, fever and epidemic illness
    s.o2x += o2New; s.o2x -= s.o2x / (R.o2.decayDays * 24);
    const wardO2 = Math.min(s.occ.MED + s.occ.SURG + s.occ.PEDS + s.occ.ISO + s.bd.MED + s.bd.ISO,
      s.occ.MED * R.o2.ward.MED + s.occ.SURG * R.o2.ward.SURG + s.occ.PEDS * R.o2.ward.PEDS + s.occ.ISO * R.o2.ward.ISO + s.o2x + (s.bd.MED + s.bd.ISO) * 0.2);
    const icuO2 = (s.occ.ICU + s.bd.ICU) * R.o2.icu;
    const o2Use = (wardO2 * R.o2.perWardPt + icuO2 * R.o2.perIcuPt) / 24;
    const o2In = P.o2Delivery * (1 - c.o2Cut) * c.o2Boost + c.o2Bolus;
    s.o2 = Math.min(P.o2Cap + c.o2Bolus, s.o2 + o2In);
    const o2Used = Math.min(s.o2, o2Use); s.o2 -= o2Used; s.o2Short += o2Use - o2Used;
    s.o2Avg = s.o2Avg ? s.o2Avg * 0.95 + o2Use * 0.05 : o2Use;

    // Nursing
    const boardTotal = WARDS.reduce((x, u) => x + s.bd[u], 0);
    const vents = Math.max(1, P.vents - c.ventsDown + c.ventExtra);
    const icuBed = (s.occ.ICU + s.dirty.ICU + s.bd.ICU + s.otQ) / cap.ICU;
    const icuVent = s.occ.ICU * R.ventPerIcuPt / vents;
    let req = (s.ed + boardTotal - s.bd.ICU) / R.ratio.ED + s.bd.ICU / R.ratio.ICU;
    for (const u of WARDS) req += s.occ[u] / R.ratio[u];
    if (sh === 0) req /= R.nightRelax;
    const leave = F.noLeave ? 0 : nearDiwali(t, 2) ? 0.06 : hol ? 0.04 : 0;
    const avail = Math.max(1, P.nurses[sh] * (1 - R.absence - Math.min(0.35, staffAbs) - leave) * (1 - c.nurseShort) + c.floatNurses);

    const p = {
      ED: (s.ed + boardTotal) / P.edSpaces,
      MED: (s.occ.MED + s.dirty.MED + s.bd.MED) / cap.MED,
      SURG: (s.occ.SURG + s.dirty.SURG + s.bd.SURG) / cap.SURG,
      ICU: Math.max(icuBed, icuVent),
      PEDS: (s.occ.PEDS + s.dirty.PEDS + s.bd.PEDS) / cap.PEDS,
      ISO: (s.occ.ISO + s.dirty.ISO + s.bd.ISO) / Math.max(1, cap.ISO),
      O2: Math.min(5, s.o2Avg * 24 * R.o2.cover / Math.max(1, s.o2)),
      AMB: s.amb / fleet,
      LAB: labTAT / R.lab.target,
      XRAY: Math.min(xrayTAT, 12) / R.xray.target,
      IMG: Math.min(imgTAT, 12) / R.img.target,
      NUR: req / avail,
      BLOOD: Math.min(5, (s.pltAvg * 24 * R.plt.cover) / Math.max(1, s.plt))
    };
    for (const id in p) if (!(p[id] < 5)) p[id] = 5; // cap display at 500% (also guards NaN)
    if (run.lite) return { p };
    const bgSum = Object.values(R.bg).reduce((x, y) => x + y, 0);
    return {
      t, k: absHour, p, arrivals, admTot, disTot, expected: expectedBase * (1 - bgSum) + Object.values(synExp).reduce((x, y) => x + y, 0),
      syn, synExp, epiX, seasonArr, seasonBy, edIn, edLOS, labTAT, xrayTAT: Math.min(xrayTAT, 12), imgTAT: Math.min(imgTAT, 12),
      boarders: boardTotal, diverted: divert ? (base + seasonArr + mci) * divert : 0, icuStepWait: s.icuStep, cancelled,
      nurseReq: req, nurseAvail: avail, labDemand: labD, xrayDemand: xrayD, plt: s.plt, pltDemand, pltShort: pltDemand - used,
      o2: s.o2, o2Use, o2Short: o2Use - o2Used, o2Pts: wardO2 + icuO2, ambBusy: s.amb, fleet, tripH, rainToday, holiday: hol,
      occ: { ...s.occ }, dirty: { ...s.dirty }, bd: { ...s.bd }, cap, ventsUsed: s.occ.ICU * R.ventPerIcuPt, vents, edCensus: s.ed
    };
  }

  function simulate(s0, t0, hours, run) {
    const s = cloneState(s0), out = [];
    for (let k = 0; k < hours; k++) out.push(step(s, k, t0 + k, run));
    return out;
  }

  function ensemble(s0, t0, hours, run, n, seed) {
    const ids = UNITS.map(u => u.id), runs = [];
    for (let i = 0; i < n; i++) runs.push(simulate(s0, t0, hours, Object.assign({}, run, { rand: mulberry(seed + i * 7919), lite: true, _sh: null })));
    const q = { p10: [], p90: [], n };
    const col = new Float64Array(n);
    for (let k = 0; k < hours; k++) {
      const a = {}, c = {};
      for (const id of ids) {
        for (let i = 0; i < n; i++) col[i] = runs[i][k].p[id];
        col.sort();
        a[id] = col[Math.floor(0.1 * (n - 1))]; c[id] = col[Math.ceil(0.9 * (n - 1))];
      }
      q.p10.push({ p: a }); q.p90.push({ p: c });
    }
    q.prob = (id, from, to, thr) => {
      let hit = 0;
      for (const ser of runs) for (let k = Math.max(0, from); k <= Math.min(hours - 1, to); k++) if (ser[k].p[id] >= thr) { hit++; break; }
      return hit / n;
    };
    return q;
  }

  // Monte Carlo summary small enough to send from a Web Worker: P10/P90 per hour, the first hour each run
  // crosses the warning and critical lines, and each run's peak per calendar day.
  function ensembleSummary(s0, t0, hours, run, n, seed) {
    const ids = UNITS.map(u => u.id), W = THRESH.warn, C = THRESH.crit;
    const days = []; let k = 0;
    while (k < hours) { const dd = new Date(START + (t0 + k) * HOUR), rest = 24 - dd.getHours(); days.push([k, Math.min(hours, k + rest)]); k += rest; }
    const cols = {}; for (const id of ids) cols[id] = new Float32Array(n * hours);
    const first = { warn: {}, crit: {} }, dayMax = {};
    for (const id of ids) { first.warn[id] = new Int16Array(n).fill(-1); first.crit[id] = new Int16Array(n).fill(-1); dayMax[id] = new Float32Array(n * days.length); }
    for (let i = 0; i < n; i++) {
      const ser = simulate(s0, t0, hours, Object.assign({}, run, { rand: mulberry(seed + i * 7919), lite: true, _sh: null }));
      for (const id of ids) {
        const col = cols[id], fw = first.warn[id], fc = first.crit[id], dm = dayMax[id];
        let di = 0;
        for (let h = 0; h < hours; h++) {
          const v = ser[h].p[id]; col[h * n + i] = v;
          if (fw[i] < 0 && v >= W) fw[i] = h;
          if (fc[i] < 0 && v >= C) fc[i] = h;
          while (di < days.length - 1 && h >= days[di][1]) di++;
          if (v > dm[i * days.length + di]) dm[i * days.length + di] = v;
        }
      }
    }
    const p10 = {}, p90 = {}, lo = Math.floor(0.1 * (n - 1)), hi = Math.ceil(0.9 * (n - 1));
    for (const id of ids) {
      const a = new Float32Array(hours), b = new Float32Array(hours), col = cols[id];
      for (let h = 0; h < hours; h++) { const sl = col.subarray(h * n, h * n + n).slice().sort(); a[h] = sl[lo]; b[h] = sl[hi]; }
      p10[id] = a; p90[id] = b;
    }
    return { n, hours, days, p10, p90, first, dayMax };
  }
  function setDiseaseMonths(id, months) {
    const tot = months.reduce((a, x) => a + x.c, 0);
    SER[id] = { ms: months, mean: tot / 365, peak: Math.max(...months.map((x, i) => x.c / dim(i))), total: tot };
  }

  /* ---------------- syndromic outbreak detection ---------------- */
  // Compares the last 3 days of patients by syndrome with what the seasonal model expected, and fits a growth rate over 7 days.
  const LEVELS = ['Normal', 'Watch', 'Outbreak', 'Epidemic', 'Severe epidemic'];
  function detectOutbreak(history, now) {
    const out = {};
    for (const sy of Object.keys(SYNDROMES)) {
      const daily = [];
      for (let dIdx = 7; dIdx >= 1; dIdx--) {
        let o = 0, e = 0, n = 0;
        for (const x of history) if (x.syn && x.k >= now - dIdx * 24 && x.k < now - (dIdx - 1) * 24) { o += x.syn[sy]; e += x.synExp[sy]; n++; }
        if (n >= 12) daily.push({ d: -dIdx, o: o * 24 / n, e: e * 24 / n });
      }
      if (daily.length < 4) { out[sy] = { level: 0, ratio: 1, z: 0, growth: 0, excessPerHour: 0, daily }; continue; }
      const last3 = daily.slice(-3), O = last3.reduce((a, x) => a + x.o, 0), E = last3.reduce((a, x) => a + x.e, 0);
      const ratio = O / Math.max(1e-6, E), z = (O - E) / Math.sqrt(Math.max(1, E));
      // Log of the excess, floored at 8% of expected so noise around zero does not read as explosive growth.
      const pts = daily.map(x => ({ d: x.d, y: Math.log(Math.max(x.o - x.e, 0.08 * x.e, 0.5)) }));
      let growth = 0;
      if (pts.length >= 4) {
        const mx = pts.reduce((a, p) => a + p.d, 0) / pts.length, my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        const sxx = pts.reduce((a, p) => a + (p.d - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p.d - mx) * (p.y - my), 0);
        growth = sxx > 0 ? Math.max(-0.3, Math.min(Math.log(2) / 2.5, sxy / sxx)) : 0;
      }
      const lastDay = daily[daily.length - 1];
      const excessPerHour = Math.max(0, lastDay.o - lastDay.e) / 24;
      let level = 0;
      if (z >= 2 && ratio >= 1.1) level = 1;
      if (z >= 3 && ratio >= 1.2) level = 2;
      if ((ratio >= 1.6 && growth > 0.05) || ratio >= 2.2) level = 3;
      if (ratio >= 3.5 || (level >= 3 && growth > Math.log(2) / 5)) level = 4;
      out[sy] = { level, ratio, z, growth, doubling: growth > 0.01 ? Math.log(2) / growth : null, excessPerHour, daily };
    }
    return out;
  }

  const THRESH = { watch: 0.85, warn: 0.95, crit: 1.05 };
  function detectEvents(series, minHours) {
    minHours = minHours || 2;
    const ev = [];
    for (const u of UNITS) {
      let i = 0;
      while (i < series.length) {
        if (series[i].p[u.id] >= THRESH.warn) {
          let j = i, peak = 0, peakAt = i;
          while (j < series.length && series[j].p[u.id] >= THRESH.warn - 0.02) { if (series[j].p[u.id] > peak) { peak = series[j].p[u.id]; peakAt = j; } j++; }
          if (j - i >= minHours) ev.push({ unit: u.id, start: i, end: j - 1, peak, peakAt, hours: j - i, sev: peak >= THRESH.crit ? 'critical' : 'warning' });
          i = j + 1;
        } else i++;
      }
    }
    const merged = [];
    for (const e of ev) {
      const prev = merged.length && merged[merged.length - 1];
      if (prev && prev.unit === e.unit && e.start - prev.end <= 6) {
        prev.end = e.end; prev.hours = prev.end - prev.start + 1;
        if (e.peak > prev.peak) { prev.peak = e.peak; prev.peakAt = e.peakAt; }
        if (prev.peak >= THRESH.crit) prev.sev = 'critical';
      } else merged.push({ ...e });
    }
    return merged;
  }

  function expectedAt(t, feeds) {
    const HP = P.hourp || HOURP, DW = P.dow || DOW;
    const d = new Date(t), unit = P.arr * HP[d.getHours()] * DW[d.getDay()] * P.arrScale;
    let x = unit;
    for (const S of DISEASES) x += (rateAt(S.id, t) * ((feeds || {})[S.id] || 1) - SER[S.id].mean) * P.share * HP[d.getHours()] / 24;
    return x;
  }

  const api = {
    HOUR, DAY, MUMBAI, HOSPITALS, ISOLATION_RESERVE, UPCOMING, UNITS, WARDS, R, DISEASES, PATHOGENS, SYNDROMES, SYN_TO_PATHOGEN, LEVELS,
    DEFAULT_SETUP, ACTIONS, ACTION_BY_ID, OUTBREAKS, THRESH, HOLIDAYS, DIWALI,
    setupFor, configure, setStart, floorHour, dayStart, seasonRaw, dayOfYear, holidayOn, indianAQI, aqiBand, rainClass, floodFactor, feedFactors, expectedCases,
    defaultLevers, initialState, cloneState, step, simulate, ensemble, detectEvents, detectOutbreak, mulberry, cfgAt, expectedAt, rateAt, SER, NOT_MODELLED, CITY_BEDS, DATA, ensembleSummary, setDiseaseMonths, HOURP, DOW, DISDOW
  };
  Object.defineProperty(api, 'START', { get: () => START, enumerable: true });
  api.SEASONS = DISEASES;
  global.SW = api;
  configure(DEFAULT_SETUP);
})(typeof window !== 'undefined' ? window : self);
