from typing import List, Optional, Dict, Any

try:
    from pydantic import BaseModel, Field
except ImportError:
    from dataclasses import dataclass, field
    class BaseModel:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
        def model_dump(self):
            return self.__dict__
        def dict(self):
            return self.__dict__
    def Field(*args, **kwargs):
        return None


class Station(BaseModel):
    callsign: str
    name: Optional[str] = None
    band: str = "FM"  # "FM" or "AM"
    frequency: float  # e.g., 93.9 for FM, 880 for AM
    erp_kw: float = 50.0  # Primary / Daytime power in kW
    haat_m: float = 150.0  # Height Above Average Terrain in meters
    latitude: float
    longitude: float
    city: str = ""
    state: str = ""  # State or Province (e.g. NY, ON, CA, QC)
    country: str = "US"  # "US" or "CA"
    licensee: Optional[str] = None
    format: Optional[str] = None
    facility_id: Optional[str] = None
    station_class: Optional[str] = "B"
    directional: bool = False
    
    # AM Day / Night Specific Technical Parameters
    day_power_kw: Optional[float] = None
    night_power_kw: Optional[float] = None
    day_directional: Optional[bool] = None
    night_directional: Optional[bool] = None
    night_beam_deg: Optional[float] = 0.0
    daytimer_only: Optional[bool] = False

    stream_url: Optional[str] = None
    web_url: Optional[str] = None


class ContourTier(BaseModel):
    level_dbu: float
    level_mvm: float
    name: str
    description: str
    color: str
    stroke_color: str
    fill_opacity: float
    avg_radius_km: float
    max_radius_km: float
    area_sqkm: float
    area_sqmi: float
    geometry: Dict[str, Any]  # GeoJSON Polygon geometry


class RadialProfilePoint(BaseModel):
    distance_km: float
    field_strength_dbu: float
    field_strength_mvm: float
    s_meter: str
    quality: str


class CoverageResponse(BaseModel):
    station: Station
    coverage_mode: str = "day"  # "day" or "night"
    operating_power_kw: float
    operating_pattern: str
    contours: List[ContourTier]
    geojson: Dict[str, Any]  # GeoJSON FeatureCollection
    radial_profile: List[RadialProfilePoint]
    center_coords: List[float]  # [lat, lon]
    est_population: int
    source: str = "FCC F(50,50) & AM Groundwave/Skywave Standards"


class SignalProbeRequest(BaseModel):
    callsign: Optional[str] = None
    station_data: Optional[Station] = None
    mode: str = "day"  # "day" or "night"
    lat: float
    lon: float


class SignalProbeResponse(BaseModel):
    callsign: str
    station_freq: str
    mode: str
    distance_km: float
    distance_mi: float
    bearing_deg: float
    bearing_cardinal: str
    field_strength_dbu: float
    field_strength_mvm: float
    s_meter: str
    reception_quality: str
    reception_badge_color: str
    notes: str


class CustomTransmitterRequest(BaseModel):
    callsign: str = "CUSTOM"
    name: str = "Custom Transmitter"
    band: str = "FM"
    frequency: float = 98.5
    erp_kw: float = 25.0
    haat_m: float = 120.0
    latitude: float = 40.7128
    longitude: float = -74.0060
    city: str = "Custom Location"
    state: str = "NA"
    country: str = "US"
    mode: str = "day"  # "day" or "night"
    day_power_kw: Optional[float] = 25.0
    night_power_kw: Optional[float] = 5.0
    directional: bool = False
    pattern_beam_deg: Optional[float] = 0.0
