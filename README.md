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

Then open http://localhost:8000. It also works on GitHub Pages. Live weather needs a real web origin, not `file://`.

## Features

- **Forecasts:** a 7/14/30-day forecast per unit, with 30 Monte Carlo runs giving breach probabilities and 80% ranges.
- **Diseases:** a table of the 7 notified diseases with each month's figure and its working.
- **City network:** 13 hospitals, each showing its published operating data and how many of its inputs are P/D, R or U.
- **Outbreak watch:** syndromic detection that escalates Watch → Outbreak → Epidemic. When it triggers, the outbreak is carried into every forecast, an epidemic alert email is drafted, desktop notifications fire, and a worst case with a preparedness checklist is produced. Outbreak drills test it without touching real data.
- **What-if scenarios and actions:** what-if scenarios, 20 preventive actions that each need a named approver, and alert drafts reviewed and sent by a person.
- **Updates and accuracy:** real-time mode (hourly re-forecast; live rain and AQI every 30 minutes), CSV census import, and a 7-day accuracy backtest.

## Files

- `data.js`: every sourced figure with source, date, kind and working.
- `model.js`: the simulation model.
- `index.html`: the interface.
