'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const { FlatCompat } = require('@eslint/eslintrc');
const { fixupConfigRules } = require('@eslint/compat');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

module.exports = [
  js.configs.recommended,
  ...fixupConfigRules(compat.extends('eslint-config-athom')),
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.node,
        Homey: 'readonly',
      },
    },
    settings: {
      node: {
        version: '>=18.0.0',
      },
    },
    rules: {
      'no-console': 'off',
      'prefer-destructuring': 'off',
      'no-underscore-dangle': 'off',
      'class-methods-use-this': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      strict: ['error', 'global'],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      indent: ['error', 2, { SwitchCase: 1 }],
      'comma-dangle': ['error', 'only-multiline'],
      'no-trailing-spaces': 'error',
      'eol-last': ['error', 'always'],
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      'node/no-unsupported-features/es-syntax': 'off',
      'import/no-extraneous-dependencies': 'off',
      'node/no-extraneous-require': 'off',
      'node/no-unpublished-require': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-expressions': 'off',
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/.homeybuild/**',
      'app.json',
      'package-lock.json',
      '.homeychangelog.json',
    ],
  },
];
