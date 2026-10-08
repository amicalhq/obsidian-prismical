import { describe, expect, it } from 'vitest';
import { dateFolderSegments, importPath, renderDate, renderTemplate, type PathSettings } from './paths';

const ctx = {
  id: 'note-1',
  title: 'Weekly sync',
  org: 'org',
  api: 'https://api.prismical.ai',
  created_at: '2026-10-08T15:30:00Z',
  updated_at: '2026-10-09T08:05:00Z',
};
const settings: PathSettings = {
  folder: 'Prismical',
  dateFolderFormat: '',
  filenameTemplate: '{title} - {id}',
  frontmatterTemplate: '',
};

describe('renderDate', () => {
  it('renders year, quarter and month tokens', () => {
    expect(renderDate('YYYY', ctx.created_at)).toBe('2026');
    expect(renderDate('YYYY/Q', ctx.created_at)).toBe('2026/4');
    expect(renderDate('YYYY/MM', ctx.created_at)).toBe('2026/10');
    expect(renderDate('MMM YYYY', ctx.created_at)).toBe('Oct 2026');
    expect(renderDate('MMMM', ctx.created_at)).toBe('October');
  });
  it('uses local calendar components', () => {
    // 15:30Z is after local midnight anywhere on Earth except late UTC-11/UTC-12
    const value = renderDate('YYYY/MM/DD', '2026-01-05T06:00:00Z');
    expect(value).toMatch(/2026\/01\/0[45]/);
  });
  it('rejects unknown tokens and invalid dates', () => {
    expect(() => renderDate('QQQ', ctx.created_at)).toThrow('Unknown date token "QQQ"');
    expect(() => renderDate('YYYY', 'not a date')).toThrow('Cannot read date');
  });
});

describe('renderTemplate', () => {
  it('substitutes identity and date tokens', () => {
    expect(renderTemplate('{title} - {id}', ctx)).toBe('Weekly sync - note-1');
    expect(renderTemplate('{created_date}', ctx)).toBe('2026-10-08');
    expect(renderTemplate('{updated_date}', ctx)).toBe('2026-10-09');
    expect(renderTemplate('{created_date:YYYY/Q}', ctx)).toBe('2026/4');
    expect(renderTemplate('{created_time}', ctx)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it('rejects unknown tokens', () => {
    expect(() => renderTemplate('{nope}', ctx)).toThrow('Unknown template token {nope}');
  });
  it('sanitizes the title before substitution', () => {
    expect(renderTemplate('{title}', { ...ctx, title: 'a/b:c' })).toBe('a-b-c');
  });
});

describe('dateFolderSegments', () => {
  it('splits on / and validates each segment', () => {
    expect(dateFolderSegments('YYYY/Q', ctx.created_at)).toEqual(['2026', '4']);
    expect(dateFolderSegments('', ctx.created_at)).toEqual([]);
  });
  it('rejects Windows-illegal characters such as : in a segment', () => {
    expect(() => dateFolderSegments("YYYY:'Q'Q", ctx.created_at)).toThrow('Invalid character in path segment');
  });
});

describe('importPath', () => {
  it('keeps the legacy flat layout by default', () => {
    const result = importPath(settings, ctx);
    expect(result.folder).toBe('Prismical');
    expect(result.path).toBe('Prismical/Weekly sync - note-1.md');
    expect(result.frontmatter).toBe('');
  });
  it('nests date folders under the destination', () => {
    const result = importPath({ ...settings, dateFolderFormat: 'YYYY/Q' }, ctx);
    expect(result.path).toBe('Prismical/2026/4/Weekly sync - note-1.md');
  });
  it('separates the identity block from custom properties with a blank line', () => {
    const result = importPath(
      { ...settings, frontmatterTemplate: 'date: {created_date:YYYY-MM-DD}\nsource: prismical' },
      ctx
    );
    expect(result.frontmatter).toBe('\ndate: 2026-10-08\nsource: prismical\n');
    expect(importPath(settings, ctx).frontmatter).toBe('');
  });
  it('supports a date-led filename for recurring meetings', () => {
    const result = importPath(
      { ...settings, filenameTemplate: '{created_date:YYYY/MM/DD} - {title}' },
      ctx
    );
    expect(result.path).toBe('Prismical/2026-10-08 - Weekly sync.md');
  });
  it('never puts a Windows-illegal character in the filename, including from time tokens', () => {
    const result = importPath(
      { ...settings, filenameTemplate: '{title} {created_time} {created_datetime} {updated_time}' },
      ctx
    );
    // Times render as HH:mm:ss and datetimes as YYYY-MM-DDTHH:mm:ss; safeTitle must
    // convert every colon (and other illegal char) so the file name works on Windows too.
    expect(result.name).not.toMatch(/[:<>"|?*/\\]/);
    expect(result.name.startsWith('Weekly sync ')).toBe(true);
    expect(result.name).toMatch(/\d{2}-\d{2}-\d{2}/); // a time component survives, colons turned to dashes
  });
  it('rejects hidden, parent, or empty segments', () => {
    expect(() => importPath({ ...settings, folder: '..' }, ctx)).toThrow('parent path segment');
    expect(() => importPath({ ...settings, folder: 'a/.b' }, ctx)).toThrow('Hidden');
    expect(() => importPath({ ...settings, folder: 'a/' }, ctx)).toThrow('Empty path segment');
    expect(() => importPath({ ...settings, folder: '' }, ctx)).toThrow('destination');
  });
  it('rejects a template whose rendered date is empty', () => {
    expect(() =>
      importPath({ ...settings, dateFolderFormat: 'Q' }, { ...ctx, created_at: '2026-01-05T00:00:00Z' }).frontmatter
    ).toBeDefined();
    expect(() => importPath({ ...settings, dateFolderFormat: '' }, ctx)).not.toThrow();
  });
});
