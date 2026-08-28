import math
from typing import List, Tuple, Dict, Any

EARTH_RADIUS_KM = 6371.0088

CARDINALS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
]


def destination_point(lat_deg: float, lon_deg: float, distance_km: float, bearing_deg: float) -> Tuple[float, float]:
    """
    Calculate destination latitude and longitude given a starting point,
    distance in kilometers, and initial bearing in degrees using spherical geodesy.
    """
    lat1 = math.radians(lat_deg)
    lon1 = math.radians(lon_deg)
    brng = math.radians(bearing_deg)
    d_r = distance_km / EARTH_RADIUS_KM

    lat2 = math.asin(
        math.sin(lat1) * math.cos(d_r) +
        math.cos(lat1) * math.sin(d_r) * math.cos(brng)
    )
    lon2 = lon1 + math.atan2(
        math.sin(brng) * math.sin(d_r) * math.cos(lat1),
        math.cos(d_r) - math.sin(lat1) * math.sin(lat2)
    )
    # Normalize lon2 between -180 and +180
    lon2 = (lon2 + 3 * math.pi) % (2 * math.pi) - math.pi

    return math.degrees(lat2), math.degrees(lon2)


def calculate_distance_bearing(lat1_deg: float, lon1_deg: float, lat2_deg: float, lon2_deg: float) -> Tuple[float, float, str]:
    """
    Calculate great circle distance (km), initial bearing (degrees), and cardinal direction.
    """
    phi1 = math.radians(lat1_deg)
    phi2 = math.radians(lat2_deg)
    d_phi = math.radians(lat2_deg - lat1_deg)
    d_lambda = math.radians(lon2_deg - lon1_deg)

    # Haversine distance
    a = math.sin(d_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2.0) ** 2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    distance_km = EARTH_RADIUS_KM * c

    # Initial bearing
    y = math.sin(d_lambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(d_lambda)
    bearing_rad = math.atan2(y, x)
    bearing_deg = (math.degrees(bearing_rad) + 360.0) % 360.0

    # Cardinal direction
    idx = int((bearing_deg + 11.25) / 22.5) % 16
    cardinal = CARDINALS[idx]

    return distance_km, bearing_deg, cardinal


def generate_polygon_coordinates(center_lat: float, center_lon: float, radial_distances_km: List[float]) -> List[List[float]]:
    """
    Generates a GeoJSON polygon ring (list of [lon, lat]) from a list of radial distances.
    Supports 360 radials (1 degree step) or any evenly spaced radial count.
    """
    num_radials = len(radial_distances_km)
    coords = []
    step = 360.0 / num_radials

    for i, dist_km in enumerate(radial_distances_km):
        bearing = i * step
        # Minimum radius 0.5 km to prevent degenerate geometry
        safe_dist = max(0.5, dist_km)
        lat, lon = destination_point(center_lat, center_lon, safe_dist, bearing)
        coords.append([round(lon, 5), round(lat, 5)])

    # Close the polygon ring
    if coords:
        coords.append(coords[0])

    return coords


def calculate_polygon_area_sqkm(coordinates: List[List[float]]) -> float:
    """
    Calculate spherical area of a GeoJSON polygon coordinate ring in square kilometers.
    """
    if len(coordinates) < 4:
        return 0.0

    area = 0.0
    rad = math.pi / 180.0
    r = EARTH_RADIUS_KM

    for i in range(len(coordinates) - 1):
        p1 = coordinates[i]
        p2 = coordinates[i + 1]
        area += (p2[0] - p1[0]) * rad * (2 + math.sin(p1[1] * rad) + math.sin(p2[1] * rad))

    area = abs(area * r * r / 2.0)
    return round(area, 1)
