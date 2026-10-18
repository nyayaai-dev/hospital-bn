# Surge Watch Mumbai

A decision-support tool that forecasts bottlenecks in Mumbai hospitals. It covers beds, ICU, isolation, oxygen, ambulances, the laboratory, X-ray, CT/ultrasound, nursing and platelets. Its inputs come from official and published sources, and it watches incoming patients for signs of an epidemic. It runs entirely in the browser, with no build step or backend.

## Where every number comes from

Every input carries a provenance label, shown as a badge in the app and in `data.js`:

| Label | Meaning |
|---|---|
| **P** | Published figure, with source link and date |
| **D** | Derived arithmetically from published figures; the working is shown |
| **R** | Another Mumbai hospital's published figure, used where this hospital publishes nothing |
| **U** | Not published anywhere; a placeholder the hospital must replace |
| **X** | Projection after the last published month; the rule is shown |
| **H** | Entered by hospital staff |
| **L** | Live data (Open-Meteo) |
| **I** | Learned from the hospital's own imported census data |
| **M** | Model forecast fitted on published data (dengue from rainfall) |

**Hospital figures (official documents):**
- **KEM:** NIRF 2026 submission for 2024 (1,900 beds, 1,430 occupied a day, 6,206 OPD a day). Medical Records report for 2023 (177 admissions a day, 1,43,098 casualty attendances, average stay 8.0 days). 2022 proforma (40 emergency beds).
- **Sion (LTMGH):**
  - MUHS 2026–27 filing: 1,750 registered beds with the full ward breakdown, 151 ICU-type beds by unit, and 18 casualty beds with 5 ventilators.
  - Equipment in the same filing: 14 working X-ray units, 10 ultrasound, 2 CT, 2 MRI and 51 operating theatres; the blood centre dispenses 75–80 units a day.
  - Dean's page: more than 75,000 inpatients a year.
- **Nair:** UGMSR proforma, April 2026: 1,632 beds, 19 emergency beds, and 4,099 admissions in the previous month.
- **Cooper, J J and the private hospitals:** bed counts from the hospitals' own sites or secondary sources. Each is marked in the app.
- **City:** BMC Budget 2025–26 (15,302 government beds, 31,076 private beds). Kasturba isolation capacity. BMC liquid-oxygen tanks (2020).

**Disease seasonality: BMC notified cases by month for 2026.**
- **Sources:** monthly figures from news reports of BMC Epidemic Cell data (FPJ, Outlook, The Week), plus the IDSP Mumbai dengue series for 2009–2018 (Pol et al., IJCMPH 2021).
- **Gaps:** months not reported individually are derived from published year-to-date totals, with the working shown. October–December are projections, using the IDSP 10-year shape for dengue and holding the last published level for the others.
- **How it enters the forecast:** each hospital's published admissions already include the yearly average, so only the deviation from that average is added. Cases are shared across hospitals by their share of Mumbai's 46,378 beds.

**Not published anywhere, so the hospital must supply them** (listed in the app under *Data sources and completeness*):
- the share of notified cases that are admitted;
- ICU beds (except Sion, Bombay Hospital and Jaslok), isolation beds and ventilators;
- nurses per shift, lab and X-ray throughput;
- ambulances per hospital (only the statewide 108 fleet of 1,756 is published);
- oxygen refill schedules;
- hourly and weekday arrival and discharge patterns, and casualty stay per patient.

Mumbai does not publish live bed occupancy. The current state is simulated from each hospital's published averages until census data is imported (CSV), and forecasts are model outputs from the labelled inputs.

## Run it

```bash
python -m http.server 8000
```

Then open http://localhost:8000. Live weather needs a real web origin, not `file://`.

Public copy on GitHub Pages: https://nyayaai-dev.github.io/hospital-bn/

## Team server (optional)

The public site runs entirely in the browser. For a hospital team, run the **Surge Watch team server**. It serves the same website and adds shared data, sign-in, an audit trail, alert sending, a news collector and privacy controls. It uses only Python 3.9+ and its standard library.

