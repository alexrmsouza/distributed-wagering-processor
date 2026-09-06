import { describe, expect, test } from 'bun:test';

import { createTestEnvironment } from '../../support/test-environment.js';

for (const [key, value] of Object.entries(createTestEnvironment().variables)) {
  if (value !== undefined) {
    process.env[key] = value;
  }
}

type ModuleClass = abstract new (...arguments_: never[]) => unknown;
const COMPOSITION_ROOT_TEST_TIMEOUT_MS = 10_000;

function importedModuleNames(moduleClass: ModuleClass): readonly string[] {
  const imports = Reflect.getMetadata('imports', moduleClass) as unknown;
  if (!Array.isArray(imports)) {
    throw new TypeError(`${moduleClass.name} does not expose Nest module imports`);
  }
  return imports.flatMap((imported: unknown) =>
    typeof imported === 'function' ? [imported.name] : [],
  );
}

describe('application composition roots', () => {
  test(
    'keeps HTTP and background workers in separate roots',
    async () => {
      const [{ ApiAppModule }, { WorkerAppModule }] = await Promise.all([
        import('../../../src/api-app.module.js'),
        import('../../../src/worker-app.module.js'),
      ]);

      const apiImports = importedModuleNames(ApiAppModule);
      const workerImports = importedModuleNames(WorkerAppModule);

      expect(apiImports).toContain('WageringHttpModule');
      expect(apiImports).toContain('ApiDocumentationModule');
      expect(apiImports).toContain('SqsQueueMetricsModule');
      expect(apiImports).not.toContain('WageringWorkerModule');
      expect(apiImports).not.toContain('MessagingModule');
      expect(workerImports).toContain('WageringWorkerModule');
      expect(workerImports).toContain('MessagingModule');
      expect(workerImports).not.toContain('WageringHttpModule');
      expect(workerImports).not.toContain('HealthModule');
      expect(workerImports).not.toContain('ApiDocumentationModule');
      expect(workerImports).not.toContain('SqsQueueMetricsModule');
    },
    COMPOSITION_ROOT_TEST_TIMEOUT_MS,
  );

  test(
    'preserves the combined root for local and evaluator workflows',
    async () => {
      const { AppModule } = await import('../../../src/app.module.js');
      const imports = importedModuleNames(AppModule);

      expect(imports).toContain('WalletModule');
      expect(imports).toContain('WageringModule');
      expect(imports).toContain('MessagingModule');
      expect(imports).toContain('HealthModule');
      expect(imports).toContain('ApiDocumentationModule');
      expect(imports).toContain('SqsQueueMetricsModule');
    },
    COMPOSITION_ROOT_TEST_TIMEOUT_MS,
  );
});
