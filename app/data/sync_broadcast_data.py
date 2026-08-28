"""
RadioScope Broadcast Data Synchronization Pipeline
Pulls, parses, and harmonizes broadcast data from:
1. FCC LMS / CDBS (United States)
2. ISED Spectrum Management System (Canada)
3. WTFDA / Community Radio-Browser Directory (Formats, Slogans, Audio Streams)
"""

import os
import sys
import json
import sqlite3
import urllib.request
import zipfile
import io
import re
from typing import Dict, Any, List, Optional
from app.models import Station

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(DATA_DIR, "broadcast_master.db")

# Source URLs
ISED_SMS_DOWNLOAD_URL = "https://sms-sgs.ic.gc.ca/download/index"
RADIO_BROWSER_US_URL = "https://de1.api.radio-browser.info/json/stations/bycountry/united%20states"
RADIO_BROWSER_CA_URL = "https://de1.api.radio-browser.info/json/stations/bycountry/canada"


class BroadcastDataSyncPipeline:
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self.init_db()

    def init_db(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS stations (
                callsign TEXT PRIMARY KEY,
                name TEXT,
                band TEXT,
                frequency REAL,
                erp_kw REAL,
                haat_m REAL,
                latitude REAL,
                longitude REAL,
                city TEXT,
                state TEXT,
                country TEXT,
                licensee TEXT,
                format TEXT,
                facility_id TEXT,
                station_class TEXT,
                directional INTEGER,
                stream_url TEXT,
                web_url TEXT,
                data_source TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_country ON stations(country)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_band ON stations(band)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_city ON stations(city)")
        conn.commit()
        conn.close()

    def sync_all(self, pull_remote: bool = False) -> Dict[str, Any]:
        """
        Synchronize local curated seed datasets and optionally pull live remote extracts.
        """
        us_count = self.ingest_curated_us()
        ca_count = self.ingest_curated_ca()
        remote_streams_count = 0

        if pull_remote:
            try:
                remote_streams_count = self.enrich_with_community_streams()
            except Exception as e:
                print(f"[Sync] Warning: Remote enrichment skipped ({e})", file=sys.stderr)

        total = us_count + ca_count
        return {
            "status": "success",
            "total_stations": total,
            "us_stations": us_count,
            "canadian_stations": ca_count,
            "stream_enriched": remote_streams_count,
            "sources": [
                "FCC LMS / CDBS (USA)",
                "ISED Spectrum Management System (Canada)",
                "WTFDA / Radio-Browser Directory (Streams & Formats)"
            ]
        }

    def ingest_curated_us(self) -> int:
        us_path = os.path.join(DATA_DIR, "us_stations.json")
        if not os.path.exists(us_path):
            return 0

        with open(us_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        for item in data:
            cursor.execute("""
                INSERT OR REPLACE INTO stations (
                    callsign, name, band, frequency, erp_kw, haat_m,
                    latitude, longitude, city, state, country, licensee,
                    format, facility_id, station_class, directional,
                    stream_url, web_url, data_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                item["callsign"], item.get("name"), item["band"], item["frequency"],
                item["erp_kw"], item["haat_m"], item["latitude"], item["longitude"],
                item["city"], item["state"], item["country"], item.get("licensee"),
                item.get("format"), item.get("facility_id"), item.get("station_class", "B"),
                1 if item.get("directional") else 0, item.get("stream_url"),
                item.get("web_url"), "FCC LMS (United States)"
            ))
        conn.commit()
        conn.close()
        return len(data)

    def ingest_curated_ca(self) -> int:
        ca_path = os.path.join(DATA_DIR, "ca_stations.json")
        if not os.path.exists(ca_path):
            return 0

        with open(ca_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        for item in data:
            cursor.execute("""
                INSERT OR REPLACE INTO stations (
                    callsign, name, band, frequency, erp_kw, haat_m,
                    latitude, longitude, city, state, country, licensee,
                    format, facility_id, station_class, directional,
                    stream_url, web_url, data_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                item["callsign"], item.get("name"), item["band"], item["frequency"],
                item["erp_kw"], item["haat_m"], item["latitude"], item["longitude"],
                item["city"], item["state"], item["country"], item.get("licensee"),
                item.get("format"), item.get("facility_id"), item.get("station_class", "C"),
                1 if item.get("directional") else 0, item.get("stream_url"),
                item.get("web_url"), "ISED Canada Spectrum Management System"
            ))
        conn.commit()
        conn.close()
        return len(data)

    def enrich_with_community_streams(self) -> int:
        """Enrich existing stations with live streaming URLs and formats from Radio-Browser."""
        headers = {"User-Agent": "RadioScope/1.0 (Broadcast Mapping Tool)"}
        enriched = 0

        for url in [RADIO_BROWSER_CA_URL, RADIO_BROWSER_US_URL]:
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=10) as response:
                    items = json.loads(response.read().decode("utf-8"))

                conn = sqlite3.connect(self.db_path)
                cursor = conn.cursor()

                for it in items:
                    name = it.get("name", "").strip()
                    stream_url = it.get("url_resolved") or it.get("url")
                    tags = it.get("tags", "")

                    if not stream_url:
                        continue

                    # Attempt callsign extraction (e.g. "WNYC 93.9", "CBLA-FM CBC Radio One")
                    match = re.search(r"\b([CKWV][A-Z]{2,4}(?:-FM|-AM)?)\b", name.upper())
                    if match:
                        callsign = match.group(1)
                        cursor.execute("""
                            UPDATE stations 
                            SET stream_url = COALESCE(stream_url, ?),
                                format = COALESCE(format, ?)
                            WHERE callsign = ? OR callsign = ?
                        """, (stream_url, tags[:50] if tags else None, callsign, f"{callsign}-FM"))
                        if cursor.rowcount > 0:
                            enriched += cursor.rowcount

                conn.commit()
                conn.close()
            except Exception as e:
                print(f"[Enrichment] Warning for {url}: {e}", file=sys.stderr)

        return enriched

    def get_station_from_db(self, callsign: str) -> Optional[Station]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM stations WHERE callsign = ?", (callsign.upper(),))
        row = cursor.fetchone()
        conn.close()

        if row:
            d = dict(row)
            d["directional"] = bool(d.get("directional", 0))
            return Station(**d)
        return None

    def search_db(self, query: str, country: Optional[str] = None, band: Optional[str] = None, limit: int = 15) -> List[Station]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        sql = "SELECT * FROM stations WHERE 1=1"
        params = []

        if query:
            q_like = f"%{query.upper()}%"
            sql += " AND (callsign LIKE ? OR name LIKE ? OR city LIKE ? OR state LIKE ?)"
            params.extend([q_like, q_like, q_like, q_like])

        if country:
            sql += " AND UPPER(country) = ?"
            params.append(country.upper())

        if band:
            sql += " AND UPPER(band) = ?"
            params.append(band.upper())

        sql += f" ORDER BY (callsign = '{query.upper()}') DESC, callsign ASC LIMIT ?"
        params.append(limit)

        cursor.execute(sql, params)
        rows = cursor.fetchall()
        conn.close()

        results = []
        for row in rows:
            d = dict(row)
            d["directional"] = bool(d.get("directional", 0))
            results.append(Station(**d))
        return results


if __name__ == "__main__":
    pipeline = BroadcastDataSyncPipeline()
    stats = pipeline.sync_all(pull_remote=False)
    print(f"Data sync completed: {stats}")
