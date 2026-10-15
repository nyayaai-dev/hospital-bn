/* Surge Watch — hospital flow model.
   Hour-by-hour simulation of a fictional 344-bed district hospital (all data synthetic).
   Exposes window.SW with: constants, simulate(), detectEvents(), seasonal helpers. */
(function (global) {
  'use strict';

  const HOUR = 3600e3;
  const START = new Date(2026, 9, 15, 8, 0, 0).getTime(); // Thu 15 Oct 2026, 08:00
  const HISTORY_HOURS = 48;

  const UNITS = [
    { id: 'ED',   name: 'Emergency',   long: 'Emergency Department',              measure: 'ED spaces in use, incl. admitted patients waiting for a bed' },
    { id: 'MED',  name: 'Medicine',    long: 'Medicine wards',                    measure: 'Beds occupied + patients waiting for a bed' },
    { id: 'SURG', name: 'Surgery',     long: 'Surgical wards',                    measure: 'Beds occupied + patients waiting for a bed' },
    { id: 'ICU',  name: 'ICU',         long: 'Intensive care',                    measure: 'Higher of bed load and ventilator load' },
    { id: 'PEDS', name: 'Paediatrics', long: 'Paediatric wards',                  measure: 'Beds occupied + patients waiting for a bed' },
    { id: 'LAB',  name: 'Laboratory',  long: 'Laboratory turnaround',             measure: 'Expected turnaround vs 2.5 h target' },
    { id: 'IMG',  name: 'Imaging',     long: 'Imaging turnaround (X-ray, USG, CT)', measure: 'Expected turnaround vs 3 h target' },
    { id: 'NUR',  name: 'Nursing',     long: 'Nurse staffing cover',              measure: 'Nurses required vs nurses on shift' }
  ];
  const WARDS = ['MED', 'SURG', 'ICU', 'PEDS'];

  const P = {
    edSpaces: 40,
    beds: { MED: 180, SURG: 90, ICU: 24, PEDS: 50 },
    vents: 18, ventPerIcuPt: 0.6,
    arr: 8.4,                                   // mean ED arrivals / hour
    route: { MED: 0.09, SURG: 0.04, ICU: 0.015, PEDS: 0.045 },
    los: { MED: 4.6, SURG: 4.5, ICU: 3.5, PEDS: 3.0 }, // days
    directMED: 0.2, elective: 1.2, postOpICU: 0.035, icuToMed: 0.7,
    edLOS: 2.6, docs: [3, 6, 5], docRate: 3.2, // [night, day, evening]
    nurses: [56, 76, 72], absence: 0.06,
    ratio: { ED: 4, MED: 6, SURG: 6, ICU: 2, PEDS: 5 }, nightRelax: 1.3,
    lab: { day: 95, night: 58, perArr: 2.2, perBedDay: 1.5, batch: 0.6, target: 2.5, proc: 0.8 },
    img: { day: 11, night: 5, perArr: 0.45, perBedDay: 0.05, target: 3, proc: 0.5 }
  };

  const norm = (a, total) => { const s = a.reduce((x, y) => x + y, 0); return a.map(v => v * total / s); };
  const HOURP = norm([.55,.45,.4,.35,.35,.4,.55,.8,1.1,1.35,1.5,1.5,1.45,1.35,1.25,1.2,1.2,1.25,1.35,1.4,1.3,1.1,.9,.7], 24);
  const DOW = [0.9, 1.15, 1.05, 1.0, 0.98, 1.0, 0.92];            // Sun..Sat arrivals
  const DISP = (() => { const a = new Array(24).fill(0); [.5,1,1.4,1.6,1.6,1.4,1.2,1,.8,.5,.3].forEach((v, i) => a[9 + i] = v); return norm(a, 24); })();
  const DISDOW = [0.45, 1.12, 1.12, 1.12, 1.12, 1.12, 0.6];        // Sun..Sat discharges

  const DIWALI = [new Date(2025, 9, 20).getTime(), new Date(2026, 10, 8).getTime(), new Date(2027, 9, 29).getTime()];

  const SEASONS = [
    { id: 'dengue', name: 'Dengue & vector-borne fever', short: 'Dengue', window: 'Sep – Nov, after the monsoon',
      peaks: [{ doy: 280, sd: 28 }], amp: 0.24, route: { MED: 0.15, ICU: 0.025, PEDS: 0.06 }, lab: 4.5, img: 0.35,
      why: 'Aedes breeding in post-monsoon standing water; platelet monitoring drives repeat blood counts.' },
    { id: 'flu', name: 'Influenza & respiratory viruses', short: 'Influenza', window: 'Jan – Feb and Jul – Sep',
      peaks: [{ doy: 28, sd: 20, w: 1 }, { doy: 222, sd: 22, w: 0.8 }], amp: 0.18, route: { MED: 0.14, ICU: 0.04, PEDS: 0.12 }, lab: 2.5, img: 0.7, staff: 0.05,
      why: 'Two seasonal waves in India (winter and monsoon); also raises staff sickness.' },
    { id: 'water', name: 'Water-borne illness', short: 'Water-borne', window: 'Jul – Sep, monsoon',
      peaks: [{ doy: 212, sd: 28 }], amp: 0.15, route: { MED: 0.12, ICU: 0.015, PEDS: 0.2 }, lab: 3, img: 0.3,
      why: 'Gastroenteritis, typhoid, hepatitis A and leptospirosis after flooding.' },
    { id: 'heat', name: 'Heat illness', short: 'Heat', window: 'Apr – Jun',
      peaks: [{ doy: 128, sd: 16 }], amp: 0.10, route: { MED: 0.12, ICU: 0.03, PEDS: 0.05 }, lab: 2.5, img: 0.2,
      why: 'Heat exhaustion and stroke, dehydration-related kidney injury.' },
    { id: 'aqi', name: 'Air pollution (post-Diwali smog)', short: 'Air quality', window: 'late Oct – Dec',
      peaks: [{ doy: 318, sd: 20 }], amp: 0.14, route: { MED: 0.16, ICU: 0.05, PEDS: 0.1 }, lab: 2, img: 0.8,
      why: 'Crop-residue burning, firecrackers and winter inversion push AQI into the severe band; asthma and COPD exacerbations.' },
    { id: 'diwali', name: 'Diwali burns & trauma', short: 'Diwali', window: 'Diwali night ± 2 days',
      event: DIWALI, sdDays: 1.1, amp: 0.20, route: { SURG: 0.22, ICU: 0.06, PEDS: 0.08, MED: 0.02 }, lab: 2, img: 0.9,
      why: 'Firecracker burns, eye injuries and road traffic trauma; staff leave peaks around the festival.' }
  ];

  function dayOfYear(t) { const d = new Date(t); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); }

  // Seasonal intensity 0..~1 for a timestamp, before feeds / scenario scaling.
  function seasonRaw(s, t) {
    if (s.event) {
      let v = 0;
      for (const e of s.event) { const dd = (t - e) / 864e5 - 0.5; v = Math.max(v, Math.exp(-dd * dd / (2 * s.sdDays * s.sdDays))); }
      return v;
    }
    const doy = dayOfYear(t); let v = 0;
    for (const p of s.peaks) { let dd = Math.abs(doy - p.doy); dd = Math.min(dd, 365 - dd); v += (p.w || 1) * Math.exp(-dd * dd / (2 * p.sd * p.sd)); }
    return v;
  }
  function nearDiwali(t, days) { return DIWALI.some(e => Math.abs((t - e) / 864e5) <= days); }

  /* ---------- scenario / plan configuration ---------- */
  function defaultLevers() {
    return { arrivalPct: 0, seasonScale: 1, outbreak: 'none', nurseShortPct: 0, docShortPct: 0,
      medBedsClosed: 0, ventsDown: 0, labDownPct: 0, imgDownPct: 0, startHour: 0 };
  }

  // Preventive actions. `apply` mutates the hourly config once active (after lead time).
  const ACTIONS = [
    { id: 'surgebeds', title: 'Open 12 surge beds in Medicine', units: ['MED', 'ED'], lead: 24, owner: 'Nursing Superintendent',
      detail: 'Convert the day-care bay on Ward 4 into 12 inpatient beds. Needs 24 h to staff and equip.',
      apply: c => { c.medExtra += 12; } },
    { id: 'weekenddc', title: 'Run a weekend discharge team', units: ['MED', 'SURG', 'PEDS', 'ED'], lead: 0, owner: 'Medical Superintendent',
      detail: 'One consultant, one pharmacist and a discharge nurse on Sat/Sun so weekend discharges run near weekday levels.',
      apply: c => { c.weekendDc = true; } },
    { id: 'noondc', title: 'Discharge-before-noon drive', units: ['MED', 'SURG', 'PEDS', 'ED'], lead: 12, owner: 'Ward consultants',
      detail: 'Board rounds at 08:30, discharge summaries and medicines prepared the evening before. Frees beds earlier in the day.',
      apply: c => { c.dcBoost *= 1.12; } },
    { id: 'floatnurse', title: 'Call in 6 float nurses per shift', units: ['NUR', 'ICU'], lead: 8, owner: 'Nursing Superintendent',
      detail: 'Use the float pool and agency roster to add 6 nurses to each shift.',
      apply: c => { c.floatNurses += 6; } },
    { id: 'labshift', title: 'Extend lab staffing and run 2nd haematology analyser', units: ['LAB', 'ED'], lead: 6, owner: 'Lab Director',
      detail: 'Adds about 30% lab throughput; prioritise CBC / platelet counts for fever patients.',
      apply: c => { c.labBoost *= 1.3; } },
    { id: 'phlebo', title: 'Stagger morning ward blood draws', units: ['LAB'], lead: 12, owner: 'Lab Director',
      detail: 'Spread routine inpatient samples across 06:00–14:00 instead of a 06:00–09:00 batch.',
      apply: c => { c.labBatch = 0.3; } },
    { id: 'fasttrack', title: 'Open a fever fast-track clinic beside the ED', units: ['ED', 'LAB'], lead: 12, owner: 'Head of Emergency',
      detail: 'Triage stable fever / dengue-suspect patients to an OPD-style clinic. Diverts about 30% of seasonal ED load.',
      apply: c => { c.fastTrack = 0.3; } },
    { id: 'defer', title: 'Defer non-urgent elective surgery', units: ['SURG', 'ICU', 'NUR'], lead: 24, owner: 'Head of Surgery',
      detail: 'Postpone half of planned non-urgent cases for the forecast window; frees surgical beds and post-op ICU beds.',
      apply: c => { c.electiveDefer = 0.5; } },
    { id: 'icustep', title: 'Convert 4 step-down beds to ICU', units: ['ICU'], lead: 12, owner: 'Head of Critical Care',
      detail: 'Upgrade 4 HDU beds with monitors and 2 transport ventilators.',
      apply: c => { c.icuExtra += 4; c.ventExtra += 2; } },
    { id: 'imgeve', title: 'Add an evening imaging session', units: ['IMG', 'ED'], lead: 24, owner: 'Head of Radiology',
      detail: 'Keep USG and CT staffed until 22:00. Adds about 40% evening capacity.',
      apply: c => { c.imgEve = 1.4; } }
  ];
  const ACTION_BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a]));

  const OUTBREAKS = {
    none:   { label: 'None' },
    dengue: { label: 'Dengue outbreak (cases ×1.5)' },
    flu:    { label: 'Early influenza wave' },
    gastro: { label: 'Cholera / gastro cluster' },
    mci:    { label: 'Mass-casualty incident (35 patients)' }
  };

  // Effective configuration at forecast hour k (0 = now).
  function cfgAt(run, k) {
    const L = run.levers, on = k >= (L.startHour || 0);
    const c = {
      arrMult: on ? 1 + L.arrivalPct / 100 : 1, seasonScale: on ? L.seasonScale : 1, outbreak: on ? L.outbreak : 'none',
      nurseShort: on ? L.nurseShortPct / 100 : 0, docShort: on ? L.docShortPct / 100 : 0,
      medClosed: on ? L.medBedsClosed : 0, ventsDown: on ? L.ventsDown : 0,
      labDown: on ? L.labDownPct / 100 : 0, imgDown: on ? L.imgDownPct / 100 : 0,
      medExtra: 0, icuExtra: 0, ventExtra: 0, weekendDc: false, dcBoost: 1, floatNurses: 0,
      labBoost: 1, labBatch: P.lab.batch, fastTrack: 0, electiveDefer: 0, imgEve: 1
    };
    for (const a of run.actions) if (k >= a.lead) ACTION_BY_ID[a.id].apply(c);
    return c;
  }

  function initialState() {
    // State 48 h before "now"; history is simulated forward from here.
    return { ed: 22, bd: { MED: 1, SURG: 0, ICU: 0, PEDS: 0 }, occ: { MED: 162, SURG: 72, ICU: 20, PEDS: 33 },
      icuStep: 0, otQ: 0, labQ: 30, imgQ: 5, cancelled: 0 };
  }
  const cloneState = s => ({ ...s, bd: { ...s.bd }, occ: { ...s.occ } });

  // One simulated hour. Mutates s, returns hourly metrics.
  function step(s, k, absHour, run) {
    const t = START + absHour * HOUR, d = new Date(t), h = d.getHours(), dow = d.getDay();
    const c = cfgAt(run, k), F = run.flags || {};
    const dowF = F.flatDow ? 1 : DOW[dow];
    const sh = h >= 7 && h < 15 ? 1 : (h >= 15 && h < 23 ? 2 : 0);
    const noise = run.rand ? Math.max(0.4, 1 + 0.2 * gauss(run.rand)) : 1;
    const m = c.arrMult * (run.nowcast || 1) * (run.band || 1) * noise;
    const base = P.arr * HOURP[h] * dowF * m;
    const expectedBase = P.arr * HOURP[h] * dowF * c.arrMult;

    const adm = { MED: base * P.route.MED + P.directMED, SURG: base * P.route.SURG, ICU: base * P.route.ICU, PEDS: base * P.route.PEDS };
    let seasonArr = 0, labD = base * P.lab.perArr, imgD = base * P.img.perArr, staffAbs = 0, expectedSeason = 0;
    const seasonBy = {};
    for (const S of SEASONS) {
      if (run.off && run.off[S.id]) { seasonBy[S.id] = 0; continue; }
      let I = seasonRaw(S, t) * c.seasonScale * ((run.feeds && run.feeds[S.id]) || 1) * (run.seasonBand || 1);
      if (c.outbreak === 'dengue' && S.id === 'dengue') I = I * 1.5 + 0.1;
      if (c.outbreak === 'flu' && S.id === 'flu') I += 0.9;
      if (c.outbreak === 'gastro' && S.id === 'water') I += 1.1;
      const x = P.arr * HOURP[h] * dowF * S.amp * I * m;
      expectedSeason += x / (run.nowcast || 1) / (run.band || 1) / noise;
      seasonBy[S.id] = x; seasonArr += x;
      for (const u in S.route) adm[u] += x * S.route[u];
      labD += x * S.lab; imgD += x * S.img;
      if (S.staff && !F.noLeave) staffAbs += S.staff * Math.min(1, I);
    }
    let mci = 0;
    if (c.outbreak === 'mci' && k === (run.levers.startHour || 0) + 0) {
      mci = 35; adm.SURG += 9; adm.ICU += 4; adm.MED += 3; labD += 35 * 4; imgD += 35 * 1.5;
    }
    const arrivals = base + seasonArr + mci;

    // Laboratory
    const wardPts = WARDS.reduce((a, u) => a + s.occ[u], 0);
    const batch = F.noBatch ? 4 / 24 : c.labBatch;
    const batchHours = batch < P.lab.batch && !F.noBatch ? 9 : 4, batchStart = 5;
    const inBatch = h >= batchStart && h < batchStart + batchHours;
    labD += wardPts * P.lab.perBedDay * (inBatch ? batch / batchHours : (1 - batch) / (24 - batchHours));
    const labCap = (h >= 8 && h < 20 ? P.lab.day : P.lab.night) * (1 - c.labDown) * c.labBoost;
    s.labQ += labD; s.labQ -= Math.min(s.labQ, labCap);
    // Backlog beyond ~8 h of capacity is sent to an external reference lab.
    s.labQ = Math.min(s.labQ, labCap * 8);
    const labTAT = s.labQ / Math.max(1, labCap) + P.lab.proc;

    // Imaging
    imgD += wardPts * P.img.perBedDay / 24;
    const imgCap = (h >= 8 && h < 20 ? P.img.day : P.img.night) * (1 - c.imgDown) * (h >= 16 && h < 22 ? c.imgEve : 1);
    s.imgQ += imgD; s.imgQ -= Math.min(s.imgQ, imgCap);
    const imgTAT = imgCap > 0.05 ? s.imgQ / imgCap + P.img.proc : 12;

    // Emergency department
    const slow = F.noLabSlow ? 1 : (1 + Math.max(0, labTAT - 1.5) * 0.18) * (1 + Math.max(0, Math.min(imgTAT, 12) - 2) * 0.08);
    const edLOS = P.edLOS * slow;
    const docs = P.docs[sh] * (1 - c.docShort);
    // Ambulance diversion: when the ED is far over capacity, half of new arrivals go elsewhere.
    const preBoard = s.bd.MED + s.bd.SURG + s.bd.ICU + s.bd.PEDS;
    const divert = (s.ed + preBoard) / P.edSpaces > 1.5 ? 0.5 : 0;
    if (divert) for (const u of WARDS) adm[u] *= 1 - divert;
    const edIn = (base + seasonArr * (1 - c.fastTrack) + mci) * (1 - divert);
    s.ed += edIn;
    s.ed -= Math.min(s.ed / edLOS, docs * P.docRate);
    for (const u of WARDS) s.bd[u] += adm[u];

    // Discharges
    const weekend = dow === 0 || dow === 6;
    const dF = DISP[h] * (weekend && F.noWeekendDip ? 0.95 : weekend && c.weekendDc ? Math.max(DISDOW[dow], 0.72) : DISDOW[dow]) * c.dcBoost;
    for (const u of ['MED', 'SURG', 'PEDS']) s.occ[u] -= s.occ[u] / (P.los[u] * 24) * dF;
    const icuDis = s.occ.ICU / (P.los.ICU * 24) * (0.5 + 0.5 * dF);
    s.occ.ICU -= icuDis * (1 - P.icuToMed);
    s.icuStep += icuDis * P.icuToMed; // waits in an ICU bed for a Medicine bed

    // Bed allocation
    const cap = { MED: P.beds.MED - c.medClosed + c.medExtra, SURG: P.beds.SURG, ICU: P.beds.ICU + c.icuExtra, PEDS: P.beds.PEDS };
    let free = Math.max(0, cap.MED - s.occ.MED);
    let a = Math.min(s.icuStep, free); s.occ.MED += a; s.icuStep -= a; s.occ.ICU -= a; free -= a;
    a = Math.min(s.bd.MED, free); s.occ.MED += a; s.bd.MED -= a;
    free = Math.max(0, cap.SURG - s.occ.SURG);
    a = Math.min(s.bd.SURG, free); s.occ.SURG += a; s.bd.SURG -= a; free -= a;
    let cancelled = 0;
    if (dow >= 1 && dow <= 5 && h >= 8 && h < 18) {
      const el = P.elective * (1 - c.electiveDefer);
      const got = Math.min(el, free); s.occ.SURG += got; cancelled = el - got;
      s.otQ += got * P.postOpICU;
    }
    s.cancelled += cancelled;
    free = Math.max(0, cap.ICU - s.occ.ICU);
    a = Math.min(s.bd.ICU, free); s.occ.ICU += a; s.bd.ICU -= a; free -= a;
    a = Math.min(s.otQ, free); s.occ.ICU += a; s.otQ -= a;
    free = Math.max(0, cap.PEDS - s.occ.PEDS);
    a = Math.min(s.bd.PEDS, free); s.occ.PEDS += a; s.bd.PEDS -= a;

    // Pressures
    const boardTotal = s.bd.MED + s.bd.SURG + s.bd.ICU + s.bd.PEDS;
    const vents = P.vents - c.ventsDown + c.ventExtra;
    const icuBed = (s.occ.ICU + s.bd.ICU + s.otQ) / cap.ICU;
    const icuVent = s.occ.ICU * P.ventPerIcuPt / Math.max(1, vents);
    let req = (s.ed + boardTotal - s.bd.ICU) / P.ratio.ED + s.bd.ICU / P.ratio.ICU;
    for (const u of WARDS) req += s.occ[u] / P.ratio[u];
    if (sh === 0) req /= P.nightRelax;
    const leave = !F.noLeave && nearDiwali(t, 2) ? 0.06 : 0;
    const avail = P.nurses[sh] * (1 - P.absence - staffAbs - leave) * (1 - c.nurseShort) + c.floatNurses;

    return {
      t, k,
      p: {
        ED: (s.ed + boardTotal) / P.edSpaces,
        MED: (s.occ.MED + s.bd.MED) / cap.MED,
        SURG: (s.occ.SURG + s.bd.SURG) / cap.SURG,
        ICU: Math.max(icuBed, icuVent),
        PEDS: (s.occ.PEDS + s.bd.PEDS) / cap.PEDS,
        LAB: labTAT / P.lab.target,
        IMG: Math.min(imgTAT, 12) / P.img.target,
        NUR: req / avail
      },
      arrivals, expected: expectedBase + expectedSeason, seasonArr, seasonBy, edIn, edLOS, labTAT, imgTAT: Math.min(imgTAT, 12),
      boarders: boardTotal, diverted: divert ? (base + seasonArr + mci) * divert : 0, icuStepWait: s.icuStep, cancelled, nurseReq: req, nurseAvail: avail, labDemand: labD,
      occ: { ...s.occ }, cap, ventsUsed: s.occ.ICU * P.ventPerIcuPt, vents
    };
  }

  function gauss(rand) { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // Forecast `hours` ahead from state s0 at absolute hour t0. run: {levers, actions, feeds, nowcast, band, seasonBand, off}
  function simulate(s0, t0, hours, run) {
    const s = cloneState(s0), out = [];
    for (let k = 0; k < hours; k++) out.push(step(s, k, t0 + k, run));
    return out;
  }

  // Find bottleneck episodes per unit. Warning >= 95%, critical >= 105% at peak.
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
    // merge episodes of the same unit separated by < 6 h
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

  global.SW = { HOUR, START, HISTORY_HOURS, UNITS, WARDS, P, SEASONS, ACTIONS, ACTION_BY_ID, OUTBREAKS, THRESH,
    seasonRaw, dayOfYear, defaultLevers, initialState, cloneState, step, simulate, detectEvents, mulberry, cfgAt };
})(window);
