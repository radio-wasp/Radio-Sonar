try:
    import pytest
except ImportError:
    pytest = None

from app.models import Station, CustomTransmitterRequest
from app.data.station_db import station_db
from app.engine.propagation import (
    calculate_fm_f50_50_field_strength,
    solve_fm_contour_distance_km,
    calculate_am_groundwave_field_strength,
    solve_am_contour_distance_km,
    generate_station_contours,
    probe_signal_at_location
)
from app.engine.geodesy import (
    calculate_distance_bearing,
    destination_point,
    generate_polygon_coordinates,
    calculate_polygon_area_sqkm
)


def test_station_db_lookups():
    # Test US station
    wnyc = station_db.get_by_callsign("WNYC-FM")
    assert wnyc is not None
    assert wnyc.callsign == "WNYC-FM"
    assert wnyc.country == "US"
    assert wnyc.frequency == 93.9

    # Test Canadian station
    cbla = station_db.get_by_callsign("CBLA-FM")
    assert cbla is not None
    assert cbla.country == "CA"
    assert cbla.city == "Toronto"
    assert cbla.frequency == 99.1

    # Test search
    results = station_db.search_stations(query="KQED")
    assert len(results) >= 1
    assert results[0].callsign == "KQED-FM"


def test_fm_f50_50_propagation():
    # 50 kW ERP, 150m HAAT
    # At 1 km, field strength should be strong (>90 dBu)
    e_near = calculate_fm_f50_50_field_strength(distance_km=1.0, haat_m=150.0, erp_kw=50.0)
    assert e_near > 90.0

    # At 100 km, field strength should be attenuated
    e_far = calculate_fm_f50_50_field_strength(distance_km=100.0, haat_m=150.0, erp_kw=50.0)
    assert e_far < e_near

    # Test distance solver for 60 dBu (should be between 40 km and 90 km for 50 kW @ 150m)
    dist_60 = solve_fm_contour_distance_km(target_dbu=60.0, haat_m=150.0, erp_kw=50.0)
    assert 40.0 <= dist_60 <= 90.0

    # 70 dBu (city grade) contour should be closer than 60 dBu
    dist_70 = solve_fm_contour_distance_km(target_dbu=70.0, haat_m=150.0, erp_kw=50.0)
    assert dist_70 < dist_60


def test_am_groundwave_propagation():
    # 50 kW AM station at 780 kHz
    mvm_near, dbu_near = calculate_am_groundwave_field_strength(
        distance_km=5.0,
        power_kw=50.0,
        freq_khz=780.0
    )
    assert mvm_near > 10.0  # Strong near-field
    assert dbu_near > 80.0

    # Solve distance for 2.0 mV/m
    dist_2mvm = solve_am_contour_distance_km(
        target_mvm=2.0,
        power_kw=50.0,
        freq_khz=780.0
    )
    assert 40.0 <= dist_2mvm <= 180.0


def test_geodesy_and_polygon_generation():
    lat, lon = 40.7128, -74.0060  # New York
    d_km = 50.0
    bearing = 90.0  # East

    dest_lat, dest_lon = destination_point(lat, lon, d_km, bearing)
    assert dest_lon > lon  # Moved east

    dist_calc, brng_calc, cardinal = calculate_distance_bearing(lat, lon, dest_lat, dest_lon)
    assert abs(dist_calc - d_km) < 0.1
    assert abs(brng_calc - bearing) < 1.0
    assert cardinal == "E"

    # Test polygon generation
    radials = [50.0] * 360
    coords = generate_polygon_coordinates(lat, lon, radials)
    assert len(coords) == 361  # Closed ring
    area = calculate_polygon_area_sqkm(coords)
    # Circle area with r=50 km is approx pi * 50^2 ≈ 7853 km²
    assert 7000.0 < area < 8500.0


def test_station_contour_pipeline():
    wnyc = station_db.get_by_callsign("WNYC-FM")
    tiers, geojson, profile, power, pattern = generate_station_contours(wnyc)

    assert len(tiers) == 4
    assert geojson["type"] == "FeatureCollection"
    assert len(geojson["features"]) == 5  # 4 contours + 1 transmitter point
    assert len(profile) > 10

    # Test Probe
    probe = probe_signal_at_location(wnyc, probe_lat=40.7589, probe_lon=-73.9851)
    assert probe.callsign == "WNYC-FM"
    assert probe.field_strength_dbu > 60.0
    assert "Stereo" in probe.reception_quality or "Quieting" in probe.reception_quality


def test_am_day_night_patterns():
    # Test 50 kW AM station: WBBM or CFRB
    cfrb = station_db.get_by_callsign("CFRB")
    assert cfrb is not None
    assert cfrb.band == "AM"

    # 1. Day Mode
    day_tiers, day_geojson, day_profile, day_power, day_pat = generate_station_contours(cfrb, mode="day")
    assert len(day_tiers) == 4
    assert "Day" in day_tiers[0].name
    day_primary_radius = day_tiers[2].avg_radius_km  # 2 mV/m primary service

    # 2. Night Mode
    night_tiers, night_geojson, night_profile, night_power, night_pat = generate_station_contours(cfrb, mode="night")
    assert len(night_tiers) == 4
    assert "Skywave" in night_tiers[2].name or "Nighttime" in night_tiers[2].name

    # Night Skywave reaches significantly farther (>300 km) than daytime groundwave
    night_skywave_radius = night_tiers[2].avg_radius_km
    assert night_skywave_radius > day_primary_radius
    assert night_skywave_radius >= 250.0

    # Test Nighttime Probe at distant location (e.g. 400 km away)
    probe_night = probe_signal_at_location(cfrb, probe_lat=45.4215, probe_lon=-75.6972, mode="night") # Ottawa from Toronto (~350km)
    assert probe_night.mode == "NIGHT"
    assert probe_night.distance_km > 300.0
    assert probe_night.field_strength_dbu > 35.0  # Decent skywave signal in Ottawa

