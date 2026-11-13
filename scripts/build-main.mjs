import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node20', external: ['electron'], sourcemap: true };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', format: 'cjs' }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', format: 'cjs' }),
  // Assistant d'identifiants et askpass : Node pur, sans Electron, exécuté par Git avec ELECTRON_RUN_AS_NODE=1.
  build({ ...common, entryPoints: ['src/main/askpass-helper.ts'], outfile: 'dist/main/askpass-helper.js', format: 'cjs', sourcemap: false }),
]);
