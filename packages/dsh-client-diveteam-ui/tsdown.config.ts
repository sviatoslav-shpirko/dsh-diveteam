import type { UserConfig } from 'tsdown'

const ID = '@diveteam/dsh-client-diveteam-ui'

/** Bare specifiers the client bundle resolves from the shell module table at runtime. */
const CLIENT_EXTERNALS = new Set(['react', 'react-dom', 'react/jsx-runtime'])

export default [
  // Host half: minimal Node ESM (no-op until a section needs host-side state).
  {
    name: ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    outputOptions: {
      entryFileNames: 'index.js',
    },
    deps: {
      neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/') || specifier.startsWith('node:'),
      alwaysBundle: (specifier: string) => !specifier.startsWith('@deepseek-ai/') && !specifier.startsWith('node:'),
    },
  },
  // Browser half: CJS wrapped in the dsh client module-loader handoff. The
  // `factory` body is what the web shell registers under the plugin id; react
  // and its JSX runtime resolve from the shell's module table (external).
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier) || specifier.startsWith('@deepseek-ai/'),
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier) && !specifier.startsWith('@deepseek-ai/'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'try { window.__ModuleLoader__?.load?.({ id: "@farvater/dsh-client-farvater-ui", factory: () => module.exports }); } catch {} return module.exports; } });',
      // rolldown's CJS interop adds the Symbol.toStringTag line itself.
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
