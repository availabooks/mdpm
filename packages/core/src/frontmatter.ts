import { isMap, parseDocument, stringify } from 'yaml';

export interface FrontMatterSplit {
  /** Raw YAML between the fences. */
  yaml: string;
  /** Everything after the closing fence. */
  body: string;
}

export interface ParsedFrontMatter {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line of each top-level key in the original file. */
  lines: Record<string, number>;
  error?: string;
  errorLine?: number;
}

const LINE = /([^\r\n]*)(\r\n|\n|$)/y;

/** Splits `---\n<yaml>\n---\n<body>`. Returns null when the text has no front matter. */
export function splitFrontMatter(text: string): FrontMatterSplit | null {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let yamlStart = -1;
  while (pos < text.length) {
    LINE.lastIndex = pos;
    const m = LINE.exec(text);
    if (!m || m[0].length === 0) break;
    const line = m[1].trimEnd();
    const next = pos + m[0].length;
    if (yamlStart < 0) {
      if (line !== '---') return null;
      yamlStart = next;
    } else if (line === '---' || line === '...') {
      return { yaml: text.slice(yamlStart, pos), body: text.slice(next) };
    }
    pos = next;
  }
  return null;
}

export function parseFrontMatter(text: string): ParsedFrontMatter | null {
  const split = splitFrontMatter(text);
  if (!split) return null;
  // Line 1 is the opening fence, so YAML starts on line 2.
  const parsed = parseYamlMapping(split.yaml, 2);
  return { ...parsed, body: split.body };
}

/** Parses YAML that must be a `key: value` mapping, reporting errors instead of throwing. */
export function parseYamlMapping(
  yaml: string,
  firstLine: number,
): { data: Record<string, unknown>; lines: Record<string, number>; error?: string; errorLine?: number } {
  const lines = keyLines(yaml, firstLine);
  const doc = parseDocument(yaml);
  if (doc.errors.length) {
    const pos = doc.errors[0].linePos?.[0];
    return { data: {}, lines, error: doc.errors[0].message.split('\n')[0], errorLine: pos ? pos.line + firstLine - 1 : undefined };
  }
  const js = doc.toJS();
  if (js == null) return { data: {}, lines };
  if (typeof js !== 'object' || Array.isArray(js)) {
    return { data: {}, lines, error: 'expected "key: value" lines (a YAML mapping), but found a list or a single value', errorLine: firstLine };
  }
  return { data: js as Record<string, unknown>, lines };
}

/** Maps each top-level key to the 1-based line it is on. */
export function keyLines(yaml: string, firstLine: number): Record<string, number> {
  const out: Record<string, number> = {};
  yaml.split(/\r?\n/).forEach((line, i) => {
    const m = /^([^\s#:'"\-][^:]*?)\s*:(\s|$)/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = firstLine + i;
  });
  return out;
}

/**
 * Applies `changes` to the front matter of `text`, keeping comments, key order,
 * line endings and the body intact. `undefined`, `null` and `''` delete the key.
 */
export function updateFrontMatter(text: string, changes: Record<string, unknown>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const split = splitFrontMatter(text);
  const doc = parseDocument(split?.yaml ?? '');
  if (doc.errors.length) throw new Error(`its front matter is not valid YAML (${doc.errors[0].message}). Fix the block between the --- lines at the top of the file, then try again.`);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === null || value === '') doc.delete(key);
    else doc.set(key, value);
  }
  const empty = doc.contents == null || (isMap(doc.contents) && doc.contents.items.length === 0);
  let yaml = empty ? '' : doc.toString({ lineWidth: 0 });
  if (eol !== '\n') yaml = yaml.replace(/\r?\n/g, eol);
  const body = split ? split.body : text.replace(/^\uFEFF/, '');
  return `---${eol}${yaml}---${eol}${body}`;
}

/** Builds a new file from front matter fields (empty values are dropped) and a body. */
export function serializeFrontMatter(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)),
  );
  return `---\n${stringify(clean, { lineWidth: 0 })}---\n${body}`;
}
