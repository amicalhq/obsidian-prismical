import { describe, expect, it } from 'vitest';
import { meetingDetail, meetingProperties, normalizeAttendees } from './meeting';
import type { NoteEvent } from './engine';

describe('normalizeAttendees', () => {
  it('returns an empty list for absent or empty values', () => {
    expect(normalizeAttendees(null)).toEqual([]);
    expect(normalizeAttendees(undefined)).toEqual([]);
    expect(normalizeAttendees([])).toEqual([]);
    expect(normalizeAttendees({})).toEqual([]);
    expect(normalizeAttendees('a string')).toEqual([]);
  });
  it('prefers displayName and falls back to email', () => {
    expect(normalizeAttendees([
      { email: 'room@resource.calendar.google.com', displayName: 'Room 101 [Zoom Room]' },
      { email: 'alice@example.com' },
      { self: true, email: 'bob@example.com' },
    ])).toEqual(['Room 101 [Zoom Room]', 'alice@example.com', 'bob@example.com']);
  });
  it('dedupes and skips entries with neither field', () => {
    expect(normalizeAttendees([
      { email: 'a@x.com', displayName: 'A' },
      { email: 'b@x.com' },
      { organizer: true },
      { email: 'a@x.com', displayName: 'A' },
    ])).toEqual(['A', 'b@x.com']);
  });
});

describe('meetingDetail', () => {
  it('extracts attendees from an event response', () => {
    expect(meetingDetail({ attendees: [{ email: 'a@x.com', displayName: 'Alice' }] }))
      .toEqual({ attendees: ['Alice'] });
  });
  it('normalizes a null or missing event payload', () => {
    expect(meetingDetail(null)).toEqual({ attendees: [] });
    expect(meetingDetail({})).toEqual({ attendees: [] });
  });
  it('handles a full event payload in the production shape', () => {
    const event = {
      id: 'cev_test00000000000000000000',
      title: 'All-Hands Demo',
      starts_at: '2026-01-05T09:30:00.000Z',
      location: 'Room 101 [Zoom Room]',
      meeting_url: 'https://zoom.us/j/123456789?pwd=abc&jst=2',
      organizer: { email: 'organizer@example.com' },
      attendees: [
        { email: 'room-101@resource.calendar.google.com', resource: true, displayName: 'Room 101 [Zoom Room]', responseStatus: 'needsAction' },
        { email: 'alice@example.com', responseStatus: 'accepted' },
        { self: true, email: 'bob@example.com', responseStatus: 'needsAction' },
        { email: 'organizer@example.com', organizer: true, responseStatus: 'accepted' },
        { email: 'design-team@example.com', displayName: 'Design Team', responseStatus: 'needsAction' },
        { email: 'growth@example.com', displayName: 'Growth', responseStatus: 'needsAction' },
      ],
    };
    expect(meetingDetail(event)).toEqual({
      attendees: ['Room 101 [Zoom Room]', 'alice@example.com', 'bob@example.com', 'organizer@example.com', 'Design Team', 'Growth'],
    });
  });
});

describe('meetingProperties', () => {
  const event: NoteEvent = {
    id: 'ev-1', title: 'Standup',
    starts_at: '2026-10-08T09:00:00Z', ends_at: '2026-10-08T09:30:00Z',
    meeting_url: 'https://meet/x',
  };
  it('includes date from the embedded event', () => {
    expect(meetingProperties(event, null)).toEqual({
      prismical_meeting_date: '2026-10-08T09:00:00Z',
    });
  });
  it('adds attendees when present', () => {
    expect(meetingProperties(event, { attendees: ['Alice', 'Bob'] })).toEqual({
      prismical_meeting_date: '2026-10-08T09:00:00Z',
      prismical_attendees: ['Alice', 'Bob'],
    });
  });
  it('omits nothing when the event is absent', () => {
    expect(meetingProperties(null, null)).toEqual({});
  });
  it('ignores an unparseable start time', () => {
    expect(meetingProperties({ ...event, starts_at: 'not-a-date' }, null)).toEqual({});
  });
});
