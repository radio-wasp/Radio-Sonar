# Radio SONAR

**Radio Intelligence Platform** — Monitor Canadian radio stations in real time, detect commercials, log music, record ad breaks, and analyze advertiser data across multiple networks.

---

## Features

- **Live metadata monitoring** across Bell, Rogers, Corus, Stingray, Maritime Broadcasting, Vista, Pattison, and Acadia Broadcasting
- **Commercial detection** using network-specific signals (Triton ad types, blank titles, ad-store segment URLs)
- **Music & commercial history** logging per station with timestamps
- **Automatic recording** of commercial breaks as MP3 files
- **MusicBrainz integration** — look up and apply canonical artist/title/album/artwork to logged songs
- **Station library** with 300+ Canadian stations across 9 networks
- **Apple Music-style UI** with light/dark mode

---

## Getting Started

### Requirements

- Docker and Docker Compose
- Portainer (optional, recommended for management)

### Installation

1. Clone the repository
2. Run `docker-compose up -d`
3. Open `http://localhost:8090` in your browser

---

## Adding Stations

Click **📻 Find Station** in the top navigation bar.

**Library mode** — Browse pre-configured stations by network. Select a network, choose a station, and click **ADD TO STATIONS**. The station is saved immediately with the correct metadata source and stream URL.

**Search mode** — Search by call letters, city, or brand name across TuneIn, iHeart, and Radio Browser.

**Manual** — Go to **Stations → Add Station** and fill in the stream URL. Use **📻 TuneIn Lookup** to auto-fill the metadata URL, or **🔍 Radio Browser** to fetch the station logo.

---

## Monitoring Stations

On the **Monitor** tab, click the **▶ START** button next to any saved station. The monitor card shows:

- Current song or commercial playing
- Time elapsed
- Ad detection status
- Album artwork (from metadata or MusicBrainz)

Use the **REC** toggle to record commercial breaks automatically. Recordings appear in the **Recordings** tab.

---

## Ad Detection

Radio SONAR uses network-specific detection methods:

| Network | Method |
| --- | --- |
| Bell | Triton XML `type="ad"` signal |
| Rogers | Blank title or stall |
| Corus | Blank title or stall |
| Stingray | Blank title or stall |
| Maritime | Blank title (clean signal) |
| Vista | Blank title (clean signal) |
| Pattison | Blank title or `comment=COM` keyword |
| Acadia | `/audio-store/ads/` segment URL |

### Keyword Detection

The **Keyword** trigger mode lets you specify a text string that, when found in the metadata title, marks a segment as a commercial.

**Pattison stations** send `comment=COMxxxxxxx` in the title field during some commercial breaks. Set the trigger keyword to `comment=COM` to catch these.

Example: a metadata title of `comment=COM3047-1780673810.13-28.7` will be detected as a commercial when the keyword `comment=COM` is configured.

To set a keyword trigger, edit the station and set **Trigger Mode** to **Keyword**, then enter your keyword in the **Keywords** field (comma-separate multiple keywords).

---

## Music History

The **Music** tab logs every song played on monitored stations. Click **🔎 MB** on any entry to look it up on MusicBrainz and apply canonical metadata and album artwork. Use **🗓 PURGE 30d+** to remove entries older than 30 days, or **CLEAR ALL** to wipe the log for a station.

---

## Commercial History

The **Commercials** tab shows all detected ad breaks with duration and timestamps. Recorded ad files can be played or downloaded from the **Recordings** tab.

---

## Supported Networks

- **Bell Media** — 55 stations (Triton Digital streams)
- **Rogers Radio** — 47 stations
- **Corus Entertainment** — 36 stations
- **Stingray Radio** — 72 stations
- **Maritime Broadcasting** — 25 stations
- **Vista Radio** — 68 stations
- **Pattison Media** — 37 stations
- **Acadia Broadcasting** — 14 stations (Futuri/cdnstream)

---

## Tools

Access via **🔧 Tools** in the header:

- **Probe Stream URL** — test any stream URL and detect its metadata format
- **Repair Metadata URLs** — fix corrupted metadata URLs in saved stations
- **Rebuild Bell URLs** — regenerate Triton metadata URLs for Bell stations
- **Refresh All Logos** — clear and re-fetch all station logos from Radio Browser

---

## Settings

Recording auto-purge and retention settings are available at the bottom of the **Stations** tab.

---

*Radio SONAR · Beta 1.1 · Built for Canadian radio monitoring*
