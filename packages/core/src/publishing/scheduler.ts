/**
 * Publishing scheduler (Module 6): turns a channel's human-readable cadence into the next
 * concrete publish time. Supported cadences:
 *
 *   "daily HH:MM [IANA-timezone]"          e.g. "daily 16:00 America/Los_Angeles"
 *   "weekly DAY HH:MM [IANA-timezone]"     e.g. "weekly fri 10:30 Europe/Berlin"
 *
 * Timezone math uses Intl (built into Node) — no dependencies. DST is handled by
 * re-checking the wall-clock time of the candidate and correcting once.
 */

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface ParsedCadence {
  readonly kind: "daily" | "weekly";
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string; // IANA; defaults to UTC
  readonly weekday?: number; // 0=Sun … 6=Sat (weekly only)
}

export class CadenceParseError extends Error {
  constructor(cadence: string, reason: string) {
    super(`Cannot parse cadence "${cadence}": ${reason}`);
    this.name = "CadenceParseError";
  }
}

export function parseCadence(cadence: string): ParsedCadence {
  const parts = cadence.trim().split(/\s+/);
  const kind = parts[0]?.toLowerCase();

  if (kind === "daily") {
    const time = parts[1];
    const tz = parts[2] ?? "UTC";
    const hm = parseTime(cadence, time);
    assertTimeZone(cadence, tz);
    return { kind: "daily", ...hm, timeZone: tz };
  }
  if (kind === "weekly") {
    const day = parts[1]?.toLowerCase().slice(0, 3);
    const weekday = DAYS.indexOf(day as (typeof DAYS)[number]);
    if (weekday < 0) throw new CadenceParseError(cadence, `unknown weekday "${parts[1]}"`);
    const hm = parseTime(cadence, parts[2]);
    const tz = parts[3] ?? "UTC";
    assertTimeZone(cadence, tz);
    return { kind: "weekly", weekday, ...hm, timeZone: tz };
  }
  throw new CadenceParseError(cadence, `unknown cadence kind "${parts[0]}"`);
}

function parseTime(cadence: string, time: string | undefined): { hour: number; minute: number } {
  const m = time ? /^(\d{1,2}):(\d{2})$/.exec(time) : null;
  if (!m) throw new CadenceParseError(cadence, `expected HH:MM, got "${time}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new CadenceParseError(cadence, `invalid time "${time}"`);
  return { hour, minute };
}

function assertTimeZone(cadence: string, tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new CadenceParseError(cadence, `unknown time zone "${tz}"`);
  }
}

/** Wall-clock parts of an instant in a time zone. */
function wallClock(date: Date, timeZone: string): {
  weekday: number; hour: number; minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: DAYS.indexOf(get("weekday").toLowerCase().slice(0, 3) as (typeof DAYS)[number]),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/**
 * The next instant, strictly after `from`, at which the cadence fires. Works by advancing
 * in minute-precision steps computed from the wall-clock delta, then correcting once for
 * DST shifts.
 */
export function nextPublishAt(cadence: string | ParsedCadence, from: Date): Date {
  const c = typeof cadence === "string" ? parseCadence(cadence) : cadence;

  const now = wallClock(from, c.timeZone);
  const nowMinutes = now.hour * 60 + now.minute;
  const targetMinutes = c.hour * 60 + c.minute;

  let deltaMinutes: number;
  if (c.kind === "daily") {
    deltaMinutes = targetMinutes - nowMinutes;
    if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  } else {
    const dayDelta = ((c.weekday! - now.weekday) % 7 + 7) % 7;
    deltaMinutes = dayDelta * 24 * 60 + (targetMinutes - nowMinutes);
    if (deltaMinutes <= 0) deltaMinutes += 7 * 24 * 60;
  }

  // Zero out seconds, then apply the wall-clock delta.
  let candidate = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + deltaMinutes * 60_000);

  // One DST correction pass: if the candidate's wall-clock time drifted, adjust by the diff.
  const check = wallClock(candidate, c.timeZone);
  const drift = targetMinutes - (check.hour * 60 + check.minute);
  if (drift !== 0 && Math.abs(drift) <= 120) {
    candidate = new Date(candidate.getTime() + drift * 60_000);
  }
  return candidate;
}
