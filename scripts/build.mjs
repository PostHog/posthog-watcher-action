import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist/index.js',
});

// Standalone pi extension loaded by the pi subprocess via `-e`; pi's jiti
// loader expects an ESM default-exported factory function.
await esbuild.build({
  entryPoints: ['src/posthog-provider-extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'dist/posthog-provider.js',
});
