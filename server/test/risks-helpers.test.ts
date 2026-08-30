import { describe, it, expect } from 'vitest';
import { addedDependencies, scanRisks } from '../src/modules/risks/helpers.js';
import { MAX_DEPENDENCY_RISKS } from '../src/modules/risks/constants.js';

/**
 * The property these pin is restraint. A risk chip is only useful if it means
 * something, so the tests that matter are the ones asserting a rule does NOT
 * fire: a reformatted manifest, a removed dependency, an unrelated path.
 */

const PKG_ADD = `@@ -10,6 +10,7 @@
   "dependencies": {
     "fastify": "^5.0.0",
+    "ioredis": "^5.4.1",
     "zod": "^3.23.8"
   },`;

describe('addedDependencies', () => {
  it('finds a dependency added inside a dependency block', () => {
    expect(addedDependencies(PKG_ADD)).toEqual(['ioredis']);
  });

  it('ignores an added key outside a dependency block', () => {
    const patch = `@@ -1,4 +1,5 @@
   "scripts": {
     "dev": "tsx watch src/index.ts",
+    "lint": "eslint .",
   },`;
    expect(addedDependencies(patch)).toEqual([]);
  });

  it('ignores a REMOVED dependency', () => {
    const patch = `@@ -10,7 +10,6 @@
   "dependencies": {
-    "ioredis": "^5.4.1",
     "zod": "^3.23.8"
   },`;
    expect(addedDependencies(patch)).toEqual([]);
  });

  it('does not carry the block across a hunk boundary', () => {
    const patch = `@@ -10,3 +10,3 @@
   "dependencies": {
     "zod": "^3.23.8"
@@ -40,2 +40,3 @@
+    "someScriptKey": "value"`;
    expect(addedDependencies(patch)).toEqual([]);
  });

  it('deduplicates a name added in two hunks', () => {
    expect(addedDependencies(`${PKG_ADD}\n${PKG_ADD}`)).toEqual(['ioredis']);
  });
});

describe('scanRisks', () => {
  it('flags the auth surface with the files that triggered it', () => {
    const risks = scanRisks([
      { path: 'src/auth/session.ts', patch: null },
      { path: 'src/ui/button.tsx', patch: null },
    ]);
    const auth = risks.find((r) => r.kind === 'auth_surface')!;

    expect(auth.title).toBe('Auth surface touched');
    expect(auth.severity).toBe('high');
    expect(auth.file_refs).toEqual(['src/auth/session.ts']);
  });

  it('emits one chip per added dependency, naming it', () => {
    const risks = scanRisks([{ path: 'package.json', patch: PKG_ADD }]);
    const dep = risks.find((r) => r.kind === 'new_dependency')!;
    expect(dep.title).toBe('New dependency: ioredis');
    expect(dep.file_refs).toEqual(['package.json']);
  });

  it('caps dependency chips', () => {
    const many = Array.from({ length: MAX_DEPENDENCY_RISKS + 5 }, (_, i) => `+    "p${i}": "^1.0.0",`);
    const patch = `@@ -1,1 +1,1 @@\n   "dependencies": {\n${many.join('\n')}\n   },`;
    const risks = scanRisks([{ path: 'package.json', patch }]);
    expect(risks.filter((r) => r.kind === 'new_dependency')).toHaveLength(MAX_DEPENDENCY_RISKS);
  });

  it('returns nothing for an ordinary PR', () => {
    expect(
      scanRisks([
        { path: 'src/ui/button.tsx', patch: '@@ -1 +1 @@\n+const x = 1;' },
        { path: 'README.md', patch: null },
      ]),
    ).toEqual([]);
  });

  it('flags migrations and CI config', () => {
    const kinds = scanRisks([
      { path: 'server/src/db/migrations/0014_x.sql', patch: null },
      { path: '.github/workflows/ci.yml', patch: null },
    ]).map((r) => r.kind);
    expect(kinds).toContain('db_migration');
    expect(kinds).toContain('ci_workflow');
  });
});
