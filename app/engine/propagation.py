import math
from typing import List, Dict, Tuple, Any
from app.models import Station, ContourTier, RadialProfilePoint, SignalProbeResponse
from app.engine.geodesy import (
    calculate_distance_bearing,
    generate_polygon_coordinates,
    calculate_polygon_area_sqkm
)

# Standard FM Contour Tiers (dBu)
FM_CONTOURS = [
    {
        "level_dbu": 70.0,
        "name": "City Grade (70 dBu / 3.16 mV/m)",
        "description": "Strong, pristine indoor and mobile stereo reception. Solid building penetration.",
        "color": "#10b981",
        "stroke_color": "#059669",
        "fill_opacity": 0.35,
    },
    {
        "level_dbu": 60.0,
        "name": "Protected Service (60 dBu / 1.00 mV/m)",
        "description": "Standard licensed coverage area. Clear car stereo and home antenna reception.",
        "color": "#3b82f6",
        "stroke_color": "#2563eb",
        "fill_opacity": 0.25,
    },
    {
        "level_dbu": 54.0,
        "name": "Secondary / Suburban (54 dBu / 0.50 mV/m)",
        "description": "Moderate signal. Good car radio reception; may experience light noise indoors.",
        "color": "#f59e0b",
        "stroke_color": "#d97706",
        "fill_opacity": 0.18,
    },
    {
        "level_dbu": 48.0,
        "name": "Fringe / DX (48 dBu / 0.25 mV/m)",
        "description": "Weak signal boundary. Sensitive car tuner or outdoor high-gain antenna required.",
        "color": "#8b5cf6",
        "stroke_color": "#7c3aed",
        "fill_opacity": 0.12,
    },
]

# Standard AM Daytime Contour Tiers (mV/m and equivalent dBu)
AM_DAY_CONTOURS = [
    {
        "level_mvm": 25.0,
        "level_dbu": 88.0,
        "name": "Daytime City Core (25 mV/m)",
        "description": "High signal strength overcoming heavy urban electromagnetic interference.",
        "color": "#10b981",
        "stroke_color": "#059669",
        "fill_opacity": 0.35,
    },
    {
        "level_mvm": 5.0,
        "level_dbu": 74.0,
        "name": "Daytime City Grade (5 mV/m)",
        "description": "Solid residential groundwave coverage with low background noise.",
        "color": "#3b82f6",
        "stroke_color": "#2563eb",
        "fill_opacity": 0.25,
    },
    {
        "level_mvm": 2.0,
        "level_dbu": 66.0,
        "name": "Daytime Primary Service (2 mV/m)",
        "description": "Official daytime primary protected groundwave service boundary.",
        "color": "#f59e0b",
        "stroke_color": "#d97706",
        "fill_opacity": 0.18,
    },
    {
        "level_mvm": 0.5,
        "level_dbu": 54.0,
        "name": "Daytime Rural Protected (0.5 mV/m)",
        "description": "Daytime rural groundwave service contour boundary.",
        "color": "#8b5cf6",
        "stroke_color": "#7c3aed",
        "fill_opacity": 0.12,
    },
]

# Standard AM Nighttime Contour Tiers (Groundwave NIF + Ionospheric Skywave)
AM_NIGHT_CONTOURS = [
    {
        "level_mvm": 10.0,
        "level_dbu": 80.0,
        "name": "Nighttime Interference-Free Groundwave (10 mV/m)",
        "description": "Primary local groundwave area free from co-channel nighttime skywave interference.",
        "color": "#10b981",
        "stroke_color": "#059669",
        "fill_opacity": 0.35,
    },
    {
        "level_mvm": 2.0,
        "level_dbu": 66.0,
        "name": "Nighttime Groundwave Service (2 mV/m)",
        "description": "Nighttime groundwave service boundary subject to phased array directional nulls.",
        "color": "#3b82f6",
        "stroke_color": "#2563eb",
        "fill_opacity": 0.22,
    },
    {
        "level_mvm": 0.5,
        "level_dbu": 54.0,
        "name": "Nighttime 50% Skywave Protected Area (0.5 mV/m)",
        "description": "Secondary ionospheric F-layer skywave coverage (300 - 1,000+ km clear-channel reach).",
        "color": "#ec4899",  # Pink/Magenta for Skywave
        "stroke_color": "#db2777",
        "fill_opacity": 0.16,
    },
    {
        "level_mvm": 0.1,
        "level_dbu": 40.0,
        "name": "Nighttime Skywave DX Fringe (0.1 mV/m)",
        "description": "Distant nighttime skip zone receivable across multiple provinces and states.",
        "color": "#8b5cf6",
        "stroke_color": "#7c3aed",
        "fill_opacity": 0.10,
    },
]


