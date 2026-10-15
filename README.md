# Surge Watch

A decision-support tool that forecasts hospital bottlenecks before they happen. It combines live operating conditions with predictable seasonal patterns. It runs entirely in the browser, with no build step or backend.

> All patients, capacities and surveillance readings are **simulated** for demonstration. The hospital ("Meridian District Hospital", 344 beds) is fictional.

## Run it

Open `index.html` in a browser. Some browsers block local scripts, so if the page is blank, serve the folder:

```bash
python -m http.server 8000
```

Then visit http://localhost:8000.

## What it does

| Requirement | How Surge Watch covers it |
|---|---|
| Find future bottlenecks | Hour-by-hour flow simulation across 8 units: Emergency, Medicine, Surgery, ICU, Paediatrics, Laboratory, Imaging, Nursing. Load above 95% is a warning; above 105% is critical. |
| Seasonal & recurring patterns | Curves for dengue and vector-borne fever, influenza (winter and monsoon waves), water-borne illness, heat illness, post-Diwali air pollution, and Diwali burns and trauma. Also covers weekday arrival patterns and weekend discharge slowdowns. |
| Timing, severity, explanation | Each bottleneck shows its onset, peak, hours above threshold and a confidence level. The *Why* panel re-runs the forecast without each factor to show how many points that factor adds. |
| Downstream effects | Knock-on chain: demand → lab and imaging turnaround → ED stay and boarding → ward and ICU load → step-down delays → nurse cover, cancelled electives and ambulance diversion. |
| What-if scenarios | Sliders for arrivals, seasonal intensity, staff shortages, closed beds, ventilators out of service, lost lab or imaging capacity, outbreaks and mass-casualty incidents, plus a start time. Includes ready-made presets. |
| Preventive actions & alerts | 10 actions ranked by simulated impact. Each needs a named approver before it joins the plan. Early-warning emails are drafted for a stakeholder list and sent by a person, never automatically. |
| Continuous updates, human control | *Run live* advances the clock, adjusts the forecast toward the arrivals actually observed, and refreshes external signals daily. A log records every change in the forecast. |

## Files

- `index.html`: the interface (dashboard, charts, what-if, actions, alerts)
- `model.js`: the simulation model, with no dependencies. Capacities, rates and seasonal curves are in the `P` and `SEASONS` constants near the top.

## Using real data

Replace `initialState()` and the history in `boot()` with real census, ED and lab feeds. Then tune `P` (beds, staffing, length of stay, routing rates) and the `SEASONS` amplitudes against your hospital's past admissions.
