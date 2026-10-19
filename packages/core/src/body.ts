/*
 * Helpers for the markdown body of a task: finding `## sections`, checkboxes, and appending
 * to the `## Questions` and `## Agent log` sections that agents write back to.
 */

export const QUESTIONS_HEADING = 'Questions';
export const AGENT_LOG_HEADING = 'Agent log';
export const CRITERIA_HEADING = 'Acceptance criteria';
export const VERIFICATION_HEADING = 'Verification';

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;

interface Section {
  /** Index of the heading line. */
  start: number;
  /** Index after the last line of the section. */
  end: number;
}

/** Splits a body into lines and returns the `## heading` sections (level 2), ignoring headings in code blocks. */
function sections(lines: string[]): Map<string, Section> {
  const out = new Map<string, Section>();
  let fenced = false;
  let current: { name: string; start: number } | undefined;
  const close = (end: number) => {
    if (current && !out.has(current.name)) out.set(current.name, { start: current.start, end });
    current = undefined;
  };
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = HEADING.exec(line);
    if (!m || m[1].length > 2) return;
    close(i);
    if (m[1].length === 2) current = { name: m[2].trim().toLowerCase(), start: i };
  });
  close(lines.length);
  return out;
}

/** Text of the `## heading` section (case-insensitive), without the heading line; undefined when there is none. */
export function sectionText(body: string, heading: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const s = sections(lines).get(heading.toLowerCase());
  return s ? lines.slice(s.start + 1, s.end).join('\n') : undefined;
}

export interface Checkbox {
  checked: boolean;
  text: string;
}

/** Checkbox items (`- [ ] text`) in a piece of markdown. Items without text are skipped. */
export function checkboxes(markdown: string | undefined): Checkbox[] {
  if (!markdown) return [];
  const out: Checkbox[] = [];
  for (const line of stripComments(markdown).split(/\r?\n/)) {
    const m = CHECKBOX.exec(line);
    if (m && m[2].trim()) out.push({ checked: m[1] !== ' ', text: m[2].trim() });
  }
  return out;
}

/** Open (`- [ ]`) questions under `## Questions`. */
export function openQuestions(body: string): string[] {
  return checkboxes(sectionText(body, QUESTIONS_HEADING))
    .filter((c) => !c.checked)
    .map((c) => c.text);
}

export interface LogEntry {
  /** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`. */
  when: string;
  by: string;
  text: string;
}

const LOG_LINE = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)\s+(.+?)\s+[—–-]\s+(.*)$/;

/** Entries of the `## Agent log` section, oldest first. Continuation lines are joined to their entry. */
export function agentLog(body: string): LogEntry[] {
  const text = sectionText(body, AGENT_LOG_HEADING);
  if (!text) return [];
  const out: LogEntry[] = [];
  for (const line of text.split('\n')) {
    const m = LOG_LINE.exec(line);
    if (m) out.push({ when: m[1], by: m[2], text: m[3].trim() });
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1].text += ' ' + line.trim();
  }
  return out;
}

/**
 * Adds `newLines` at the end of the `## heading` section, creating it when missing. A new
 * `## Agent log` goes at the end of the body; any other new section goes before the agent log.
 * Line endings of the body are kept.
 */
export function appendToSection(body: string, heading: string, newLines: string[]): string {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const all = sections(lines);
  const s = all.get(heading.toLowerCase());
  if (s) {
    let at = s.end;
    while (at > s.start + 1 && lines[at - 1].trim() === '') at--;
    // Directly under the heading, keep one blank line between heading and list.
    const insert = at === s.start + 1 ? ['', ...newLines] : newLines;
    lines.splice(at, 0, ...insert);
    if (at + insert.length < lines.length && lines[at + insert.length].trim() !== '') lines.splice(at + insert.length, 0, '');
    return lines.join(eol);
  }

  const block = [`## ${heading}`, '', ...newLines];
  const log = all.get(AGENT_LOG_HEADING.toLowerCase());
  if (log && heading.toLowerCase() !== AGENT_LOG_HEADING.toLowerCase()) {
    lines.splice(log.start, 0, ...block, '');
    return lines.join(eol);
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return [...lines, ...(lines.length ? [''] : []), ...block, ''].join(eol);
}

/** A log entry line: `- 2026-10-20 02:14 claude — text`. Extra lines of `text` are indented under it. */
export function formatLogEntry(by: string, text: string, now = new Date()): string[] {
  const [first, ...rest] = text.trim().split(/\r?\n/);
  return [`- ${timestamp(now)} ${by} — ${first}`, ...rest.map((l) => `  ${l.trim()}`).filter((l) => l.trim())];
}

/** An open question: `- [ ] (claude, 2026-10-20) text`. */
export function formatQuestion(by: string, text: string, now = new Date()): string[] {
  const [first, ...rest] = text.trim().split(/\r?\n/);
  return [`- [ ] (${by}, ${timestamp(now).slice(0, 10)}) ${first}`, ...rest.map((l) => `      ${l.trim()}`).filter((l) => l.trim())];
}

export function timestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stripComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

export interface Readiness {
  /** True when an agent can implement the task as written. */
  ready: boolean;
  /** Acceptance criteria items with text. */
  criteria: number;
  /** The task says how to check the work (a `## Verification` section with content). */
  verification: boolean;
  /** Why it isn't ready, phrased as what to add. */
  missing?: string;
}

/**
 * A task is ready for an agent when its `## Acceptance criteria` section has at least one
 * checkbox item with text. A `## Verification` section (commands or tests that prove the work)
 * is recommended but not required.
 */
export function readiness(body: string): Readiness {
  const criteria = checkboxes(sectionText(body, CRITERIA_HEADING)).length;
  const verification = !!stripComments(sectionText(body, VERIFICATION_HEADING) ?? '').trim();
  return {
    ready: criteria > 0,
    criteria,
    verification,
    missing: criteria > 0 ? undefined : `an "## ${CRITERIA_HEADING}" section with at least one "- [ ] …" item`,
  };
}

export type TaskTemplate = 'default' | 'agent';
export const TASK_TEMPLATES: TaskTemplate[] = ['default', 'agent'];

/** Body of a new task. The `agent` template has every section an agent needs to work unattended. */
export function taskBody(title: string, template: TaskTemplate = 'default'): string {
  if (template === 'default') return `\n# ${title}\n\n## Description\n\n\n## ${CRITERIA_HEADING}\n\n- [ ] \n`;
  return `
# ${title}

## Goal

<!-- What should be true when this is done, in one or two sentences. Write it the way you would prompt the agent. -->

## Context

<!-- Where to look: files, functions, docs, related tasks, links. What has been tried or decided already. -->

## ${CRITERIA_HEADING}

<!-- One checkbox per observable outcome. An agent only implements a task that has at least one. -->
- [ ]

## ${VERIFICATION_HEADING}

<!-- Commands or tests that prove the work, e.g. \`npm test\`, or steps to try by hand. -->

## Constraints

<!-- What not to change, conventions to follow, limits on scope. -->

## ${QUESTIONS_HEADING}

<!-- Open questions, as "- [ ] …". Agents add theirs here when they block. -->
`;
}