def dbu_to_mvm(dbu: float) -> float:
    return round(10.0 ** ((dbu - 60.0) / 20.0), 3)


def mvm_to_dbu(mvm: float) -> float:
    if mvm <= 0:
        return 0.0
    return round(20.0 * math.log10(mvm) + 60.0, 1)


# =========================================================================
# FM Propagation Model (47 CFR § 73.313 / § 73.333 & ITU-R P.1546)
# =========================================================================

def calculate_fm_f50_50_field_strength(distance_km: float, haat_m: float, erp_kw: float) -> float:
    if distance_km <= 0.1:
        distance_km = 0.1
    haat = max(10.0, min(1600.0, haat_m))
    erp = max(0.001, erp_kw)

    d_los = 4.124 * (math.sqrt(haat) + math.sqrt(2.0))
    erp_dbk = 10.0 * math.log10(erp)
    height_gain = 20.0 * math.log10(haat / 100.0)

    if distance_km <= d_los:
        ratio = distance_km / max(1.0, d_los)
        attenuation_exponent = 20.0 + 15.0 * (ratio ** 1.5)
        path_loss = attenuation_exponent * math.log10(distance_km)
    else:
        los_loss = 35.0 * math.log10(d_los)
        scatter_loss = 48.0 * math.log10(distance_km / d_los)
        path_loss = los_loss + scatter_loss

    f_1kw = 106.92 + height_gain - path_loss - 2.5
    e_field = f_1kw + erp_dbk
    return max(0.0, min(140.0, e_field))


def solve_fm_contour_distance_km(target_dbu: float, haat_m: float, erp_kw: float) -> float:
    d_min, d_max = 0.5, 250.0
    e_min = calculate_fm_f50_50_field_strength(d_min, haat_m, erp_kw)
    if target_dbu >= e_min:
        return d_min
    e_max = calculate_fm_f50_50_field_strength(d_max, haat_m, erp_kw)
    if target_dbu <= e_max:
        return d_max

    for _ in range(30):
        d_mid = (d_min + d_max) / 2.0
        e_mid = calculate_fm_f50_50_field_strength(d_mid, haat_m, erp_kw)
        if abs(e_mid - target_dbu) < 0.05:
            return round(d_mid, 2)
        if e_mid > target_dbu:
            d_min = d_mid
        else:
            d_max = d_mid
    return round((d_min + d_max) / 2.0, 2)


# =========================================================================
# AM Groundwave & Nighttime Skywave Propagation Model (FCC 47 CFR § 73.184 / § 73.190)
# =========================================================================

def calculate_am_groundwave_field_strength(
    distance_km: float,
    power_kw: float,
    freq_khz: float,
    conductivity_ms: float = 8.0
) -> Tuple[float, float]:
    if distance_km <= 0.1:
        distance_km = 0.1
    p_kw = max(0.05, power_kw)
    freq_mhz = freq_khz / 1000.0
    sigma = max(0.5, conductivity_ms)

    e0_mvm = 350.0 * math.sqrt(p_kw)
    p = (0.00844 * distance_km * (freq_mhz ** 2)) / sigma
    a_p = (2.0 + 0.3 * p) / (2.0 + p + 0.6 * (p ** 2))
    curvature_loss = math.exp(-0.012 * (freq_mhz ** (1.0 / 3.0)) * distance_km)
    a_factor = a_p * curvature_loss

    e_mvm = (e0_mvm / distance_km) * a_factor
    e_dbu = mvm_to_dbu(e_mvm)
    return e_mvm, e_dbu


