import { describe, it, expect } from 'vitest';
import {
  isBodyChange,
  parseSkillMarkdown,
  filenameStem,
} from '../src/modules/skills/helpers.js';

describe('parseSkillMarkdown — name derivation', () => {
  it('prefers YAML frontmatter `name`', () => {
    const text = [
      '---',
      'name: pr-quality-rubric',
      'description: Rubric for evaluating PR quality.',
      'type: rubric',
      '---',
      '',
      '# Something Else Entirely',
      '',
      'Body text.',
    ].join('\n');

    const parsed = parseSkillMarkdown(text, 'whatever.md');
    expect(parsed.name).toBe('pr-quality-rubric');
    expect(parsed.description).toBe('Rubric for evaluating PR quality.');
    expect(parsed.type).toBe('rubric');
    // Frontmatter is metadata, not part of the prompt block.
    expect(parsed.body.startsWith('# Something Else Entirely')).toBe(true);
  });

  it('falls back to the first markdown heading', () => {
    const parsed = parseSkillMarkdown('# Test Coverage Nudge\n\nAsk for the missing branch.\n', 'x.md');
    expect(parsed.name).toBe('Test Coverage Nudge');
    expect(parsed.description).toBe('Ask for the missing branch.');
  });

  it('falls back to the filename stem when there is no heading', () => {
    const parsed = parseSkillMarkdown('Just prose, no heading.', 'skills/no-then-chains.md');
    expect(parsed.name).toBe('no-then-chains');
    expect(parsed.description).toBe('Just prose, no heading.');
  });

  it('defaults the type to custom when frontmatter omits or mistypes it', () => {
    expect(parseSkillMarkdown('# A\n\nb', 'a.md').type).toBe('custom');
    expect(parseSkillMarkdown('---\ntype: nonsense\n---\n# A\n\nb', 'a.md').type).toBe('custom');
  });

  it('joins a multi-line first paragraph and stops at the blank line', () => {
    const text = '# Title\n\nFirst line\nsecond line.\n\nSecond paragraph is ignored.\n';
    expect(parseSkillMarkdown(text, 'a.md').description).toBe('First line second line.');
  });

  it('does not treat a fenced code block as the description', () => {
    const text = '# Title\n\n```ts\nconst a = 1;\n```\n\nReal description here.\n';
    expect(parseSkillMarkdown(text, 'a.md').description).toBe('Real description here.');
  });

  it('yields an empty description when the document is heading-only', () => {
    expect(parseSkillMarkdown('# Only A Heading\n', 'a.md').description).toBe('');
  });

  it('handles CRLF frontmatter', () => {
    const parsed = parseSkillMarkdown('---\r\nname: crlf-skill\r\n---\r\n# H\r\n\r\nBody.\r\n', 'a.md');
    expect(parsed.name).toBe('crlf-skill');
  });

  it('strips surrounding quotes from frontmatter values', () => {
    const parsed = parseSkillMarkdown('---\nname: "quoted name"\n---\nBody.', 'a.md');
    expect(parsed.name).toBe('quoted name');
  });
});

describe('filenameStem', () => {
  it.each([
    ['SKILL.md', 'SKILL'],
    ['a/b/c.md', 'c'],
    ['no-extension', 'no-extension'],
    ['archive.tar.gz', 'archive.tar'],
  ])('%s → %s', (input, expected) => {
    expect(filenameStem(input)).toBe(expected);
  });
});

describe('isBodyChange', () => {
  it('is true only when the body actually differs', () => {
    expect(isBodyChange({ body: 'a' }, { body: 'b' })).toBe(true);
    expect(isBodyChange({ body: 'a' }, { body: 'a' })).toBe(false);
    expect(isBodyChange({ body: 'a' }, {})).toBe(false);
  });
});
