/* Surge Watch — sourced facts.
   Every figure here comes from a public document or report, with its source and date.
   kind: 'P' = published figure, 'D' = derived arithmetically from published figures (formula in note),
         'X' = projection beyond the last published data point (rule in note).
   Nothing in this file is a guess. Values the model needs but that are not published are listed in
   UNPUBLISHED and must be entered by the hospital. */
(function (global) {
  'use strict';

  const SOURCES = {
    kemMRD: { title: 'KEM Hospital, Medical Record Dept — Annual statistical report 2021, 2022 & 2023', url: 'https://kem.edu/wp-content/uploads/2024/11/ANNUAL-STATISTICAL-REPORT-2021-2023-Medical-Records-Department.pdf', date: '05 Jan 2024' },
    kemNIRF: { title: 'NIRF 2026 data submitted by Seth G.S. Medical College & KEM Hospital', url: 'https://www.kem.edu/wp-content/uploads/2026/05/Seth-G.S.-Medical-College-&-KEM-Hospital-Parel-Mumbai.pdf', date: '2026 (calendar-year 2024 figures)' },
    kemProforma: { title: 'KEM Hospital — Proforma 18 N', url: 'https://www.kem.edu/wp-content/uploads/2022/01/Proforma-18-N.pdf', date: 'Jan 2022' },
    sionMUHS: { title: 'LTMMC & LTMGH Sion — MUHS college information Part II, 2026–27', url: 'https://ltmgh.com/wp-content/uploads/2026/02/MUHS-LIC-2026-Part-2.pdf', date: 'Feb 2026' },
    sionDean: { title: 'LTMGH Sion — Dean\'s message (ltmgh.com)', url: 'https://ltmgh.com/?p=1399', date: 'accessed Oct 2026' },
    nairProforma: { title: 'TNMC & BYL Nair Hospital — UGMSR 2023 website pro-forma', url: 'https://tnmcnair.edu.in/wp-content/uploads/2026/04/TOPIWALA-NATIONAL-MEDICAL-COLLEGE-1.pdf', date: 'Apr 2026' },
    cooperSite: { title: 'HBT Medical College & Dr R N Cooper Hospital — college website', url: 'https://hbtmc.edu.in/?p=738', date: 'accessed Oct 2026' },
    jjAbout: { title: 'Grant Government Medical College & Sir J J Group of Hospitals — About us', url: 'https://gmcjjh.edu.in/about-us/', date: 'accessed Oct 2026' },
    kokilaben: { title: 'Kokilaben Dhirubhai Ambani Hospital profile (secondary)', url: 'https://www.digitalhealthnews.com/7-promising-healthcare-giants-of-mumbai-building-digital-health-delivery', date: 'secondary source' },
    hinduja: { title: 'P D Hinduja Hospital profile (secondary)', url: 'https://www.businessoutreach.in/top-notch-healthcare-institutions/', date: 'secondary source' },
    bombay: { title: 'Bombay Hospital — Wikipedia / hospital website', url: 'https://en.wikipedia.org/wiki/Bombay_Hospital', date: 'accessed Oct 2026' },
    jaslok: { title: 'Jaslok Hospital profile', url: 'https://graceslist.org/?p=7704', date: 'secondary source' },
    nanavati: { title: 'Nanavati-Max expansion announcement', url: 'https://www.indianpharmapost.com/hospitals/lite/nanavati-max-hospital-mumbai-to-expand-capacity-by-over-600-beds-12176', date: '2022' },
    lilavati: { title: 'Lilavati Hospital listing (secondary)', url: 'https://www.ketto.org/blog/best-hospitals-in-mumbai', date: 'secondary source' },
    fortis: { title: 'Fortis Hospital Mulund listing (secondary)', url: 'https://www.businessoutreach.in/top-notch-healthcare-institutions/', date: 'secondary source' },
    breach: { title: 'Breach Candy Hospital — Wikipedia', url: 'https://en.wikipedia.org/wiki/Breach_Candy_Hospital', date: 'accessed Oct 2026' },
    bmcBudget: { title: 'BMC Budget Estimates 2025–26 — Municipal Commissioner\'s speech', url: 'https://www.mcgm.gov.in/irj/go/km/docs/documents/MCGM%20Department%20List/Chief%20Accountant%20(Finance)/Budget/Budget%20Estimate%202025-2026/1-%20MC\'s%20Speech/BUDGET%20A,B,G/ENGLISH%20SPEECH.pdf', date: 'Feb 2025' },
    kasturba2020: { title: 'Kasturba Hospital (Mumbai) — Wikipedia (78 isolation beds, March 2020)', url: 'https://en.wikipedia.org/wiki/Kasturba_Hospital_(Mumbai)', date: 'Mar 2020' },
    kasturbaEbola: { title: 'BMC sets up 10-bed Ebola isolation ward at Kasturba Hospital', url: 'https://www.latestly.com/india/news/ebola-threat-in-mumbai-bmc-sets-up-10-bed-isolation-ward-in-kasturba-hospital-7451298.html', date: '2026' },
    newBeds: { title: 'Mumbai to get 1,100 new hospital beds as civic facilities near completion', url: 'https://freepressjournal.in/mumbai/mumbai-to-get-1100-new-hospital-beds-as-civic-facilities-near-completion-shiv-sena-ubt-opposes-privatisation-move', date: '2026' },
    polIDSP: { title: 'Pol SS et al. Effect of climatic factors on dengue cases in the metropolitan city of Maharashtra. IJCMPH 2021;8(2):672-7 (IDSP Mumbai, month-wise dengue 2009–2018)', url: 'https://www.ijcmph.com/index.php/ijcmph/article/download/7341/4657/30079', date: 'Feb 2021' },
    fpjJul2026: { title: 'FPJ: Malaria cases jump 111%, leptospirosis surges 136% in July (BMC data)', url: 'https://www.freepressjournal.in/amp/mumbai/mumbai-monsoon-malaria-cases-jump-111-per-cent-leptospirosis-surges-136-pc-in-july-bmc-intensifies-disease-control', date: 'Aug 2026' },
    fpjMidJul2026: { title: 'FPJ: 28% surge in dengue, 18% rise in malaria until mid-July (BMC data)', url: 'https://www.freepressjournal.in/mumbai/mumbai-sees-28-per-cent-surge-in-dengue-cases-18-pc-rise-in-malaria-until-mid-july-bmc-intensifies-monsoon-disease-control', date: 'Jul 2026' },
    outlookSep2026: { title: 'Outlook: H1N1 cases jump from 62 to 441, malaria rises 20% in monsoon (BMC data, Jun–Aug)', url: 'https://www.outlookindia.com/national/mumbai-h1n1-cases-jump-from-62-to-441-malaria-rises-20-in-monsoon', date: 'Sep 2026' },
    fpjSep2026: { title: 'FPJ: H1N1 cases surge 511% to 507; malaria rises 39% to 8,723 (BMC data, 1 Jan–15 Sep)', url: 'https://www.freepressjournal.in/mumbai/mumbai-h1n1-cases-surge-511-per-cent-to-507-malaria-rises-39-pc-to-8723-bmc-data-shows', date: 'Sep 2026' },
    week2025: { title: 'The Week/PTI: Mumbai sees rise in malaria, gastro, dengue cases in first half of 2025', url: 'https://www.theweek.in/wire-updates/national/2025/07/01/bom23-mh-monsoon-mumbai-diseases.html', date: 'Jul 2025' },
    week2025b: { title: 'The Week/PTI: early monsoon — malaria, chikungunya rise (BMC data to 14 Jul 2025)', url: 'https://www.theweek.in/wire-updates/national/2025/07/15/bom33-mh-bmc-monsoon-diseases.html', date: 'Jul 2025' },
    mems: { title: 'Maharashtra MEMS 108 — new fleet of 1,756 ambulances (rollout from Nov 2025); earlier 937 (233 ALS, 704 BLS)', url: 'https://biospectrumindia.com/news/16/26090/government-of-maharashtra-to-revolutionise-emergency-medical-services-in-india.html', date: '2025' },
    lmo: { title: 'BMC installs liquid oxygen tanks at 20 places incl. KEM, Nair, Sion (13 kL and 6 kL tanks)', url: 'https://www.freepressjournal.in/mumbai/bmc-instals-huge-oxygen-cylinders-at-20-places', date: 'Jun 2020' },
    leptoICU: { title: 'Epidemic of leptospirosis: an ICU experience (60 patients; 26 ventilated; 52% mortality)', url: 'https://pubmed.ncbi.nlm.nih.gov/15847354/', date: '2004' },
    imd: { title: 'India Meteorological Department — rainfall intensity categories', url: 'https://mausam.imd.gov.in/', date: 'standard' },
    cpcb: { title: 'CPCB National Air Quality Index breakpoints', url: 'https://cpcb.nic.in/national-air-quality-index/', date: 'standard' },
    openMeteo: { title: 'Open-Meteo weather and air-quality APIs (live)', url: 'https://open-meteo.com/', date: 'live' },
    holidays: { title: 'Gazetted holidays 2026 (Punjab AG office list; IIT Kanpur circular)', url: 'https://cag.gov.in/ag/punjab/en/page-ag-punjab-holiday-list', date: '2026' }
  };

  // Facts per hospital. f(value, kind, source, note)
  const f = (v, kind, src, note) => ({ v, kind, src, note: note || '' });
  const HOSPITAL_FACTS = {
    kem: {
      beds: f(1900, 'P', 'kemNIRF', 'Number of beds in the hospital, calendar year 2024 (scheduled beds: 2,250 in the MRD report)'),
      bedsScheduled: f(2250, 'P', 'kemMRD', 'Scheduled beds 2021–2023'),
      occupiedPerDay: f(1430, 'P', 'kemNIRF', 'Average occupancy per day, 2024'),
      bor: f(1430 / 1900, 'D', 'kemNIRF', '1,430 occupied ÷ 1,900 beds'),
      admissionsPerDay: f(177, 'P', 'kemMRD', 'Daily average of admission, 2023 (64,520 a year)'),
      casualtyPerDay: f(143098 / 365, 'D', 'kemMRD', 'Total casualty attendance 2023: 1,43,098 ÷ 365'),
      alos: f(8.0, 'P', 'kemMRD', 'Daily average of patients stay in ward, 2023'),
      emergencyBeds: f(40, 'P', 'kemProforma', 'Number of beds for emergency (2022 proforma)'),
      deathsPerYear: f(5722, 'P', 'kemMRD', '2023'),
      opsPerYear: f(66636, 'P', 'kemMRD', 'Total operations 2023 (31,054 major)'),
      opdPerDay: f(6206, 'P', 'kemNIRF', 'Average OPD attendance, 2024'),
      lmoTank: f(13, 'P', 'lmo', 'kL — BMC installed LMO tanks at KEM, Nair and Sion in 2020; the article lists 13 kL and 6 kL tanks without saying which hospital got which, so 13 kL is the larger published size')
    },
    sion: {
      beds: f(1750, 'P', 'sionMUHS', 'Number of beds registered as per BNH Act'),
      admissionsPerDay: f(75000 / 365, 'D', 'sionDean', '"over 75,000 in-patient care per year" ÷ 365'),
      emergencyBeds: f(18, 'P', 'sionMUHS', 'Casualty teaching beds (excl. ICU & emergency OBGY)'),
      casualtyVentilators: f(5, 'P', 'sionMUHS', 'Ventilators in casualty'),
      icuAdult: f(100, 'P', 'sionMUHS', 'ICCU 14 + MICU 26 + SICU 22 + CVTSRR 12 + IRCU 12 + MICU-2 14'),
      icuNeoPaed: f(51, 'P', 'sionMUHS', 'NICU 30 + PICU 11 + SNICU 10'),
      wardMED: f(331, 'P', 'sionMUHS', 'Gen. Medicine 220 + Respiratory 40 + Psychiatry 33 + Dermatology 18 + Gastromedicine 20'),
      wardSURG: f(844, 'P', 'sionMUHS', 'Gen. Surgery 244 + Orthopaedics 180 + Ophthalmology 40 + ENT 41 + Paediatric surgery 39 + Urology 37 + CVTS 23 + Obst. & Gynae. 240'),
      wardPEDS: f(160, 'P', 'sionMUHS', 'Paediatrics 160'),
      xrayUnits: f(14, 'P', 'sionMUHS', '100 mA ×10, 300 mA, 600 mA, 800 mA, 1000 mA (1 of 2 working); plus 2 IITV'),
      usgUnits: f(10, 'P', 'sionMUHS', 'Radiology department ultrasound machines'),
      ctUnits: f(2, 'P', 'sionMUHS', 'CT (≥16 slice)'),
      mriUnits: f(2, 'P', 'sionMUHS', '3T MRI'),
      operatingTheatres: f(51, 'P', 'sionMUHS', 'Total OTs'),
      bloodUnitsPerDay: f(77.5, 'D', 'sionMUHS', 'Average units dispensed per day: 75–80 (midpoint)'),
      deliveriesPerDay: f(31, 'D', 'sionMUHS', '15–20 normal + 12–15 LSCS per day (midpoints)'),
      lmoTank: f(13, 'P', 'lmo', 'kL — see KEM note')
    },
    nair: {
      beds: f(1632, 'P', 'nairProforma', 'Number of beds'),
      emergencyBeds: f(19, 'P', 'nairProforma', 'Number of beds for emergency'),
      admissionsPerDay: f(4099 / 31, 'D', 'nairProforma', 'Inpatients admitted in previous month: 4,099 ÷ 31 days'),
      opdPerMonth: f(26691, 'P', 'nairProforma', 'Outpatients registered, previous month'),
      deathsPerMonth: f(239, 'P', 'nairProforma', 'Deaths reported, previous month'),
      lmoTank: f(13, 'P', 'lmo', 'kL — see KEM note')
    },
    jj: { beds: f(2844, 'P', 'jjAbout', 'Bed capacity (the college homepage also shows "1885+ beds")') },
    cooper: { beds: f(520, 'P', 'cooperSite', '"A 520-bed multi-specialty hospital" (another page of the same site says 715 beds with 70.25% occupancy)'), bor: f(0.7025, 'P', 'cooperSite', 'Bed occupancy ratio 70.25% (stated with the 715-bed figure)') },
    kokilaben: { beds: f(750, 'P', 'kokilaben', '"750-bed" (secondary source)') },
    hinduja: { beds: f(520, 'P', 'hinduja', 'About 520 beds across two units (secondary source; figures vary)') },
    bombay: { beds: f(500, 'P', 'bombay', '500 beds'), icuAdult: f(110, 'P', 'bombay', '110 in critical care and recovery') },
    jaslok: { beds: f(350, 'P', 'jaslok', '350 beds'), icuAdult: f(75, 'P', 'jaslok', '75 ICU beds') },
    nanavati: { beds: f(350, 'P', 'nanavati', 'Existing capacity of 350 beds (2022)') },
    lilavati: { beds: f(300, 'P', 'lilavati', '"Over 300 beds" (secondary source)') },
    fortis: { beds: f(261, 'P', 'fortis', '261 beds (directory listing)') },
    breach: { beds: f(220, 'P', 'breach', '"Over 220 beds"') }
  };

  const CITY_FACTS = {
    govtBeds: f(15302, 'P', 'bmcBudget', 'Beds in government hospitals in Mumbai'),
    privateBeds: f(31076, 'P', 'bmcBudget', 'Beds in private hospitals in Mumbai'),
    peripheralHospitals: f(16, 'P', 'bmcBudget', 'BMC peripheral hospitals'),
    kasturbaIsolation: f(78, 'P', 'kasturba2020', 'Isolation beds, March 2020'),
    kasturbaEbola: f(10, 'P', 'kasturbaEbola', 'Ebola isolation ward, 2026'),
    upcomingBeds: f(1120, 'P', 'newBeds', 'Siddharth 306 + Shatabdi 324 + Harilal Bhagwati 490'),
    mems108State: f(1756, 'P', 'mems', 'Statewide MEMS 108 fleet (Mumbai share not published)')
  };

  /* Mumbai notified cases by month, 2026 (BMC Epidemic Cell data via news reports).
     Each month: [cases, kind, note]. 'X' months are projections from the stated rule. */
  const m = (c, kind, note) => ({ c, kind, note });
  const IDSP_DENGUE_10Y = [333, 183, 138, 159, 191, 279, 703, 1350, 2868, 2552, 1454, 698]; // sum of 2009–2018 by month (Pol et al.)
  const DISEASE_SERIES = {
    dengue: { src: ['fpjJul2026', 'fpjMidJul2026', 'fpjSep2026', 'polIDSP'], months: [
      m(92, 'D', 'Jan–May: 938 (1 Jan–14 Jul) − 266 (Jun) − 210 (1–14 Jul) = 462 ÷ 5'), m(92, 'D', 'see Jan'), m(92, 'D', 'see Jan'), m(92, 'D', 'see Jan'), m(92, 'D', 'see Jan'),
      m(266, 'P', 'June 2026'), m(466, 'P', 'July 2026'),
      m(709, 'D', '2,656 (1 Jan–15 Sep) − 1,194 (Jan–Jul) = 1,462 for Aug + 1–15 Sep, split by the IDSP 2009–18 Aug:½Sep ratio (1,350 : 1,434)'),
      m(1506, 'D', '753 for 1–15 Sep (see Aug) × 2'),
      m(1340, 'X', 'Sep × 0.89 — Oct/Sep ratio in IDSP Mumbai 2009–18 (2,552 / 2,868)'),
      m(763, 'X', 'Sep × 0.51 — Nov/Sep ratio in IDSP 2009–18 (1,454 / 2,868)'),
      m(367, 'X', 'Sep × 0.24 — Dec/Sep ratio in IDSP 2009–18 (698 / 2,868)') ] },
    malaria: { src: ['fpjJul2026', 'fpjMidJul2026', 'outlookSep2026', 'fpjSep2026'], months: [
      m(481, 'D', 'Jan–May: 3,681 (1 Jan–14 Jul) − 655 (Jun) − 623 (1–14 Jul) = 2,403 ÷ 5'), m(481, 'D', 'see Jan'), m(481, 'D', 'see Jan'), m(481, 'D', 'see Jan'), m(481, 'D', 'see Jan'),
      m(655, 'P', 'June 2026'), m(1380, 'P', 'July 2026'),
      m(2450, 'D', '4,485 (Jun–Aug) − 655 − 1,380'),
      m(3670, 'D', '8,723 (1 Jan–15 Sep) − 6,888 (Jan–Aug) = 1,835 for 1–15 Sep, × 2'),
      m(3670, 'X', 'Held at the last published level (no Oct–Dec data published)'), m(3670, 'X', 'Held at the last published level'), m(3670, 'X', 'Held at the last published level') ] },
    lepto: { src: ['fpjJul2026', 'fpjSep2026', 'week2025'], months: [
      m(17, 'D', 'Jan–May 2026 not published; 2025 Jan–Jun = 101 → 101 ÷ 6'), m(17, 'D', 'see Jan'), m(17, 'D', 'see Jan'), m(17, 'D', 'see Jan'), m(17, 'D', 'see Jan'),
      m(33, 'P', 'June 2026'), m(78, 'P', 'July 2026'),
      m(130, 'D', '390 (1 Jan–15 Sep) − 85 (Jan–May) − 111 (Jun–Jul) = 194 for Aug + 1–15 Sep, split pro rata by days (31 : 15)'),
      m(126, 'D', '63 for 1–15 Sep (see Aug) × 2'),
      m(17, 'X', 'Back to the Jan–May level (leptospirosis follows monsoon flooding)'), m(17, 'X', 'Jan–May level'), m(17, 'X', 'Jan–May level') ] },
    gastro: { src: ['fpjJul2026', 'fpjSep2026'], months: [
      m(545, 'D', '4,997 (1 Jan–15 Sep) − 603 − 851 = 3,543 over Jan–May, Aug and ½Sep (6.5 months)'), m(545, 'D', 'see Jan'), m(545, 'D', 'see Jan'), m(545, 'D', 'see Jan'), m(545, 'D', 'see Jan'),
      m(603, 'P', 'June 2026'), m(851, 'P', 'July 2026'), m(545, 'D', 'see Jan'), m(545, 'D', 'see Jan'),
      m(545, 'X', 'Jan–Sep average level'), m(545, 'X', 'Jan–Sep average level'), m(545, 'X', 'Jan–Sep average level') ] },
    hep: { src: ['week2025b'], months: Array.from({ length: 12 }, () => m(73, 'D', '2025: 477 cases 1 Jan–14 Jul ÷ 6.45 months (2026 figure not published)')) },
    flu: { src: ['fpjJul2026', 'outlookSep2026', 'fpjSep2026'], months: [
      m(0, 'D', '507 (1 Jan–15 Sep) − 441 (Jun–Aug) = 66 for Jan–May + 1–15 Sep; assigned to September (no Jan–May figure published)'), m(0, 'D', 'see Jan'), m(0, 'D', 'see Jan'), m(0, 'D', 'see Jan'), m(0, 'D', 'see Jan'),
      m(58, 'P', 'June 2026'), m(105, 'P', 'July 2026'), m(278, 'D', '441 (Jun–Aug) − 58 − 105'), m(132, 'D', '66 for 1–15 Sep × 2'),
      m(132, 'X', 'Held at the last published level'), m(132, 'X', 'Held at the last published level'), m(132, 'X', 'Held at the last published level') ] },
    chik: { src: ['fpjSep2026'], months: Array.from({ length: 12 }, () => m(9, 'D', '80 cases 1 Jan–15 Sep 2026 ÷ 8.5 months')) }
  };

  // Inputs the model needs that no source publishes for Mumbai hospitals. The UI asks hospitals to replace these.
  const UNPUBLISHED = [
    { key: 'admitFraction', label: 'Share of notified cases admitted, by disease', why: 'BMC publishes case counts, not admissions.' },
    { key: 'hospitalShare', label: 'Share of the city\'s notified cases seen at this hospital', why: 'Not published; set to the hospital\'s share of Mumbai\'s 46,378 beds (BMC budget) until replaced.' },
    { key: 'icuBeds', label: 'ICU beds (except Sion, Bombay Hospital, Jaslok)', why: 'Not in the published documents found.' },
    { key: 'isolationBeds', label: 'Isolation beds at each hospital', why: 'Only Kasturba\'s isolation capacity is published.' },
    { key: 'ventilators', label: 'Ventilators (except Sion casualty: 5)', why: 'Not published.' },
    { key: 'nurses', label: 'Nurses on duty per shift', why: 'Not published by any of these hospitals.' },
    { key: 'labCapacity', label: 'Laboratory tests per hour', why: 'Equipment lists are published for Sion, not throughput.' },
    { key: 'xrayRate', label: 'Studies per X-ray unit per hour', why: 'Unit counts are published for Sion, not throughput.' },
    { key: 'ambulances', label: 'Ambulances serving the hospital', why: 'Maharashtra publishes a statewide 108 fleet (1,756), not Mumbai or per-hospital numbers.' },
    { key: 'o2Delivery', label: 'Oxygen refills per day', why: 'Tank sizes are reported (2020); delivery schedules are not.' },
    { key: 'patterns', label: 'Hour-of-day and weekday arrival and discharge patterns', why: 'No Mumbai hospital publishes these; enter from your HIS or import census data.' }
  ];

  global.SWDATA = { SOURCES, HOSPITAL_FACTS, CITY_FACTS, DISEASE_SERIES, IDSP_DENGUE_10Y, UNPUBLISHED, YEAR: 2026 };
})(window);