def calculate_am_nighttime_skywave_field_strength(
    distance_km: float,
    power_kw: float,
    freq_khz: float
) -> Tuple[float, float]:
    """
    FCC 47 CFR § 73.190 50% Skywave Field Strength Curve.
    Models ionospheric reflection via F-layer during nighttime.
    """
    if distance_km < 80.0:
        # Near field is dominated by groundwave; skywave skip zone starts ~80-100km
        return 0.0, 0.0

    p_kw = max(0.05, power_kw)
    # 50% median skywave field strength at 1000 km for 1 kW is approx 0.1 mV/m (40 dBu)
    # Peak skywave occurs between 300 km and 1200 km
    d = distance_km
    # FCC empirical skywave attenuation formula:
    # E_skywave = (E_1000 / d_scale) * sqrt(P_kw)
    sky_factor = 280.0 / (1.0 + (abs(d - 550.0) / 450.0) ** 1.6)
    e_mvm = (sky_factor / d) * math.sqrt(p_kw) * 0.45
    e_dbu = mvm_to_dbu(e_mvm)
    return e_mvm, e_dbu


def solve_am_groundwave_distance_km(
    target_mvm: float,
    power_kw: float,
    freq_khz: float,
    conductivity_ms: float = 8.0
) -> float:
    d_min, d_max = 0.5, 400.0
    for _ in range(30):
        d_mid = (d_min + d_max) / 2.0
        e_mvm, _ = calculate_am_groundwave_field_strength(d_mid, power_kw, freq_khz, conductivity_ms)
        if abs(e_mvm - target_mvm) < 0.01:
            return round(d_mid, 2)
        if e_mvm > target_mvm:
            d_min = d_mid
        else:
            d_max = d_mid
    return round((d_min + d_max) / 2.0, 2)


solve_am_contour_distance_km = solve_am_groundwave_distance_km



def solve_am_skywave_distance_km(
    target_mvm: float,
    power_kw: float,
    freq_khz: float
) -> float:
    """
    Solve for nighttime skywave coverage radius (km).
    """
    p_kw = max(0.1, power_kw)
    if target_mvm <= 0.1:
        # Skywave DX limit (0.1 mV/m)
        return round(min(1800.0, 450.0 * math.sqrt(p_kw) + 300.0), 1)
    elif target_mvm <= 0.5:
        # 50% Protected Skywave area (0.5 mV/m)
        return round(min(1200.0, 220.0 * math.sqrt(p_kw) + 180.0), 1)
    else:
        return 300.0


# =========================================================================
# Directional Phased Arrays & Azimuth Patterns
# =========================================================================

def get_am_directional_multiplier(
    azimuth_deg: float,
    mode: str = "day",
    is_directional: bool = False,
    beam_heading_deg: float = 0.0
) -> float:
    """
    Calculates antenna pattern relative field power along given azimuth.
    In night mode, AM stations often deploy deep nulls (e.g. 20-30 dB down)
    to protect co-channel stations in other markets.
    """
    if not is_directional:
        return 1.0

    angle_diff = math.radians(azimuth_deg - beam_heading_deg)
    if mode == "night":
        # Sharp multi-tower cardioid / figure-8 array with deep side/back nulls
        rel_field = 0.08 + 0.92 * (0.5 * (1.0 + math.cos(angle_diff))) ** 2
    else:
        # Daytime directional (broader lobe)
        rel_field = 0.25 + 0.75 * (0.5 * (1.0 + math.cos(angle_diff)))

    return max(0.01, min(1.0, rel_field ** 2))


# =========================================================================
# Coverage Pipeline with Day / Night Mode Support
# =========================================================================

