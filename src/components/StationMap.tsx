// src/components/StationMap.tsx — the network, geographically
//
// A charging network is a geographic business. A table can say four chargers
// are down; only a map says three of the four are in one city, which is the
// difference between bad luck and one bad installer.
//
// Deliberately built on CircleMarker rather than Leaflet's default pin. The
// default pin loads its icon from a bundled PNG whose URL breaks under Vite's
// asset hashing — a famous, tedious bug — and a circle is the better encoding
// here anyway: area carries bay count, colour carries availability.
import { useMemo } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";

export interface MapStation {
  id: number;
  name: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  chargers: number;
  down: number;
  inUse: number;
  availabilityPercent: number;
}

/** Green healthy, amber degraded, red mostly down. Three bands, not a gradient:
 *  a reader can act on three categories and cannot act on a hue. */
function colourFor(percent: number): string {
  if (percent >= 90) return "#10b981";
  if (percent >= 60) return "#f59e0b";
  return "#f43f5e";
}

export function StationMap({
  stations,
  loading,
  height = 420,
}: {
  stations: MapStation[];
  loading?: boolean;
  height?: number;
}) {
  // Centre on the fleet rather than a hard-coded coordinate, so the map is
  // still useful if the seed data moves to another country.
  const centre = useMemo<[number, number]>(() => {
    if (!stations.length) return [39.5, -98.35]; // geographic centre of the US
    const lat = stations.reduce((a, s) => a + s.lat, 0) / stations.length;
    const lng = stations.reduce((a, s) => a + s.lng, 0) / stations.length;
    return [lat, lng];
  }, [stations]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center bg-slate-100 text-sm text-slate-500 dark:bg-white/5 dark:text-ink-muted"
        style={{ height }}
      >
        Loading map…
      </div>
    );
  }

  if (!stations.length) {
    return (
      <div
        className="flex items-center justify-center bg-slate-100 text-sm text-slate-500 dark:bg-white/5 dark:text-ink-muted"
        style={{ height }}
      >
        No sites have coordinates yet.
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <MapContainer
        center={centre}
        zoom={4}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {stations.map((s) => (
          <CircleMarker
            key={s.id}
            center={[s.lat, s.lng]}
            // Radius grows with the square root of bay count so a 20-bay site
            // reads as roughly twice a 5-bay one by AREA, which is what the eye
            // actually compares.
            radius={Math.max(5, Math.min(18, Math.sqrt(s.chargers) * 2.4))}
            pathOptions={{
              color: colourFor(s.availabilityPercent),
              fillColor: colourFor(s.availabilityPercent),
              fillOpacity: 0.55,
              weight: 1.5,
            }}
          >
            <Tooltip>
              <div className="text-xs">
                <p className="font-semibold">{s.name}</p>
                <p>
                  {s.city}, {s.state}
                </p>
                <p>
                  {s.chargers} bays · {s.inUse} in use
                  {s.down ? ` · ${s.down} down` : ""}
                </p>
                <p>{s.availabilityPercent}% available</p>
              </div>
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
