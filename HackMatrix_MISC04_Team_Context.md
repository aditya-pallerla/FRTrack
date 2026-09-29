# HackMatrix 5.0 — MISC-04 Project Context

## 1. Project Decision

**Selected Problem Statement:**  
**MISC-04 — Local Disaster Warning & Response Coordination Platform**

**Primary hazard for our prototype:** Flood

**Scope:** One defined Pune-area district/region.

### Official PS requirement

The system should connect disaster/hazard warnings with affected settlements and road accessibility, using environmental observations and reports from people on the ground, explain each alert, and help response teams prioritize action.

The official PS expects:
- One district and one primary hazard.
- Rainfall/terrain data (live, historical, or clearly labelled replayed data).
- Mapping of affected settlements and road closures.
- Response priorities that update as conditions change.
- Evidence and confidence behind each warning.
- Testing of false-alert rate and route validity under simulated disruption.
- Historical/replayed events must be clearly timestamped and labelled.

## 2. Core Product Idea

We are NOT rebuilding the entire previous JanRakshak system.

Our core idea is:

> **Dynamic disaster-response decision support: when the disaster situation changes, the system automatically reassesses risk, affected areas, road accessibility, response priority, and recommended routes.**

The central loop is:

```text
Rainfall / Ground Report
        ↓
Hazard & Impact Assessment
        ↓
Affected Settlement
        ↓
Road Accessibility
        ↓
Response Priority
        ↓
Recommended Route
        ↓
Situation Changes
        ↓
Recalculate
        ↓
Priority / Route / Action Changes
```

The key differentiator is NOT the use of AI, XGBoost, Gemini, OSM, etc. Those are technologies.

The product differentiation is:

> **A response priority is dynamic. New evidence, worsening conditions, or road disruption can change what responders should do.**

## 3. Killer Demo

We should demonstrate one controlled flood scenario.

### T0 — Initial situation

- Moderate rainfall
- Roads available
- Settlement A = HIGH priority

### T1 — Rainfall increases

- Hazard severity increases
- Settlement A becomes CRITICAL

### T2 — Ground report arrives

Example:

> "Water has entered houses near the school and the main road is blocked."

Gemini extracts structured evidence:

```json
{
  "hazard": "flood",
  "severity_indicators": ["water_entering_houses"],
  "road_blocked": true,
  "location": "school",
  "confidence": 0.91
}
```

### T3 — Road disruption

Simulate:

```text
Road R17 = BLOCKED
```

The original route becomes invalid.

The system:
- Detects the disruption.
- Recalculates/flags the route.
- Finds an alternative route if available.
- Updates ETA.
- Reassesses response priority if accessibility changes its urgency.

### T4 — Explainable result

Example dashboard explanation:

> **Priority: CRITICAL**  
> Rainfall increased + high exposure + ground report confirmed flooding + road accessibility decreased.

And:

> **Original route unavailable because R17 is blocked. Alternative route selected. ETA increased by 8 minutes.**

The judge should immediately understand:

> **The system is not just showing a disaster on a map. It changes the recommended response when the situation changes.**

## 4. Proposed Architecture

```text
                 DATA SOURCES
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
   Rainfall         OSM       Ground Reports
       │             │             │
       │          Roads          Gemini
       │             │             │
       └─────────────┼─────────────┘
                     ↓
              DATA PROCESSING
                     ↓
          ┌─────────────────────┐
          │ Hazard / Risk Model │
          │       XGBoost       │
          └──────────┬──────────┘
                     ↓
          ┌─────────────────────┐
          │ Priority Engine     │
          │                     │
          │ Risk                │
          │ Exposure            │
          │ Accessibility       │
          │ Ground evidence     │
          └──────────┬──────────┘
                     ↓
          ┌─────────────────────┐
          │ Routing Engine      │
          │ OSM + routing       │
          └──────────┬──────────┘
                     ↓
          ┌─────────────────────┐
          │ React Dashboard     │
          │                     │
          │ Map                 │
          │ Priority queue      │
          │ Evidence            │
          │ Route / ETA         │
          │ Timeline            │
          └─────────────────────┘
```

## 5. Tech Stack

### Frontend
- React
- TypeScript
- Tailwind CSS
- React-Leaflet
- Zustand if needed
- Framer Motion only if useful

### Backend
- Node.js
- TypeScript
- Express

### Database
- PostgreSQL
- GeoJSON where useful
- PostGIS only if genuinely needed

### AI / NLP
- Gemini API
- Purpose: extract structured evidence from unstructured ground reports.
- Do NOT build a generic chatbot.

