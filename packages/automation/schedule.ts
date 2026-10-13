/**
 * W30-A: the deterministic schedule evaluator for workflow triggers.
 *
 * Every instant is computed in the trigger's DECLARED timezone, never the host
 * zone: a workspace that configured "every day at 09:00" must keep meaning 09:00
 * across a worker restart, a deploy or a region change. The rules for a local
 * time that a daylight-saving transition skips or repeats are fixed here (resolve
 * forward to the first existing instant, or to the earlier of the two) so two
 * workers can never disagree about when a schedule fired.
 */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

/** True when the string is a timezone `Intl` recognises, so a bogus zone is rejected at definition time. */
export function isValidTimezone(timezone: string): boolean {
  if (
    typeof timezone !== "string" ||
    timezone.length < 1 ||
    timezone.length > 64
  )
    return false;
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** The same wall clock read as a UTC instant, which makes offset arithmetic trivial. */
  asUTC: number;
};

function localParts(timezone: string, instant: Date): LocalParts {
  const parts = formatterFor(timezone).formatToParts(instant);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || "0");
  const year = read("year");
  const month = read("month");
  const day = read("day");
  const hour = read("hour");
  const minute = read("minute");
  const second = read("second");
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    asUTC: Date.UTC(year, month - 1, day, hour, minute, second),
  };
}

/**
 * Resolves a wall-clock time in a timezone to a UTC instant.
 *
 * The window scan is deliberate: it makes the skipped/repeated local time rules
 * explicit instead of depending on the host's Intl offset internals. An existing
 * local time resolves to the earliest instant that reads that way (the spring
 * forward duplicate and the fall back duplicate both resolve to the first
 * occurrence), and a local time that a spring-forward transition skips resolves
 * to the first instant that exists at or after it.
 */
function utcForLocal(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = localParts(timezone, new Date(naive)).asUTC - naive;
  const center = naive - offset;
  for (let delta = -240; delta <= 240; delta++) {
    const instant = center + delta * 60000;
    const parts = localParts(timezone, new Date(instant));
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute
    )
      return new Date(instant);
  }
  for (let delta = -240; delta <= 240; delta++) {
    const instant = center + delta * 60000;
    if (localParts(timezone, new Date(instant)).asUTC >= naive)
      return new Date(instant);
  }
  return new Date(center);
}

/** Parses an ISO 8601 instant, reading a timezone-less string as wall clock in the trigger timezone. */
export function parseInstant(value: unknown, timezone: string): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match || !isValidTimezone(timezone)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  )
    return null;
  return utcForLocal(timezone, year, month, day, hour, minute);
}

export type ParsedCron = {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
};

function parseCronField(
  field: string,
  min: number,
  max: number,
): number[] | null {
  if (!field) return null;
  const values = new Set<number>();
  for (const token of field.split(",")) {
    if (!token) return null;
    const segments = token.split("/");
    if (segments.length > 2) return null;
    let step = 1;
    if (segments.length === 2) {
      if (!/^\d+$/.test(segments[1])) return null;
      step = Number(segments[1]);
      if (step < 1) return null;
    }
    const range = segments[0];
    let low: number;
    let high: number;
    if (range === "*") {
      low = min;
      high = max;
    } else {
      const match = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!match) return null;
      low = Number(match[1]);
      high =
        match[2] !== undefined
          ? Number(match[2])
          : segments.length === 2
            ? max
            : low;
    }
    if (low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a 5-field cron expression (`m h dom mon dow`); unknown syntax yields null rather than a guess. */
export function parseCron(expression: string): ParsedCron | null {
  if (typeof expression !== "string") return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const dowRaw = parseCronField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = [
    ...new Set(dowRaw.map((value) => (value === 7 ? 0 : value))),
  ].sort((a, b) => a - b);
  return { minute, hour, dom, month, dow };
}

function dayMatches(
  parsed: ParsedCron,
  year: number,
  month: number,
  day: number,
): boolean {
  if (!parsed.month.includes(month)) return false;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domRestricted = parsed.dom.length < 31;
  const dowRestricted = parsed.dow.length < 7;
  if (domRestricted && dowRestricted)
    return parsed.dom.includes(day) || parsed.dow.includes(dow);
  if (domRestricted) return parsed.dom.includes(day);
  if (dowRestricted) return parsed.dow.includes(dow);
  return true;
}

const CRON_SEARCH_DAYS = 366 * 5;

function nextCronAfter(
  parsed: ParsedCron,
  timezone: string,
  after: Date,
): Date | null {
  const start = localParts(timezone, after);
  const base = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset <= CRON_SEARCH_DAYS; offset++) {
    const cursor = new Date(base + offset * 86400000);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    if (!dayMatches(parsed, year, month, day)) continue;
    for (const hour of parsed.hour)
      for (const minute of parsed.minute) {
        const candidate = utcForLocal(timezone, year, month, day, hour, minute);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
  }
  return null;
}

function intervalAfter(
  everySeconds: number,
  baseMs: number,
  anchorMs: number,
): Date {
  const step = everySeconds * 1000;
  if (anchorMs <= baseMs) return new Date(baseMs + step);
  const index = Math.floor((anchorMs - baseMs) / step) + 1;
  return new Date(baseMs + index * step);
}

export type ScheduleSpec = {
  kind: "one_time" | "interval" | "cron";
  at?: string;
  every_seconds?: number;
  expression?: string;
  timezone: string;
  missed_policy: "skip" | "catch_up_once";
  /** The cursor to advance past. */
  after: Date;
  /**
   * The last instant this trigger actually fired (the persisted `last_at`), when
   * there is one. `catch_up_once` uses it to recover the oldest missed instant;
   * without it there is no authoritative record of what was missed.
   */
  from?: Date | null;
};

/**
 * The next instant a schedule should fire, or null when it never fires again.
 *
 * `skip` advances past every missed occurrence to the first instant strictly after
 * `after`. `catch_up_once` returns the single oldest missed occurrence when one
 * exists and the next future occurrence otherwise, and never more than one per
 * call so a backlog drains at a bounded rate instead of all at once.
 */
export function nextOccurrence(spec: ScheduleSpec): Date | null {
  const { kind, timezone, missed_policy, after } = spec;
  if (!after || Number.isNaN(after.getTime())) return null;
  if (!isValidTimezone(timezone)) return null;

  if (kind === "one_time") {
    const at = spec.at ? parseInstant(spec.at, timezone) : null;
    if (!at) return null;
    if (missed_policy === "catch_up_once") {
      if (spec.from && at.getTime() <= spec.from.getTime()) return null;
      return at;
    }
    return at.getTime() > after.getTime() ? at : null;
  }

  // `catch_up_once` recovers from the last fired instant when there is one, so a
  // backlog is never silently skipped. `skip` advances past `after` but never
  // returns an instant at or before the last fired one, so clock skew cannot
  // make it re-fire the same occurrence.
  let anchor = after;
  if (missed_policy === "catch_up_once" && spec.from) anchor = spec.from;
  else if (spec.from && spec.from.getTime() > anchor.getTime())
    anchor = spec.from;

  if (kind === "interval") {
    const every = Number(spec.every_seconds || 0);
    if (!Number.isFinite(every) || every <= 0) return null;
    const base =
      spec.from ?? (spec.at ? parseInstant(spec.at, timezone) : null);
    if (!base) return null;
    return intervalAfter(every, base.getTime(), anchor.getTime());
  }

  if (kind === "cron") {
    const parsed = spec.expression ? parseCron(spec.expression) : null;
    if (!parsed) return null;
    return nextCronAfter(parsed, timezone, anchor);
  }

  return null;
}
