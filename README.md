# RadioScope 📡
### US & Canadian Radio Station Coverage Map (Docker Application)

**RadioScope** is a high-precision, containerized broadcast coverage mapping web application. It generates signal contours, GIS polygons, transmitter specs, and reception predictions for any **United States (FCC)** or **Canadian (ISED)** AM/FM radio station by callsign.

![RadioScope Banner](https://img.shields.io/badge/Coverage-US%20%26%20Canada-blue?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-emerald?style=for-the-badge)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)

---

## Key Features

- **US & Canada Coverage Database**:
  - Comprehensive index of US stations (FCC) and Canadian stations (ISED/CRTC) across all states and provinces (e.g., `WNYC-FM`, `KQED`, `KEXP`, `WBBM`, `WWOZ`, `CBLA-FM`, `CJBC`, `CKUA`, `CFNY-FM`, `CFRB`, `CJAD`, `CKNW`, etc.).
  - Real-world technical parameters: Coordinates, Frequency, ERP (Effective Radiated Power), HAAT (Height Above Average Terrain), Licensee, City of License, and Band.
  - Automatic synthesis engine for unindexed callsigns based on North American ITU allocations.

- **Broadcast Engineering Models**:
  - **FM Model (FCC 47 CFR § 73.313 / § 73.333 & ITU-R P.1546)**:
    - **70 dBu (3.16 mV/m)**: City Grade / Strong building penetration & mobile stereo
    - **60 dBu (1.00 mV/m)**: Principal Protected Service Area (standard car/home radio)
    - **54 dBu (0.50 mV/m)**: Secondary / Suburban Fringe reception
    - **48 dBu (0.25 mV/m)**: Weak / DX Reception boundary
  - **AM Groundwave Model (FCC 47 CFR § 73.184)**:
    - **25 mV/m**: Business / Urban Core
    - **5 mV/m**: Residential / City Grade
    - **2 mV/m**: Primary Service Area
    - **0.5 mV/m**: Protected Rural Service

- **Interactive GIS Map & Tools**:
  - Smooth multi-layer vector map (Dark Matter, Positron Light, OpenStreetMap, Satellite, OpenTopo).
  - Multi-tier contour polygons with geodesic 360-radial accuracy.
  - Pulsing transmitter beacon with tower metadata popup.
  - **Interactive Signal Strength Probe**: Click anywhere on the map to calculate exact field strength ($dB\mu V/m$ & $mV/m$), distance, bearing, and S-meter reception quality.
  - **Radial Signal Attenuation Chart**: Real-time cross-section profile of signal decay across distance.
  - **Live Web Stream Player**: Listen live to station audio broadcasts directly in the browser.
  - **Custom Transmitter Simulator**: Model hypothetical radio stations anywhere with custom power, antenna height, coordinates, and directional patterns.

- **GIS & Data Exports**:
  - **GeoJSON**: Standard polygon features for QGIS, ArcGIS, Mapbox, or Google Earth.
  - **KML**: 3D vector contours for Google Earth Desktop & Web.
  - **Engineering JSON Report**: Full technical specification and contour radius export.

---

## Quick Start with Docker

### 1. Using Docker Compose (Recommended)
```bash
cd /path/to/radio-coverage-map

# Build and run the container
docker compose up -d --build
```
Open **`http://localhost:8080`** in your browser.

To stop the container:
```bash
docker compose down
```

### 2. Using Docker CLI
```bash
# Build the Docker image
docker build -t radioscope:latest .

# Run the container on port 8080
docker run -d -p 8080:8080 --name radioscope-app radioscope:latest
```

---

## Running Locally without Docker

### Prerequisites
- Python 3.9+
- pip

```bash
# Install dependencies
pip install -r requirements.txt

# Run the application
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```
Open **`http://localhost:8080`** in your browser.

---

## REST API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `GET /api/stations/search?q={query}` | `GET` | Search stations by callsign, name, city, state, or frequency with autocomplete. |
| `GET /api/station/{callsign}` | `GET` | Retrieve station engineering specifications and metadata. |
| `GET /api/coverage/{callsign}` | `GET` | Generate multi-tier coverage contours, GeoJSON, and radial signal profiles. |
| `POST /api/probe` | `POST` | Probe field strength ($dB\mu V/m$), distance, and reception quality at a lat/lon coordinate. |
| `POST /api/custom-coverage` | `POST` | Generate coverage map for a simulated custom transmitter. |
| `GET /api/export/geojson/{callsign}` | `GET` | Download coverage polygons as GeoJSON. |
| `GET /api/export/kml/{callsign}` | `GET` | Download coverage contours as Google Earth KML. |
| `GET /api/health` | `GET` | Container health check endpoint. |

---

## Example Test Callsigns

- **US Stations**:
  - `WNYC-FM` (93.9 MHz, New York, NY - 6 kW ERP @ 415m HAAT)
  - `KQED-FM` (88.5 MHz, San Francisco, CA - 110 kW ERP @ 540m HAAT)
  - `KEXP-FM` (90.3 MHz, Seattle, WA - 4.7 kW ERP @ 489m HAAT)
  - `WBBM` (780 kHz AM, Chicago, IL - 50 kW clear-channel)
  - `WWOZ` (90.7 MHz, New Orleans, LA - 100 kW ERP @ 204m HAAT)
  - `WFMT` (98.7 MHz, Chicago, IL - 6 kW ERP @ 480m HAAT)

- **Canadian Stations**:
  - `CBLA-FM` (99.1 MHz, CBC Radio One Toronto, ON - 38 kW ERP @ 418m HAAT)
  - `CJBC` (860 kHz AM, ICI Première Toronto, ON - 50 kW)
  - `CFRB` (1010 kHz AM, NEWSTALK 1010 Toronto, ON - 50 kW)
  - `CFNY-FM` (102.1 MHz, 102.1 The Edge Toronto, ON - 35 kW ERP @ 418m HAAT)
  - `CKUA` (93.7 MHz, Edmonton, AB - 100 kW ERP @ 220m HAAT)
  - `CBF-FM` (95.1 MHz, ICI Première Montréal, QC - 100 kW ERP @ 300m HAAT)
  - `CFOX-FM` (99.3 MHz, Vancouver, BC - 75 kW ERP @ 665m HAAT)

---

## Project Structure

```
radio-coverage-map/
├── Dockerfile                  # Multi-stage lightweight Python container
├── docker-compose.yml          # Single-command Docker orchestration
├── .dockerignore
├── requirements.txt            # Python dependencies (FastAPI, Uvicorn, NumPy, etc.)
├── README.md                   # Full documentation
├── app/
│   ├── main.py                 # FastAPI application & REST routing
│   ├── models.py               # Pydantic / Data schemas
│   ├── data/
│   │   ├── station_db.py       # Station repository & fuzzy search
│   │   ├── us_stations.json    # Curated US broadcast stations
│   │   └── ca_stations.json    # Curated Canadian broadcast stations
│   ├── engine/
│   │   ├── propagation.py      # FCC F(50,50) and AM Groundwave calculation engine
│   │   └── geodesy.py          # Spherical geodesy, Vincenty & GeoJSON generation
│   └── static/
│       ├── index.html          # Interactive Web UI
│       ├── css/
│       │   └── style.css       # Clean responsive theme
│       └── js/
│           ├── app.js          # App controller, audio player, simulation & export
│           └── map.js          # Leaflet map, contours, probes, basemap switchers
└── tests/
    └── test_engine.py          # Unit test suite
```

---

## License
MIT License. Open-source broadcast mapping tool for radio engineers, hobbyists, and DXers.
