// All shuttle times are Troy local time regardless of where the viewer's browser is.
//
// Times are handled as "absolute minutes": minutes since midnight of today in Troy.
// A 12:00 AM departure belongs to the previous evening's service, so it counts as
// minute 1440 of that day.

const TZ = 'America/New_York';
export const DAY = 1440;
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/** Service days run past midnight: anything before this hour belongs to the night before. */
const SERVICE_DAY_ROLLOVER_HOUR = 4;

export interface Clock {
  /** Index into WEEKDAYS for today in Troy. */
  weekdayIndex: number;
  /** Minutes since midnight in Troy, including fractional seconds. */
  minutes: number;
  /** Changes when the date changes. */
  dateKey: string;
}

export function troyClock(date: Date = new Date()): Clock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekdayIndex: WEEKDAYS.indexOf(get('weekday').toUpperCase()),
    minutes: Number(get('hour')) * 60 + Number(get('minute')) + Number(get('second')) / 60,
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** "7:25 PM" to service-day minutes; early-morning times count as past midnight. */
export function parseClockTime(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text.trim());
  if (!m) return null;
  const hour12 = Number(m[1]) % 12;
  const pm = m[3].toUpperCase() === 'PM';
  const hour = hour12 + (pm ? 12 : 0);
  const minutes = hour * 60 + Number(m[2]);
  return !pm && hour < SERVICE_DAY_ROLLOVER_HOUR ? minutes + DAY : minutes;
}

export function formatTime(abs: number): string {
  const m = ((Math.round(abs) % DAY) + DAY) % DAY;
  const h = Math.floor(m / 60);
  const minute = String(m % 60).padStart(2, '0');
  return `${h % 12 || 12}:${minute} ${h < 12 ? 'AM' : 'PM'}`;
}

/** '' for today, otherwise 'Tomorrow' or the weekday, for prefixing a time. */
export function dayLabel(abs: number, clock: Clock): string {
  const dayOffset = Math.floor(Math.round(abs) / DAY);
  if (dayOffset <= 0) return '';
  if (dayOffset === 1) return 'Tomorrow';
  const name = WEEKDAYS[(clock.weekdayIndex + dayOffset) % 7];
  return name.charAt(0) + name.slice(1).toLowerCase();
}

export function formatTimeWithDay(abs: number, clock: Clock): string {
  const day = dayLabel(abs, clock);
  return day ? `${day} ${formatTime(abs)}` : formatTime(abs);
}

export type RawSchedule = Record<string, unknown>;

/** Departures from the Student Union, per route, across a window around today. */
export class Timetable {
  private readonly byRoute = new Map<string, number[]>();

  constructor(schedule: RawSchedule, clock: Clock, daysAhead = 8) {
    const collected = new Map<string, Set<number>>();
    for (let offset = -1; offset <= daysAhead; offset++) {
      const weekday = WEEKDAYS[(clock.weekdayIndex + offset + 7) % 7];
      const dayType = schedule[weekday] as string | undefined;
      const buses = (dayType ? schedule[dayType] : undefined) as Record<string, [string, string][]> | undefined;
      for (const runs of Object.values(buses ?? {})) {
        for (const [time, routeId] of runs) {
          const minutes = parseClockTime(time);
          if (minutes == null) continue;
          const set = collected.get(routeId) ?? new Set<number>();
          set.add(minutes + offset * DAY);
          collected.set(routeId, set);
        }
      }
    }
    for (const [routeId, set] of collected) {
      this.byRoute.set(routeId, [...set].sort((a, b) => a - b));
    }
  }

  /** First Student Union departure at or after `abs`. */
  next(routeId: string, abs: number): number | null {
    return this.upcoming(routeId, abs, 1)[0] ?? null;
  }

  upcoming(routeId: string, abs: number, count: number): number[] {
    const all = this.byRoute.get(routeId) ?? [];
    const start = all.findIndex((t) => t >= abs);
    return start === -1 ? [] : all.slice(start, start + count);
  }

  /** First and last departure of the service day starting at `dayOffset`. */
  serviceHours(routeId: string, dayOffset = 0): { first: number; last: number } | null {
    const lo = dayOffset * DAY + SERVICE_DAY_ROLLOVER_HOUR * 60;
    const hi = lo + DAY;
    const within = (this.byRoute.get(routeId) ?? []).filter((t) => t >= lo && t < hi);
    return within.length ? { first: within[0], last: within[within.length - 1] } : null;
  }
}
