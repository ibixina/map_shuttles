import { useState } from 'react';
import { formatDistance, formatDuration, metersBetween } from '../lib/geo';
import { busStatusText, liveArrivals, type Bus } from '../lib/live';
import type { Network, Route, Stop } from '../lib/network';
import type { Leg, PlanResult, RideLeg, Trip, WalkLeg } from '../lib/planner';
import type { Place, PlaceCategory, RawPlace } from '../lib/search';
import { dayLabel, formatTime, formatTimeWithDay, type Clock, type Timetable } from '../lib/time';
import { walkPathKey, type WalkPath } from '../lib/walking';
import { Actions, Badge, CdtaCredit, googleDirectionsUrl, PanelHeader } from './parts';

function minutesAway(abs: number, clock: Clock): string {
  const delta = Math.round(abs - clock.minutes);
  if (delta <= 0) return 'now';
  return delta < 60 ? `in ${delta} min` : `in ${formatDuration(delta)}`;
}

// --- Browse -------------------------------------------------------------------------------

export function browsePlaces(all: RawPlace[], cat: PlaceCategory): RawPlace[] {
  // Food is useful off campus too; for everything else, off-campus results are noise.
  return all.filter((p) => p.cat === cat && (cat === 'food' || p.campus)).sort((a, b) => a.name.localeCompare(b.name));
}

