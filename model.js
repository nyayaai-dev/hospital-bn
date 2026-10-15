/* Surge Watch — Mumbai hospital flow model.
   Hour-by-hour simulation of patient flow through a Mumbai hospital: Mumbai's seasonal infections,
   beds, isolation, oxygen, ambulances, laboratory, X-ray, CT/ultrasound, nursing and platelets.
   Includes Monte Carlo ensembles, syndromic outbreak detection and epidemic growth.
   Exposes window.SW. No dependencies. */
(function (global) {
  'use strict';

  const HOUR = 3600e3, DAY = 864e5;
  const MUMBAI = { name: 'Mumbai', lat: 19.08, lon: 72.88 };

  /* ---------------- Mumbai hospitals (bed counts from public sources; coordinates approximate) ---------------- */
  const HOSPITALS = [
    { id: 'kem', name: 'KEM Hospital', area: 'Parel', zone: 'Central Mumbai', type: 'BMC', beds: 2250, lat: 19.0026, lon: 72.8420, src: 'KEM Medical Records annual statistical report 2021–23 (2,250 scheduled beds)' },
    { id: 'jj', name: 'Sir J J Hospital', area: 'Byculla', zone: 'South Mumbai', type: 'State', beds: 2844, lat: 18.9627, lon: 72.8337, src: 'Hospital profile, Govt of Maharashtra (2,844 beds)' },
    { id: 'nair', name: 'B Y L Nair Hospital', area: 'Mumbai Central', zone: 'South Mumbai', type: 'BMC', beds: 1800, lat: 18.9719, lon: 72.8227, src: 'Hospital listings (~1,800); an older survey gives 1,200' },
    { id: 'sion', name: 'LTMG (Sion) Hospital', area: 'Sion', zone: 'Central Mumbai', type: 'BMC', beds: 1400, lat: 19.0368, lon: 72.8597, src: 'National Herald profile ("more than 1,400 beds")' },
    { id: 'cooper', name: 'Dr R N Cooper Hospital', area: 'Juhu / Vile Parle', zone: 'Western suburbs', type: 'BMC', beds: 636, lat: 19.1069, lon: 72.8360, src: 'Hospital listing (636); other sources range 500–1,462' },
    { id: 'kokilaben', name: 'Kokilaben Dhirubhai Ambani Hospital', area: 'Andheri West', zone: 'Western suburbs', type: 'Private', beds: 750, lat: 19.1309, lon: 72.8253, src: 'Hospital profiles ("750-bed")' },
    { id: 'hinduja', name: 'P D Hinduja Hospital', area: 'Mahim', zone: 'Central Mumbai', type: 'Private', beds: 520, lat: 19.0335, lon: 72.8388, src: 'Two units, about 520 beds combined (sources vary)' },
    { id: 'bombay', name: 'Bombay Hospital', area: 'Marine Lines', zone: 'South Mumbai', type: 'Private', beds: 500, icu: 110, lat: 18.9415, lon: 72.8270, src: 'Hospital website and Wikipedia (500 beds, 110 critical care)' },
    { id: 'jaslok', name: 'Jaslok Hospital', area: 'Pedder Road', zone: 'South Mumbai', type: 'Private', beds: 350, icu: 75, lat: 18.9718, lon: 72.8094, src: 'Hospital profile (350 beds, 75 ICU)' },
    { id: 'nanavati', name: 'Nanavati Max Hospital', area: 'Vile Parle West', zone: 'Western suburbs', type: 'Private', beds: 350, lat: 19.0963, lon: 72.8400, src: '2022 expansion announcement (existing 350 beds)' },
    { id: 'lilavati', name: 'Lilavati Hospital', area: 'Bandra West', zone: 'Western suburbs', type: 'Private', beds: 300, lat: 19.0510, lon: 72.8288, src: 'Hospital listings ("over 300 beds")' },
    { id: 'fortis', name: 'Fortis Hospital', area: 'Mulund', zone: 'Eastern suburbs', type: 'Private', beds: 261, lat: 19.1612, lon: 72.9408, src: 'Business directory listing (261 beds)' },
    { id: 'breach', name: 'Breach Candy Hospital', area: 'Breach Candy', zone: 'South Mumbai', type: 'Private', beds: 220, lat: 18.9705, lon: 72.8045, src: 'Wikipedia ("over 220 beds")' }
  ];
  const ISOLATION_RESERVE = [
    { name: 'Kasturba Hospital for Infectious Diseases, Chinchpokli', beds: 78, note: 'BMC infectious-disease hospital: 78 isolation beds reported in March 2020, plus a 10-bed Ebola isolation ward set up in 2026.' }
  ];
  const UPCOMING = { beds: 1120, note: 'Siddharth (306), Shatabdi (324) and Harilal Bhagwati (490) BMC hospitals, reported as more than 85% complete.' };

  // Derive a full setup from a hospital's bed count. Shares are typical values, not published figures.
  function setupFor(h) {
    const pub = h.type !== 'Private', b = h.beds;
    const icu = h.icu || Math.round(b * (pub ? 0.06 : 0.09));
    const arr = Math.round(b * (pub ? 0.46 : 0.30));
    const nDay = Math.round(b * (pub ? 0.2 : 0.21));
    const docDay = Math.max(3, Math.ceil(arr / 24 * 1.5 / 3.2 * 1.5));
    return {
      hospitalId: h.id, name: h.name + ', ' + h.area, type: h.type,
      edSpaces: Math.max(10, Math.round(b * (pub ? 0.06 : 0.05))),
      beds: { MED: Math.round(b * 0.40), SURG: Math.round(b * 0.26), ICU: icu, PEDS: Math.round(b * (pub ? 0.11 : 0.09)), ISO: Math.max(4, Math.round(b * 0.015)) },
      vents: Math.round(icu * 0.75), arrPerDay: arr,
      nurses: [Math.round(nDay * 0.74), nDay, Math.round(nDay * 0.92)], docs: [Math.ceil(docDay / 2), docDay, Math.ceil(docDay * 0.85)],
      lab: { day: Math.round(arr * 0.3 + b * 0.12), night: Math.round((arr * 0.3 + b * 0.12) * 0.6) }, xray: { day: Math.max(3, Math.round(arr * 0.034)), night: Math.max(2, Math.round(arr * 0.018)) },
      img: { day: Math.max(2, Math.round(arr * 0.02)), night: Math.max(1, Math.round(arr * 0.008)) },
      plateletSupply: Math.round(arr * 0.11), plateletStock: Math.round(arr * 0.3),
      o2Capacity: Math.round(b * 2.4), o2Delivery: Math.round(b * 0.22), ambulances: Math.max(3, Math.round(arr / 25)),
      elective: pub ? 1 : 2.4, icuReferral: pub ? 0 : Math.round(icu * 0.16), startOcc: pub ? 0.96 : 0.82
    };
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
    route: { MED: 0.09, SURG: 0.04, ICU: 0.015, PEDS: 0.045, ISO: 0.002 },
    los: { MED: 4.5, SURG: 4.5, ICU: 3.4, PEDS: 3.0, ISO: 6.0 },
    directMED: 0.024, elective: 1.2, postOpICU: 0.035, icuToMed: 0.7,
    edLOS: 2.6, docRate: 3.2, absence: 0.06,
    ratio: { ED: 4, MED: 6, SURG: 6, ICU: 2, PEDS: 5, ISO: 3 }, nightRelax: 1.3,
    clean: [4, 2, 2.5],
    lab: { perArr: 2.2, perBedDay: 1.5, batch: 0.6, target: 2.5, proc: 0.8 },
    xray: { perArr: 0.30, perBedDay: 0.06, target: 1.5, proc: 0.5 },
    img: { perArr: 0.15, perBedDay: 0.02, target: 3, proc: 0.5 },
    ventPerIcuPt: 0.6,
    plt: { base: 0.3, perDengueAdm: 0.95, shelf: 5, cover: 1.5 },
    // Oxygen in D-type cylinder equivalents (~7 m³). A ward patient on 5 L/min uses about 1 a day; ICU about 2.5.
    o2: { ward: { MED: 0.10, SURG: 0.04, PEDS: 0.05, ISO: 0.3 }, icu: 0.8, perWardPt: 1, perIcuPt: 2.5, decayDays: 5, cover: 3 },
    amb: { share: 0.16, epiShare: 0.25, trip: 1.5 },
    bg: { fever: 0.10, resp: 0.14, gi: 0.07, trauma: 0.22 } // background share of ordinary ED arrivals by syndrome
  };

  /* ---------------- Mumbai seasonal infections ---------------- */
  // Peaks are day of year. amp = extra ED demand at peak (share of a normal day). route = share of those patients admitted to each unit.
  const DISEASES = [
    { id: 'malaria', name: 'Malaria', syn: 'fever', months: 'Jun – Oct', peaks: [{ doy: 215, sd: 38 }], amp: 0.16,
      route: { MED: 0.10, ICU: 0.012, PEDS: 0.03 }, lab: 3, xray: 0.05, img: 0.1, o2: 0.05, needs: ['Lab (smear, RDT)', 'Medicine beds'],
      mumbai: '1,380 cases in July 2026; 4,825 Jan–mid-Aug 2025 (BMC)', why: 'Anopheles breed in construction sites, water tanks and waterlogged areas during the monsoon.' },
    { id: 'dengue', name: 'Dengue', syn: 'fever', months: 'Aug – Nov', peaks: [{ doy: 265, sd: 30 }], amp: 0.22, platelets: true,
      route: { MED: 0.13, ICU: 0.022, PEDS: 0.05 }, lab: 4.5, xray: 0.05, img: 0.3, o2: 0.05, needs: ['Platelets', 'Lab (NS1, CBC)', 'Ultrasound', 'Medicine beds'],
      mumbai: '466 cases in July 2026; 1,564 Jan–mid-Aug 2025 (BMC)', why: 'Aedes breed in clean stored water 2–5 weeks after rain; platelet monitoring drives repeat blood counts and transfusions.' },
    { id: 'lepto', name: 'Leptospirosis', syn: 'fever', months: 'Jul – Aug, 1–2 weeks after flooding', peaks: [{ doy: 205, sd: 20 }], amp: 0.05, rainDriven: true,
      route: { MED: 0.42, ICU: 0.12 }, lab: 4, xray: 0.5, img: 0.1, o2: 0.3, needs: ['ICU', 'Dialysis', 'Oxygen', 'X-ray'],
      mumbai: '78 cases in July 2026 (BMC); highest share of confirmed deaths in 2025', why: 'Wading through flood water contaminated by rat urine; causes kidney failure and lung bleeding, so a high share needs ICU.' },
    { id: 'chik', name: 'Chikungunya', syn: 'fever', months: 'Aug – Oct', peaks: [{ doy: 250, sd: 30 }], amp: 0.04,
      route: { MED: 0.05 }, lab: 2, xray: 0.05, img: 0, o2: 0, needs: ['Mostly outpatient'],
      mumbai: 'Up 56% Jan–Aug 2025 (BMC)', why: 'Same Aedes mosquito as dengue; severe joint pain, rarely needs admission.' },
    { id: 'gastro', name: 'Gastroenteritis & cholera', syn: 'gi', months: 'Jun – Sep', peaks: [{ doy: 190, sd: 35 }], amp: 0.14,
      route: { MED: 0.08, ICU: 0.005, PEDS: 0.18 }, lab: 2, xray: 0.02, img: 0.05, o2: 0, needs: ['Paediatric beds', 'IV fluids'],
      mumbai: '851 cases in July 2026; 5,510 Jan–mid-Aug 2025 (BMC)', why: 'Contaminated water and street food during heavy rain and pipeline leaks.' },
    { id: 'hep', name: 'Hepatitis A/E & typhoid', syn: 'gi', months: 'Jul – Oct', peaks: [{ doy: 220, sd: 40 }], amp: 0.06,
      route: { MED: 0.2, PEDS: 0.08, ICU: 0.01 }, lab: 3, xray: 0.02, img: 0.3, o2: 0, needs: ['Medicine beds', 'Ultrasound', 'Lab'],
      mumbai: 'Hepatitis up 16% Jan–Aug 2025 (BMC)', why: 'Faecal contamination of drinking water; hepatitis E is dangerous in pregnancy.' },
    { id: 'flu', name: 'Influenza (H1N1 / H3N2)', syn: 'resp', months: 'Jul – Sep, smaller Jan – Feb wave', peaks: [{ doy: 210, sd: 25, w: 1 }, { doy: 25, sd: 20, w: 0.6 }], amp: 0.16, staff: 0.05,
      route: { MED: 0.14, ICU: 0.05, PEDS: 0.10, ISO: 0.03 }, lab: 2.5, xray: 0.7, img: 0.05, o2: 0.35, needs: ['Isolation', 'Oxygen', 'ICU', 'X-ray'],
      mumbai: '105 H1N1 cases in July 2026 (BMC)', why: 'Mumbai\'s main flu wave comes with the monsoon; it also raises staff sickness.' },
    { id: 'aqi', name: 'Pollution-related respiratory illness', syn: 'resp', months: 'Nov – Feb', peaks: [{ doy: 5, sd: 40 }], amp: 0.09,
      route: { MED: 0.16, ICU: 0.05, PEDS: 0.10 }, lab: 2, xray: 0.8, img: 0.05, o2: 0.3, needs: ['Oxygen', 'X-ray', 'Medicine beds'],
      mumbai: 'Winter AQI often "Poor" with construction dust and weak sea breeze', why: 'Asthma, COPD and cardiac exacerbations rise with PM2.5 and PM10.' },
    { id: 'heat', name: 'Heat & humidity illness', syn: 'trauma', months: 'Apr – May', peaks: [{ doy: 125, sd: 18 }], amp: 0.05,
      route: { MED: 0.12, ICU: 0.03, PEDS: 0.05 }, lab: 2.5, xray: 0.1, img: 0.05, o2: 0.05, needs: ['Medicine beds'],
      mumbai: 'Humid heat before the monsoon', why: 'Heat exhaustion, dehydration and kidney injury in outdoor workers.' },
    { id: 'injury', name: 'Monsoon injuries', syn: 'trauma', months: 'Jun – Sep', peaks: [{ doy: 200, sd: 35 }], amp: 0.06,
      route: { SURG: 0.25, ICU: 0.04 }, lab: 1.5, xray: 1.2, img: 0.4, o2: 0.02, needs: ['X-ray', 'CT', 'Surgical beds', 'Ambulances'],
      mumbai: 'Falls, wall and building collapses, and road accidents in heavy rain', why: 'Slippery roads, waterlogging and dilapidated buildings.' },
    { id: 'diwali', name: 'Diwali burns & trauma', syn: 'trauma', months: 'Diwali ± 2 days', event: true, sdDays: 1.1, amp: 0.20,
      route: { SURG: 0.22, ICU: 0.06, PEDS: 0.08, MED: 0.02 }, lab: 2, xray: 0.9, img: 0.3, o2: 0.05, needs: ['Burns beds', 'ICU', 'X-ray'],
      mumbai: 'Firecracker burns and eye injuries', why: 'Burns, eye injuries and road accidents; staff leave peaks around the festival.' }
  ];

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
    P = { setup: s, edSpaces: s.edSpaces, beds: s.beds, vents: s.vents, arr: s.arrPerDay / 24, arrScale: 1,
      nurses: s.nurses, docs: s.docs,
      lab: Object.assign({}, R.lab, s.lab), xray: Object.assign({}, R.xray, s.xray), img: Object.assign({}, R.img, s.img),
      pltSupply: s.plateletSupply / 12, pltStock: s.plateletStock, o2Cap: s.o2Capacity, o2Delivery: s.o2Delivery / 24,
      amb: s.ambulances, startOcc: s.startOcc || 0.88, elective: s.elective || 1, icuRef: (s.icuReferral || 0) / 24, sizeK: s.arrPerDay / 200 };
    api.P = P; api.SETUP = s;
    return P;
  }

  function dayOfYear(t) { const d = new Date(t); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / DAY); }
  function seasonRaw(s, t) {
    if (s.event) {
      let v = 0;
      for (const e of DIWALI) { const dd = (t - e) / DAY - 0.5; v = Math.max(v, Math.exp(-dd * dd / (2 * s.sdDays * s.sdDays))); }
      return v;
    }
    const doy = dayOfYear(t); let v = 0;
    for (const p of s.peaks) { let dd = Math.abs(doy - p.doy); dd = Math.min(dd, 365 - dd); v += (p.w || 1) * Math.exp(-dd * dd / (2 * p.sd * p.sd)); }
    return v;
  }
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

  // v: raw readings. v.rainDays: { dayStartMs: mm } from the weather feed (past and forecast).
  function feedFactors(v) {
    const rainF = 0.75 + 0.25 * Math.min(2.2, (v.rainLag || 0) / 50);
    return {
      dengue: (v.dengueCases / v.dengueAvg) * rainF,
      malaria: (v.malariaCases / v.malariaAvg) * (0.8 + 0.2 * Math.min(2, (v.rainLag || 0) / 50)),
      chik: rainF, rainF, aqi: Math.max(0.3, Math.min(3, v.aqi / 150)), flu: v.ili,
      heat: Math.max(0.2, Math.min(2.2, 0.4 + ((v.tmax == null ? 32 : v.tmax) - 33) / 4)),
      rainDays: v.rainDays || {}
    };
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
      occ: { MED: P.beds.MED * o, SURG: P.beds.SURG * (o - 0.08), ICU: P.beds.ICU * (o - 0.08), PEDS: P.beds.PEDS * (o - 0.22), ISO: P.beds.ISO * 0.3 },
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
    const hol = F.noHoliday ? null : holidayOn(t);
    const dowF = F.flatDow ? 1 : DOW[dow];
    const sh = h >= 7 && h < 15 ? 1 : (h >= 15 && h < 23 ? 2 : 0);
    const [seasonShock, dayShock, epiShock] = shocks(run, t);
    const m = c.arrMult * (run.nowcast || 1) * (run.band || 1) * dayShock * P.arrScale;
    const unit = P.arr * HOURP[h] * dowF;
    let base = unit * m;
    const expectedBase = unit * c.arrMult * P.arrScale;

    // Rain and flooding: today's rain slows ambulances; heavy rain 7–14 days ago drives leptospirosis.
    let rainToday = rainOn(fe, t), leptoF = 1, floodExtra = 0;
    if (c.floodH != null && c.floodH >= 0) {
      if (c.floodH < 36) rainToday = Math.max(rainToday, 260);
      if (c.floodH >= 24 && c.floodH < 288) floodExtra = 1;
      if (c.floodH >= 150 && c.floodH < 360) leptoF += 3.5 * Math.exp(-Math.pow((c.floodH - 250) / 70, 2));
    }
    if (fe.rainDays) for (let j = 7; j <= 14; j++) leptoF += Math.max(0, rainOn(fe, t - j * DAY) - 64.5) / 120;

    let seasonArr = 0, staffAbs = 0;
    const seasonBy = {}, parts = [], syn = { fever: 0, resp: 0, gi: 0, trauma: 0 }, synExp = { fever: 0, resp: 0, gi: 0, trauma: 0 };
    for (const S of DISEASES) {
      if (run.off && run.off[S.id]) { seasonBy[S.id] = 0; continue; }
      let I = seasonRaw(S, t) * c.seasonScale * (fe[S.id] || 1) * (run.seasonBand || 1);
      if (S.rainDriven) I *= leptoF;
      if (S.id === 'gastro' && floodExtra) I += 0.8;
      if (S.id === 'injury' && c.floodH != null && c.floodH >= 0 && c.floodH < 48) I += 2;
      if (c.outbreak === 'dengue' && S.id === 'dengue') I = I * 1.5 + 0.1;
      if (c.outbreak === 'flu' && S.id === 'flu') I += 0.9;
      if (c.outbreak === 'gastro' && S.id === 'gastro') I += 1.1;
      synExp[S.syn] += unit * S.amp * I * c.arrMult * P.arrScale / (run.seasonBand || 1);
      const x = unit * S.amp * I * seasonShock * m;
      parts.push([S, x]); seasonArr += x;
      if (S.staff && !F.noLeave) staffAbs += S.staff * Math.min(1, I);
    }
    // Epidemic: an outbreak drill in the observed world, or a detected outbreak carried into the forecast.
    let epiX = 0, epiP = null;
    const ep = F.noEpi ? null : run.epi;
    if (ep && absHour >= ep.t0) {
      epiP = PATHOGENS[ep.pathogen];
      epiX = Math.min(ep.cap * P.sizeK, ep.a0 * P.sizeK * Math.exp(ep.r * epiShock * (absHour - ep.t0))) * HOURP[h] * (run.band || 1) * dayShock;
      if (epiP.staff && !F.noLeave) staffAbs += epiP.staff * Math.min(1, epiX / Math.max(1, P.arr));
    }
    if (rnd) {
      const lam = base + seasonArr + epiX, n = poisson(lam, rnd), f = lam > 0 ? n / lam : 0;
      base *= f; seasonArr *= f; epiX *= f; for (const p of parts) p[1] *= f;
    }
    const adm = { MED: base * R.route.MED + P.arr * R.directMED * P.arrScale, SURG: base * R.route.SURG, ICU: base * R.route.ICU + P.icuRef, PEDS: base * R.route.PEDS, ISO: base * R.route.ISO };
    let labD = base * P.lab.perArr, xrayD = base * P.xray.perArr, imgD = base * P.img.perArr, dengueAdm = 0, o2New = 0;
    for (const sy in R.bg) { syn[sy] += base * R.bg[sy]; synExp[sy] += expectedBase * R.bg[sy]; }
    for (const [S, x] of parts) {
      seasonBy[S.id] = x; syn[S.syn] += x;
      let admitted = 0;
      for (const u in S.route) { adm[u] += x * S.route[u]; admitted += x * S.route[u]; }
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
    const edLOS = R.edLOS * slow;
    const docs = P.docs[sh] * (1 - c.docShort);
    const preBoard = WARDS.reduce((a, u) => a + s.bd[u], 0);
    const divert = (s.ed + preBoard) / P.edSpaces > 1.5 ? 0.5 : 0;
    if (divert) for (const u of WARDS) adm[u] *= 1 - divert;
    const edIn = (base + seasonArr * (1 - c.fastTrack) + epiX * (1 - c.jumbo) + mci) * (1 - divert);
    s.ed += edIn;
    s.ed -= Math.min(s.ed / edLOS, docs * R.docRate);
    for (const u of WARDS) s.bd[u] += adm[u];

    // Ambulances: trips scale with arrivals; Mumbai traffic and flooding lengthen each trip.
    const tripH = R.amb.trip * TRAFFIC(h) * floodFactor(rainToday);
    const trips = (base + seasonArr) * R.amb.share + epiX * R.amb.epiShare + mci * 0.6 + (divert ? edIn * 0.2 : 0);
    s.amb += rnd ? poisson(trips, rnd) : trips;
    s.amb -= s.amb / tripH;
    const fleet = Math.max(1, (P.amb + c.ambExtra) * (1 - c.ambDown));

    // Discharges (fewer at weekends and on public holidays); each freed bed then needs cleaning
    const offDay = dow === 0 || dow === 6 || !!hol;
    const dd = hol && dow >= 1 && dow <= 5 ? 0.6 : DISDOW[dow];
    const dF = DISP[h] * (offDay && F.noWeekendDip ? 0.95 : offDay && c.weekendDc ? Math.max(dd, 0.72) : dd) * c.dcBoost;
    const disOf = (u, x) => rnd ? Math.min(s.occ[u], poisson(x, rnd)) : x;
    for (const u of ['MED', 'SURG', 'PEDS', 'ISO']) { const x = disOf(u, s.occ[u] / (R.los[u] * 24) * dF); s.occ[u] -= x; s.dirty[u] += x; }
    const icuDis = disOf('ICU', s.occ.ICU / (R.los.ICU * 24) * (0.5 + 0.5 * dF));
    s.occ.ICU -= icuDis * (1 - R.icuToMed); s.dirty.ICU += icuDis * (1 - R.icuToMed);
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
    let cancelled = 0;
    if (dow >= 1 && dow <= 5 && !hol && h >= 8 && h < 18) {
      const el = R.elective * P.sizeK * P.elective * (1 - c.electiveDefer);
      const got = Math.min(el, free); s.occ.SURG += got; cancelled = el - got;
      s.otQ += got * R.postOpICU;
    }
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
      t, k: absHour, p, arrivals, expected: expectedBase * (1 - bgSum) + Object.values(synExp).reduce((x, y) => x + y, 0),
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
    const d = new Date(t), unit = P.arr * HOURP[d.getHours()] * DOW[d.getDay()] * P.arrScale;
    let x = unit;
    for (const S of DISEASES) x += unit * S.amp * seasonRaw(S, t) * ((feeds || {})[S.id] || 1);
    return x;
  }

  const api = {
    HOUR, DAY, MUMBAI, HOSPITALS, ISOLATION_RESERVE, UPCOMING, UNITS, WARDS, R, DISEASES, PATHOGENS, SYNDROMES, SYN_TO_PATHOGEN, LEVELS,
    DEFAULT_SETUP, ACTIONS, ACTION_BY_ID, OUTBREAKS, THRESH, HOLIDAYS, DIWALI,
    setupFor, configure, setStart, floorHour, dayStart, seasonRaw, dayOfYear, holidayOn, indianAQI, aqiBand, rainClass, floodFactor, feedFactors,
    defaultLevers, initialState, cloneState, step, simulate, ensemble, detectEvents, detectOutbreak, mulberry, cfgAt, expectedAt
  };
  Object.defineProperty(api, 'START', { get: () => START, enumerable: true });
  api.SEASONS = DISEASES;
  global.SW = api;
  configure(DEFAULT_SETUP);
})(window);
