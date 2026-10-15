# Surge Watch

A decision-support tool that forecasts hospital bottlenecks before they happen. It combines live operating conditions with predictable seasonal patterns. It runs entirely in the browser, with no build step or backend.

> Hospital observations are **simulated** unless you import your own census data. The example hospital ("Meridian District Hospital", 344 beds) is fictional. Weather and air quality are **live** when the page can reach Open-Meteo.

## Run it

Serve the folder and open it in a browser. Live weather needs a real web origin, not `file://`.

```bash
python -m http.server 8000
```

Then visit http://localhost:8000. It also works as-is on GitHub Pages.

## What it does

| Requirement | How Surge Watch covers it |
|---|---|
| Find future bottlenecks | Hour-by-hour flow simulation across 9 units: Emergency, Medicine, Surgery, ICU, Paediatrics, Laboratory, Imaging, Nursing and the blood bank (platelets). Load above 95% is a warning; above 105% is critical. |
| Seasonal & recurring patterns | City-specific curves for 10 Indian cities. They cover dengue (driven by rain 2–5 weeks earlier), influenza (winter and monsoon waves), water-borne illness and leptospirosis, heat illness (driven by forecast temperature), air pollution (driven by the forecast Indian AQI) and Diwali burns and trauma. Also weekday arrival patterns, weekend discharge slowdowns and public holidays (Dussehra, Diwali, Guru Nanak Jayanti…). |
| Timing, severity, explanation | Each bottleneck shows its onset, peak and hours above threshold, plus a **probability** from 30 Monte Carlo runs. The *Why* panel re-runs the forecast without each factor to show how many points that factor adds. |
| Downstream effects | Demand → lab and imaging turnaround and platelet use → ED stay, boarding and ambulance diversion → ward and ICU load → step-down delays → nurse cover and cancelled electives. |
| What-if scenarios | Sliders for arrivals, seasonal intensity, staff shortages, closed beds, ventilators, lab, imaging and platelet supply. Also outbreaks, a mass-casualty incident, a delayed start, and 7 presets. |
| Preventive actions & alerts | 13 actions ranked by simulated impact. Each needs a named approver before it joins the plan. Alert emails are drafted when a breach passes a probability threshold within a lead time, then reviewed and sent by a person. Alerts pause while a hypothetical scenario is on. |
| Continuous updates, human control | *Real time* mode follows the wall clock and refreshes live data every 30 minutes; *Fast-forward* is for demos. Forecasts lean toward observed arrivals, and a log records every change. A 7-day backtest shows forecast error and how well the 80% range is calibrated. |

## How realistic is it?

- **Uncertainty is simulated, not guessed.** Each forecast runs 30 futures with Poisson arrivals, admissions and discharges, day-level demand shocks, and run-level outbreak strength. The band is the 10th–90th percentile.
- **Real operational frictions:**
  - Discharges cluster at 11:00–14:00 and fall at weekends and on holidays.
  - Beds take 2–4 h to clean.
  - ICU patients wait for a Medicine bed before stepping down.
  - Morning blood draws create a 05:00–09:00 lab backlog, and slow lab results lengthen ED stays.
  - Overflowing EDs divert ambulances.
  - Platelets expire after 5 days.
- **Live external data:**
  - [Open-Meteo](https://open-meteo.com/) rainfall and temperature, and PM2.5/PM10 converted to the CPCB Indian AQI, for the hospital's city. No API key is needed.
  - Dengue and influenza-like-illness figures are entered from IDSP or municipal reports, since no open API exists.
- **Your own data:** the *Hospital setup and data* panel takes your beds, staffing, lab, imaging and blood-bank capacity. It also imports a CSV census export, which recalibrates demand and powers the accuracy check.
- **Limits:** clinical rates (routing, length of stay, nurse ratios) are typical values, not fitted to a specific hospital. Validate them against your own records before using this for real decisions.

## Data import format

One row per hour or per day. Only `timestamp` is required.

```
timestamp,ed_arrivals,ed_census,ed_waiting_for_bed,med_occupied,surg_occupied,icu_occupied,peds_occupied,lab_backlog,platelet_stock
2026-10-14 08:00,9,24,2,168,72,20,36,40,58
```

`ed_arrivals` is the count during the period ending at that timestamp. The other columns are snapshots.

## Files

- `index.html`: the interface (dashboard, charts, what-if, actions, alerts, setup, import)
- `model.js`: the simulation model, with no dependencies. Clinical rates are in `R`, the example hospital in `DEFAULT_SETUP`, city seasonality in `CITIES`, and holidays in `HOLIDAYS`.