```bash
py server/app.py
```

Open http://127.0.0.1:8000. On first use the site asks you to create the **administrator** account; this only works on the server computer itself. The administrator then adds team members in **Setup & import → Team, accounts and security**.

| Role | Can |
|---|---|
| Viewer | See everything |
| Staff | Also import census data, edit setup and the checklist, add BMC reports and stakeholders, draft alerts |
| Approver | Also approve preventive actions, send alerts, accept collected news figures |
| Administrator | Also manage accounts and read the audit trail |

What the server adds:
- **Shared data:** approvals, alert drafts and their status, stakeholders, BMC reports, setup answers, census data and validation runs are stored in SQLite (`server/data/surgewatch.db`). Every browser syncs every 30 seconds. Approvals carry the signed-in name and role.
- **Audit trail:** every sign-in, approval, alert, upload and change is recorded. Each entry includes the SHA-256 of the previous one, so any edit or deletion shows up as a broken chain; the admin panel verifies it.
- **Sending alerts:** approvers can send an alert by email, SMS or WhatsApp to the stakeholders whose rules match it. The message goes out in the chosen language with the English version included, and a delivery log records each message. Nothing is sent automatically. Configure the channels with environment variables:
  - Email: `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURITY` (`starttls`, `ssl` or `none`)
  - SMS and WhatsApp (Twilio): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`. In India, bulk SMS also needs DLT registration with your operator.
  - Without configuration, alerts are recorded as "not configured" and can still be copied or opened in a mail app.
- **News collector:** once a day the server searches Google News for Mumbai BMC disease reports from the last 60 days. It pulls out case counts stated in headlines (ignoring percentages, years and breeding-site counts) and queues each article. An approver reads it, sets the period and accepts it as a BMC report; nothing is used automatically. Set `SURGEWATCH_COLLECTOR=0` to turn it off.
- **Model validation** (also in the browser-only site): **Data sources → Model validation** restarts the model from up to 21 past observed days. It scores the forecasts 1, 3 and 7 days ahead against what happened and against a naive "no change" forecast, and reports how often outcomes fell inside the 80% range. With simulated or example data it says it is only a self-consistency check.

Privacy and security:
- Only aggregate counts are accepted. Files with columns such as name, patient ID, UHID, MRD number, phone, address, Aadhaar, ABHA, date of birth, age or sex are refused in the browser and on the server. The server also accepts only the known census columns, and only numbers.
- **Encryption at rest:** run `py -m pip install cryptography` to store census data with AES-256-GCM. The key comes from `SURGEWATCH_DATA_KEY` (32 bytes, base64) or is generated in `server/data/data.key`; in production keep it in a secret store, not next to the database. Without the package, the admin panel shows encryption as off.
- **Retention:** census rows older than `SURGEWATCH_RETENTION_DAYS` (default 180) are deleted daily, along with expired sessions.
- **Accounts:** passwords are stored as salted PBKDF2-SHA256 hashes (310,000 iterations) and must be 10+ characters, not common. Sessions use an HttpOnly, SameSite=Strict cookie and expire after `SURGEWATCH_SESSION_HOURS` (12). An account is locked for 15 minutes after 5 failed sign-ins.
- **Requests:** changes need a custom header and a same-site origin (CSRF protection). Every response carries a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`. Only the four site files are served.
- **Network use:** the server listens on 127.0.0.1 by default. To share it on the hospital network use `--host 0.0.0.0` behind an HTTPS reverse proxy, or pass `--cert`/`--key` to serve HTTPS directly; the cookie is then marked Secure.
- This follows the data-minimisation and security principles of India's Digital Personal Data Protection Act, 2023. Each hospital remains responsible for its own compliance and approvals.

Tests: `py -m unittest discover -s server/tests -v` (13 end-to-end tests). They cover accounts, lockout, CSRF, roles, the audit tamper check, privacy checks, encryption round trip, alert sending through stand-in SMTP and Twilio servers, the collector, retention and setup conflicts.

## Features

