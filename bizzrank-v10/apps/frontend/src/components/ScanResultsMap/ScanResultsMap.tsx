import { useState, useMemo, useEffect, useRef } from 'react';
import './ScanResultsMap.css';

// ----- Types -----
export interface ClientPoint {
  pointIndex: number;
  latitude: number;
  longitude: number;
  rank: number | null;        // null = client not found in top 20 at this point
  label?: string;
  locationName?: string;
}

export interface BusinessInfo {
  name: string;
  latitude: number;
  longitude: number;
  address?: string;
}

export interface CompetitorAtPoint {
  rank_position: number;
  found_business_name: string;
  found_place_id: string | null;
}

interface Props {
  business: BusinessInfo;
  clientPoints: ClientPoint[];
  /** Optional: all rankings, used to show competitor list when a point is clicked */
  rankings?: Array<{
    point_index: number;
    rank_position: number;
    found_business_name: string;
    found_place_id: string | null;
  }>;
  /** Google Maps JavaScript API key (from VITE_GOOGLE_MAPS_API_KEY in your .env) */
  apiKey: string;
}

// ----- Color mapping for rank -----
function colorForRank(rank: number | null): { bg: string; border: string; text: string } {
  if (rank === null || rank > 20) return { bg: '#9ca3af', border: '#4b5563', text: '#fff' };
  if (rank <= 3)  return { bg: '#16a34a', border: '#15803d', text: '#fff' };
  if (rank <= 10) return { bg: '#eab308', border: '#a16207', text: '#1f1f1f' };
  return                  { bg: '#dc2626', border: '#991b1b', text: '#fff' };
}

function labelForRank(rank: number | null): string {
  if (rank === null || rank > 20) return 'X';
  return String(rank);
}

// ----- Google Maps script loader (idempotent) -----
let mapsLoaderPromise: Promise<void> | null = null;
function loadGoogleMaps(apiKey: string): Promise<void> {
  if ((window as any).google?.maps) return Promise.resolve();
  if (mapsLoaderPromise) return mapsLoaderPromise;
  mapsLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
  return mapsLoaderPromise;
}

