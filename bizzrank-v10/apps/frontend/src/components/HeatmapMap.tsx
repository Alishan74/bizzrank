/**
 * HeatmapMap — Real Google Maps with ranked grid point markers.
 * No npm packages needed — loads Google Maps JS API via script tag.
 * Each marker is color-coded: green(1-3), amber(4-10), red(11+), gray(not ranked).
 * Clicking a marker opens a detail panel showing rank, location name,
 * who's ranking there, and a link to view on Google Maps.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

interface HeatmapPoint {
  lat: number;
  lng: number;
  rank: number | null;
  label: string;
  locationName: string;
  intensity: number;
  googleMapsUrl: string;
}

interface HeatmapMapProps {
  points: HeatmapPoint[];
  businessName: string;
  keyword: string;
  centerLat?: number;
  centerLng?: number;
}

// Load Google Maps script once
let mapsLoaded = false;
let mapsLoading = false;
const mapsCallbacks: Array<() => void> = [];

function loadGoogleMaps(apiKey: string): Promise<void> {
  return new Promise((resolve) => {
    if (mapsLoaded) { resolve(); return; }
    mapsCallbacks.push(resolve);
    if (mapsLoading) return;
    mapsLoading = true;
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=marker`;
    script.async = true;
    script.onload = () => {
      mapsLoaded = true;
      mapsCallbacks.forEach(cb => cb());
      mapsCallbacks.length = 0;
    };
    document.head.appendChild(script);
  });
}

function rankColor(rank: number | null): string {
  if (!rank) return '#9ca3af';
  if (rank <= 3)  return '#22c55e';
  if (rank <= 10) return '#f59e0b';
  return '#ef4444';
}

function rankLabel(rank: number | null): string {
  if (!rank) return '–';
  return '#' + rank;
}

export default function HeatmapMap({ points, businessName, keyword, centerLat, centerLng }: HeatmapMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markers = useRef<any[]>([]);
  const [selected, setSelected] = useState<HeatmapPoint | null>(null);
  const [mapsReady, setMapsReady] = useState(false);

  // Fetch API key
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get('/config').then(r => r.data),
    staleTime: Infinity,
  });

  // Load Google Maps when key is ready
  useEffect(() => {
    if (!config?.googleMapsKey) return;
    loadGoogleMaps(config.googleMapsKey).then(() => setMapsReady(true));
  }, [config?.googleMapsKey]);

  // Initialize map
  useEffect(() => {
    if (!mapsReady || !mapRef.current || !points.length) return;
    const g = (window as any).google;

    const center = {
      lat: centerLat ?? points[Math.floor(points.length / 2)].lat,
      lng: centerLng ?? points[Math.floor(points.length / 2)].lng,
    };

    mapInstance.current = new g.maps.Map(mapRef.current, {
      center,
      zoom: 13,
      mapTypeId: 'roadmap',
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      styles: [
        { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      ],
    });

    // Clear old markers
    markers.current.forEach(m => m.setMap(null));
    markers.current = [];

    points.forEach((point) => {
      const color = rankColor(point.rank);
      const label = rankLabel(point.rank);

      // Custom marker using overlay
      const marker = new g.maps.Marker({
        position: { lat: point.lat, lng: point.lng },
        map: mapInstance.current,
        title: (point.locationName || point.label) + (point.rank ? ' — Rank ' + label : ' — Not ranked'),
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 16,
          fillColor: color,
          fillOpacity: 0.95,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        label: {
          text: label,
          color: '#ffffff',
          fontSize: '10px',
          fontWeight: 'bold',
        },
        zIndex: point.rank ? (100 - point.rank) : 0,
      });

      marker.addListener('click', () => setSelected(point));
      markers.current.push(marker);
    });

    // Fit bounds to all points
    const bounds = new g.maps.LatLngBounds();
    points.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
    mapInstance.current.fitBounds(bounds, { top: 40, bottom: 40, left: 40, right: 40 });

  }, [mapsReady, points, centerLat, centerLng]);

  if (!config?.googleMapsKey) {
    return (
      <div className="w-full h-80 bg-gray-100 rounded-2xl flex items-center justify-center">
        <p className="text-sm text-gray-400">Map unavailable — Google Maps API key not configured</p>
      </div>
    );
  }

  if (!mapsReady) {
    return (
      <div className="w-full h-80 bg-gray-100 rounded-2xl flex items-center justify-center animate-pulse">
        <p className="text-sm text-gray-400">Loading map...</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Map */}
      <div ref={mapRef} className="w-full h-80 rounded-2xl overflow-hidden border border-gray-200" />

      {/* Legend */}
      <div className="absolute bottom-3 left-3 bg-white/90 backdrop-blur-sm rounded-xl shadow-md px-3 py-2 flex gap-3 text-xs">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-500 inline-block" />Top 3</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-amber-400 inline-block" />4–10</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-400 inline-block" />11+</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-gray-400 inline-block" />Not ranked</span>
      </div>

      {/* Point detail panel */}
      {selected && (
        <div className="absolute top-3 right-3 w-64 bg-white rounded-2xl shadow-xl border border-gray-200 p-4 z-10">
          <button onClick={() => setSelected(null)}
            className="absolute top-2 right-3 text-gray-400 hover:text-gray-600 text-lg">×</button>

          <div className="mb-3">
            <p className="font-bold text-sm text-gray-900">{selected.locationName || selected.label}</p>
            <p className="text-xs text-gray-400">{selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}</p>
          </div>

          {selected.rank ? (
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className={'w-3 h-3 rounded-full inline-block ' +
                  (selected.rank <= 3 ? 'bg-green-500' : selected.rank <= 10 ? 'bg-amber-400' : 'bg-red-400')} />
                <span className="font-bold text-lg text-gray-900">Rank #{selected.rank}</span>
              </div>
              <p className="text-xs text-gray-500">
                {selected.rank <= 3 ? '✅ Excellent — top 3 in this zone' :
                 selected.rank <= 10 ? '🟡 Good — page 1' :
                 '🔴 Needs work — page 2+'}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                <strong>{businessName}</strong> ranks #{selected.rank} for "<em>{keyword}</em>" at this location
              </p>
            </div>
          ) : (
            <div className="mb-3">
              <p className="text-sm font-semibold text-gray-500">Not ranking here</p>
              <p className="text-xs text-gray-400 mt-1">
                {businessName} doesn't appear in Google Maps results for "{keyword}" at this location
              </p>
            </div>
          )}

          <a href={selected.googleMapsUrl} target="_blank" rel="noreferrer"
            className="block w-full text-center text-xs font-semibold text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-xl py-2 transition-colors">
            🗺 View this spot on Google Maps →
          </a>
        </div>
      )}
    </div>
  );
}
