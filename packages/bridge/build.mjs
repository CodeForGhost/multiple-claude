// Bundles the daemon, CLI and MCP server into one self-contained file (dist/bridge.cjs)
// so the Tauri app can ship it as a single resource.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/bridge.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // ws optional native accelerators: fall back to JS when absent.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
