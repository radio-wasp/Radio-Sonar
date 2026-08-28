/**
 * RadioScope - Main Application Controller
 */

class RadioScopeApp {
    constructor() {
        this.mapManager = null;
        this.currentCoverage = null;
        this.currentMode = "day";
        this.isPlayingAudio = false;
        this.searchDebounceTimer = null;

        this.dom = {
            searchInput: document.getElementById('callsign-search-input'),
            searchClearBtn: document.getElementById('search-clear-btn'),
            searchSubmitBtn: document.getElementById('search-submit-btn'),
            autocompleteDropdown: document.getElementById('autocomplete-dropdown'),
            
            // Station Card
            stCallsign: document.getElementById('st-callsign'),
            stCountryBadge: document.getElementById('st-country-badge'),
            stBandBadge: document.getElementById('st-band-badge'),
            stName: document.getElementById('st-name'),
            stFrequency: document.getElementById('st-frequency'),
            stErp: document.getElementById('st-erp'),
            stHaat: document.getElementById('st-haat'),
            stClass: document.getElementById('st-class'),
            stLocation: document.getElementById('st-location'),
            stCoords: document.getElementById('st-coords'),
            stLicensee: document.getElementById('st-licensee'),

            // AM Day / Night Switcher
            amModeContainer: document.getElementById('am-mode-toggle-container'),
            btnModeDay: document.getElementById('btn-mode-day'),
            btnModeNight: document.getElementById('btn-mode-night'),

            // Stream
            streamContainer: document.getElementById('live-stream-container'),
            audioPlayer: document.getElementById('audio-player'),
            btnPlayStream: document.getElementById('btn-play-stream'),
            playBtnText: document.getElementById('play-btn-text'),
            playIcon: document.querySelector('.play-icon'),
            pauseIcon: document.querySelector('.pause-icon'),
            volumeSlider: document.getElementById('volume-slider'),

            // Contours List & Profile
            contourTiersList: document.getElementById('contour-tiers-list'),
            profileCanvas: document.getElementById('profile-chart'),

            // Probe
            probeContent: document.getElementById('probe-content'),

            // Modals & Buttons
            btnCustomSim: document.getElementById('btn-custom-sim'),
            customModal: document.getElementById('custom-modal'),
            modalCloseBtn: document.getElementById('modal-close-btn'),
            modalCancelBtn: document.getElementById('modal-cancel-btn'),
            customSimForm: document.getElementById('custom-sim-form'),

            btnExportMenu: document.getElementById('btn-export-menu'),
            exportModal: document.getElementById('export-modal'),
            exportCloseBtn: document.getElementById('export-close-btn'),
            exportGeojsonBtn: document.getElementById('export-geojson-btn'),
            exportKmlBtn: document.getElementById('export-kml-btn'),
            exportReportBtn: document.getElementById('export-report-btn'),
            exportPngBtn: document.getElementById('export-png-btn'),

            // Compare DOM Elements
            btnCompareMenu: document.getElementById('btn-compare-menu'),
            compareBadge: document.getElementById('compare-badge'),
            btnAddCompare: document.getElementById('btn-add-compare'),
            compareModal: document.getElementById('compare-modal'),
            compareCloseBtn: document.getElementById('compare-close-btn'),
            compareSearchInput: document.getElementById('compare-search-input'),
            compareAddBtn: document.getElementById('compare-add-btn'),
            compareSlotsContainer: document.getElementById('compare-slots-container'),
            compareTable: document.getElementById('compare-table'),
            compareClearBtn: document.getElementById('compare-clear-btn'),
            compareOverlayMapBtn: document.getElementById('compare-overlay-map-btn'),

            btnThemeToggle: document.getElementById('btn-theme-toggle'),
            btnRecenter: document.getElementById('btn-recenter'),
            btnToggleProbeTool: document.getElementById('btn-toggle-probe-tool'),
        };

        this.comparedStations = [];
        this.init();
    }

    init() {
        this.mapManager = new CoverageMapManager('map');
        window.radioApp = this;

        this.setupEventListeners();
        this.setupTheme();

        // Load initial default station: WNYC-FM
        this.loadStationCoverage('WNYC-FM');
    }