### ML
- Python
- scikit-learn
- XGBoost

Possible model features:
- Rainfall
- Elevation/terrain
- Population/exposure
- Distance to water
- Ground-report signals
- Road accessibility

Model output:
- Hazard/impact severity
- Confidence

Important design principle:

> **ML estimates the situation; a transparent decision engine determines response priority.**

Do not pretend the ML model itself makes the operational decision.

### Geospatial
- OpenStreetMap
- React-Leaflet
- OSRM or another routing engine
- Turf.js if needed

## 6. Data Strategy

We do NOT need one perfect disaster dataset.

Use a combination of:

### Disaster messages
Use the previously used Multilingual Disaster Response Messages dataset for disaster/ground-report NLP experiments where appropriate.

### Roads and locations
OpenStreetMap.

### Rainfall
Use historical/replay data or a prepared scenario dataset. Live data is NOT necessary for the core demo.

### Terrain
SRTM/elevation data if needed.

### Prototype scenario dataset

Create a controlled dataset containing:

```text
timestamp
latitude
longitude
rainfall_1h
rainfall_6h
rainfall_24h
elevation
slope
population/exposure
road_access
ground_report_severity
road_blocked
hazard_severity
response_priority
```

The demo should be deterministic and reliable.

## 7. Core Database Entities

### settlements
- id
- name
- latitude
- longitude
- population
- elevation

### roads
- id
- geometry
- status

### environment
- timestamp
- rainfall
- settlement_id

### reports
- id
- settlement_id
- text
- timestamp

### assessments
- settlement_id
- severity
- confidence
- priority
- reasons

## 8. What We Reuse From JanRakshak

We previously worked on:
- Gemini evidence extraction
- XGBoost risk modelling
- risk/confidence
- OpenStreetMap
- routing
- road disruption
- React/TypeScript dashboard architecture
- resource/response prioritization
- real-time state changes
- explainability

We should reuse the KNOWLEDGE and proven patterns, but do not blindly recreate the entire JanRakshak product.

## 9. Major Changes From JanRakshak

### JanRakshak concept

```text
Incident
   ↓
Risk
   ↓
Resources
   ↓
Allocation
   ↓
Route
```

### New concept

```text
Environmental Conditions
       +
Ground Reports
       +
Terrain / Exposure
       ↓
Hazard / Impact Assessment
       ↓
Affected Settlements
       ↓
Road Accessibility
       ↓
Dynamic Response Priority
       ↓
Valid Response Route
       ↓
Explainable Action
```

### Keep
- XGBoost
- Gemini extraction
- OSM
- Routing
- Risk/confidence
- Map
- Event/state updates
- Evidence

### Cut unless needed
- Complex resource inventory
- Resource exhaustion prediction
- Large allocation engine
- Hungarian algorithm
- 3D map
- Heatmap
- Multiple dashboards
- Citizen app
- Complex admin workflows
- Generic AI chatbot

## 10. Prototype Target

For the first 50% prototype, we need ONE complete vertical slice:

```text
Ground Report / Rainfall
        ↓
Gemini / Data Processing
        ↓
XGBoost Severity
        ↓
Affected Settlement
        ↓
Priority Engine
        ↓
Route
        ↓
Road Disruption
        ↓
Recalculation
        ↓
Dashboard Update
```

If this works reliably, the prototype is strong enough to demonstrate the central idea.

## 11. What NOT to Do

- Do not add features just to make the project look bigger.
- Do not introduce deep learning just because it sounds advanced.
- Do not add agents unnecessarily.
- Do not depend entirely on live APIs for the demo.
- Do not claim simulated data is live.
- Do not claim model accuracy without actual evaluation.
- Do not make Gemini the final decision-maker.
- Do not build the whole JanRakshak again.
- Do not spend most of the time on UI before the end-to-end pipeline works.

## 12. Team Division — 4 People

### PERSON 1 — ML + AI / Data Pipeline

**Own:**
- Ground-report dataset
- Gemini extraction
- Structured report schema
- XGBoost dataset/features
- XGBoost training
- Evaluation
- Model export/integration format
- Confidence handling

**Deliverable:**
```text
Report
  ↓
Structured evidence
  ↓
Severity prediction
  ↓
Confidence
```

**Must coordinate with Person 2 on API/model integration.**

---

### PERSON 2 — Backend + Decision Engine

**Own:**
- Node/Express backend
- Database
- API endpoints
- Priority engine
- Assessment workflow
- State updates
- Integration of ML output
- Evidence/reason generation

Important endpoints could include:

