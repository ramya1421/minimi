/**
 * dates.ts — deterministic date-reference resolver
 *
 * Runs BEFORE every model call. Parses natural-language date phrases
 * ("last Monday", "3 November", "yesterday") into concrete UTC date
 * ranges using chrono-node. Never relies on the model to interpret dates.
 */

import * as chrono from "chrono-node";

export interface DateRange {
  start: Date;
  end: Date;
  label: string; // the original phrase, for display
}

/**
 * Parse a natural-language date phrase into a concrete date range.
 *
 * Returns null if no date reference is detected.
 *
 * @param text        The raw user message
 * @param userNow     The current moment in the user's timezone (a real Date)
 */
export function resolveDateReferences(
  text: string,
  userNow: Date
): DateRange[] {
  // chrono-node parses relative to `userNow`
  const results = chrono.parse(text, userNow, { forwardDate: false });

  return results.map((result) => {
    const start = result.start.date();

    // If a range end is explicitly mentioned (e.g. "from Monday to Wednesday")
    const end = result.end ? result.end.date() : endOfDay(start);

    return {
      start: startOfDay(start),
      end,
      label: result.text,
    };
  });
}

/**
 * Given a user message, return the single most-relevant date range if one
 * exists, otherwise null.  Used by the memory layer to retrieve prior context.
 */
export function primaryDateRange(
  text: string,
  userNow: Date
): DateRange | null {
  const ranges = resolveDateReferences(text, userNow);
  if (ranges.length === 0) return null;
  // Pick the range closest to the present (the last one chrono found is usually
  // the most specific), but prefer named days over bare months.
  return ranges[ranges.length - 1];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

/**
 * Format a Date as a readable absolute string for injecting into prompts.
 * e.g. "Monday 3 November 2025 at 14:32"
 */
export function formatAbsolute(d: Date): string {
  return d.toLocaleString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Returns true if the message likely refers to a past date/time, meaning we
 * should look up memory before calling the model.
 */
export function hasPastDateReference(text: string, userNow: Date): boolean {
  const ranges = resolveDateReferences(text, userNow);
  if (ranges.length === 0) return false;
  // At least one range ends before now
  return ranges.some((r) => r.end < userNow);
}