- **Forecasts:** a 7/14/30-day forecast per unit, with 100 Monte Carlo runs (60 for 30 days) giving breach probabilities and 80% ranges. The runs happen in a background Web Worker so the page never freezes.
- **Diseases:** a table of the 7 notified diseases with each month's figure and its working. September 2026 comes from BMC's June–September totals (malaria 7,422, dengue 2,941, gastroenteritis 2,194, H1N1 504; reported 8 Oct 2026).
- **BMC disease reports:** enter any BMC release (period plus counts per disease). A report that ended in the last 21 days and covers up to 5 weeks rescales each disease's current rate. Longer or older reports are kept as a record, with the model's expected count shown beside each figure. Reports are shared by all hospitals on the device.
- **Dengue from rainfall:** Pol et al. (IDSP Mumbai, 2009–18) report that dengue follows rainfall with a 2-month lag. The app fits that lag on their month-by-month dengue table and Open-Meteo daily rainfall for the same years. It then projects October–December from this year's rain, labelled **M**. The fit shows β, r and n. When the year-to-year signal is weak, it says so, and the forecast stays near the IDSP seasonal shape.
- **City network:** 13 hospitals, each showing its published operating data and how many of its inputs are P/D, R or U.
- **Outbreak watch:** syndromic detection that escalates Watch → Outbreak → Epidemic. When it triggers, the outbreak is carried into every forecast, an epidemic alert email is drafted, desktop notifications fire, and a worst case with a preparedness checklist is produced. Outbreak drills test it without touching real data.
- **What-if scenarios and actions:** what-if scenarios, 20 preventive actions that each need a named approver, and alert drafts reviewed and sent by a person.
- **Morning briefing:** a one-page summary for the 9 am meeting: availability now, coming bottlenecks, outbreak status, this week's expected Mumbai cases, alerts and actions awaiting decisions, and a sign-off line. It prints or saves as PDF.
- **Updates and accuracy:** real-time mode (hourly re-forecast; live rain and AQI every 30 minutes), CSV census import, and a 7-day accuracy backtest.
- **Getting real hospital data:** the import accepts commas, semicolons or tabs and quoted numbers. It recognises common HMIS headings (`Date`, `Casualty attendance`, `ICU census`, `IPD admissions`…) and day-first dates (`14/10/2026 08:00`, `14-Oct-2026`, Excel serials, or a separate hour column). It accepts daily or hourly rows, and files can be dragged in. Setup also has a hospital checklist of every input no source publishes: the question, who to ask, and a Confirmed tick, with answers labelled **H** and a print view. It also has a ready-to-send data-request letter to the Medical Superintendent and Medical Records, asking for aggregate counts only, plus a blank CSV template.
- **Learning from your data:** import 7+ days of census rows, adding `admissions` and `discharges` columns if you have them. The app learns casualty attendances and admissions per day, average stay (occupied beds ÷ admissions) and occupancy. Hourly rows also teach the hour-of-day arrival pattern; 14+ days teach the weekday arrival and discharge patterns. These values are labelled **I**.
- **Saved between visits:** history, approvals, alerts, stakeholders, scenario settings and learned values are kept in IndexedDB on this device, one save per hospital. On return, the app simulates the hours missed (up to 7 days). A button forgets the saved data.
- **About us:** a Help page in the sidebar that walks a first-time user through every part of the site, with links to each page and a 5-minute tour.
- **Languages:** English, हिन्दी (Hindi) and मराठी (Marathi) cover menus, tiles, the headline, the "why" explanations, banners, preventive actions, the briefing, the checklist and alert emails. Each email also keeps an English version for official records. Dates are shown in the chosen language. Data-source notes and hospital names stay in English.

## Files

- `data.js`: every sourced figure with source, date, kind and working.
- `model.js`: the simulation model.
- `worker.js`: runs the Monte Carlo ensemble in the background.
- `index.html`: the interface.
- `server/`: the optional team server (`app.py` routes and HTTP, `core.py` database, accounts, audit, encryption and privacy, `notify.py` email/SMS/WhatsApp, `collector.py` news collector, `tests/`).