def generate_station_contours(
    station: Station,
    mode: str = "day"
) -> Tuple[List[ContourTier], Dict[str, Any], List[RadialProfilePoint], float, str]:
    """
    Generate coverage contours for FM or AM (with Day or Night pattern).
    """
    is_am = station.band.upper() == "AM"
    calculated_tiers: List[ContourTier] = []
    features: List[Dict[str, Any]] = []
    num_radials = 360

    # Determine Operating Power and Directional Status
    if is_am:
        if mode == "night":
            operating_power = station.night_power_kw if station.night_power_kw is not None else max(1.0, round(station.erp_kw * 0.2, 1))
            is_directional = station.night_directional if station.night_directional is not None else True
            pattern_desc = f"Night Pattern: {operating_power} kW ({'Directional Array (DA-2/DA-N)' if is_directional else 'Non-Directional'})"
            tiers_config = AM_NIGHT_CONTOURS
        else:
            operating_power = station.day_power_kw if station.day_power_kw is not None else station.erp_kw
            is_directional = station.day_directional if station.day_directional is not None else station.directional
            pattern_desc = f"Day Pattern: {operating_power} kW ({'Directional Array (DA-1/DA-D)' if is_directional else 'Non-Directional (ND)'})"
            tiers_config = AM_DAY_CONTOURS
    else:
        operating_power = station.erp_kw
        is_directional = station.directional
        pattern_desc = f"FM Broadcast: {operating_power} kW ({'Directional' if is_directional else 'Omni'})"
        tiers_config = FM_CONTOURS

    beam_heading = station.night_beam_deg if mode == "night" else 0.0

    for tier_info in tiers_config:
        radial_distances: List[float] = []

        is_skywave_tier = is_am and mode == "night" and "Skywave" in tier_info["name"]

        for azimuth in range(num_radials):
            power_mult = get_am_directional_multiplier(
                azimuth,
                mode=mode,
                is_directional=is_directional,
                beam_heading_deg=beam_heading
            )
            effective_p = operating_power * power_mult

            if is_am:
                if is_skywave_tier:
                    dist = solve_am_skywave_distance_km(
                        target_mvm=tier_info["level_mvm"],
                        power_kw=effective_p,
                        freq_khz=station.frequency
                    )
                else:
                    dist = solve_am_groundwave_distance_km(
                        target_mvm=tier_info["level_mvm"],
                        power_kw=effective_p,
                        freq_khz=station.frequency,
                        conductivity_ms=8.0
                    )
            else:
                dist = solve_fm_contour_distance_km(
                    target_dbu=tier_info["level_dbu"],
                    haat_m=station.haat_m,
                    erp_kw=effective_p
                )

            radial_distances.append(dist)

        coords_ring = generate_polygon_coordinates(
            station.latitude,
            station.longitude,
            radial_distances
        )
        area_sqkm = calculate_polygon_area_sqkm(coords_ring)
        area_sqmi = round(area_sqkm * 0.386102, 1)
        avg_radius = round(sum(radial_distances) / len(radial_distances), 1)
        max_radius = round(max(radial_distances), 1)

        level_dbu = tier_info["level_dbu"]
        level_mvm = tier_info.get("level_mvm", dbu_to_mvm(level_dbu))

        geometry_polygon = {
            "type": "Polygon",
            "coordinates": [coords_ring]
        }

        tier_obj = ContourTier(
            level_dbu=level_dbu,
            level_mvm=level_mvm,
            name=tier_info["name"],
            description=tier_info["description"],
            color=tier_info["color"],
            stroke_color=tier_info["stroke_color"],
            fill_opacity=tier_info["fill_opacity"],
            avg_radius_km=avg_radius,
            max_radius_km=max_radius,
            area_sqkm=area_sqkm,
            area_sqmi=area_sqmi,
            geometry=geometry_polygon
        )
        calculated_tiers.append(tier_obj)

        features.append({
            "type": "Feature",
            "properties": {
                "callsign": station.callsign,
                "tier_name": tier_info["name"],
                "mode": mode,
                "level_dbu": level_dbu,
                "level_mvm": level_mvm,
                "avg_radius_km": avg_radius,
                "area_sqkm": area_sqkm,
                "area_sqmi": area_sqmi,
                "color": tier_info["color"],
                "stroke_color": tier_info["stroke_color"],
                "fill_opacity": tier_info["fill_opacity"],
                "description": tier_info["description"]
            },
            "geometry": geometry_polygon
        })

    # Add Transmitter Pin
    features.append({
        "type": "Feature",
        "properties": {
            "type": "transmitter",
            "callsign": station.callsign,
            "name": station.name or station.callsign,
            "frequency": f"{station.frequency} {'MHz' if not is_am else 'kHz'}",
            "band": station.band,
            "operating_power_kw": operating_power,
            "operating_pattern": pattern_desc,
            "haat_m": station.haat_m,
            "city": station.city,
            "state": station.state,
            "country": station.country
        },
        "geometry": {
            "type": "Point",
            "coordinates": [round(station.longitude, 5), round(station.latitude, 5)]
        }
    })

    geojson_collection = {
        "type": "FeatureCollection",
        "features": features
    }

    # Generate Profile Points
    profile_points: List[RadialProfilePoint] = []
    max_profile_dist = max(100.0, min(800.0 if (is_am and mode == "night") else 200.0, calculated_tiers[-1].max_radius_km * 1.1))
    steps = 25
    step_size = max_profile_dist / steps

    for step in range(1, steps + 1):
        d_km = round(step * step_size, 1)
        if is_am:
            gw_mvm, gw_dbu = calculate_am_groundwave_field_strength(d_km, operating_power, station.frequency)
            if mode == "night":
                sky_mvm, sky_dbu = calculate_am_nighttime_skywave_field_strength(d_km, operating_power, station.frequency)
                total_mvm = math.sqrt(gw_mvm ** 2 + sky_mvm ** 2)
                total_dbu = mvm_to_dbu(total_mvm)
            else:
                total_mvm = gw_mvm
                total_dbu = gw_dbu
        else:
            total_dbu = calculate_fm_f50_50_field_strength(d_km, station.haat_m, operating_power)
            total_mvm = dbu_to_mvm(total_dbu)

        s_meter, quality, _ = assess_signal_quality(total_dbu, is_am, mode)

        profile_points.append(RadialProfilePoint(
            distance_km=d_km,
            field_strength_dbu=round(total_dbu, 1),
            field_strength_mvm=round(total_mvm, 3),
            s_meter=s_meter,
            quality=quality
        ))

    return calculated_tiers, geojson_collection, profile_points, operating_power, pattern_desc


