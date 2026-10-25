import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['main.js', 'bin/**', 'node_modules/**'] },
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: { parser: tsParser, ecmaVersion: 2021, sourceType: 'module' },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // The base rule cannot see TypeScript constructor parameter properties or the
      // parameter names in a type signature, and reports both as unused.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-console': 'warn'
    }
  },
  {
    // Build scripts run in a terminal; printing is how they report.
    files: ['scripts/**/*.mjs', '*.mjs'],
    rules: { 'no-console': 'off' }
  }
];
