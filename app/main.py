import os
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.models import (
    Station,
    CoverageResponse,
    SignalProbeRequest,
    SignalProbeResponse,
    CustomTransmitterRequest
)
from app.data.station_db import station_db
from app.engine.propagation import (
    generate_station_contours,
    probe_signal_at_location
)

app = FastAPI(
    title="RadioScope - US & Canada Radio Coverage Mapping API",
    description="High-fidelity coverage map and signal contour generator for US (FCC) and Canadian (ISED) radio stations.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR, exist_ok=True)

# Mount static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "RadioScope Broadcast Engine",
        "version": "1.0.0",
        "data_sources": [
            "FCC LMS (United States)",
            "ISED Spectrum Management System (Canada)",
            "WTFDA / Community Radio-Browser Directory"
        ]
    }


@app.post("/api/admin/sync")
async def trigger_data_sync(pull_remote: bool = False):
    """
    Trigger full synchronization from FCC LMS, ISED Canada, and community datasets.
    """
    result = station_db.pipeline.sync_all(pull_remote=pull_remote)
    station_db._cache.clear()
    return result



@app.get("/api/stations/search", response_model=List[Station])
async def search_stations(
    q: str = Query("", description="Callsign, station name, city, state, or frequency"),
    country: Optional[str] = Query(None, description="Country filter: US or CA"),
    band: Optional[str] = Query(None, description="Band filter: FM or AM"),
    limit: int = Query(15, ge=1, le=50)
):
    """Search stations with fuzzy matching and filtering."""
    return station_db.search_stations(query=q, country=country, band=band, limit=limit)


@app.get("/api/station/{callsign}", response_model=Station)
async def get_station(callsign: str):
    """Retrieve station metadata and engineering specifications by callsign."""
    st = station_db.get_by_callsign(callsign)
    if not st:
        raise HTTPException(status_code=404, detail=f"Station '{callsign}' not found.")
    return st


@app.get("/api/coverage/{callsign}", response_model=CoverageResponse)
async def get_station_coverage(
    callsign: str,
    mode: str = Query("day", description="Operating mode: 'day' or 'night' (for AM stations)")
):
    """
    Calculate and generate high-fidelity coverage contours, GeoJSON polygons,
    and radial signal profiles for any US or Canadian radio station by callsign.
    Supports Day and Night patterns for AM broadcast stations.
    """
    st = station_db.get_by_callsign(callsign)
    if not st:
        raise HTTPException(status_code=404, detail=f"Station '{callsign}' not found.")

    contours, geojson_fc, radial_profile, operating_power, pattern_desc = generate_station_contours(st, mode=mode.lower())

    primary_area = contours[1].area_sqkm if len(contours) > 1 else contours[0].area_sqkm
    density_factor = 280 if st.country == "US" else 210
    if st.city in ["New York", "Los Angeles", "Chicago", "Toronto", "Montréal", "San Francisco"]:
        density_factor = 1200
    est_pop = int(primary_area * density_factor)

    return CoverageResponse(
        station=st,
        coverage_mode=mode.lower(),
        operating_power_kw=operating_power,
        operating_pattern=pattern_desc,
        contours=contours,
        geojson=geojson_fc,
        radial_profile=radial_profile,
        center_coords=[st.latitude, st.longitude],
        est_population=est_pop,
        source=f"FCC 47 CFR § 73.184/73.190 & § 73.313 ({st.country} Standard)"
    )