def assess_signal_quality(field_strength_dbu: float, is_am: bool = False, mode: str = "day") -> Tuple[str, str, str]:
    if is_am:
        if mode == "night":
            if field_strength_dbu >= 80.0:
                return "S9+20dB", "Pristine Local Night Groundwave (No Fading)", "#10b981"
            elif field_strength_dbu >= 66.0:
                return "S9", "Strong Night Groundwave / Dominant Signal", "#3b82f6"
            elif field_strength_dbu >= 54.0:
                return "S7", "50% Skywave Protected Area (Clear Night Audio)", "#ec4899"
            elif field_strength_dbu >= 40.0:
                return "S4", "Skywave Skip Zone (Distant DX Reception with Selective Fading)", "#8b5cf6"
            else:
                return "S1", "Deep DX / Background Atmospheric Static", "#ef4444"
        else:
            if field_strength_dbu >= 88.0:
                return "S9+30dB", "Pristine Urban Groundwave (Overcomes Heavy Interference)", "#10b981"
            elif field_strength_dbu >= 74.0:
                return "S9+10dB", "Strong City Grade (Clear Audio, Low Noise)", "#059669"
            elif field_strength_dbu >= 66.0:
                return "S9", "Solid Primary Service (Good Daytime Quality)", "#3b82f6"
            elif field_strength_dbu >= 54.0:
                return "S7", "Protected Rural Service (Acceptable Audio)", "#f59e0b"
            elif field_strength_dbu >= 40.0:
                return "S4", "Fringe Daytime (Noticeable Static)", "#8b5cf6"
            else:
                return "S1", "Below Daytime Threshold", "#ef4444"
    else:
        if field_strength_dbu >= 70.0:
            return "S9+20dB", "Pristine High-Fidelity Stereo (Full Quieting)", "#10b981"
        elif field_strength_dbu >= 60.0:
            return "S9", "Clear Stereo Service (Standard Home/Car Quieting)", "#3b82f6"
        elif field_strength_dbu >= 54.0:
            return "S7", "Good Mono / Light Stereo Noise (Secondary Area)", "#f59e0b"
        elif field_strength_dbu >= 48.0:
            return "S5", "Fringe / Noisy Car Radio (Suburban Boundary)", "#8b5cf6"
        else:
            return "S1", "Weak / DX Reception Only", "#ef4444"


