import { describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

async function loadEvidenceModule() {
  const exists = await Bun.file('scripts/requirement-evidence.ts').exists();
  if (!exists) {
    expect(exists).toBeTrue();
  }
  return import('../../../scripts/requirement-evidence.js');
}

describe('requirement evidence manifest', () => {
  test('maps every functional requirement and success criterion to executable evidence', async () => {
    const { readAndValidateRequirementEvidence } = await loadEvidenceModule();

    const result = await readAndValidateRequirementEvidence('docs/requirement-evidence.json');

    expect(result.status).toBe('PASSED');
    expect(result.requirements).toBe(40);
    expect(result.functionalRequirements).toBe(32);
    expect(result.successCriteria).toBe(8);
  });

  test('contains only public evidence fields', async () => {
    const manifest = (await Bun.file('docs/requirement-evidence.json').json()) as {
      requirements: Record<string, unknown>[];
    };

    expect(
      manifest.requirements.every(
        (entry) =>
          JSON.stringify(Object.keys(entry).sort()) ===
          JSON.stringify(['commands', 'documentation', 'id', 'implementation', 'tests']),
      ),
    ).toBeTrue();
  });

  test('validates from a public checkout without planning files', async () => {
    const { validateRequirementEvidence } = await loadEvidenceModule();
    const manifest = (await Bun.file('docs/requirement-evidence.json').json()) as {
      requirements: {
        tests: string[];
        implementation: string[];
        documentation: string[];
      }[];
    };

    const checkout = await mkdtemp(resolve(tmpdir(), 'requirement-evidence-'));
    try {
      const references = new Set([
        'package.json',
        ...manifest.requirements.flatMap((entry) => [
          ...entry.tests,
          ...entry.implementation,
          ...entry.documentation.map((reference) => reference.split('#', 1)[0] ?? reference),
        ]),
      ]);
      for (const reference of references) {
        const destination = resolve(checkout, reference);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(resolve(process.cwd(), reference), destination);
      }

      expect(validateRequirementEvidence(manifest, checkout).status).toBe('PASSED');
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  test('rejects missing, duplicate, stale, prose-only, and nonexistent evidence', async () => {
    const { validateRequirementEvidence } = await loadEvidenceModule();
    const invalid = {
      schemaVersion: 1,
      feature: 'distributed-wagering-processor',
      requirements: [
        {
          id: 'FR-001',
          tests: [],
          implementation: ['src/does-not-exist.ts'],
          documentation: ['README.md#missing'],
          commands: ['bun run unknown-command'],
        },
        {
          id: 'FR-001',
          tests: ['test/does-not-exist.test.ts'],
          implementation: [],
          documentation: [],
          commands: [],
        },
      ],
    };

    expect(() => validateRequirementEvidence(invalid)).toThrow(
      /^Invalid requirement evidence manifest:/,
    );
  });

  test('rejects a documentation reference whose Markdown section does not exist', async () => {
    const { markdownSectionExists, validateRequirementEvidence } = await loadEvidenceModule();
    const manifest = (await Bun.file('docs/requirement-evidence.json').json()) as {
      requirements: { documentation: string[] }[];
    };
    const firstRequirement = manifest.requirements[0];
    expect(firstRequirement).toBeDefined();
    if (firstRequirement === undefined) {
      throw new Error('Manifest has no requirements');
    }
    expect(
      markdownSectionExists('ARCHITECTURE.md#transaction-and-persistence-boundary', process.cwd()),
    ).toBeTrue();
    firstRequirement.documentation = ['ARCHITECTURE.md#missing-section'];

    expect(() => validateRequirementEvidence(manifest)).toThrow(
      /^Invalid requirement evidence manifest:/,
    );
  });
});
