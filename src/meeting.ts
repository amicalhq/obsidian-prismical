import type { NoteEvent } from './engine';

/** Meeting details fetched per note for display in frontmatter. */
export interface MeetingDetail {
  attendees: string[];
}

/**
 * Builds the meeting-related frontmatter lines for an imported note.
 * The date comes from the shallow event embedded in the note detail (no
 * extra request). Attendees come from the optional per-note event request
 * and are only included when present.
 */
export function meetingProperties(event: NoteEvent | null | undefined, detail: MeetingDetail | null): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const startsAt = event?.starts_at;
  if (typeof startsAt === 'string' && Number.isFinite(Date.parse(startsAt)))
    properties['prismical_meeting_date'] = startsAt;
  if (detail?.attendees.length) properties['prismical_attendees'] = detail.attendees;
  return properties;
}

/**
 * Normalizes the `attendees` field returned by `GET /v1/events/{id}` into a
 * list of display strings. Each attendee is an object with an `email` and an
 * optional `displayName`; the display name is preferred, falling back to the
 * email. Unexpected shapes are skipped rather than throwing.
 */
export function normalizeAttendees(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.map(item => {
    if (typeof item === 'string') return item.trim() || null;
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const display = record.displayName;
      if (typeof display === 'string' && display.trim()) return display.trim();
      const email = record.email;
      if (typeof email === 'string' && email.trim()) return email.trim();
    }
    return null;
  }).filter((name): name is string => name !== null);
  return [...new Set(names)];
}

/** Extracts display details from a raw `/v1/events/{event_id}` response. */
export function meetingDetail(raw: unknown): MeetingDetail {
  const event = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { attendees: normalizeAttendees(event.attendees) };
}
