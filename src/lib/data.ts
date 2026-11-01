import { useEffect, useMemo, useRef, useState } from 'react';
import { dataUrl, LIVE_URL } from './engine';
import { buildBuses, type Bus, type RawEta, type RawLocation, type RawVelocity } from './live';
import { buildNetwork, type Network, type RawRoutes } from './network';
import { Timetable, troyClock, type Clock, type RawSchedule } from './time';

const LIVE_POLL_MS = 6_000;
const STATIC_REFRESH_MS = 3_600_000;
const STATIC_RETRY_MS = 10_000;
const CLOCK_TICK_MS = 15_000;

export interface Announcement {
  id: string | number;
  message: string;
  type?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Runs `task` now and on an interval, pausing while the tab is in the background. */
function usePolling(task: () => void, intervalMs: number) {
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    let timer: number | undefined;
    const start = () => {
      latest.current();
      timer = window.setInterval(() => latest.current(), intervalMs);
    };
    const stop = () => window.clearInterval(timer);
    const onVisibility = () => {
      stop();
      if (!document.hidden) start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}

export function useClock(): Clock {
  const [clock, setClock] = useState(() => troyClock());
  usePolling(() => setClock(troyClock()), CLOCK_TICK_MS);
  return clock;
}

export interface ShuttleData {
  network: Network | null;
  schedule: RawSchedule | null;
  timetable: Timetable | null;
  buses: Bus[];
  /** The live feed isn't answering; schedule information still works. */
  liveFailed: boolean;
  /** Routes couldn't be loaded at all: nothing useful can be shown yet. */
  staticFailed: boolean;
  announcements: Announcement[];
}

export function useShuttleData(clock: Clock): ShuttleData {
  const [network, setNetwork] = useState<Network | null>(null);
  const [schedule, setSchedule] = useState<RawSchedule | null>(null);
  const [staticFailed, setStaticFailed] = useState(false);
  const [locations, setLocations] = useState<Record<string, RawLocation>>({});
  const [velocities, setVelocities] = useState<Record<string, RawVelocity>>({});
  const [etas, setEtas] = useState<Record<string, RawEta>>({});
  const [liveFailed, setLiveFailed] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const [routes, sched] = await Promise.all([getJson<RawRoutes>(dataUrl('shuttle-routes.json')), getJson<RawSchedule>(dataUrl('shuttle-schedule.json'))]);
        if (cancelled) return;
        setNetwork(buildNetwork(routes));
        setSchedule(sched);
        setStaticFailed(false);
        timer = window.setTimeout(load, STATIC_REFRESH_MS);
      } catch {
        if (cancelled) return;
        setStaticFailed(true);
        timer = window.setTimeout(load, STATIC_RETRY_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  usePolling(() => {
    if (!LIVE_URL) return;
    getJson<{ locations: Record<string, RawLocation>; velocities: Record<string, RawVelocity> | null; etas: Record<string, RawEta> | null; announcements: Announcement[] | null }>(`${LIVE_URL}/shuttle`).then(
      (live) => {
        setLocations(live.locations);
        setVelocities(live.velocities ?? {});
        setEtas(live.etas ?? {});
        setAnnouncements(Array.isArray(live.announcements) ? live.announcements : []);
        setFetchedAt(Date.now());
        setLiveFailed(false);
      },
      () => setLiveFailed(true),
    );
  }, LIVE_POLL_MS);

  const timetable = useMemo(() => (schedule ? new Timetable(schedule, clock) : null), [schedule, clock.dateKey]);
  const buses = useMemo(
    () => (network ? buildBuses(locations, velocities, etas, network, fetchedAt) : []),
    [network, locations, velocities, etas, fetchedAt],
  );

  return { network, schedule, timetable, buses, liveFailed, staticFailed, announcements };
}