def probe_signal_at_location(
    station: Station,
    probe_lat: float,
    probe_lon: float,
    mode: str = "day"
) -> SignalProbeResponse:
    dist_km, bearing_deg, cardinal = calculate_distance_bearing(
        station.latitude, station.longitude,
        probe_lat, probe_lon
    )
    dist_mi = round(dist_km * 0.621371, 1)
    is_am = station.band.upper() == "AM"

    if is_am:
        if mode == "night":
            operating_power = station.night_power_kw if station.night_power_kw is not None else max(1.0, round(station.erp_kw * 0.2, 1))
            is_dir = station.night_directional if station.night_directional is not None else True
        else:
            operating_power = station.day_power_kw if station.day_power_kw is not None else station.erp_kw
            is_dir = station.day_directional if station.day_directional is not None else station.directional
    else:
        operating_power = station.erp_kw
        is_dir = station.directional

    beam_heading = station.night_beam_deg if mode == "night" else 0.0
    power_mult = get_am_directional_multiplier(
        bearing_deg,
        mode=mode,
        is_directional=is_dir,
        beam_heading_deg=beam_heading
    )
    effective_p = operating_power * power_mult

    if is_am:
        gw_mvm, _ = calculate_am_groundwave_field_strength(dist_km, effective_p, station.frequency)
        if mode == "night":
            sky_mvm, _ = calculate_am_nighttime_skywave_field_strength(dist_km, effective_p, station.frequency)
            total_mvm = math.sqrt(gw_mvm ** 2 + sky_mvm ** 2)
            total_dbu = mvm_to_dbu(total_mvm)
            notes = f"Night Mode: {operating_power} kW ({'DA-N Array' if is_dir else 'ND'}). Bearing: {round(bearing_deg, 1)}° ({cardinal}). Skywave skip active."
        else:
            total_mvm = gw_mvm
            total_dbu = mvm_to_dbu(total_mvm)
            notes = f"Day Mode: {operating_power} kW Groundwave. Bearing: {round(bearing_deg, 1)}° ({cardinal})."
    else:
        total_dbu = calculate_fm_f50_50_field_strength(dist_km, station.haat_m, effective_p)
        total_mvm = dbu_to_mvm(total_dbu)
        notes = f"FM Broadcast: {operating_power} kW @ {station.haat_m}m HAAT. Bearing: {round(bearing_deg, 1)}° ({cardinal})."

    s_meter, quality, badge_color = assess_signal_quality(total_dbu, is_am, mode)
    unit_str = "kHz" if is_am else "MHz"

    return SignalProbeResponse(
        callsign=station.callsign,
        station_freq=f"{station.frequency} {unit_str}",
        mode=mode.upper(),
        distance_km=round(dist_km, 1),
        distance_mi=dist_mi,
        bearing_deg=round(bearing_deg, 1),
        bearing_cardinal=cardinal,
        field_strength_dbu=round(total_dbu, 1),
        field_strength_mvm=round(total_mvm, 3),
        s_meter=s_meter,
        reception_quality=quality,
        reception_badge_color=badge_color,
        notes=notes
    )
