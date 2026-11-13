// Assistant d'identifiants et askpass d'Arbor, exécuté par Git ou OpenSSH (jamais par Arbor lui-même) :
//   askpass.sh credential get|store|erase   (credential.helper : champs `clé=valeur` sur stdin)
//   askpass.sh "<invite>"                    (GIT_ASKPASS, SSH_ASKPASS : réponse sur stdout ; SSH_ASKPASS_PROMPT
//                                            transmis : `confirm` oui/non, `none` notification)
// Node pur (`net`, `process`), sans Electron : lancé par `process.execPath` avec ELECTRON_RUN_AS_NODE=1.
// Il relaie la demande au processus principal par la socket locale `ARBOR_ASKPASS_SOCKET` (jeton
// `ARBOR_ASKPASS_TOKEN`, session `ARBOR_ASKPASS_SESSION`) et recopie la réponse sur stdout.
// Il n'écrit jamais de valeur sur stderr : seulement une ligne fixe en cas d'échec.
import { connect } from 'node:net';

const MAX_INPUT = 64 * 1024;
const MAX_REPLY = 64 * 1024;
const CANCELLED = 'arbor: authentification annulée\n';
const UNREACHABLE = 'arbor: Arbor injoignable\n';

function fail(line: string): never {
  process.stderr.write(line);
  process.exit(1);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_INPUT) chunks.push(c);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function request(payload: object): Promise<{ ok: boolean; out?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(process.env.ARBOR_ASKPASS_SOCKET ?? '');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (d: string) => {
      data += d;
      if (data.length > MAX_REPLY) socket.destroy(new Error('réponse trop longue'));
    });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        resolve(JSON.parse(data.split('\n')[0]));
      } catch {
        reject(new Error('réponse illisible'));
      }
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const credential = argv[0] === 'credential' && argv.length === 2;
  const action = credential ? argv[1] : null;
  if (credential && action !== 'get' && action !== 'store' && action !== 'erase') return; // action inconnue : ignorée (protocole Git)
  if (!process.env.ARBOR_ASKPASS_SOCKET || !process.env.ARBOR_ASKPASS_TOKEN || !process.env.ARBOR_ASKPASS_SESSION) fail(UNREACHABLE);
  const base = { token: process.env.ARBOR_ASKPASS_TOKEN, session: process.env.ARBOR_ASKPASS_SESSION };
  const payload = credential ? { ...base, mode: 'credential', action, input: await readStdin() } : { ...base, mode: 'askpass', prompt: argv.join(' '), promptMode: process.env.SSH_ASKPASS_PROMPT ?? null };
  let reply: { ok: boolean; out?: string; error?: string };
  try {
    reply = await request(payload);
  } catch {
    fail(UNREACHABLE);
  }
  if (!reply.ok) fail(reply.error === 'cancelled' ? CANCELLED : UNREACHABLE);
  const out = typeof reply.out === 'string' ? reply.out : '';
  if (credential) process.stdout.write(out);
  else process.stdout.write(out + '\n');
}

main().catch(() => fail(UNREACHABLE));
