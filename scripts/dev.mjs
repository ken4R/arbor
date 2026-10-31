// Lance Vite en mode dev puis Electron pointé sur le serveur Vite.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

await import('./build-main.mjs');
const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
const app = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, ARBOR_DEV_URL: url } });
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
