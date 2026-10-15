/* Surge Watch — hospital flow model.
   Hour-by-hour simulation of patient flow through a hospital, with Indian seasonal illness patterns,
   stochastic (Monte Carlo) ensembles for uncertainty, and hooks for real data and live external feeds.
   Exposes window.SW. No dependencies. */
(function (global) {
  'use strict';

  const HOUR = 3600e3, DAY = 864e5;

  /* ---------------- hospital setup ---------------- */
  const DEFAULT_SETUP = {
    name: 'Meridian District Hospital', city: 'pune',
    edSpaces: 40, beds: { MED: 180, SURG: 90, ICU: 24, PEDS: 50 }, vents: 18,
    arrPerDay: 200,                       // ED arrivals on an average non-seasonal day
    nurses: [56, 76, 72],                 // night, day, evening shift
    docs: [3, 6, 5],                      // ED doctors per shift
    lab: { day: 95, night: 58 },          // tests / hour
    img: { day: 11, night: 5 },           // studies / hour
    plateletSupply: 22, plateletStock: 60 // units prepared / day, units in stock now
  };

  // City-specific seasonality. Peaks are day-of-year; amp is extra ED demand at the peak.
  const CITIES = {
    pune:      { name: 'Pune',      lat: 18.52, lon: 73.86, aqiAmp: 0.08, pm25: 48,  pm10: 95,  note: 'South-west monsoon Jun–Sep; dengue peaks Sep–Oct.' },
    mumbai:    { name: 'Mumbai',    lat: 19.08, lon: 72.88, aqiAmp: 0.09, pm25: 52,  pm10: 105, water: 205, lepto: true, note: 'Monsoon flooding drives leptospirosis and gastro in Jul–Aug.' },
    delhi:     { name: 'Delhi',     lat: 28.61, lon: 77.21, aqiAmp: 0.22, pm25: 110, pm10: 210, dengue: 285, note: 'Severe post-Diwali smog Nov–Dec; dengue peaks in October.' },
    lucknow:   { name: 'Lucknow',   lat: 26.85, lon: 80.95, aqiAmp: 0.18, pm25: 95,  pm10: 180, dengue: 288, note: 'Winter smog; dengue Sep–Nov.' },
    jaipur:    { name: 'Jaipur',    lat: 26.91, lon: 75.79, aqiAmp: 0.13, pm25: 75,  pm10: 160, heatAmp: 0.14, note: 'Strong heat season Apr–Jun.' },
    ahmedabad: { name: 'Ahmedabad', lat: 23.02, lon: 72.57, aqiAmp: 0.10, pm25: 65,  pm10: 140, heatAmp: 0.14, note: 'Heat season Apr–Jun; dengue Sep–Oct.' },
    kolkata:   { name: 'Kolkata',   lat: 22.57, lon: 88.36, aqiAmp: 0.13, pm25: 70,  pm10: 130, dengue: 295, note: 'Dengue peaks Oct–Nov; winter pollution.' },
    hyderabad: { name: 'Hyderabad', lat: 17.39, lon: 78.49, aqiAmp: 0.07, pm25: 45,  pm10: 95,  note: 'Dengue Aug–Oct; mild winter pollution.' },
    bengaluru: { name: 'Bengaluru', lat: 12.97, lon: 77.59, aqiAmp: 0.05, pm25: 35,  pm10: 75,  dengue: 250, note: 'Two rain seasons; dengue Jun–Sep.' },
    chennai:   { name: 'Chennai',   lat: 13.08, lon: 80.27, aqiAmp: 0.05, pm25: 35,  pm10: 70,  dengue: 320, water: 320, flu2: 320, note: 'North-east monsoon Oct–Dec: dengue, flooding and flu peak late in the year.' }
  };

  const UNITS = [
    { id: 'ED',    name: 'Emergency',   long: 'Emergency Department',                measure: 'ED spaces in use, incl. admitted patients waiting for a bed' },
    { id: 'MED',   name: 'Medicine',    long: 'Medicine wards',                      measure: 'Beds occupied or being cleaned, plus patients waiting for a bed' },
    { id: 'SURG',  name: 'Surgery',     long: 'Surgical wards',                      measure: 'Beds occupied or being cleaned, plus patients waiting for a bed' },
    { id: 'ICU',   name: 'ICU',         long: 'Intensive care',                      measure: 'Higher of bed load and ventilator load' },
    { id: 'PEDS',  name: 'Paediatrics', long: 'Paediatric wards',                    measure: 'Beds occupied or being cleaned, plus patients waiting for a bed' },
    { id: 'LAB',   name: 'Laboratory',  long: 'Laboratory turnaround',               measure: 'Expected turnaround vs 2.5 h target' },
    { id: 'IMG',   name: 'Imaging',     long: 'Imaging turnaround (X-ray, USG, CT)', measure: 'Expected turnaround vs 3 h target' },
    { id: 'NUR',   name: 'Nursing',     long: 'Nurse staffing cover',                measure: 'Nurses required vs nurses on shift' },
    { id: 'BLOOD', name: 'Blood bank',  long: 'Blood bank: platelets',               measure: '1.5 days of expected platelet use vs units in stock' }
  ];
  const WARDS = ['MED', 'SURG', 'ICU', 'PEDS'];

  // Clinical rates that do not depend on hospital size.
  const R = {
    route: { MED: 0.09, SURG: 0.04, ICU: 0.015, PEDS: 0.045 }, // share of ED arrivals admitted to each unit
    los: { MED: 4.5, SURG: 4.5, ICU: 3.4, PEDS: 3.0 },        // mean length of stay, days
    directMED: 0.024,                                          // direct admissions per ED arrival
    elective: 1.2, postOpICU: 0.035, icuToMed: 0.7,            // electives / h, weekday daytime
    edLOS: 2.6, docRate: 3.2, absence: 0.06,
    ratio: { ED: 4, MED: 6, SURG: 6, ICU: 2, PEDS: 5 }, nightRelax: 1.3,
    clean: [4, 2, 2.5],                                        // hours to turn a bed round: night, day, evening
    lab: { perArr: 2.2, perBedDay: 1.5, batch: 0.6, target: 2.5, proc: 0.8 },
    img: { perArr: 0.45, perBedDay: 0.05, target: 3, proc: 0.5 },
    ventPerIcuPt: 0.6,
    plt: { base: 0.3, perDengueAdm: 0.95, shelf: 5, cover: 1.5 } // units / h baseline, units per dengue admission, shelf life (days), days of cover wanted
  };

  let P = null, SEASONS = null;
  let START = floorHour(Date.now());
  function floorHour(t) { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); }
  function setStart(t) { START = floorHour(t); }

  const norm = (a, total) => { const s = a.reduce((x, y) => x + y, 0); return a.map(v => v * total / s); };
  const HOURP = norm([.55,.45,.4,.35,.35,.4,.55,.8,1.1,1.35,1.5,1.5,1.45,1.35,1.25,1.2,1.2,1.25,1.35,1.4,1.3,1.1,.9,.7], 24);
  const DOW = [0.9, 1.15, 1.05, 1.0, 0.98, 1.0, 0.92];
  const DISP = (() => { const a = new Array(24).fill(0); [.5,1,1.4,1.6,1.6,1.4,1.2,1,.8,.5,.3].forEach((v, i) => a[9 + i] = v); return norm(a, 24); })();
  const DISDOW = [0.45, 1.12, 1.12, 1.12, 1.12, 1.12, 0.6];

  const ymd = (y, m, d) => new Date(y, m - 1, d).getTime();
  const DIWALI = [ymd(2025, 10, 20), ymd(2026, 11, 8), ymd(2027, 10, 29)];
  // Public holidays: fewer discharges, no elective lists, some staff leave.
  const HOLIDAYS = [
    [ymd(2025, 10, 2), 'Gandhi Jayanti'], [ymd(2025, 10, 20), 'Diwali'], [ymd(2025, 12, 25), 'Christmas'],
    [ymd(2026, 1, 26), 'Republic Day'], [ymd(2026, 8, 15), 'Independence Day'], [ymd(2026, 10, 2), 'Gandhi Jayanti'],
    [ymd(2026, 10, 20), 'Dussehra'], [ymd(2026, 11, 8), 'Diwali'], [ymd(2026, 11, 24), 'Guru Nanak Jayanti'],
    [ymd(2026, 12, 25), 'Christmas'], [ymd(2027, 1, 26), 'Republic Day'], [ymd(2027, 8, 15), 'Independence Day'],
    [ymd(2027, 10, 2), 'Gandhi Jayanti'], [ymd(2027, 10, 29), 'Diwali'], [ymd(2027, 12, 25), 'Christmas']
  ];
  const HOLIDAY_MAP = new Map(HOLIDAYS.map(h => [h[0], h[1]]));
  function holidayOn(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return HOLIDAY_MAP.get(d.getTime()) || null; }

  function buildSeasons(city) {
    const c = CITIES[city] || CITIES.pune;
    return [
      { id: 'dengue', name: 'Dengue & vector-borne fever', window: 'after the monsoon',
        peaks: [{ doy: c.dengue || 278, sd: 28 }], amp: 0.24, route: { MED: 0.13, ICU: 0.022, PEDS: 0.05 }, lab: 4.5, img: 0.35, platelets: true,
        why: 'Aedes mosquitoes breed in standing water 2–5 weeks after rain; platelet monitoring drives repeat blood counts and transfusions.' },
      { id: 'flu', name: 'Influenza & respiratory viruses', window: 'winter and monsoon waves',
        peaks: [{ doy: 28, sd: 20, w: 1 }, { doy: c.flu2 || 222, sd: 22, w: 0.8 }], amp: 0.18, route: { MED: 0.14, ICU: 0.04, PEDS: 0.12 }, lab: 2.5, img: 0.7, staff: 0.05,
        why: 'India has a winter and a monsoon influenza wave; flu also raises staff sickness.' },
      { id: 'water', name: c.lepto ? 'Water-borne illness & leptospirosis' : 'Water-borne illness', window: 'monsoon flooding',
        peaks: [{ doy: c.water || 212, sd: 28 }], amp: c.lepto ? 0.18 : 0.15, route: { MED: 0.12, ICU: 0.02, PEDS: 0.2 }, lab: 3, img: 0.3,
        why: 'Gastroenteritis, typhoid, hepatitis A and leptospirosis after flooding and contaminated water.' },
      { id: 'heat', name: 'Heat illness', window: 'Apr – Jun',
        peaks: [{ doy: 128, sd: 16 }], amp: c.heatAmp || 0.10, route: { MED: 0.12, ICU: 0.03, PEDS: 0.05 }, lab: 2.5, img: 0.2,
        why: 'Heat exhaustion, heat stroke, dehydration and kidney injury when maximum temperatures pass about 40 °C.' },
      { id: 'aqi', name: 'Air pollution', window: 'Nov – Jan',
        peaks: [{ doy: 320, sd: 24 }], amp: c.aqiAmp, route: { MED: 0.16, ICU: 0.05, PEDS: 0.1 }, lab: 2, img: 0.8,
        why: 'Crop-residue burning, firecrackers and winter inversions; asthma, COPD and cardiac exacerbations rise with PM2.5.' },
      { id: 'diwali', name: 'Diwali burns & trauma', window: 'Diwali night ± 2 days',
        event: DIWALI, sdDays: 1.1, amp: 0.20, route: { SURG: 0.22, ICU: 0.06, PEDS: 0.08, MED: 0.02 }, lab: 2, img: 0.9,
        why: 'Firecracker burns, eye injuries and road accidents; staff leave peaks around the festival.' }
    ];
  }

  function configure(setup) {
    const u = setup || {};
    const s = Object.assign({}, DEFAULT_SETUP, u);
    s.beds = Object.assign({}, DEFAULT_SETUP.beds, u.beds);
    s.lab = Object.assign({}, DEFAULT_SETUP.lab, u.lab);
    s.img = Object.assign({}, DEFAULT_SETUP.img, u.img);
    if (!CITIES[s.city]) s.city = 'pune';
    SEASONS = buildSeasons(s.city);
    P = { setup: s, edSpaces: s.edSpaces, beds: s.beds, vents: s.vents, arr: s.arrPerDay / 24, arrScale: 1,
      nurses: s.nurses, docs: s.docs, lab: Object.assign({}, R.lab, s.lab), img: Object.assign({}, R.img, s.img),
      pltSupply: s.plateletSupply / 12, pltStock: s.plateletStock, sizeK: s.arrPerDay / 200 };
    api.P = P; api.SEASONS = SEASONS; api.CITY = CITIES[s.city]; api.SETUP = s;
    return P;
  }

  function dayOfYear(t) { const d = new Date(t); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / DAY); }
  function seasonRaw(s, t) {
    if (s.event) {
      let v = 0;
      for (const e of s.event) { const dd = (t - e) / DAY - 0.5; v = Math.max(v, Math.exp(-dd * dd / (2 * s.sdDays * s.sdDays))); }
      return v;
    }
    const doy = dayOfYear(t); let v = 0;
    for (const p of s.peaks) { let dd = Math.abs(doy - p.doy); dd = Math.min(dd, 365 - dd); v += (p.w || 1) * Math.exp(-dd * dd / (2 * p.sd * p.sd)); }
    return v;
  }
  const nearDiwali = (t, days) => DIWALI.some(e => Math.abs((t - e) / DAY) <= days);

  /* ---------------- external signals ---------------- */
  // Indian National AQI (CPCB breakpoints) from 24-h PM2.5 and PM10 concentrations.
  function subIndex(c, bp) { for (const [lo, hi, ilo, ihi] of bp) if (c <= hi) return ilo + (ihi - ilo) * (c - lo) / (hi - lo); return 500; }
  const BP25 = [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 500, 400, 500]];
  const BP10 = [[0, 50, 0, 50], [50, 100, 50, 100], [100, 250, 100, 200], [250, 350, 200, 300], [350, 430, 300, 400], [430, 600, 400, 500]];
  function indianAQI(pm25, pm10) { return Math.round(Math.max(subIndex(pm25, BP25), pm10 != null ? subIndex(pm10, BP10) : 0)); }
  function aqiBand(a) { return a <= 50 ? 'Good' : a <= 100 ? 'Satisfactory' : a <= 200 ? 'Moderate' : a <= 300 ? 'Poor' : a <= 400 ? 'Very poor' : 'Severe'; }

  // Turn raw readings into multipliers on the seasonal curves.
  function feedFactors(v) {
    const rainF = 0.75 + 0.25 * Math.min(2.2, (v.rainLag || 0) / 50); // rain 2–5 weeks ago → breeding sites
    return {
      dengue: (v.dengueCases / v.dengueAvg) * rainF, rainF,
      aqi: Math.max(0.3, Math.min(3, v.aqi / 150)),
      flu: v.ili,
      heat: Math.max(0.2, Math.min(2.2, 0.4 + ((v.tmax == null ? 32 : v.tmax) - 34) / 5))
    };
  }

  /* ---------------- scenarios & actions ---------------- */
  function defaultLevers() {
    return { arrivalPct: 0, seasonScale: 1, outbreak: 'none', nurseShortPct: 0, docShortPct: 0,
      medBedsClosed: 0, ventsDown: 0, labDownPct: 0, imgDownPct: 0, plateletCutPct: 0, startHour: 0 };
  }

  const ACTIONS = [
    { id: 'surgebeds', title: 'Open 12 surge beds in Medicine', units: ['MED', 'ED'], lead: 24, owner: 'Nursing Superintendent',
      detail: 'Convert the day-care bay into 12 inpatient beds. Needs 24 h to staff and equip.', apply: c => { c.medExtra += 12; } },
    { id: 'weekenddc', title: 'Run a weekend and holiday discharge team', units: ['MED', 'SURG', 'PEDS', 'ED'], lead: 0, owner: 'Medical Superintendent',
      detail: 'A consultant, pharmacist and discharge nurse on Sat/Sun and public holidays lift discharges to about 70% of a weekday.', apply: c => { c.weekendDc = true; } },
    { id: 'noondc', title: 'Discharge-before-noon drive', units: ['MED', 'SURG', 'PEDS', 'ED'], lead: 12, owner: 'Ward consultants',
      detail: 'Board rounds at 08:30; discharge summaries and take-home medicines prepared the evening before.', apply: c => { c.dcBoost *= 1.12; } },
    { id: 'housekeep', title: 'Add housekeeping on evenings and nights', units: ['MED', 'SURG', 'PEDS', 'ICU', 'ED'], lead: 8, owner: 'Facilities Manager',
      detail: 'Turn discharged beds round in about 1.5 h at any hour instead of waiting for the morning shift.', apply: c => { c.cleanFast = true; } },
    { id: 'floatnurse', title: 'Call in 6 float nurses per shift', units: ['NUR', 'ICU'], lead: 8, owner: 'Nursing Superintendent',
      detail: 'Use the float pool and agency roster to add 6 nurses to each shift.', apply: c => { c.floatNurses += 6; } },
    { id: 'labshift', title: 'Extend lab staffing and run a 2nd haematology analyser', units: ['LAB', 'ED'], lead: 6, owner: 'Lab Director',
      detail: 'Adds about 30% lab throughput; prioritise CBC and platelet counts for fever patients.', apply: c => { c.labBoost *= 1.3; } },
    { id: 'phlebo', title: 'Stagger morning ward blood draws', units: ['LAB'], lead: 12, owner: 'Lab Director',
      detail: 'Spread routine inpatient samples across 05:00–14:00 instead of a 05:00–09:00 batch.', apply: c => { c.labBatch = 0.3; } },
    { id: 'fasttrack', title: 'Open a fever fast-track clinic beside the ED', units: ['ED', 'LAB'], lead: 12, owner: 'Head of Emergency',
      detail: 'Triage stable fever and dengue-suspect patients to an OPD-style clinic; diverts about 30% of seasonal ED load.', apply: c => { c.fastTrack = 0.3; } },
    { id: 'defer', title: 'Defer non-urgent elective surgery', units: ['SURG', 'ICU', 'NUR'], lead: 24, owner: 'Head of Surgery',
      detail: 'Postpone half of planned non-urgent cases for the forecast window; frees surgical and post-op ICU beds.', apply: c => { c.electiveDefer = 0.5; } },
    { id: 'icustep', title: 'Convert 4 step-down beds to ICU', units: ['ICU'], lead: 12, owner: 'Head of Critical Care',
      detail: 'Upgrade 4 HDU beds with monitors and 2 transport ventilators.', apply: c => { c.icuExtra += 4; c.ventExtra += 2; } },
    { id: 'imgeve', title: 'Add an evening imaging session', units: ['IMG', 'ED'], lead: 24, owner: 'Head of Radiology',
      detail: 'Keep USG and CT staffed until 22:00; adds about 40% evening capacity.', apply: c => { c.imgEve = 1.4; } },
    { id: 'donorcamp', title: 'Hold platelet donation camps', units: ['BLOOD'], lead: 48, owner: 'Blood Bank Officer',
      detail: 'Apheresis and whole-blood camps with colleges and NGOs; adds about 15 platelet units a day after 48 h.', apply: c => { c.pltExtra += 15 / 12; } },
    { id: 'plttransfer', title: 'Request platelets from the regional blood bank', units: ['BLOOD'], lead: 12, owner: 'Blood Bank Officer',
      detail: 'One-off transfer of 40 units through the state blood transfusion council network.', apply: (c, k, lead) => { if (k === lead) c.pltBolus += 40; } }
  ];
  const ACTION_BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a]));

  const OUTBREAKS = {
    none:   { label: 'None' },
    dengue: { label: 'Dengue outbreak (cases ×1.5)' },
    flu:    { label: 'Early influenza wave' },
    gastro: { label: 'Cholera / gastro cluster' },
    mci:    { label: 'Mass-casualty incident (35 patients)' }
  };

  function cfgAt(run, k) {
    const L = run.levers, on = k >= (L.startHour || 0);
    const c = {
      arrMult: on ? 1 + L.arrivalPct / 100 : 1, seasonScale: on ? L.seasonScale : 1, outbreak: on ? L.outbreak : 'none',
      nurseShort: on ? L.nurseShortPct / 100 : 0, docShort: on ? L.docShortPct / 100 : 0,
      medClosed: on ? L.medBedsClosed : 0, ventsDown: on ? L.ventsDown : 0,
      labDown: on ? L.labDownPct / 100 : 0, imgDown: on ? L.imgDownPct / 100 : 0, pltCut: on ? (L.plateletCutPct || 0) / 100 : 0,
      medExtra: 0, icuExtra: 0, ventExtra: 0, weekendDc: false, dcBoost: 1, floatNurses: 0, cleanFast: false,
      labBoost: 1, labBatch: R.lab.batch, fastTrack: 0, electiveDefer: 0, imgEve: 1, pltExtra: 0, pltBolus: 0
    };
    for (const a of run.actions) if (k >= a.lead) ACTION_BY_ID[a.id].apply(c, k, a.lead);
    return c;
  }

  /* ---------------- state ---------------- */
  function initialState() {
    const k = P.sizeK;
    return { ed: 22 * k, bd: { MED: 1, SURG: 0, ICU: 0, PEDS: 0 },
      occ: { MED: P.beds.MED * 0.88, SURG: P.beds.SURG * 0.8, ICU: P.beds.ICU * 0.8, PEDS: P.beds.PEDS * 0.66 },
      dirty: { MED: 2, SURG: 1, ICU: 0, PEDS: 1 }, icuStep: 0, otQ: 0, labQ: 30 * k, imgQ: 5 * k,
      plt: P.pltStock, pltAvg: R.plt.base * k, pltShort: 0, cancelled: 0 };
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
  // Correlated uncertainty: one multiplier per run on seasonal illness, one demand shock per calendar day.
  function shocks(run, t) {
    if (!run.rand || run.noShock) return [1, 1];
    if (!run._sh) run._sh = { season: Math.exp(0.16 * gauss(run.rand) - 0.0128), days: {} };
    const d = Math.floor(t / DAY);
    if (run._sh.days[d] == null) run._sh.days[d] = Math.exp(0.07 * gauss(run.rand) - 0.00245);
    return [run._sh.season, run._sh.days[d]];
  }

  /* ---------------- one simulated hour ---------------- */
  function step(s, k, absHour, run) {
    const t = START + absHour * HOUR, d = new Date(t), h = d.getHours(), dow = d.getDay();
    const c = cfgAt(run, k), F = run.flags || {}, rnd = run.rand;
    const hol = F.noHoliday ? null : holidayOn(t);
    const dowF = F.flatDow ? 1 : DOW[dow];
    const sh = h >= 7 && h < 15 ? 1 : (h >= 15 && h < 23 ? 2 : 0);
    const [seasonShock, dayShock] = shocks(run, t);
    const m = c.arrMult * (run.nowcast || 1) * (run.band || 1) * dayShock * P.arrScale;
    const unit = P.arr * HOURP[h] * dowF;
    let base = unit * m;
    const expectedBase = unit * c.arrMult * P.arrScale;

    let seasonArr = 0, expectedSeason = 0, staffAbs = 0;
    const seasonBy = {}, fe = run.feeds || {}, parts = [];
    for (const S of SEASONS) {
      if (run.off && run.off[S.id]) { seasonBy[S.id] = 0; continue; }
      let I = seasonRaw(S, t) * c.seasonScale * (fe[S.id] || 1) * (run.seasonBand || 1);
      if (c.outbreak === 'dengue' && S.id === 'dengue') I = I * 1.5 + 0.1;
      if (c.outbreak === 'flu' && S.id === 'flu') I += 0.9;
      if (c.outbreak === 'gastro' && S.id === 'water') I += 1.1;
      expectedSeason += unit * S.amp * I * c.arrMult * P.arrScale / (run.seasonBand || 1);
      const x = unit * S.amp * I * seasonShock * m;
      parts.push([S, x]); seasonArr += x;
      if (S.staff && !F.noLeave) staffAbs += S.staff * Math.min(1, I);
    }
    // Stochastic runs draw a Poisson number of arrivals and split them by cause.
    if (rnd) { const lam = base + seasonArr, n = poisson(lam, rnd), f = lam > 0 ? n / lam : 0; base *= f; seasonArr *= f; for (const p of parts) p[1] *= f; }
    const adm = { MED: base * R.route.MED + P.arr * R.directMED * P.arrScale, SURG: base * R.route.SURG, ICU: base * R.route.ICU, PEDS: base * R.route.PEDS };
    let labD = base * P.lab.perArr, imgD = base * P.img.perArr, dengueAdm = 0;
    for (const [S, x] of parts) {
      seasonBy[S.id] = x;
      for (const u in S.route) adm[u] += x * S.route[u];
      labD += x * S.lab; imgD += x * S.img;
      if (S.platelets) dengueAdm += x * (S.route.MED + S.route.ICU + S.route.PEDS);
    }
    let mci = 0;
    if (c.outbreak === 'mci' && k === (run.levers.startHour || 0)) { mci = 35; adm.SURG += 9; adm.ICU += 4; adm.MED += 3; labD += 140; imgD += 52; }
    if (rnd) for (const u of WARDS) adm[u] = poisson(adm[u], rnd);
    const arrivals = base + seasonArr + mci;

    // Laboratory: backlog beyond ~8 h of capacity is sent to an external reference lab
    const wardPts = WARDS.reduce((a, u) => a + s.occ[u], 0);
    const batch = F.noBatch ? 4 / 24 : c.labBatch;
    const batchHours = batch < R.lab.batch && !F.noBatch ? 9 : 4;
    const inBatch = h >= 5 && h < 5 + batchHours;
    labD += wardPts * R.lab.perBedDay * (inBatch ? batch / batchHours : (1 - batch) / (24 - batchHours));
    const labCap = (h >= 8 && h < 20 ? P.lab.day : P.lab.night) * (1 - c.labDown) * c.labBoost;
    s.labQ += labD; s.labQ -= Math.min(s.labQ, labCap); s.labQ = Math.min(s.labQ, labCap * 8);
    const labTAT = s.labQ / Math.max(1, labCap) + R.lab.proc;

    // Imaging
    imgD += wardPts * R.img.perBedDay / 24;
    const imgCap = (h >= 8 && h < 20 ? P.img.day : P.img.night) * (1 - c.imgDown) * (h >= 16 && h < 22 ? c.imgEve : 1);
    s.imgQ += imgD; s.imgQ -= Math.min(s.imgQ, imgCap); s.imgQ = Math.min(s.imgQ, Math.max(imgCap, 1) * 12);
    const imgTAT = imgCap > 0.05 ? s.imgQ / imgCap + R.img.proc : 12;

    // Emergency department, with ambulance diversion when far over capacity
    const slow = F.noLabSlow ? 1 : (1 + Math.max(0, labTAT - 1.5) * 0.18) * (1 + Math.max(0, Math.min(imgTAT, 12) - 2) * 0.08);
    const edLOS = R.edLOS * slow;
    const docs = P.docs[sh] * (1 - c.docShort);
    const preBoard = s.bd.MED + s.bd.SURG + s.bd.ICU + s.bd.PEDS;
    const divert = (s.ed + preBoard) / P.edSpaces > 1.5 ? 0.5 : 0;
    if (divert) for (const u of WARDS) adm[u] *= 1 - divert;
    const edIn = (base + seasonArr * (1 - c.fastTrack) + mci) * (1 - divert);
    s.ed += edIn;
    s.ed -= Math.min(s.ed / edLOS, docs * R.docRate);
    for (const u of WARDS) s.bd[u] += adm[u];

    // Discharges (fewer at weekends and on public holidays); each freed bed then needs cleaning
    const offDay = dow === 0 || dow === 6 || !!hol;
    const dd = hol && dow >= 1 && dow <= 5 ? 0.6 : DISDOW[dow];
    const dF = DISP[h] * (offDay && F.noWeekendDip ? 0.95 : offDay && c.weekendDc ? Math.max(dd, 0.72) : dd) * c.dcBoost;
    const disOf = (u, x) => rnd ? Math.min(s.occ[u], poisson(x, rnd)) : x;
    for (const u of ['MED', 'SURG', 'PEDS']) { const x = disOf(u, s.occ[u] / (R.los[u] * 24) * dF); s.occ[u] -= x; s.dirty[u] += x; }
    const icuDis = disOf('ICU', s.occ.ICU / (R.los.ICU * 24) * (0.5 + 0.5 * dF));
    s.occ.ICU -= icuDis * (1 - R.icuToMed); s.dirty.ICU += icuDis * (1 - R.icuToMed);
    s.icuStep += icuDis * R.icuToMed; // waits in an ICU bed for a Medicine bed
    const cleanH = F.noCleaning ? 0.2 : c.cleanFast ? 1.5 : R.clean[sh];
    for (const u of WARDS) s.dirty[u] -= s.dirty[u] * Math.min(1, 1 / cleanH);

    // Bed allocation
    const cap = { MED: P.beds.MED - c.medClosed + c.medExtra, SURG: P.beds.SURG, ICU: P.beds.ICU + c.icuExtra, PEDS: P.beds.PEDS };
    const freeOf = u => Math.max(0, cap[u] - s.occ[u] - s.dirty[u]);
    let free = freeOf('MED');
    let a = Math.min(s.icuStep, free); s.occ.MED += a; s.icuStep -= a; s.occ.ICU -= a; s.dirty.ICU += a; free -= a;
    a = Math.min(s.bd.MED, free); s.occ.MED += a; s.bd.MED -= a;
    free = freeOf('SURG');
    a = Math.min(s.bd.SURG, free); s.occ.SURG += a; s.bd.SURG -= a; free -= a;
    let cancelled = 0;
    if (dow >= 1 && dow <= 5 && !hol && h >= 8 && h < 18) {
      const el = R.elective * P.sizeK * (1 - c.electiveDefer);
      const got = Math.min(el, free); s.occ.SURG += got; cancelled = el - got;
      s.otQ += got * R.postOpICU;
    }
    s.cancelled += cancelled;
    free = freeOf('ICU');
    a = Math.min(s.bd.ICU, free); s.occ.ICU += a; s.bd.ICU -= a; free -= a;
    a = Math.min(s.otQ, free); s.occ.ICU += a; s.otQ -= a;
    free = freeOf('PEDS');
    a = Math.min(s.bd.PEDS, free); s.occ.PEDS += a; s.bd.PEDS -= a;

    // Blood bank: platelets are prepared in the day, expire after 5 days, and are used mostly in severe dengue
    const pltDemand = R.plt.base * P.sizeK + dengueAdm * R.plt.perDengueAdm;
    const supply = (h >= 8 && h < 20 ? P.pltSupply * (1 - c.pltCut) + c.pltExtra : 0) + c.pltBolus;
    s.plt += supply; s.plt -= s.plt / (R.plt.shelf * 24);
    const used = Math.min(s.plt, pltDemand); s.plt -= used; s.pltShort += pltDemand - used;
    s.pltAvg = s.pltAvg * 0.96 + pltDemand * 0.04;

    // Pressures
    const boardTotal = s.bd.MED + s.bd.SURG + s.bd.ICU + s.bd.PEDS;
    const vents = P.vents - c.ventsDown + c.ventExtra;
    const icuBed = (s.occ.ICU + s.dirty.ICU + s.bd.ICU + s.otQ) / cap.ICU;
    const icuVent = s.occ.ICU * R.ventPerIcuPt / Math.max(1, vents);
    let req = (s.ed + boardTotal - s.bd.ICU) / R.ratio.ED + s.bd.ICU / R.ratio.ICU;
    for (const u of WARDS) req += s.occ[u] / R.ratio[u];
    if (sh === 0) req /= R.nightRelax;
    const leave = F.noLeave ? 0 : nearDiwali(t, 2) ? 0.06 : hol ? 0.04 : 0;
    const avail = P.nurses[sh] * (1 - R.absence - staffAbs - leave) * (1 - c.nurseShort) + c.floatNurses;

    const p = {
      ED: (s.ed + boardTotal) / P.edSpaces,
      MED: (s.occ.MED + s.dirty.MED + s.bd.MED) / cap.MED,
      SURG: (s.occ.SURG + s.dirty.SURG + s.bd.SURG) / cap.SURG,
      ICU: Math.max(icuBed, icuVent),
      PEDS: (s.occ.PEDS + s.dirty.PEDS + s.bd.PEDS) / cap.PEDS,
      LAB: labTAT / R.lab.target,
      IMG: Math.min(imgTAT, 12) / R.img.target,
      NUR: req / avail,
      BLOOD: Math.min(5, (s.pltAvg * 24 * R.plt.cover) / Math.max(1, s.plt))
    };
    if (run.lite) return { p };
    return {
      t, k: absHour, p, arrivals, expected: expectedBase + expectedSeason, seasonArr, seasonBy, edIn, edLOS, labTAT, imgTAT: Math.min(imgTAT, 12),
      boarders: boardTotal, diverted: divert ? (base + seasonArr + mci) * divert : 0, icuStepWait: s.icuStep, cancelled,
      nurseReq: req, nurseAvail: avail, labDemand: labD, plt: s.plt, pltDemand, pltShort: pltDemand - used, holiday: hol,
      occ: { ...s.occ }, dirty: { ...s.dirty }, cap, ventsUsed: s.occ.ICU * R.ventPerIcuPt, vents, edCensus: s.ed
    };
  }

  function simulate(s0, t0, hours, run) {
    const s = cloneState(s0), out = [];
    for (let k = 0; k < hours; k++) out.push(step(s, k, t0 + k, run));
    return out;
  }

  // Monte Carlo ensemble: P10 / P50 / P90 per hour, plus breach probabilities across runs.
  function ensemble(s0, t0, hours, run, n, seed) {
    const ids = UNITS.map(u => u.id), runs = [];
    for (let i = 0; i < n; i++) runs.push(simulate(s0, t0, hours, Object.assign({}, run, { rand: mulberry(seed + i * 7919), lite: true, _sh: null })));
    const q = { p10: [], p50: [], p90: [], n };
    const col = new Float64Array(n);
    for (let k = 0; k < hours; k++) {
      const a = {}, b = {}, c = {};
      for (const id of ids) {
        for (let i = 0; i < n; i++) col[i] = runs[i][k].p[id];
        col.sort();
        a[id] = col[Math.floor(0.1 * (n - 1))]; b[id] = col[Math.round(0.5 * (n - 1))]; c[id] = col[Math.ceil(0.9 * (n - 1))];
      }
      q.p10.push({ p: a }); q.p50.push({ p: b }); q.p90.push({ p: c });
    }
    q.prob = (id, from, to, thr) => {
      let hit = 0;
      for (const ser of runs) for (let k = Math.max(0, from); k <= Math.min(hours - 1, to); k++) if (ser[k].p[id] >= thr) { hit++; break; }
      return hit / n;
    };
    return q;
  }

  // Expected ED arrivals in the hour starting at t (no scenario, no randomness).
  function expectedAt(t, feeds) {
    const d = new Date(t), unit = P.arr * HOURP[d.getHours()] * DOW[d.getDay()] * P.arrScale;
    let x = unit;
    for (const S of SEASONS) x += unit * S.amp * seasonRaw(S, t) * ((feeds || {})[S.id] || 1);
    return x;
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

  const api = {
    HOUR, DAY, UNITS, WARDS, R, CITIES, DEFAULT_SETUP, ACTIONS, ACTION_BY_ID, OUTBREAKS, THRESH, HOLIDAYS, DIWALI,
    configure, setStart, floorHour, seasonRaw, dayOfYear, holidayOn, indianAQI, aqiBand, feedFactors,
    defaultLevers, initialState, cloneState, step, simulate, ensemble, detectEvents, mulberry, cfgAt, expectedAt
  };
  Object.defineProperty(api, 'START', { get: () => START, enumerable: true });
  global.SW = api;
  configure(DEFAULT_SETUP);
})(window);
