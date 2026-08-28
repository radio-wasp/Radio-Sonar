/**
 * RadioScope - Map Management Module (Leaflet & GIS Layer Management)
 */

class CoverageMapManager {
    constructor(elementId) {
        this.map = null;
        this.baseLayers = {};
        this.currentBaseLayer = null;
        this.contourLayers = [];
        this.transmitterMarker = null;
        this.probeMarker = null;
        this.probeEnabled = true;
        this.currentStation = null;
        this.elementId = elementId;

        this.initMap();
    }

    initMap() {
        // Tile Layers
        this.baseLayers = {
            dark: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
                attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey',
                maxZoom: 18
            }),
            positron: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
                maxZoom: 19
            }),
            osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
                maxZoom: 19
            }),
            satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
                maxZoom: 18
            }),
            terrain: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
                attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community',
                maxZoom: 18
            })
        };

        // Initialize Map centered on North America initially
        this.map = L.map(this.elementId, {
            center: [40.7128, -74.0060],
            zoom: 8,
            zoomControl: false,
            layers: [this.baseLayers.dark]
        });

        // Add Zoom Control to bottom-left
        L.control.zoom({ position: 'bottomleft' }).addTo(this.map);

        // Map Click for Signal Probe
        this.map.on('click', (e) => {
            if (this.probeEnabled && window.radioApp) {
                window.radioApp.handleMapProbe(e.latlng.lat, e.latlng.lng);
            }
        });
    }

    setBasemap(styleKey) {
        if (!this.baseLayers[styleKey]) return;
        Object.values(this.baseLayers).forEach(layer => this.map.removeLayer(layer));
        this.map.addLayer(this.baseLayers[styleKey]);
    }

    clearContours() {
        this.contourLayers.forEach(layer => this.map.removeLayer(layer));
        this.contourLayers = [];

        if (this.transmitterMarker) {
            this.map.removeLayer(this.transmitterMarker);
            this.transmitterMarker = null;
        }

        if (this.probeMarker) {
            this.map.removeLayer(this.probeMarker);
            this.probeMarker = null;
        }
    }

    renderCoverage(coverageData) {
        this.clearContours();
        this.currentStation = coverageData.station;

        const bounds = L.latLngBounds();

        // Render Contour Tiers in reverse order (outer/fringe first so inner/city sits on top)
        const reversedContours = [...coverageData.contours].reverse();

        reversedContours.forEach((tier) => {
            const geojsonLayer = L.geoJSON(tier.geometry, {
                style: {
                    color: tier.stroke_color,
                    weight: 2,
                    opacity: 0.85,
                    fillColor: tier.color,
                    fillOpacity: tier.fill_opacity,
                    dashArray: tier.level_dbu === 48.0 ? '4, 4' : null
                }
            });

            geojsonLayer.bindTooltip(`
                <strong>${tier.name}</strong><br>
                <span>Avg Radius: ${tier.avg_radius_km} km (${Math.round(tier.avg_radius_km * 0.621371)} mi)</span><br>
                <span>Area: ${tier.area_sqkm.toLocaleString()} km²</span>
            `, { sticky: true, className: 'contour-tooltip' });

            geojsonLayer.addTo(this.map);
            this.contourLayers.push(geojsonLayer);

            // Extend bounds
            bounds.extend(geojsonLayer.getBounds());
        });

        // Add Animated Transmitter Marker
        const st = coverageData.station;
        const towerIcon = L.divIcon({
            className: 'custom-tower-marker',
            html: `
                <div class="transmitter-icon-container">
                    <div class="transmitter-pulse-ring"></div>
                    <div class="transmitter-tower-pin"></div>
                </div>
            `,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });

        this.transmitterMarker = L.marker([st.latitude, st.longitude], { icon: towerIcon })
            .bindPopup(`
                <div style="font-family: var(--font-sans); min-width: 180px;">
                    <strong style="font-size: 1rem; color: #2563eb;">${st.callsign} Transmitter</strong><br>
                    <span>${st.name || ''}</span><br>
                    <hr style="margin: 6px 0; border: none; border-top: 1px solid #cbd5e1;">
                    <small>
                        <b>Freq:</b> ${st.frequency} ${st.band === 'FM' ? 'MHz' : 'kHz'}<br>
                        <b>ERP:</b> ${st.erp_kw} kW | <b>HAAT:</b> ${st.haat_m} m<br>
                        <b>Coords:</b> ${st.latitude.toFixed(4)}°, ${st.longitude.toFixed(4)}°
                    </small>
                </div>
            `)
            .addTo(this.map);

        bounds.extend([st.latitude, st.longitude]);

        // Fit map smoothly to contours
        if (bounds.isValid()) {
            this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12, animate: true });
        }
    }

    renderMultiCoverage(coverageList) {
        this.clearContours();
        if (!coverageList || coverageList.length === 0) return;

        const palette = [
            { stroke: '#10b981', fill: '#10b981', name: 'Emerald' },
            { stroke: '#f59e0b', fill: '#f59e0b', name: 'Amber' },
            { stroke: '#8b5cf6', fill: '#8b5cf6', name: 'Purple' },
            { stroke: '#06b6d4', fill: '#06b6d4', name: 'Cyan' },
            { stroke: '#f43f5e', fill: '#f43f5e', name: 'Rose' }
        ];

        const bounds = L.latLngBounds();

        coverageList.forEach((cov, idx) => {
            const st = cov.station;
            const color = palette[idx % palette.length];

            // Render Service/Primary (60 dBu) contour polygon for comparison
            const primaryContour = cov.contours.find(c => c.level_dbu === 60.0) || cov.contours[0];
            if (primaryContour) {
                const geojsonLayer = L.geoJSON(primaryContour.geometry, {
                    style: {
                        color: color.stroke,
                        weight: 3,
                        opacity: 0.9,
                        fillColor: color.fill,
                        fillOpacity: 0.2
                    }
                });

                geojsonLayer.bindTooltip(`
                    <strong>${st.callsign} (${st.frequency} ${st.band})</strong><br>
                    <span>${st.city}, ${st.state}</span><br>
                    <span>60 dBu Radius: ${primaryContour.avg_radius_km} km</span>
                `, { sticky: true, className: 'contour-tooltip' });

                geojsonLayer.addTo(this.map);
                this.contourLayers.push(geojsonLayer);
                bounds.extend(geojsonLayer.getBounds());
            }

            // Custom Pin Marker with Callsign Badge
            const pinIcon = L.divIcon({
                className: 'custom-compare-marker',
                html: `
                    <div style="background:${color.stroke}; color:#ffffff; font-weight:800; font-size:11px; padding:3px 7px; border-radius:12px; border:2px solid #ffffff; box-shadow:0 2px 6px rgba(0,0,0,0.4); text-align:center; white-space:nowrap;">
                        ${st.callsign}
                    </div>
                `,
                iconSize: [64, 24],
                iconAnchor: [32, 12]
            });

            const marker = L.marker([st.latitude, st.longitude], { icon: pinIcon })
                .bindPopup(`
                    <div style="font-family: var(--font-sans); min-width: 170px;">
                        <strong style="font-size: 1rem; color: ${color.stroke};">${st.callsign}</strong><br>
                        <span>${st.name || ''}</span><br>
                        <small><b>Power:</b> ${st.erp_kw} kW | <b>HAAT:</b> ${st.haat_m} m</small>
                    </div>
                `)
                .addTo(this.map);

            this.contourLayers.push(marker);
            bounds.extend([st.latitude, st.longitude]);
        });

        if (bounds.isValid()) {
            this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 11, animate: true });
        }
    }

    setProbeLocation(probeData, lat, lon) {
        if (this.probeMarker) {
            this.map.removeLayer(this.probeMarker);
        }

        const probeIcon = L.divIcon({
            className: 'custom-probe-marker',
            html: `
                <div style="width: 14px; height: 14px; background: ${probeData.reception_badge_color}; border: 2px solid #ffffff; border-radius: 50%; box-shadow: 0 0 6px rgba(0,0,0,0.5);"></div>
            `,
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });

        this.probeMarker = L.marker([lat, lon], { icon: probeIcon })
            .bindPopup(`
                <div style="font-family: var(--font-sans); min-width: 170px;">
                    <strong>Signal Probe</strong><br>
                    <b>${probeData.field_strength_dbu} dBµV/m</b> (${probeData.field_strength_mvm} mV/m)<br>
                    <span style="display:inline-block; margin-top:4px; padding:2px 6px; border-radius:4px; font-size:0.75rem; color:#fff; background:${probeData.reception_badge_color}; font-weight:bold;">
                        ${probeData.s_meter} - ${probeData.reception_quality}
                    </span><br>
                    <small style="color:#64748b; margin-top:4px; display:block;">
                        Distance: ${probeData.distance_km} km (${probeData.distance_mi} mi) &bull; Bearing: ${probeData.bearing_deg}° (${probeData.bearing_cardinal})
                    </small>
                </div>
            `)
            .addTo(this.map)
            .openPopup();
    }

    recenterTransmitter() {
        if (this.transmitterMarker) {
            this.map.setView(this.transmitterMarker.getLatLng(), 9, { animate: true });
        }
    }
}