```text
POST /reports
POST /assessments
GET /settlements
GET /roads
GET /priorities
GET /routes
POST /simulate/road-block
POST /simulate/rainfall
```

**Deliverable:**
```text
Input data
   ↓
Backend
   ↓
Risk + priority
   ↓
Route / response state
```

---

### PERSON 3 — Geospatial + Routing

**Own:**
- OpenStreetMap data
- Map layers
- Road network
- Routing integration
- Road-block simulation
- Alternative route calculation
- ETA
- Geographic data preparation

**Deliverable:**

```text
Settlement A
    ↓
Route
    ↓
Road blocked
    ↓
Alternative route
    ↓
Updated ETA
```

This person should make the **killer road-closure demo** extremely reliable.

---

### PERSON 4 — Frontend + UX + Demo Integration

**Own:**
- React dashboard
- Map UI integration
- Priority queue
- Evidence panel
- Route display
- Timeline/replay
- Scenario controls
- Visual polish
- Final demo flow

Main screen:

```text
┌─────────────────────────────────────────┐
│ FLOOD RESPONSE COMMAND CENTRE           │
├────────────────────┬────────────────────┤
│                    │ RESPONSE PRIORITY  │
│       MAP          │ 🔴 Settlement A    │
│                    │ 🟠 Settlement B    │
│                    │ 🟡 Settlement C    │
├────────────────────┴────────────────────┤
│ WHY CRITICAL?                           │
│ Rainfall ↑ + Exposure ↑ + Road blocked │
│                                         │
│ Route: R18 → R21     ETA: 22 min        │
└─────────────────────────────────────────┘
```

## 13. Integration Ownership

Do not let four people work independently until the last hour.

### Person 1
Provides:
```text
ML output schema
```

### Person 2
Consumes Person 1's output and exposes APIs.

### Person 3
Provides:
```text
route + road state
```

to Person 2.

### Person 4
Consumes backend APIs from Persons 1–3 and creates the final dashboard.

### Integration contract

Agree early on the JSON structures.

Example:

```json
{
  "settlement_id": "S01",
  "severity": "CRITICAL",
  "confidence": 0.91,
  "priority": "CRITICAL",
  "reasons": [
    "Heavy rainfall",
    "High exposure",
    "Ground report confirms flooding",
    "Main road blocked"
  ],
  "route": {
    "status": "ALTERNATIVE",
    "eta_minutes": 22
  }
}
```

This prevents integration chaos.

## 14. Priority Order

### MUST HAVE
1. Flood scenario
2. Map
3. Ground-report extraction
4. Severity/risk model
5. Priority engine
6. Road disruption
7. Routing
8. Evidence/confidence
9. One polished dashboard

### SHOULD HAVE
- Replay timeline
- Multiple settlements
- False-alert test
- Better animations
- Historical scenario comparison

### WOW FEATURE
- Live-looking scenario replay where one event changes the entire response plan

### NICE TO HAVE
- Citizen interface
- Notifications
- Advanced analytics
- Multiple hazards
- Multiple districts

### CUT
- 3D
- Complex resource allocation
- Huge admin system
- Generic chatbot
- Unnecessary AI agents

## 15. Judge Attack Questions

Everyone should be able to answer these:

### "Why AI?"
Gemini converts unstructured ground reports into structured evidence, while XGBoost estimates hazard/impact severity from environmental and exposure features.

### "Why not just use rules?"
Rules handle transparent response decisions, but ML can combine multiple environmental signals for severity estimation. We use each where it is appropriate.

### "Is your data real?"
The prototype uses a combination of available geographic/environmental data and clearly labelled historical/simulated replay data. We do not present replayed data as live.

### "What happens when a road closes?"
The road state is updated, the existing route is invalidated/rechecked, an alternative is calculated where available, and the response state is updated.

### "What happens when AI is wrong?"
Confidence is shown, evidence is exposed, and uncertain cases should be flagged rather than presented as certain.

### "What's actually innovative?"
The innovation is not simply AI or a map. It is dynamic response decision-making where changing hazard evidence and road accessibility can change the recommended response.

### "How is this different from JanRakshak?"
This is a narrower, more focused system centred on dynamic hazard assessment, evidence-backed warnings, and response/route changes under changing conditions. We are applying lessons from the previous project rather than reproducing its full architecture.

## 16. Development Principle

**Build this first:**

```text
INPUT
  ↓
PROCESS
  ↓
DECISION
  ↓
VISIBLE CHANGE
```

Every major feature must produce a visible result in the demo.

The goal is NOT the most complicated system.

The goal is:

> **Useful + differentiated + technically credible + reliable + memorable + defensible.**
