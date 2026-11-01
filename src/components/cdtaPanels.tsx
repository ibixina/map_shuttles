import { formatDuration } from '../lib/geo';
import type { CdtaAlert, CdtaArrival, CdtaOverview, CdtaRoute, CdtaRouteDetail, CdtaStop, CdtaStopDetail, CdtaVehicle, CdtaVehicleDetail } from '../lib/cdta';
import { formatTime, formatTimeWithDay, type Clock } from '../lib/time';
import { Actions, Badge, CdtaCredit, PanelHeader } from './parts';

function Alerts({ alerts }: { alerts: CdtaAlert[] }) {
  if (!alerts.length) return null;
  return (
    <section>
      <h3>Alerts</h3>
      {alerts.map((alert) => (
        <details key={alert.id} className="alert">
          <summary>{alert.header || 'Service alert'}</summary>
          <p>{alert.description}</p>
          {alert.url && /^https?:/.test(alert.url) && <a href={alert.url} target="_blank" rel="noreferrer">More from CDTA</a>}
        </details>
      ))}
    </section>
  );
}

const minsAway = (abs: number, clock: Clock) => {
  const delta = Math.round(abs - clock.minutes);
  if (delta <= 0) return 'now';
  return delta < 60 ? `${delta} min` : formatDuration(delta);
};

function lateness(liveMin: number, schedMin: number): string {
  const delta = Math.round(liveMin - schedMin);
  if (Math.abs(delta) < 2) return 'On time';
  return delta > 0 ? `${delta} min late` : `${-delta} min early`;
}

function ArrivalRow({ arrival, clock, onClick }: { arrival: CdtaArrival; clock: Clock; onClick(): void }) {
  const at = arrival.liveMin ?? arrival.schedMin;
  return (
    <li>
      <button type="button" className="row" onClick={onClick}>
        <Badge label={arrival.short} color={arrival.color} textColor={arrival.textColor} />
        <span className="row-main">
          <span>{arrival.headsign || arrival.long}</span>
          <small>
            {formatTimeWithDay(at, clock)}
            {arrival.liveMin != null && <> · <span className="live-dot" /> {lateness(arrival.liveMin, arrival.schedMin)}</>}
          </small>
        </span>
        <span className="row-time">{minsAway(at, clock)}</span>
      </button>
    </li>
  );
}