// ----- Component -----
export function ScanResultsMap({ business, clientPoints, rankings = [], apiKey }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [selected, setSelected] = useState<ClientPoint | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const center = useMemo(
    () => ({ lat: business.latitude, lng: business.longitude }),
    [business.latitude, business.longitude]
  );

  // Compute summary counts for the legend
  const summary = useMemo(() => {
    const c = { green: 0, yellow: 0, red: 0, none: 0 };
    for (const p of clientPoints) {
      if (p.rank === null || p.rank > 20) c.none++;
      else if (p.rank <= 3) c.green++;
      else if (p.rank <= 10) c.yellow++;
      else c.red++;
    }
    return c;
  }, [clientPoints]);

  // Competitors visible at the selected point (top 5)
  const competitorsAtPoint = useMemo(() => {
    if (!selected) return [];
    return rankings
      .filter(r => r.point_index === selected.pointIndex && r.rank_position != null)
      .sort((a, b) => a.rank_position - b.rank_position)
      .slice(0, 5);
  }, [selected, rankings]);

  // Load Maps script and init map
  useEffect(() => {
    if (!apiKey) {
      setError('Missing VITE_GOOGLE_MAPS_API_KEY');
      return;
    }
    loadGoogleMaps(apiKey)
      .then(() => setLoaded(true))
      .catch(e => setError(e.message));
  }, [apiKey]);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const google = (window as any).google;
    mapInstance.current = new google.maps.Map(mapRef.current, {
      center,
      zoom: 13,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'cooperative',
      styles: [
        { featureType: 'poi.business', stylers: [{ visibility: 'off' }] }, // de-clutter
      ],
    });
  }, [loaded, center]);

  // Render markers when map + data are ready
  useEffect(() => {
    if (!loaded || !mapInstance.current) return;
    const google = (window as any).google;

    // Clear old markers
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];

    // Business pin (the user's own location)
    const bizMarker = new google.maps.Marker({
      position: center,
      map: mapInstance.current,
      title: business.name,
      icon: {
        path: 'M12 0C7.6 0 4 3.6 4 8c0 5.4 8 16 8 16s8-10.6 8-16c0-4.4-3.6-8-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z',
        fillColor: '#2563eb',
        fillOpacity: 1,
        strokeColor: '#1e3a8a',
        strokeWeight: 2,
        scale: 1.6,
        anchor: new google.maps.Point(12, 24),
      },
      zIndex: 9999,
    });
    markersRef.current.push(bizMarker);

    // Auto-fit bounds to include business + all points
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(center);

    // Grid point markers — using custom HTML labels via OverlayView would be ideal but
    // we use Marker with custom SVG icon for performance and reliability.
    clientPoints.forEach(point => {
      const colors = colorForRank(point.rank);
      const label = labelForRank(point.rank);

      const marker = new google.maps.Marker({
        position: { lat: point.latitude, lng: point.longitude },
        map: mapInstance.current,
        label: {
          text: label,
          color: colors.text,
          fontSize: '13px',
          fontWeight: '700',
        },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 16,
          fillColor: colors.bg,
          fillOpacity: 0.95,
          strokeColor: colors.border,
          strokeWeight: 2,
        },
        title: `Point ${point.pointIndex} — ${point.rank == null ? 'Not in top 20' : 'Rank ' + point.rank}`,
      });

      marker.addListener('click', () => setSelected(point));
      markersRef.current.push(marker);
      bounds.extend({ lat: point.latitude, lng: point.longitude });
    });

    // Fit to all markers if we have any points
    if (clientPoints.length > 0) {
      mapInstance.current.fitBounds(bounds, 40);
    }
  }, [loaded, clientPoints, business.name, center]);

  if (error) {
    return (
      <div className="srm-error">
        <strong>Map failed to load:</strong> {error}
      </div>
    );
  }

  return (
    <div className="srm-root">
      <div className="srm-map-wrap">
        <div ref={mapRef} className="srm-map" />
        {!loaded && <div className="srm-loading">Loading map…</div>}

        {/* Legend */}
        <div className="srm-legend">
          <div className="srm-legend-title">Your rank at each point</div>
          <div className="srm-legend-row">
            <span className="srm-dot" style={{ background: '#16a34a', borderColor: '#15803d' }} />
            Top 3 <span className="srm-count">({summary.green})</span>
          </div>
          <div className="srm-legend-row">
            <span className="srm-dot" style={{ background: '#eab308', borderColor: '#a16207' }} />
            4 – 10 <span className="srm-count">({summary.yellow})</span>
          </div>
          <div className="srm-legend-row">
            <span className="srm-dot" style={{ background: '#dc2626', borderColor: '#991b1b' }} />
            11 – 20 <span className="srm-count">({summary.red})</span>
          </div>
          <div className="srm-legend-row">
            <span className="srm-dot" style={{ background: '#9ca3af', borderColor: '#4b5563' }} />
            Not found <span className="srm-count">({summary.none})</span>
          </div>
        </div>

        {/* Selected point detail panel */}
        {selected && (
          <div className="srm-detail">
            <button className="srm-close" onClick={() => setSelected(null)} aria-label="Close">×</button>
            <div className="srm-detail-head">
              <div className="srm-detail-num" style={{
                background: colorForRank(selected.rank).bg,
                borderColor: colorForRank(selected.rank).border,
                color: colorForRank(selected.rank).text,
              }}>
                {labelForRank(selected.rank)}
              </div>
              <div>
                <div className="srm-detail-title">Grid point {selected.pointIndex}</div>
                <div className="srm-detail-sub">
                  {selected.locationName || `${selected.latitude.toFixed(4)}, ${selected.longitude.toFixed(4)}`}
                </div>
              </div>
            </div>

            <div className="srm-detail-rank">
              {selected.rank == null
                ? <>Your business <strong>did not appear</strong> in the top 20 results here.</>
                : <>Your rank: <strong>#{selected.rank}</strong></>
              }
            </div>

            {competitorsAtPoint.length > 0 && (
              <>
                <div className="srm-detail-section">Top results at this point</div>
                <ol className="srm-comp-list">
                  {competitorsAtPoint.map((c, i) => (
                    <li key={i}>
                      <span className="srm-comp-rank">{c.rank_position}</span>
                      <span className="srm-comp-name">{c.found_business_name}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ScanResultsMap;
