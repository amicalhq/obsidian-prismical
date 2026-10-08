/** Sanitize a remote title for use in a vault filename; throws nothing. */
export function safeTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f\\/:*?"<>|\[\]#^]/g, '-')
    .replace(/^[. ]+/g, '').slice(0, 80).replace(/[. ]+$/g, '') || 'Note';
}

/** Settings shape for vault layout; mirrored by the plugin Settings. */
export interface PathSettings {
  folder: string;
  dateFolderFormat: string;
  filenameTemplate: string;
  frontmatterTemplate: string;
}
export interface TemplateContext {
  id: string;
  title: string;
  org: string;
  api: string;
  created_at: string;
  updated_at: string;
}

const DATE_TOKENS = new Set(['YYYY', 'YY', 'MM', 'M', 'MMM', 'MMMM', 'Q', 'D', 'DD', 'ddd', 'dddd']);
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Render moment-style date tokens (YYYY YY MM M MMM MMMM Q D DD ddd dddd); throws on unknown tokens. */
export function renderDate(template: string, iso: string): string {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) throw new Error(`Cannot read date ${JSON.stringify(iso)}`);
  const date = new Date(value);
  for (const token of template.match(/[A-Za-z]+/g) ?? [])
    if (!DATE_TOKENS.has(token)) throw new Error(`Unknown date token "${token}"`);
  const parts: [RegExp, string][] = [
    [/\bYYYY\b/g, String(date.getFullYear())],
    [/\bYY\b/g, String(date.getFullYear()).slice(-2)],
    [/\bMM\b/g, String(date.getMonth() + 1).padStart(2, '0')],
    [/\bM\b/g, String(date.getMonth() + 1)],
    [/\bMMM\b/g, EN_MONTHS[date.getMonth()].slice(0, 3)],
    [/\bMMMM\b/g, EN_MONTHS[date.getMonth()]],
    [/\bQ\b/g, String(Math.floor(date.getMonth() / 3) + 1)],
    [/\bDD\b/g, String(date.getDate()).padStart(2, '0')],
    [/\bD\b/g, String(date.getDate())],
    [/\bddd\b/g, DAYS[date.getDay()].slice(0, 3)],
    [/\bdddd\b/g, DAYS[date.getDay()]],
  ];
  let result = template;
  for (const [pattern, replacement] of parts) result = result.replace(pattern, replacement);
  return result;
}

const iso = (iso: string): number => {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) throw new Error(`Cannot read date ${JSON.stringify(iso)}`);
  return value;
};
const pad = (value: number): string => String(value).padStart(2, '0');

/** {var[:format]} tokens; format applies to date/time/datetime tokens. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const dateField = (name: string): string => name === 'updated_date' ? ctx.updated_at : ctx.created_at;
  return template.replace(
    /\{(\w+)(?::([^}]*))?\}/g,
    (match, name: string, format?: string) => {
      switch (name) {
        case 'title':
          return safeTitle(ctx.title);
        case 'id':
          return ctx.id;
        case 'api':
          return ctx.api;
        case 'org':
          return ctx.org;
        case 'created_date':
        case 'updated_date': {
          const field = dateField(name);
          return format ? renderDate(format, field) : renderDate('YYYY-MM-DD', field);
        }
        case 'created_time':
        case 'updated_time': {
          const d = new Date(iso(dateField(name)));
          return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
        case 'created_datetime':
        case 'updated_datetime': {
          const field = dateField(name);
          const d = new Date(iso(field));
          return `${renderDate('YYYY-MM-DD', field)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
        default:
          throw new Error(`Unknown template token {${name}}`);
      }
    }
  );
}

export interface ImportPath {
  folder: string;
  name: string;
  path: string;
  frontmatter: string;
}

function cleanSegment(segment: string, index: number): string {
  if (!segment) throw new Error(`Empty path segment at ${segmentLabel(index)}`);
  if (segment === '..' || segment.startsWith('.'))
    throw new Error(`Hidden or parent path segment ${JSON.stringify(segment)}`);
  // Windows forbids these in any path component; reject so a bad template fails loudly.
  if (/[:<>"|?*/\\]/.test(segment))
    throw new Error(`Invalid character in path segment ${JSON.stringify(segment)}`);
  return segment;
}
function segmentLabel(index: number): string {
  return index === 0 ? 'destination' : `date folder part ${index}`;
}

/** Render and validate the date-folder path segments; throws on an empty or unsafe segment. */
export function dateFolderSegments(template: string, iso: string): string[] {
  if (!template) return [];
  return renderDate(template, iso).split('/').map((part, i) => cleanSegment(part, i + 1));
}

/** Compute the vault path and vault-side frontmatter for an imported note. Pure; throws on invalid layout. */
export function importPath(settings: PathSettings, ctx: TemplateContext): ImportPath {
  const destination = settings.folder.trim();
  if (!destination) throw new Error('Choose a destination folder');
  const baseParts = destination.split('/').map(cleanSegment);

  const dateParts = dateFolderSegments(settings.dateFolderFormat, ctx.created_at);
  const folderParts = [...baseParts, ...dateParts];
  const name = safeTitle(renderTemplate(settings.filenameTemplate, ctx));
  const custom = settings.frontmatterTemplate ? renderTemplate(settings.frontmatterTemplate, ctx).trim() : '';
  return {
    folder: folderParts.join('/'),
    name,
    path: `${folderParts.join('/')}/${name}.md`,
    // A blank line separates the identity block from the vault-only properties.
    frontmatter: custom ? `\n${custom}\n` : '',
  };
}
