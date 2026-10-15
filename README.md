# Surge Watch Mumbai

A decision-support tool that forecasts bottlenecks in Mumbai hospitals before they happen. It covers beds, ICU, isolation, oxygen, ambulances, the laboratory, X-ray, CT/ultrasound, nursing and platelets. It accounts for Mumbai's seasonal infections, monsoon flooding and public holidays, and it watches incoming patients for signs of an epidemic. It runs entirely in the browser, with no build step or backend.

> **What is real and what is simulated.** Hospital bed counts come from public sources, and weather and air quality are live from Open-Meteo. Mumbai hospitals do not publish live occupancy, so patient numbers, stock levels and per-hospital load are **simulated** until you import your own census data.

## Run it

```bash
python -m http.server 8000
```

Then open http://localhost:8000. It also works on GitHub Pages. Live weather needs a real web origin, not `file://`.

## What it covers

| Need | How |
|---|---|
| Seasonal infections that fill beds | 11 Mumbai illnesses, each with its own season, admission rate, ICU share and resource needs: malaria, dengue, leptospirosis, chikungunya, gastroenteritis and cholera, hepatitis A/E and typhoid, influenza (H1N1/H3N2), pollution-related respiratory illness, heat illness, monsoon injuries, and Diwali burns. TB is treated as year-round load, and COVID-type epidemics are handled by outbreak detection. The table shows how many beds and ICU beds each illness adds at its peak. |
| Mumbai hospitals | 13 hospitals with published bed counts (KEM, J J, Nair, Sion, Cooper, Kokilaben, Hinduja, Bombay, Jaslok, Nanavati, Lilavati, Fortis Mulund, Breach Candy), plus Kasturba's isolation reserve and upcoming BMC beds. Pick any hospital to forecast it; the network view estimates free beds, ICU, isolation, oxygen and ambulances across the city. |
| Keeps updating | *Real time* mode (the default) re-forecasts every hour and refreshes live rain, temperature and AQI every 30 minutes. *Fast-forward* is for demos. |
| Epidemic / pandemic alerts | Every hour, arrivals by syndrome (fever, respiratory, diarrhoea/jaundice, injuries) are compared with the seasonal expectation. The level escalates from Watch to Outbreak, Epidemic and Severe epidemic. Once an outbreak is detected, its growth goes into every forecast. An epidemic alert email is drafted, a red banner appears, and a desktop notification is sent where the browser allows it. |
| Prepared for the worst | A reasonable worst case (faster growth, 15% fewer nurses, 30% oxygen supply cut, 15% of ambulances off road) shows when each resource runs out and by how much. A preparedness checklist lists each action, its owner, its lead time and a *decide by* time. With no outbreak, it runs a stress test of a COVID-like epidemic starting today. |
| Beds, oxygen, ambulances, labs, X-ray | Availability tiles show free general, ICU and isolation beds; free ventilators; oxygen days of supply (liquid tank and cylinders, in D-type cylinder equivalents); ambulances available and current trip time (Mumbai traffic, and IMD heavy-rain classes slow trips); lab turnaround; X-ray wait; CT/ultrasound wait; and platelet stock. Each shows its lowest point in the next 72 h. |
| What-if | Mumbai flood (26 July-type), dengue outbreak, flu wave with staff sickness, building collapse, oxygen supply crisis, X-ray and lab breakdown, nursing strike, and blood donor shortage, plus 13 sliders. |
| Human control | 20 preventive actions, each needing a named approver. Alerts are drafts that a person reviews and sends. Outbreak drills test detection without touching real data. |

## Data sources

- **Bed counts:**
  - KEM Medical Records annual statistical report 2021–23 (2,250 beds).
  - Hospital websites, Wikipedia and published profiles for the others. Sources disagree for some hospitals (e.g. Cooper 500–1,462), and each figure's source is shown in the app.
- **Mumbai disease figures:** BMC data reported by the Free Press Journal and The Week (2025–2026). For example, July 2026 had 1,380 malaria, 466 dengue, 78 leptospirosis, 851 gastroenteritis and 105 H1N1 cases.
- **Oxygen:** the BMC liquid-oxygen tank programme, and the April 2021 shortage as context.
- **Rain classes:** India Meteorological Department (heavy ≥ 64.5 mm, very heavy ≥ 115.6 mm, extremely heavy ≥ 204.5 mm per day).
- **AQI:** CPCB National AQI breakpoints, from Open-Meteo PM2.5/PM10.

## Limits

- **Capacities other than beds are estimated.** ICU share, ventilators, staff, lab, X-ray, oxygen, ambulances and platelets are derived from bed counts using typical ratios. Edit them in *Hospital setup and data*.
- **Clinical rates are typical values,** not fitted to any hospital. Validate against your own records before using this for real decisions.
- **Disease counts have no open API,** so they're entered by hand from BMC/IDSP reports.

## Data import format

One row per hour or per day. Only `timestamp` is required.

```
timestamp,ed_arrivals,ed_census,ed_waiting_for_bed,med_occupied,surg_occupied,icu_occupied,peds_occupied,iso_occupied,lab_backlog,platelet_stock,oxygen_stock,ambulances_busy
2026-10-14 08:00,40,120,12,880,520,120,190,20,200,230,5200,9
```

## Files

- `index.html`: the interface.
- `model.js`: the simulation model, with no dependencies. It contains the hospitals in `HOSPITALS`, the illnesses in `DISEASES`, the epidemic profiles in `PATHOGENS`, the clinical rates in `R`, and the actions in `ACTIONS`.
