import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const evidenceEntrySchema = z
  .object({
    id: z.string().regex(/^(?:FR-\d{3}|SC-\d{3})$/),
    tests: z.array(z.string().min(1)).min(1),
    implementation: z.array(z.string().min(1)).min(1),
    documentation: z.array(z.string().min(1)).min(1),
    commands: z.array(z.string().min(1)).min(1),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    feature: z.literal('distributed-wagering-processor'),
    requirements: z.array(evidenceEntrySchema),
  })
  .strict();

const EXPECTED_IDS = Object.freeze([
  ...Array.from({ length: 32 }, (_, index) => `FR-${String(index + 1).padStart(3, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `SC-${String(index + 1).padStart(3, '0')}`),
]);

export interface RequirementEvidenceValidation {
  readonly status: 'PASSED';
  readonly requirements: number;
  readonly functionalRequirements: number;
  readonly successCriteria: number;
}

function filePath(reference: string): string {
  return reference.split('#', 1)[0] ?? reference;
}

function markdownSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .replaceAll(/\s+/g, '-');
}

export function markdownSectionExists(reference: string, root: string): boolean {
  const separator = reference.indexOf('#');
  if (separator < 1 || separator === reference.length - 1) {
    return false;
  }
  const path = reference.slice(0, separator);
  const expectedAnchor = reference.slice(separator + 1);
  if (!path.toLowerCase().endsWith('.md')) {
    return false;
  }
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) {
    return false;
  }
  const headings = readFileSync(absolutePath, 'utf8')
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line);
      return match?.[1] === undefined ? [] : [markdownSlug(match[1])];
    });
  return headings.includes(expectedAnchor);
}

function packageScripts(root: string): ReadonlySet<string> {
  const packagePath = resolve(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  return new Set(Object.keys(packageJson.scripts ?? {}));
}

function commandIsKnown(command: string, scripts: ReadonlySet<string>, root: string): boolean {
  const scriptMatch = /^bun run ([A-Za-z0-9:_-]+)$/.exec(command);
  if (scriptMatch !== null) {
    return scripts.has(scriptMatch[1] ?? '');
  }
  const testMatch = /^bun test ([A-Za-z0-9_./\\-]+)$/.exec(command);
  if (testMatch !== null) {
    return existsSync(resolve(root, testMatch[1] ?? ''));
  }
  return false;
}

export function validateRequirementEvidence(
  input: unknown,
  root = process.cwd(),
): RequirementEvidenceValidation {
  try {
    const manifest = manifestSchema.parse(input);
    const ids = manifest.requirements.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('requirement identifiers must be unique');
    }
    if (ids.length !== EXPECTED_IDS.length || EXPECTED_IDS.some((id) => !ids.includes(id))) {
      throw new Error('every FR-001..FR-032 and SC-001..SC-008 entry is required');
    }
    const scripts = packageScripts(root);
    for (const entry of manifest.requirements) {
      const references = [...entry.tests, ...entry.implementation, ...entry.documentation];
      if (references.some((reference) => !existsSync(resolve(root, filePath(reference))))) {
        throw new Error('evidence contains a nonexistent file path');
      }
      if (entry.documentation.some((reference) => !markdownSectionExists(reference, root))) {
        throw new Error(`Evidence: ${entry.id} documentation section is missing`);
      }
      if (entry.commands.some((command) => !commandIsKnown(command, scripts, root))) {
        throw new Error('evidence contains an unknown command');
      }
    }
    return Object.freeze({
      status: 'PASSED',
      requirements: ids.length,
      functionalRequirements: ids.filter((id) => id.startsWith('FR-')).length,
      successCriteria: ids.filter((id) => id.startsWith('SC-')).length,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Evidence: ')) {
      throw new Error(`Invalid requirement evidence manifest: ${error.message.slice(10)}`, {
        cause: error,
      });
    }
    throw new Error('Invalid requirement evidence manifest: validation failed', { cause: error });
  }
}

export async function readAndValidateRequirementEvidence(
  path: string,
): Promise<RequirementEvidenceValidation> {
  let input: unknown;
  try {
    input = await Bun.file(path).json();
  } catch {
    throw new Error('Invalid requirement evidence manifest: unable to read JSON');
  }
  return validateRequirementEvidence(input);
}

async function runCli(): Promise<number> {
  try {
    const result = await readAndValidateRequirementEvidence(
      Bun.argv[2] ?? 'docs/requirement-evidence.json',
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : 'Requirement evidence validation failed',
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli();
}
