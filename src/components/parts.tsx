import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LatLng } from '../lib/geo';
import { CloseIcon, LayersIcon, LocateIcon } from './icons';

export const streetViewUrl = (p: LatLng) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}`;
export const googleMapsUrl = (p: LatLng) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.lat},${p.lng}`)}`;
export const googleDirectionsUrl = (a: LatLng, b: LatLng, mode: 'walking' | 'transit' | 'driving' = 'walking') =>
  `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}&travelmode=${mode}`;

export function Badge({ label, color, textColor = '#ffffff' }: { label: string; color: string; textColor?: string }) {
  return (
    <span className="badge" style={{ background: color, color: textColor }}>
      {label}
    </span>
  );
}

export function PanelHeader({ title, subtitle, color, onClose }: { title: string; subtitle?: ReactNode; color?: string; onClose(): void }) {
  return (
    <header className="panel-header">
      {color && <span className="title-mark" style={{ background: color }} />}
      <div className="panel-heading">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
        <CloseIcon size={18} />
      </button>
    </header>
  );
}

export function Actions({ point, onDirections }: { point: LatLng; onDirections?(): void }) {
  return (
    <div className="actions">
      {onDirections && (
        <button type="button" className="btn-primary" onClick={onDirections}>
          Directions
        </button>
      )}
      <a href={streetViewUrl(point)} target="_blank" rel="noreferrer">Street View</a>
      <a href={googleMapsUrl(point)} target="_blank" rel="noreferrer">Google Maps</a>
    </div>
  );
}

export function CdtaCredit() {
  return <p className="credit">Bus data from CDTA. Unofficial, not affiliated with CDTA.</p>;
}

export function MapControls(props: {
  satellite: boolean;
  showCdta: boolean;
  onSatellite(on: boolean): void;
  onShowCdta(on: boolean): void;
  onLocate(): void;
}) {
  const { satellite, showCdta, onSatellite, onShowCdta, onLocate } = props;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="map-controls" ref={root}>
      {open && (
        <div className="layer-menu">
          <label><input type="checkbox" checked={satellite} onChange={(e) => onSatellite(e.target.checked)} /> Satellite</label>
          <label><input type="checkbox" checked={showCdta} onChange={(e) => onShowCdta(e.target.checked)} /> CDTA buses</label>
        </div>
      )}
      <button type="button" className="map-btn" aria-label="Map layers" aria-expanded={open} onClick={() => setOpen(!open)}>
        <LayersIcon size={18} />
      </button>
      <button type="button" className="map-btn" aria-label="Show my location" onClick={onLocate}>
        <LocateIcon size={18} />
      </button>
    </div>
  );
}
