import type { MemoryRow } from '../memory/repository.js';

/** Pure formatting for digest bodies — no I/O, so it is unit-testable on its own. */

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export function renderDigestMarkdown(periodStart: Date, periodEnd: Date, lines: string[]): string {
  const heading = `## Merged ${DATE.format(periodStart)} – ${DATE.format(periodEnd)}`;
  return [heading, '', ...lines, ''].join('\n');
}

/** Renders one remembered item as the trailing context line of a digest. */
export function renderMemoryLine(item: MemoryRow): string {
  return `- _context:_ ${item.content}`;
}