export function CdtaStopPanel(props: {
  stop: CdtaStop;
  routes: Map<string, CdtaRoute>;
  detail: CdtaStopDetail | null;
  failed: boolean;
  clock: Clock;
  onBack(): void;
  onDirections(): void;
  onRoute(id: string): void;
  onBus(id: string): void;
}) {
  const { stop, routes, detail, failed, clock, onBack, onDirections, onRoute, onBus } = props;
  const list = stop.routes.flatMap((id) => routes.get(id) ?? []).sort((a, b) => a.sort - b.sort);
  return (
    <>
      <PanelHeader title={stop.name} subtitle={`CDTA stop ${stop.code}`} onClose={onBack} />
      <div className="panel-body">
        <Actions point={stop} onDirections={onDirections} />
        <div className="badge-row">
          {list.map((r) => (
            <button type="button" key={r.id} aria-label={`Route ${r.short}, ${r.long}`} title={r.long} onClick={() => onRoute(r.id)}>
              <Badge label={r.short} color={r.color} textColor={r.textColor} />
            </button>
          ))}
        </div>
        <section>
          <h3>Next buses</h3>
          {!detail && !failed && <p className="muted" role="status">Loading…</p>}
          {failed && !detail && <p className="muted">Can't load arrivals right now.</p>}
          {detail && detail.arrivals.length === 0 && <p className="muted">None scheduled.</p>}
          {detail && (
            <ul>
              {detail.arrivals.map((a) => (
                <ArrivalRow key={`${a.tripId}:${a.schedMin}`} arrival={a} clock={clock} onClick={() => (a.vehicleId ? onBus(a.vehicleId) : onRoute(a.routeId))} />
              ))}
            </ul>
          )}
        </section>
        {detail && <Alerts alerts={detail.alerts} />}
        <CdtaCredit />
      </div>
    </>
  );
}

export function CdtaRoutePanel(props: {
  route: CdtaRoute;
  detail: CdtaRouteDetail | null;
  failed: boolean;
  directionIndex: number;
  vehicles: CdtaVehicle[];
  onDirectionIndex(i: number): void;
  onBack(): void;
  onStop(id: string): void;
  onBus(id: string): void;
}) {
  const { route, detail, failed, directionIndex, vehicles, onDirectionIndex, onBack, onStop, onBus } = props;
  const direction = detail?.directions[directionIndex] ?? detail?.directions[0] ?? null;
  const running = vehicles.filter((v) => v.routeId === route.id);
  return (
    <>
      <PanelHeader title={`Route ${route.short}`} subtitle={route.long} color={route.color} onClose={onBack} />
      <div className="panel-body">
        {!detail && !failed && <p className="muted" role="status">Loading…</p>}
        {failed && !detail && <p className="muted">Can't load this route right now.</p>}
        {detail && detail.directions.length > 1 && (
          <div className="segments" role="group" aria-label="Direction">
            {detail.directions.map((d, i) => (
              <button type="button" key={d.direction} aria-pressed={i === directionIndex} className={i === directionIndex ? 'is-on' : ''} onClick={() => onDirectionIndex(i)}>
                {d.headsign || `Direction ${i + 1}`}
              </button>
            ))}
          </div>
        )}
        {direction && (
          <p className="muted">
            {direction.firstMin != null && direction.lastMin != null
              ? `Today ${formatTime(direction.firstMin)} – ${formatTime(direction.lastMin)} · ${direction.tripsToday} trips`
              : 'No trips this way today.'}
          </p>
        )}
        {detail && <Alerts alerts={detail.alerts} />}
        {running.length > 0 && (
          <section>
            <h3><span className="live-dot" /> Running now</h3>
            <ul>
              {running.map((v) => (
                <li key={v.id}>
                  <button type="button" className="row" onClick={() => onBus(v.id)}>
                    <span className="row-main">
                      <span>Bus {v.id}</span>
                      <small>{v.headsign}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {direction && (
          <section>
            <h3>Stops</h3>
            <ul className="timeline" style={{ ['--c' as string]: route.color }}>
              {direction.stops.map((s, i) => (
                <li key={`${s.id}:${i}`}>
                  <button type="button" onClick={() => onStop(s.id)}><span>{s.name}</span></button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <CdtaCredit />
      </div>
    </>
  );
}

export function CdtaBusPanel(props: {
  vehicle: CdtaVehicle | null;
  detail: CdtaVehicleDetail | null;
  failed: boolean;
  onBack(): void;
  onRoute(id: string): void;
  onStop(id: string): void;
}) {
  const { vehicle, detail, failed, onBack, onRoute, onStop } = props;
  const bus = detail ?? vehicle;
  if (!bus) {
    return (
      <>
        <PanelHeader title="CDTA bus" onClose={onBack} />
        <div className="panel-body">
          <p className="muted">{failed ? "This bus isn't reporting a position right now." : 'Loading…'}</p>
        </div>
      </>
    );
  }
  const stopName = detail?.currentStopName;
  const status = !stopName ? bus.headsign : bus.status === 'STOPPED_AT' ? `Stopped at ${stopName}` : `Next stop: ${stopName}`;
  const firstSched = detail?.upcoming[0]?.schedMin;
  const late = detail?.delayMin != null && firstSched != null ? lateness(firstSched + detail.delayMin, firstSched) : null;
  return (
    <>
      <PanelHeader title={`Bus ${bus.id}`} subtitle={status} color={bus.color} onClose={onBack} />
      <div className="panel-body">
        <button type="button" className="row" onClick={() => onRoute(bus.routeId)}>
          <Badge label={bus.short} color={bus.color} textColor={bus.textColor} />
          <span className="row-main">
            <span>{bus.long}</span>
            <small>{bus.headsign}</small>
          </span>
        </button>
        <dl className="details">
          {late && <div><dt>Schedule</dt><dd>{late}</dd></div>}
          {bus.occupancy && <div><dt>Seats</dt><dd>{bus.occupancy}</dd></div>}
          <div><dt>Last update</dt><dd>{bus.ageSeconds < 60 ? `${Math.round(bus.ageSeconds)} sec ago` : `${Math.round(bus.ageSeconds / 60)} min ago`}</dd></div>
        </dl>
        {detail && detail.upcoming.length > 0 && (
          <section>
            <h3>Next stops</h3>
            <ul className="timeline" style={{ ['--c' as string]: bus.color }}>
              {detail.upcoming.map((u) => (
                <li key={`${u.stopId}:${u.schedMin}`}>
                  <button type="button" onClick={() => onStop(u.stopId)}>
                    <span>{u.name}</span>
                    <small>{formatTime(u.liveMin ?? u.schedMin)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <CdtaCredit />
      </div>
    </>
  );
}

export function CdtaRoutesPanel({ overview, nearCampus, onBack, onRoute }: { overview: CdtaOverview; nearCampus: CdtaRoute[]; onBack(): void; onRoute(id: string): void }) {
  const near = new Set(nearCampus.map((r) => r.id));
  const row = (r: CdtaRoute) => (
    <li key={r.id}>
      <button type="button" className="row" onClick={() => onRoute(r.id)}>
        <Badge label={r.short} color={r.color} textColor={r.textColor} />
        <span className="row-main"><span>{r.long}</span></span>
      </button>
    </li>
  );
  return (
    <>
      <PanelHeader title="CDTA routes" onClose={onBack} />
      <div className="panel-body">
        <section>
          <h3>Near campus</h3>
          <ul>{nearCampus.map(row)}</ul>
        </section>
        <section>
          <h3>Everywhere else</h3>
          <ul>{overview.routes.filter((r) => !near.has(r.id)).map(row)}</ul>
        </section>
        <CdtaCredit />
      </div>
    </>
  );
}
