module.exports = [
  // Ignore node_modules
  { ignores: ['node_modules/**'] },

  // Apply rules to JS files in src/
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      // Keep common sensible defaults; adjust as needed
      'no-unused-vars': 'warn',
      'no-undef': 'error',
      'no-console': 'off',
    },
  },
];
