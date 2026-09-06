import { describe, expect, test } from 'bun:test';

interface OpenApiScriptModule {
  checkOpenApiArtifact(path?: string): Promise<void>;
  writeOpenApiArtifact(path?: string): Promise<void>;
}

const MODULE_PATH = '../../../scripts/openapi.js';

async function loadScript(): Promise<OpenApiScriptModule | undefined> {
  try {
    return (await import(MODULE_PATH)) as OpenApiScriptModule;
  } catch {
    return undefined;
  }
}

describe('OpenAPI artifact commands', () => {
  test('writes and checks the exact deterministic document', async () => {
    const module = await loadScript();
    if (module === undefined) {
      throw new Error('OpenAPI script is unavailable');
    }

    const directory = `${process.cwd()}/artifacts/test-openapi`;
    const path = `${directory}/openapi.json`;
    await module.writeOpenApiArtifact(path);
    await module.checkOpenApiArtifact(path);

    const generated = await Bun.file(path).text();
    await Bun.write(path, generated.replaceAll('\n', '\r\n'));
    await module.checkOpenApiArtifact(path);

    await Bun.write(path, '{}\n');
    try {
      await module.checkOpenApiArtifact(path);
      throw new Error('Expected stale OpenAPI artifact rejection');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('OpenAPI artifact is stale');
    }
  });
});