    setupEventListeners() {
        // Search Input
        this.dom.searchInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            this.dom.searchClearBtn.classList.toggle('hidden', val.length === 0);
            
            clearTimeout(this.searchDebounceTimer);
            if (val.length >= 1) {
                this.searchDebounceTimer = setTimeout(() => this.fetchAutocomplete(val), 200);
            } else {
                this.dom.autocompleteDropdown.classList.add('hidden');
            }
        });

        this.dom.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = this.dom.searchInput.value.trim();
                if (val) {
                    this.dom.autocompleteDropdown.classList.add('hidden');
                    this.loadStationCoverage(val);
                }
            }
        });

        this.dom.searchClearBtn.addEventListener('click', () => {
            this.dom.searchInput.value = '';
            this.dom.searchClearBtn.classList.add('hidden');
            this.dom.autocompleteDropdown.classList.add('hidden');
            this.dom.searchInput.focus();
        });

        this.dom.searchSubmitBtn.addEventListener('click', () => {
            const val = this.dom.searchInput.value.trim();
            if (val) {
                this.dom.autocompleteDropdown.classList.add('hidden');
                this.loadStationCoverage(val);
            }
        });

        // Click outside autocomplete to dismiss
        document.addEventListener('click', (e) => {
            if (!this.dom.searchInput.contains(e.target) && !this.dom.autocompleteDropdown.contains(e.target)) {
                this.dom.autocompleteDropdown.classList.add('hidden');
            }
        });

        // AM Day / Night Mode Switcher
        if (this.dom.btnModeDay && this.dom.btnModeNight) {
            this.dom.btnModeDay.addEventListener('click', () => {
                if (this.currentMode !== 'day') {
                    this.currentMode = 'day';
                    if (this.currentCoverage) {
                        this.loadStationCoverage(this.currentCoverage.station.callsign, 'day');
                    }
                }
            });
            this.dom.btnModeNight.addEventListener('click', () => {
                if (this.currentMode !== 'night') {
                    this.currentMode = 'night';
                    if (this.currentCoverage) {
                        this.loadStationCoverage(this.currentCoverage.station.callsign, 'night');
                    }
                }
            });
        }

        // Quick Suggestion Chips
        document.querySelectorAll('.chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                const call = chip.dataset.callsign;
                if (call) {
                    this.dom.searchInput.value = call;
                    this.loadStationCoverage(call, this.currentMode);
                }
            });
        });

        // Basemap switchers
        document.querySelectorAll('.basemap-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.basemap-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.mapManager.setBasemap(btn.dataset.style);
            });
        });

        // Floating Map Buttons
        this.dom.btnRecenter.addEventListener('click', () => this.mapManager.recenterTransmitter());
        this.dom.btnToggleProbeTool.addEventListener('click', () => {
            this.mapManager.probeEnabled = !this.mapManager.probeEnabled;
            this.dom.btnToggleProbeTool.classList.toggle('active', this.mapManager.probeEnabled);
        });

        // Audio Stream Player
        this.dom.btnPlayStream.addEventListener('click', () => this.toggleStreamPlay());
        this.dom.volumeSlider.addEventListener('input', (e) => {
            this.dom.audioPlayer.volume = parseFloat(e.target.value);
        });

        // Modals
        this.dom.btnCustomSim.addEventListener('click', () => this.dom.customModal.classList.remove('hidden'));
        this.dom.modalCloseBtn.addEventListener('click', () => this.dom.customModal.classList.add('hidden'));
        this.dom.modalCancelBtn.addEventListener('click', () => this.dom.customModal.classList.add('hidden'));

        this.dom.btnExportMenu.addEventListener('click', () => this.dom.exportModal.classList.remove('hidden'));
        this.dom.exportCloseBtn.addEventListener('click', () => this.dom.exportModal.classList.add('hidden'));

        // Custom Transmitter Form Submit
        this.dom.customSimForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleCustomSimulation();
        });

        // Export Actions
        this.dom.exportGeojsonBtn.addEventListener('click', () => this.triggerExport('geojson'));
        this.dom.exportKmlBtn.addEventListener('click', () => this.triggerExport('kml'));
        this.dom.exportReportBtn.addEventListener('click', () => this.triggerExport('report'));
        if (this.dom.exportPngBtn) {
            this.dom.exportPngBtn.addEventListener('click', () => this.exportMapScreenshot());
        }

        // Compare Event Listeners
        if (this.dom.btnCompareMenu) {
            this.dom.btnCompareMenu.addEventListener('click', () => {
                this.renderCompareModalUI();
                this.dom.compareModal.classList.remove('hidden');
            });
        }

        if (this.dom.compareCloseBtn) {
            this.dom.compareCloseBtn.addEventListener('click', () => {
                this.dom.compareModal.classList.add('hidden');
            });
        }

        if (this.dom.btnAddCompare) {
            this.dom.btnAddCompare.addEventListener('click', () => {
                if (this.currentCoverage) {
                    this.addStationToCompare(this.currentCoverage.station.callsign);
                }
            });
        }

        if (this.dom.compareAddBtn) {
            this.dom.compareAddBtn.addEventListener('click', () => {
                const val = this.dom.compareSearchInput.value.trim();
                if (val) {
                    this.addStationToCompare(val);
                    this.dom.compareSearchInput.value = '';
                }
            });
        }

        if (this.dom.compareSearchInput) {
            this.dom.compareSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = this.dom.compareSearchInput.value.trim();
                    if (val) {
                        this.addStationToCompare(val);
                        this.dom.compareSearchInput.value = '';
                    }
                }
            });
        }

        if (this.dom.compareClearBtn) {
            this.dom.compareClearBtn.addEventListener('click', () => {
                this.comparedStations = [];
                this.updateCompareBadge();
                this.renderCompareModalUI();
            });
        }

        if (this.dom.compareOverlayMapBtn) {
            this.dom.compareOverlayMapBtn.addEventListener('click', () => {
                this.dom.compareModal.classList.add('hidden');
                if (this.comparedStations.length > 0) {
                    this.mapManager.renderMultiCoverage(this.comparedStations);
                }
            });
        }

        // Theme Toggle
        this.dom.btnThemeToggle.addEventListener('click', () => this.toggleTheme());
    }

    async fetchAutocomplete(query) {
        try {
            const res = await fetch(`/api/stations/search?q=${encodeURIComponent(query)}&limit=8`);
            if (!res.ok) return;
            const stations = await res.json();

            if (!stations || stations.length === 0) {
                this.dom.autocompleteDropdown.innerHTML = `
                    <div class="autocomplete-item" style="cursor:default; color:var(--text-muted);">
                        <span>No exact match found. Press Enter to simulate <strong>${query.toUpperCase()}</strong></span>
                    </div>
                `;
                this.dom.autocompleteDropdown.classList.remove('hidden');
                return;
            }

            let html = '';
            stations.forEach((st) => {
                const flag = st.country === 'CA' ? '🇨🇦' : '🇺🇸';
                html += `
                    <div class="autocomplete-item" data-call="${st.callsign}">
                        <div class="ac-main">
                            <span class="ac-callsign">${st.callsign}</span>
                            <span class="ac-name">${st.name || ''}</span>
                        </div>
                        <div class="ac-meta">
                            <span>${flag} ${st.city}, ${st.state}</span>
                            <span>&bull;</span>
                            <span>${st.frequency} ${st.band === 'FM' ? 'MHz' : 'kHz'}</span>
                        </div>
                    </div>
                `;
            });

            this.dom.autocompleteDropdown.innerHTML = html;
            this.dom.autocompleteDropdown.classList.remove('hidden');

            this.dom.autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach((el) => {
                el.addEventListener('click', () => {
                    const call = el.dataset.call;
                    if (call) {
                        this.dom.searchInput.value = call;
                        this.dom.autocompleteDropdown.classList.add('hidden');
                        this.loadStationCoverage(call, this.currentMode);
                    }
                });
            });
        } catch (err) {
            console.error('Autocomplete fetch error:', err);
        }
    }

    async loadStationCoverage(callsign, mode = null) {
        if (!mode) mode = this.currentMode;
        try {
            const res = await fetch(`/api/coverage/${encodeURIComponent(callsign)}?mode=${encodeURIComponent(mode)}`);
            if (!res.ok) {
                alert(`Could not load coverage for '${callsign}'.`);
                return;
            }
            const data = await res.json();
            this.currentMode = data.coverage_mode || mode;
            this.renderStationData(data);
        } catch (err) {
            console.error('Error fetching station coverage:', err);
            alert('Failed to generate station coverage. Please verify your connection.');
        }
    }

    renderStationData(coverageData) {
        this.currentCoverage = coverageData;
        const st = coverageData.station;
        const isAm = st.band.toUpperCase() === 'AM';

        // Populate Station Identity
        this.dom.stCallsign.textContent = st.callsign;
        this.dom.stCountryBadge.textContent = st.country === 'CA' ? '🇨🇦 Canada' : '🇺🇸 USA';
        this.dom.stBandBadge.textContent = st.band;
        this.dom.stName.textContent = st.name || `${st.callsign} Broadcast Station`;

        // Handle AM Day / Night Switcher
        if (isAm) {
            this.dom.amModeContainer.classList.remove('hidden');
            if (this.currentMode === 'night') {
                this.dom.btnModeDay.classList.remove('active');
                this.dom.btnModeNight.classList.add('active');
            } else {
                this.dom.btnModeDay.classList.add('active');
                this.dom.btnModeNight.classList.remove('active');
            }
        } else {
            this.dom.amModeContainer.classList.add('hidden');
        }
        
        // Populate Engineering Specs
        this.dom.stFrequency.textContent = `${st.frequency} ${isAm ? 'kHz' : 'MHz'}`;
        this.dom.stErp.textContent = `${coverageData.operating_power_kw || st.erp_kw} kW`;
        this.dom.stHaat.textContent = `${st.haat_m} m (${Math.round(st.haat_m * 3.28084)} ft)`;
        this.dom.stClass.textContent = coverageData.operating_pattern || `Class ${st.station_class || 'B'}`;
        this.dom.stLocation.textContent = `${st.city}, ${st.state}`;
        this.dom.stCoords.textContent = `${st.latitude.toFixed(4)}° N, ${Math.abs(st.longitude).toFixed(4)}° W`;
        this.dom.stLicensee.textContent = st.licensee || st.format || 'Licensed Broadcast Operator';


        // Setup Audio Stream
        this.setupAudioStream(st.stream_url);

        // Populate Contour Tiers List
        this.renderContourTiers(coverageData.contours);

        // Draw Radial Profile Chart
        this.drawProfileChart(coverageData.radial_profile);

        // Reset Probe Card
        this.dom.probeContent.innerHTML = `
            <div class="probe-empty-state">
                Click anywhere on the map to test predicted reception quality and field strength.
            </div>
        `;

        // Render on Map
        this.mapManager.renderCoverage(coverageData);
    }

    renderContourTiers(contours) {
        let html = '';
        contours.forEach((tier) => {
            html += `
                <div class="tier-item">
                    <div class="tier-header">
                        <div class="tier-title">
                            <span class="tier-color-bar" style="background: ${tier.color};"></span>
                            <span>${tier.name}</span>
                        </div>
                        <span class="tier-radius-badge">~${tier.avg_radius_km} km</span>
                    </div>
                    <div class="tier-desc">${tier.description}</div>
                    <div class="tier-stats-row">
                        <span>Area: <b>${tier.area_sqkm.toLocaleString()} km²</b> (${tier.area_sqmi.toLocaleString()} sq mi)</span>
                        <span>Max Radius: <b>${tier.max_radius_km} km</b></span>
                    </div>
                </div>
            `;
        });
        this.dom.contourTiersList.innerHTML = html;
    }

    drawProfileChart(profilePoints) {
        const canvas = this.dom.profileCanvas;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const w = rect.width;
        const h = rect.height;
        const padL = 36;
        const padR = 14;
        const padT = 12;
        const padB = 24;

        ctx.clearRect(0, 0, w, h);

        if (!profilePoints || profilePoints.length === 0) return;

        const maxDist = profilePoints[profilePoints.length - 1].distance_km;
        const maxDbu = 100.0;
        const minDbu = 30.0;

        const getX = (dist) => padL + (dist / maxDist) * (w - padL - padR);
        const getY = (dbu) => padT + (1 - (dbu - minDbu) / (maxDbu - minDbu)) * (h - padT - padB);

        // Determine if Amber CRT theme is active
        const isAmber = document.body.classList.contains('amber-crt-theme') || (!document.body.classList.contains('dark-theme') && !document.body.classList.contains('light-theme'));

        // Draw Reference Contour Lines (70, 60, 54, 48 dBu)
        const refLines = [
            { dbu: 70, color: isAmber ? 'rgba(255, 170, 0, 0.45)' : 'rgba(16, 185, 129, 0.4)', label: '70' },
            { dbu: 60, color: isAmber ? 'rgba(255, 150, 0, 0.35)' : 'rgba(59, 130, 246, 0.4)', label: '60' },
            { dbu: 54, color: isAmber ? 'rgba(255, 120, 0, 0.25)' : 'rgba(245, 158, 11, 0.4)', label: '54' },
            { dbu: 48, color: isAmber ? 'rgba(255, 90, 0, 0.20)' : 'rgba(139, 92, 246, 0.4)', label: '48' }
        ];

        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        refLines.forEach((ref) => {
            const y = getY(ref.dbu);
            ctx.strokeStyle = ref.color;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(w - padR, y);
            ctx.stroke();

            ctx.fillStyle = isAmber ? '#ffaa00' : '#64748b';
            ctx.font = '9px "Share Tech Mono", monospace';
            ctx.fillText(`${ref.label}`, 8, y + 3);
        });

        // Draw Signal Curve (with Phosphor CRT Glow in Amber Mode)
        ctx.setLineDash([]);
        ctx.lineWidth = 2.5;

        if (isAmber) {
            ctx.strokeStyle = '#ffb700';
            ctx.shadowColor = '#ff9900';
            ctx.shadowBlur = 12;
        } else {
            const gradient = ctx.createLinearGradient(padL, 0, w - padR, 0);
            gradient.addColorStop(0, '#10b981');
            gradient.addColorStop(0.35, '#3b82f6');
            gradient.addColorStop(0.7, '#f59e0b');
            gradient.addColorStop(1, '#8b5cf6');
            ctx.strokeStyle = gradient;
            ctx.shadowBlur = 0;
        }

        ctx.beginPath();
        profilePoints.forEach((pt, i) => {
            const x = getX(pt.distance_km);
            const y = getY(Math.max(minDbu, Math.min(maxDbu, pt.field_strength_dbu)));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Reset Shadow Glow
        ctx.shadowBlur = 0;

        // X-Axis Distance Labels
        ctx.fillStyle = isAmber ? '#d98400' : '#94a3b8';
        ctx.font = '10px "Share Tech Mono", monospace';
        ctx.fillText('0 km', padL - 6, h - 6);
        ctx.fillText(`${Math.round(maxDist / 2)} km`, (padL + w - padR) / 2 - 12, h - 6);
        ctx.fillText(`${Math.round(maxDist)} km`, w - padR - 22, h - 6);
    }


    async handleMapProbe(lat, lon) {
        if (!this.currentCoverage) return;

        try {
            const res = await fetch('/api/probe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    station_data: this.currentCoverage.station,
                    mode: this.currentMode,
                    lat: lat,
                    lon: lon
                })
            });

            if (!res.ok) return;
            const probe = await res.json();


            // Update Probe Card UI
            this.dom.probeContent.innerHTML = `
                <div class="probe-active-data">
                    <div class="probe-quality-badge" style="background:${probe.reception_badge_color};">
                        ${probe.s_meter} &bull; ${probe.reception_quality}
                    </div>
                    <div class="probe-metric-row">
                        <span class="probe-metric-label">Signal Level</span>
                        <span class="probe-metric-value">${probe.field_strength_dbu} dBµV/m (${probe.field_strength_mvm} mV/m)</span>
                    </div>
                    <div class="probe-metric-row">
                        <span class="probe-metric-label">Distance to Tower</span>
                        <span class="probe-metric-value">${probe.distance_km} km (${probe.distance_mi} mi)</span>
                    </div>
                    <div class="probe-metric-row">
                        <span class="probe-metric-label">Bearing from Tower</span>
                        <span class="probe-metric-value">${probe.bearing_deg}° (${probe.bearing_cardinal})</span>
                    </div>
                    <div class="probe-metric-row">
                        <span class="probe-metric-label">Probe Point</span>
                        <span class="probe-metric-value">${lat.toFixed(4)}°, ${lon.toFixed(4)}°</span>
                    </div>
                </div>
            `;

            // Place probe marker on map
            this.mapManager.setProbeLocation(probe, lat, lon);
        } catch (err) {
            console.error('Error probing signal:', err);
        }
    }

    setupAudioStream(streamUrl) {
        this.dom.audioPlayer.pause();
        this.isPlayingAudio = false;
        this.updatePlayButtonState();

        if (streamUrl) {
            this.dom.streamContainer.classList.remove('hidden');
            this.dom.audioPlayer.src = streamUrl;
        } else {
            this.dom.streamContainer.classList.add('hidden');
            this.dom.audioPlayer.src = '';
        }
    }

    toggleStreamPlay() {
        if (!this.dom.audioPlayer.src) return;

        if (this.isPlayingAudio) {
            this.dom.audioPlayer.pause();
            this.isPlayingAudio = false;
        } else {
            this.dom.audioPlayer.play().then(() => {
                this.isPlayingAudio = true;
                this.updatePlayButtonState();
            }).catch(err => {
                console.warn('Audio playback error (e.g. CORS/mixed-content):', err);
                alert('Live audio stream currently unavailable or restricted by browser security.');
                this.isPlayingAudio = false;
                this.updatePlayButtonState();
            });
        }
        this.updatePlayButtonState();
    }

    updatePlayButtonState() {
        if (this.isPlayingAudio) {
            this.dom.playIcon.classList.add('hidden');
            this.dom.pauseIcon.classList.remove('hidden');
            this.dom.playBtnText.textContent = 'Pause Stream';
        } else {
            this.dom.playIcon.classList.remove('hidden');
            this.dom.pauseIcon.classList.add('hidden');
            this.dom.playBtnText.textContent = 'Listen Live';
        }
    }

    async handleCustomSimulation() {
        const payload = {
            callsign: document.getElementById('sim-callsign').value.trim().toUpperCase(),
            name: document.getElementById('sim-callsign').value.trim(),
            band: document.getElementById('sim-band').value,
            frequency: parseFloat(document.getElementById('sim-freq').value),
            erp_kw: parseFloat(document.getElementById('sim-erp').value),
            haat_m: parseFloat(document.getElementById('sim-haat').value),
            country: document.getElementById('sim-country').value,
            latitude: parseFloat(document.getElementById('sim-lat').value),
            longitude: parseFloat(document.getElementById('sim-lon').value),
            directional: document.getElementById('sim-directional').checked
        };

        try {
            const res = await fetch('/api/custom-coverage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                alert('Could not calculate custom simulation coverage.');
                return;
            }

            const data = await res.json();
            this.dom.customModal.classList.add('hidden');
            this.renderStationData(data);
        } catch (err) {
            console.error('Simulation error:', err);
        }
    }

    triggerExport(format) {
        if (!this.currentCoverage) return;
        const callsign = this.currentCoverage.station.callsign;

        if (format === 'geojson') {
            window.location.href = `/api/export/geojson/${encodeURIComponent(callsign)}`;
        } else if (format === 'kml') {
            window.location.href = `/api/export/kml/${encodeURIComponent(callsign)}`;
        } else if (format === 'report') {
            const blob = new Blob([JSON.stringify(this.currentCoverage, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${callsign}_engineering_report.json`;
            a.click();
            URL.revokeObjectURL(url);
        }

        this.dom.exportModal.classList.add('hidden');
    }

    updateBasemapUIForTheme() {
        const isAmber = document.body.classList.contains('amber-crt-theme') || 
            (!document.body.classList.contains('dark-theme') && !document.body.classList.contains('light-theme'));

        const basemapBtns = document.querySelectorAll('.basemap-btn');
        basemapBtns.forEach((btn) => {
            if (isAmber) {
                if (btn.dataset.style === 'positron') {
                    btn.classList.add('active');
                    btn.style.display = 'inline-block';
                    btn.removeAttribute('disabled');
                } else {
                    btn.classList.remove('active');
                    btn.style.display = 'none';
                    btn.setAttribute('disabled', 'true');
                }
            } else {
                btn.style.display = 'inline-block';
                btn.removeAttribute('disabled');
            }
        });

        if (isAmber) {
            this.mapManager.setBasemap('positron');
        }
    }

    setupTheme() {
        const saved = localStorage.getItem('radioscope_theme') || 'amber-crt';
        document.body.classList.remove('amber-crt-theme', 'dark-theme', 'light-theme');
        if (saved === 'light') {
            document.body.classList.add('light-theme');
            this.mapManager.setBasemap('positron');
        } else if (saved === 'dark') {
            document.body.classList.add('dark-theme');
            this.mapManager.setBasemap('dark');
        } else {
            document.body.classList.add('amber-crt-theme');
        }
        this.updateBasemapUIForTheme();
    }

    toggleTheme() {
        if (document.body.classList.contains('amber-crt-theme')) {
            document.body.classList.remove('amber-crt-theme');
            document.body.classList.add('dark-theme');
            localStorage.setItem('radioscope_theme', 'dark');
            this.mapManager.setBasemap('dark');
            document.querySelectorAll('.basemap-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.style === 'dark');
            });
        } else if (document.body.classList.contains('dark-theme')) {
            document.body.classList.remove('dark-theme');
            document.body.classList.add('light-theme');
            localStorage.setItem('radioscope_theme', 'light');
            this.mapManager.setBasemap('positron');
            document.querySelectorAll('.basemap-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.style === 'positron');
            });
        } else {
            document.body.classList.remove('light-theme');
            document.body.classList.add('amber-crt-theme');
            localStorage.setItem('radioscope_theme', 'amber-crt');
        }

        this.updateBasemapUIForTheme();

        if (this.currentCoverage) {
            this.drawProfileChart(this.currentCoverage.radial_profile);
        }
    }

    async addStationToCompare(callsign) {
        if (this.comparedStations.length >= 5) {
            alert('Comparison maximum reached (up to 5 stations). Please remove a station to add another.');
            return;
        }

        const cleanCall = callsign.toUpperCase().trim();
        if (this.comparedStations.some(s => s.station.callsign.toUpperCase() === cleanCall)) {
            alert(`${cleanCall} is already in the comparison list.`);
            return;
        }

        try {
            const res = await fetch(`/api/coverage/${encodeURIComponent(cleanCall)}`);
            if (!res.ok) {
                alert(`Could not find coverage data for station '${cleanCall}'.`);
                return;
            }
            const data = await res.json();
            this.comparedStations.push(data);
            this.updateCompareBadge();
            this.renderCompareModalUI();
        } catch (err) {
            console.error('Error adding station to compare:', err);
        }
    }

    removeStationFromCompare(callsign) {
        this.comparedStations = this.comparedStations.filter(s => s.station.callsign !== callsign);
        this.updateCompareBadge();
        this.renderCompareModalUI();
    }

    updateCompareBadge() {
        const count = this.comparedStations.length;
        if (this.dom.compareBadge) {
            this.dom.compareBadge.textContent = count;
            this.dom.compareBadge.classList.toggle('hidden', count === 0);
        }
    }

    renderCompareModalUI() {
        if (!this.dom.compareSlotsContainer || !this.dom.compareTable) return;

        const colors = ['#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f43f5e'];

        // Render Slots / Chips Bar
        let slotsHtml = '';
        for (let i = 0; i < 5; i++) {
            const cov = this.comparedStations[i];
            if (cov) {
                const color = colors[i % colors.length];
                slotsHtml += `
                    <div class="compare-slot active-slot" style="border-left: 4px solid ${color};">
                        <div class="slot-info">
                            <strong style="color: ${color};">${cov.station.callsign}</strong>
                            <span>${cov.station.frequency} ${cov.station.band} &bull; ${cov.station.city}</span>
                        </div>
                        <button class="btn-slot-remove" data-call="${cov.station.callsign}" title="Remove station">&times;</button>
                    </div>
                `;
            } else {
                slotsHtml += `
                    <div class="compare-slot empty-slot">
                        <span>Slot ${i + 1} Empty</span>
                    </div>
                `;
            }
        }
        this.dom.compareSlotsContainer.innerHTML = slotsHtml;

        // Slot Remove Listeners
        this.dom.compareSlotsContainer.querySelectorAll('.btn-slot-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const call = e.target.getAttribute('data-call');
                this.removeStationFromCompare(call);
            });
        });

        // Render Technical Parameter Comparison Matrix Table
        if (this.comparedStations.length === 0) {
            this.dom.compareTable.innerHTML = `
                <tr>
                    <td class="compare-empty-msg" colspan="6">
                        No stations selected. Type a callsign above or click "+ Compare" on any station card to compare up to 5 stations side-by-side.
                    </td>
                </tr>
            `;
            return;
        }

        const metrics = [
            { label: 'Callsign', key: (s) => `<strong>${s.callsign}</strong>` },
            { label: 'Station Name', key: (s) => s.name || '-' },
            { label: 'Band & Frequency', key: (s) => `${s.frequency} ${s.band === 'FM' ? 'MHz' : 'kHz'}` },
            { label: 'ERP Power', key: (s) => `${s.erp_kw} kW` },
            { label: 'Antenna HAAT', key: (s) => `${s.haat_m} m (${Math.round(s.haat_m * 3.28084)} ft)` },
            { label: 'Station Class', key: (s) => s.station_class || '-' },
            { label: 'City of License', key: (s) => `${s.city}, ${s.state} (${s.country})` },
            { label: 'Licensee / Operator', key: (s) => s.licensee || '-' },
            { 
                label: '60 dBu Service Radius', 
                key: (s, cov) => {
                    const c60 = cov.contours.find(c => c.level_dbu === 60.0) || cov.contours[0];
                    return c60 ? `${c60.avg_radius_km} km (${Math.round(c60.avg_radius_km * 0.621371)} mi)` : '-';
                }
            },
            { 
                label: '60 dBu Service Area', 
                key: (s, cov) => {
                    const c60 = cov.contours.find(c => c.level_dbu === 60.0) || cov.contours[0];
                    return c60 ? `${c60.area_sqkm.toLocaleString()} km²` : '-';
                }
            }
        ];

        let tableHtml = '<thead><tr><th>Parameter</th>';
        this.comparedStations.forEach((cov, idx) => {
            const color = colors[idx % colors.length];
            tableHtml += `<th style="color:${color};">${cov.station.callsign}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';

        metrics.forEach((m) => {
            tableHtml += `<tr><td class="param-label">${m.label}</td>`;
            this.comparedStations.forEach((cov) => {
                tableHtml += `<td>${m.key(cov.station, cov)}</td>`;
            });
            tableHtml += '</tr>';
        });
        tableHtml += '</tbody>';

        this.dom.compareTable.innerHTML = tableHtml;
    }

    async exportMapScreenshot() {
        const mapEl = document.getElementById('map-container');
        if (!mapEl) return;

        const btn = document.getElementById('export-png-btn');
        const originalContent = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = `<div class="opt-icon">⏳</div><div class="opt-text"><h4>Rendering Screenshot...</h4><p>Capturing map layers and contours...</p></div>`;
        }

        try {
            const canvas = await html2canvas(mapEl, {
                useCORS: true,
                allowTaint: true,
                scale: 2,
                ignoreElements: (element) => element.classList.contains('leaflet-control-zoom')
            });

            const imageUri = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            const call = this.currentCoverage ? this.currentCoverage.station.callsign : 'RadioScope';
            a.href = imageUri;
            a.download = `${call}_coverage_map_screenshot.png`;
            a.click();
        } catch (err) {
            console.error('Screenshot generation error:', err);
            alert('Could not render map screenshot. Please try again.');
        } finally {
            if (btn) btn.innerHTML = originalContent;
            if (this.dom.exportModal) this.dom.exportModal.classList.add('hidden');
        }
    }
}

// Initialize Application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new RadioScopeApp();
});
