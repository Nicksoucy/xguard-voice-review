// Config vitest — tests unitaires de la logique metier pure (Node, sans navigateur).
// Les modules de logique (lib/*-logic.js, lib/format-utils.js) utilisent un export
// double navigateur/CommonJS, donc ils sont require()-ables ici sans build.
export default {
  test: {
    include: ['tests/unit/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 10000,
  },
};