@app.post("/api/custom-coverage", response_model=CoverageResponse)
async def calculate_custom_coverage(req: CustomTransmitterRequest):
    """
    Calculate coverage contours for a custom transmitter location and specifications.
    """
    st = Station(
        callsign=req.callsign.upper(),
        name=req.name,
        band=req.band.upper(),
        frequency=req.frequency,
        erp_kw=req.erp_kw,
        haat_m=req.haat_m,
        latitude=req.latitude,
        longitude=req.longitude,
        city=req.city,
        state=req.state,
        country=req.country.upper(),
        day_power_kw=req.day_power_kw,
        night_power_kw=req.night_power_kw,
        directional=req.directional,
        night_beam_deg=req.pattern_beam_deg or 0.0,
        licensee="Custom Simulation",
        format="Experimental Broadcast"
    )

    mode = req.mode.lower() if req.mode else "day"
    contours, geojson_fc, radial_profile, operating_power, pattern_desc = generate_station_contours(st, mode=mode)
    primary_area = contours[1].area_sqkm if len(contours) > 1 else contours[0].area_sqkm
    est_pop = int(primary_area * 250)

    return CoverageResponse(
        station=st,
        coverage_mode=mode,
        operating_power_kw=operating_power,
        operating_pattern=pattern_desc,
        contours=contours,
        geojson=geojson_fc,
        radial_profile=radial_profile,
        center_coords=[st.latitude, st.longitude],
        est_population=est_pop,
        source="Custom Transmitter Simulation Engine"
    )


@app.post("/api/probe", response_model=SignalProbeResponse)
async def probe_signal(req: SignalProbeRequest):
    """
    Probe predicted signal strength (dBu & mV/m), distance, bearing,
    and reception quality at any point on the map.
    """
    station = req.station_data
    if not station and req.callsign:
        station = station_db.get_by_callsign(req.callsign)

    if not station:
        raise HTTPException(status_code=400, detail="Station data or valid callsign required.")

    return probe_signal_at_location(station, req.lat, req.lon, mode=req.mode or "day")



@app.get("/api/export/geojson/{callsign}")
async def export_geojson(callsign: str):
    """Download GeoJSON FeatureCollection containing all coverage contours and transmitter."""
    st = station_db.get_by_callsign(callsign)
    if not st:
        raise HTTPException(status_code=404, detail=f"Station '{callsign}' not found.")

    _, geojson_fc, _ = generate_station_contours(st)
    return JSONResponse(
        content=geojson_fc,
        headers={"Content-Disposition": f"attachment; filename={st.callsign}_coverage.geojson"}
    )


@app.get("/api/export/kml/{callsign}")
async def export_kml(callsign: str):
    """Export coverage contours as Google Earth KML format."""
    st = station_db.get_by_callsign(callsign)
    if not st:
        raise HTTPException(status_code=404, detail=f"Station '{callsign}' not found.")

    contours, _, _ = generate_station_contours(st)

    kml_placemarks = []
    for c in contours:
        ring = c.geometry["coordinates"][0]
        coord_str = " ".join([f"{p[0]},{p[1]},0" for p in ring])
        # KML color in aabbggrr format
        kml_placemarks.append(f"""
        <Placemark>
            <name>{c.name}</name>
            <description>{c.description} - Avg Radius: {c.avg_radius_km} km</description>
            <Style>
                <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>
                <PolyStyle><color>4d0000ff</color><fill>1</fill><outline>1</outline></PolyStyle>
            </Style>
            <Polygon>
                <outerBoundaryIs><LinearRing><coordinates>{coord_str}</coordinates></LinearRing></outerBoundaryIs>
            </Polygon>
        </Placemark>
        """)

    # Tower placemark
    tower_kml = f"""
    <Placemark>
        <name>{st.callsign} Transmitter</name>
        <description>{st.name} ({st.frequency} {'MHz' if st.band=='FM' else 'kHz'}) - ERP: {st.erp_kw} kW, HAAT: {st.haat_m}m</description>
        <Point>
            <coordinates>{st.longitude},{st.latitude},0</coordinates>
        </Point>
    </Placemark>
    """

    kml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{st.callsign} Coverage Map</name>
    <description>Radio coverage contours generated by RadioScope for {st.callsign} ({st.city}, {st.state})</description>
    {tower_kml}
    {''.join(kml_placemarks)}
  </Document>
</kml>
"""
    return Response(
        content=kml_content,
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f"attachment; filename={st.callsign}_coverage.kml"}
    )


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        with open(index_file, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse(content="<h1>RadioScope API Running</h1><p>Static UI loading...</p>")
