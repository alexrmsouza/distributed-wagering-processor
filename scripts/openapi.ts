import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { serializeOpenApiDocument } from '../src/api-documentation/openapi.document.js';

const DEFAULT_ARTIFACT_PATH = resolve('docs/openapi.json');

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

export async function writeOpenApiArtifact(path = DEFAULT_ARTIFACT_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeOpenApiDocument(), 'utf8');
}

export async function checkOpenApiArtifact(path = DEFAULT_ARTIFACT_PATH): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(path, 'utf8');
  } catch {
    throw new Error('OpenAPI artifact is missing; run bun run openapi:generate');
  }

  if (normalizeLineEndings(actual) !== normalizeLineEndings(serializeOpenApiDocument())) {
    throw new Error('OpenAPI artifact is stale; run bun run openapi:generate');
  }
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? 'check';
  if (command === 'generate') {
    await writeOpenApiArtifact();
    return;
  }
  if (command === 'check') {
    await checkOpenApiArtifact();
    return;
  }
  throw new Error(`Unknown OpenAPI command: ${command}`);
}

if (import.meta.main) {
  await runCli();
}
