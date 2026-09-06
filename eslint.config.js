import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', prefer: 'type-imports' },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
    },
  },
  {
    files: ['src/**/*.module.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['src/**/domain/*.ts', 'src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)(application|infrastructure|presentation)/',
              message: 'Domain code may depend only on domain-level abstractions.',
            },
            {
              regex: '^(?:@nestjs|@mikro-orm|@aws-sdk)(?:/|$)|^(?:prom-client|zod)$',
              message: 'Domain code must remain independent from frameworks and adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/application/*.ts', 'src/**/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)(infrastructure|presentation)/',
              message: 'Application code must depend on ports instead of adapters.',
            },
            {
              regex: '^(?:@nestjs|@mikro-orm|@aws-sdk)(?:/|$)|^prom-client$',
              message: 'Application code must remain independent from frameworks and adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/shared/domain/money.ts',
      'src/accounting/domain/*.ts',
      'src/accounting/domain/**/*.ts',
      'src/wallet/domain/*.ts',
      'src/wallet/domain/**/*.ts',
      'src/wagering/domain/*.ts',
      'src/wagering/domain/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name=/^(Number|parseFloat|parseInt)$/]',
          message: 'Financial domain code must not use lossy numeric conversion.',
        },
        {
          selector:
            'CallExpression[callee.object.name="Number"][callee.property.name=/^(parseFloat|parseInt)$/]',
          message: 'Financial domain code must not use lossy numeric parsing.',
        },
        {
          selector:
            'CallExpression[callee.object.name="Math"][callee.property.name=/^(round|floor|ceil|trunc)$/]',
          message: 'Financial domain code must not round binary floating-point values.',
        },
      ],
    },
  },
  eslintConfigPrettier,
);