export function BrowsePanel({ title, places, onBack, onPick }: { title: string; places: Place[]; onBack(): void; onPick(p: Place): void }) {
  return (
    <>
      <PanelHeader title={title} subtitle={`${places.length} places`} onClose={onBack} />
      <div className="panel-body">
        <ul>
          {places.map((place) => (
            <li key={place.id}>
              <button type="button" className="row" onClick={() => onPick(place)}>
                <span className="row-main">
                  <span>{place.name}</span>
                  {place.subtitle && <small>{place.subtitle}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// --- Stop ---------------------------------------------------------------------------------

export function StopPanel(props: {
  stop: Stop;
  network: Network;
  timetable: Timetable;
  clock: Clock;
  buses: Bus[];
  onBack(): void;
  onDirections(): void;
  onStop(id: string): void;
  onRoute(id: string): void;
  onBus(id: string): void;
}) {
  const { stop, network, timetable, clock, buses, onBack, onDirections, onStop, onRoute, onBus } = props;
  const route = network.routeById.get(stop.routeId)!;
  const departures = timetable.upcoming(stop.routeId, clock.minutes - stop.offset, 4).map((t) => t + stop.offset);
  const isUnion = stop.index === 0;
  const live = liveArrivals(isUnion ? route.stops.at(-1)! : stop, buses);
  const later = route.stops.filter((s) => s.index > stop.index);
  const otherUnionStop = isUnion ? network.boardingStops.find((s) => s.index === 0 && s.routeId !== stop.routeId) : undefined;
  return (
    <>
      <PanelHeader title={stop.name} subtitle={`Shuttle stop · ${route.name}`} color={route.color} onClose={onBack} />
      <div className="panel-body">
        <Actions point={stop} onDirections={onDirections} />
        {otherUnionStop && (
          <p className="muted">
            The {network.routeById.get(otherUnionStop.routeId)?.name} stop has a separate marker, about {formatDistance(metersBetween(stop, otherUnionStop))} away.
          </p>
        )}
        {live.length > 0 && (
          <section>
            <h3><span className="live-dot" /> On the way</h3>
            <ul>
              {live.map(({ bus, etaMin }) => (
                <li key={bus.id}>
                  <button type="button" className="row" onClick={() => onBus(bus.id)}>
                    <span className="row-main"><span>Bus {bus.name}</span></span>
                    <span className="row-time">{etaMin < 1 ? 'Arriving' : `~${Math.round(etaMin)} min`}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3>Departures</h3>
          {departures.length === 0 && <p className="muted">None scheduled.</p>}
          <ul>
            {departures.map((t) => (
              <li key={t} className="row is-static">
                <span className="row-main"><span>{formatTimeWithDay(t, clock)}</span></span>
                <small>{minutesAway(t, clock)}</small>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>Next stops</h3>
          <ul className="timeline" style={{ ['--c' as string]: route.color }}>
            {later.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onStop(s.isReturn ? route.stops[0].id : s.id)}>
                  <span>{s.isReturn ? `${s.name} (end of loop)` : s.name}</span>
                  <small>{Math.max(1, s.offset - stop.offset)} min</small>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="link" onClick={() => onRoute(route.id)}>Whole route</button>
        </section>
      </div>
    </>
  );
}

// --- Route --------------------------------------------------------------------------------

export function RoutePanel(props: {
  route: Route;
  timetable: Timetable;
  clock: Clock;
  buses: Bus[];
  onBack(): void;
  onStop(id: string): void;
  onBus(id: string): void;
}) {
  const { route, timetable, clock, buses, onBack, onStop, onBus } = props;
  const hours = timetable.serviceHours(route.id);
  const nextRuns = timetable.upcoming(route.id, clock.minutes, 3);
  const onThisRoute = buses.filter((b) => b.route?.id === route.id);
  const nextRun = nextRuns[0];
  return (
    <>
      <PanelHeader
        title={route.name}
        subtitle={hours ? `Today ${formatTime(hours.first)} – ${formatTime(hours.last)} · ${route.duration} min loop` : 'No service today'}
        color={route.color}
        onClose={onBack}
      />
      <div className="panel-body">
        <section>
          <h3>Leaves the Student Union</h3>
          <p>{nextRuns.length ? nextRuns.map((t) => formatTimeWithDay(t, clock)).join('  ·  ') : 'None scheduled.'}</p>
        </section>
        {onThisRoute.length > 0 && (
          <section>
            <h3><span className="live-dot" /> Running now</h3>
            <ul>
              {onThisRoute.map((bus) => (
                <li key={bus.id}>
                  <button type="button" className="row" onClick={() => onBus(bus.id)}>
                    <span className="row-main">
                      <span>Bus {bus.name}</span>
                      <small>{busStatusText(bus)}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3>{nextRun != null ? `Stops for the ${formatTime(nextRun)} bus` : 'Stops'}</h3>
          <ul className="timeline" style={{ ['--c' as string]: route.color }}>
            {route.stops.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onStop(s.isReturn ? route.stops[0].id : s.id)}>
                  <span>{s.isReturn ? `${s.name} (end of loop)` : s.name}</span>
                  {nextRun != null && <small>{formatTime(nextRun + s.offset)}</small>}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <p className="muted">Times can change on holidays and breaks.</p>
      </div>
    </>
  );
}

// --- Bus ----------------------------------------------------------------------------------

export function BusPanel({ bus, onBack, onStop }: { bus: Bus; onBack(): void; onStop(stop: Stop): void }) {
  return (
    <>
      <PanelHeader title={`Bus ${bus.name}`} subtitle={busStatusText(bus)} color={bus.route?.color} onClose={onBack} />
      <div className="panel-body">
        {bus.stale && <p className="muted">Hasn't reported in a while, so its position may be out of date.</p>}
        {!bus.route && <p className="muted">Not on a passenger route right now.</p>}
        {bus.route && bus.upcoming.length > 0 && (
          <section>
            <h3>Next stops</h3>
            <ul className="timeline" style={{ ['--c' as string]: bus.route.color }}>
              {bus.upcoming.map(({ stop, etaMin }) => (
                <li key={stop.id}>
                  <button type="button" onClick={() => onStop(stop)}>
                    <span>{stop.isReturn ? `${stop.name} (end of loop)` : stop.name}</span>
                    <small>{etaMin < 1 ? 'Arriving' : `~${Math.round(etaMin)} min`}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3>Driver and vehicle</h3>
          <dl className="details">
            <div><dt>Speed</dt><dd>{Math.round(bus.speedMph)} mph</dd></div>
            <div><dt>Last update</dt><dd>{bus.ageSeconds < 60 ? `${Math.round(bus.ageSeconds)} sec ago` : `${Math.round(bus.ageSeconds / 60)} min ago`}</dd></div>
            {bus.details.map(({ label, value }) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </section>
      </div>
    </>
  );
}

// --- Directions ---------------------------------------------------------------------------

const firstRide = (trip: Trip) => trip.legs.find((l): l is RideLeg => l.kind === 'ride');

function TripCard({ trip, best, clock, selected, onSelect }: { trip: Trip; best: boolean; clock: Clock; selected: boolean; onSelect(): void }) {
  const rides = trip.legs.filter((l): l is RideLeg => l.kind === 'ride');
  const first = rides[0];
  const last = rides.at(-1);
  return (
    <button type="button" className={`trip-card ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={onSelect}>
      <span className="trip-line">
        <span className="trip-how">
          {rides.length === 0 && <span>Walk</span>}
          {rides.map((r, i) => <Badge key={i} label={r.routeShort} color={r.color} textColor={r.textColor} />)}
          {best && <small className="trip-best">Best</small>}
        </span>
        <b>{formatDuration(trip.arriveMin - trip.leaveMin)}</b>
      </span>
      {first && last && (
        <span className="trip-stops">
          <span><i>Get on</i> {first.board.name}, {formatTimeWithDay(first.departMin, clock)}</span>
          {rides.slice(1).map((r, i) => {
            const offAt = rides[i].alight.name;
            return <span key={i}><i>Change</i> {offAt === r.board.name ? r.board.name : `${offAt}, walk to ${r.board.name}`}</span>;
          })}
          <span><i>Get off</i> {last.alight.isReturn ? `${last.alight.name} (end of loop)` : last.alight.name}, {formatTime(last.arriveMin)}</span>
        </span>
      )}
      <small>
        Arrive {formatTime(trip.arriveMin)} · {rides.length ? `${formatDuration(trip.walkMinutes)} walking` : formatDistance(trip.walkMeters)}
      </small>
    </button>
  );
}

function WalkStep({ leg, path, endLabel }: { leg: WalkLeg; path: WalkPath | undefined; endLabel: string }) {
  const [open, setOpen] = useState(false);
  const steps = path?.steps ?? [];
  return (
    <li className="step step-walk">
      <p>Walk {formatDuration(leg.minutes)} to {endLabel}</p>
      <small>{formatDistance(leg.meters)}</small>
      {path?.isEstimate && <small>Exact path unavailable, so the line is direct. Follow the sidewalks.</small>}
      {steps.length > 1 && (
        <>
          <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide steps' : 'Walking directions'}
          </button>
          {open && (
            <ol className="walk-steps">
              {steps.map((s, i) => <li key={i}>{s.text}</li>)}
            </ol>
          )}
        </>
      )}
    </li>
  );
}

function RideStep({ leg, network, clock, buses, isNow }: { leg: RideLeg; network: Network; clock: Clock; buses: Bus[]; isNow: boolean }) {
  const [open, setOpen] = useState(false);
  const shuttleStop = leg.agency === 'rpi' ? network.stopById.get(leg.board.id.replace(/^rpi:/, '')) : undefined;
  const arrivals = isNow && shuttleStop ? liveArrivals(shuttleStop, buses) : [];
  const count = leg.stopsPassed.length + 1;
  const title = leg.agency === 'cdta' ? `CDTA ${leg.routeShort}` : `the ${leg.routeName}`;
  const liveDelta = leg.liveDepartMin != null ? Math.round(leg.liveDepartMin - leg.departMin) : null;
  return (
    <li className="step step-ride" style={{ ['--c' as string]: leg.color }}>
      <p>Board {title} at {leg.board.name}</p>
      {leg.agency === 'cdta' && leg.headsign && <small>{leg.headsign}</small>}
      <small>
        {formatTimeWithDay(leg.departMin, clock)}
        {leg.later.length > 0 && `, then ${leg.later.slice(0, 2).map(formatTime).join(', ')}`}
      </small>
      {arrivals[0] && (
        <small className="live-note">
          <span className="live-dot" /> Bus {arrivals[0].bus.name} {arrivals[0].etaMin < 1 ? 'arriving now' : `about ${Math.round(arrivals[0].etaMin)} min away`}
        </small>
      )}
      {isNow && liveDelta != null && leg.liveDepartMin != null && (
        <small className="live-note">
          <span className="live-dot" /> Live {formatTime(leg.liveDepartMin)}
          {Math.abs(liveDelta) >= 2 ? ` (${liveDelta > 0 ? `${liveDelta} min late` : `${-liveDelta} min early`})` : ''}
        </small>
      )}
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {count} {count === 1 ? 'stop' : 'stops'} · {formatDuration(leg.arriveMin - leg.departMin)}
      </button>
      {open && leg.stopsPassed.length > 0 && (
        <ul className="passed-stops">
          {leg.stopsPassed.map((s, i) => <li key={`${s.id}:${i}`}>{s.name}</li>)}
        </ul>
      )}
      <p>Get off at {leg.alight.isReturn ? `${leg.alight.name} (end of loop)` : leg.alight.name}</p>
      <small>{formatTimeWithDay(leg.arriveMin, clock)}</small>
    </li>
  );
}

function TripSteps({ trip, network, clock, buses, walkPaths, isNow, destination }: {
  trip: Trip;
  network: Network;
  clock: Clock;
  buses: Bus[];
  walkPaths: Map<string, WalkPath>;
  isNow: boolean;
  destination: string;
}) {
  const renderLeg = (leg: Leg, i: number) => {
    if (leg.kind === 'ride') return <RideStep key={i} leg={leg} network={network} clock={clock} buses={buses} isNow={isNow} />;
    const next = trip.legs[i + 1];
    return <WalkStep key={i} leg={leg} path={walkPaths.get(walkPathKey(leg.from, leg.to))} endLabel={next?.kind === 'ride' ? next.board.name : destination} />;
  };
  return (
    <ol className="steps">
      {firstRide(trip) && <li className="step-time">Leave by {formatTimeWithDay(trip.leaveMin, clock)}</li>}
      {trip.legs.map(renderLeg)}
      <li className="step-time">Arrive by {formatTimeWithDay(trip.arriveMin, clock)}</li>
    </ol>
  );
}

export interface LeaveAt {
  dayOffset: number;
  minutes: number;
}

const toTimeInput = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;

function LeaveControl({ leaveAt, clock, onChange }: { leaveAt: LeaveAt | null; clock: Clock; onChange(v: LeaveAt | null): void }) {
  const dayNames = ['Today', 'Tomorrow', ...[2, 3, 4, 5, 6].map((n) => dayLabel(n * 1440, clock))];
  return (
    <div className="leave-control">
      <select
        aria-label="When to leave"
        value={leaveAt ? 'later' : 'now'}
        onChange={(e) => onChange(e.target.value === 'now' ? null : { dayOffset: 0, minutes: Math.ceil(clock.minutes / 5) * 5 })}
      >
        <option value="now">Leave now</option>
        <option value="later">Leave at</option>
      </select>
      {leaveAt && (
        <>
          <select aria-label="Day" value={leaveAt.dayOffset} onChange={(e) => onChange({ ...leaveAt, dayOffset: Number(e.target.value) })}>
            {dayNames.map((name, i) => <option key={name} value={i}>{name}</option>)}
          </select>
          <input
            type="time"
            aria-label="Time"
            value={toTimeInput(leaveAt.minutes)}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              if (Number.isFinite(h) && Number.isFinite(m)) onChange({ ...leaveAt, minutes: h * 60 + m });
            }}
          />
        </>
      )}
    </div>
  );
}

export function DirectionsResults(props: {
  from: Place | null;
  to: Place | null;
  plan: PlanResult | null;
  loading: boolean;
  selectedTripId: string | null;
  network: Network;
  clock: Clock;
  buses: Bus[];
  walkPaths: Map<string, WalkPath>;
  leaveAt: LeaveAt | null;
  locationError: string | null;
  transitUnavailable: boolean;
  onLeaveAt(v: LeaveAt | null): void;
  onSelectTrip(id: string): void;
  onUseMyLocation(): void;
  onPickStartOnMap(): void;
}) {
  const { from, to, plan, loading, selectedTripId, network, clock, buses, walkPaths, leaveAt, locationError, transitUnavailable, onLeaveAt, onSelectTrip, onUseMyLocation, onPickStartOnMap } = props;
  const selected = plan?.trips.find((t) => t.id === selectedTripId) ?? plan?.trips[0] ?? null;
  const busTrips = plan?.trips.filter((t) => t.kind !== 'walk') ?? [];

  if (!from || !to) {
    return (
      <div className="panel-body">
        {locationError && <p className="muted">{locationError}</p>}
        <p className="muted">
          {!from && to && 'Where are you starting from? Search, or click the map.'}
          {from && !to && 'Where to? Search, or click the map.'}
          {!from && !to && 'Search for a start and destination, or click the map.'}
        </p>
      </div>
    );
  }

  return (
    <div className="panel-body">
      {locationError && (
        <p className="muted">
          {locationError} Type where you are in the start field, or{' '}
          <button type="button" className="link" onClick={onPickStartOnMap}>click your spot on the map</button>.
        </p>
      )}
      <div className="destination">
        <h2>{to.name}</h2>
        {to.subtitle && <p className="muted">{to.subtitle}</p>}
        <Actions point={to} />
      </div>
      <div className="trip-options-bar">
        <LeaveControl leaveAt={leaveAt} clock={clock} onChange={onLeaveAt} />
        {from.kind !== 'me' && <button type="button" className="link" onClick={onUseMyLocation}>Use my location</button>}
      </div>
      {loading && !plan && <p className="muted" role="status">Finding the best way…</p>}
      {plan && (
        <>
          {busTrips.length === 0 && plan.outOfRange && (
            <p className="muted">
              Neither the shuttle nor CDTA comes near this trip.{' '}
              <a href={googleDirectionsUrl(from, to, 'transit')} target="_blank" rel="noreferrer">Try Google Maps</a>
            </p>
          )}
          {busTrips.length === 0 && !plan.outOfRange && plan.trips.length > 0 && <p className="muted">A bus wouldn't save you any walking.</p>}
          {transitUnavailable && <p className="muted">CDTA options aren't available right now.</p>}
          <ul className="trip-list" aria-label="Ways to get there">
            {plan.trips.map((trip, i) => (
              <li key={trip.id} className={`trip-option ${trip.id === selected?.id ? 'is-selected' : ''}`}>
                <TripCard trip={trip} best={i === 0 && plan.trips.length > 1} clock={clock} selected={trip.id === selected?.id} onSelect={() => onSelectTrip(trip.id)} />
                {trip.id === selected?.id && (
                  <TripSteps trip={trip} network={network} clock={clock} buses={buses} walkPaths={walkPaths} isNow={!leaveAt} destination={to.name} />
                )}
              </li>
            ))}
          </ul>
          {selected?.hasEstimatedWalk && <p className="muted">Walking times are rough estimates right now.</p>}
          {selected && selected.kind !== 'walk' && <p className="muted">Scheduled times. Buses can run a few minutes off, and holidays may differ.</p>}
          {selected?.kind === 'transit' && <CdtaCredit />}
          <a className="link" href={googleDirectionsUrl(from, to)} target="_blank" rel="noreferrer">Compare in Google Maps</a>
        </>
      )}
    </div>
  );
}
