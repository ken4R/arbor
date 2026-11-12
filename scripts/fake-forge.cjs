#!/usr/bin/env node
// Faux hébergeur pour les tests (Node pur, aucune dépendance) : fausse API GitHub et GitLab, et dépôts Git servis
// en HTTP par `git http-backend` (CGI) avec authentification Basic.
//
// Usage :
//   node scripts/fake-forge.cjs [--port 0] [--token <jeton>] [--scopes api,read_user] [--fine-grained]
//                               [--login arbor-test] [--name "Arbor Test"]
//                               [--repos <dossier>] [--git-user <u> --git-password <p>] [--log]
// Affiche sur stdout une ligne JSON `{ "url": "http://127.0.0.1:<port>", "port": <port> }` une fois prêt.
//
// Routes :
//   GET /github/user                         API GitHub (ARBOR_GITHUB_API_URL=<url>/github) ; en-tête
//                                            X-OAuth-Scopes (absent avec --fine-grained)
//   GET /api/v4/user                         API GitLab (instance = <url>)
//   GET /api/v4/personal_access_tokens/self  scopes du jeton GitLab
//   /<chemin>.git/…                          dépôts Git de --repos (clone, fetch, push) ; Basic exigé :
//                                            --git-user/--git-password, ou n'importe quel identifiant avec le jeton
// Les API répondent 401 si le jeton (Authorization: Bearer|token, ou PRIVATE-TOKEN) diffère de --token.
// `--log` journalise méthode, chemin et statut sur stderr, jamais l'en-tête Authorization ni la requête.
'use strict';
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');

function parseArgs(argv) {
  const opts = { port: 0, token: 'arbor-test-token', scopes: null, fineGrained: false, login: 'arbor-test', name: 'Arbor Test', repos: null, gitUser: null, gitPassword: null, log: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Valeur manquante pour ${a}`);
      return v;
    };
    if (a === '--port') opts.port = Number(val());
    else if (a === '--token') opts.token = val();
    else if (a === '--scopes') opts.scopes = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--fine-grained') opts.fineGrained = true;
    else if (a === '--login') opts.login = val();
    else if (a === '--name') opts.name = val();
    else if (a === '--repos') opts.repos = path.resolve(val());
    else if (a === '--git-user') opts.gitUser = val();
    else if (a === '--git-password') opts.gitPassword = val();
    else if (a === '--log') opts.log = true;
    else throw new Error(`Option inconnue : ${a}`);
  }
  return opts;
}

/** Comparaison à temps constant. */
function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function apiToken(req) {
  const auth = req.headers.authorization || '';
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const priv = req.headers['private-token'];
  return typeof priv === 'string' ? priv.trim() : null;
}

/** Identifiant authentifié (Basic) pour les dépôts Git, ou null. */
function gitUser(req, opts) {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const user = decoded.slice(0, i);
  const password = decoded.slice(i + 1);
  if (!user) return null;
  if (opts.gitUser !== null && opts.gitPassword !== null && same(user, opts.gitUser) && same(password, opts.gitPassword)) return user;
  if (same(password, opts.token)) return user;
  return null;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function handleApi(req, res, url, opts) {
  const token = apiToken(req);
  if (token === null || !same(token, opts.token)) return json(res, 401, { message: '401 Unauthorized' });
  if (req.method !== 'GET') return json(res, 405, { message: 'Method Not Allowed' });
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/github/user') {
    const scopes = opts.scopes ?? ['repo', 'read:org'];
    const headers = { 'X-GitHub-Media-Type': 'github.v3', 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': '4999' };
    if (!opts.fineGrained) headers['X-OAuth-Scopes'] = scopes.join(', ');
    return json(res, 200, { login: opts.login, id: 1, name: opts.name, avatar_url: null, html_url: `${baseUrl}/${opts.login}`, type: 'User' }, headers);
  }
  if (p === '/api/v4/user') {
    return json(res, 200, { id: 1, username: opts.login, name: opts.name, avatar_url: null, web_url: `${baseUrl}/${opts.login}`, state: 'active' });
  }
  if (p === '/api/v4/personal_access_tokens/self') {
    return json(res, 200, { id: 1, name: 'Arbor', revoked: false, active: true, scopes: opts.scopes ?? ['api'], expires_at: null });
  }
  return json(res, 404, { message: '404 Not Found' });
}

/** Relaie la requête à `git http-backend` (CGI) et recopie sa réponse (en-têtes CGI analysés). */
function handleGit(req, res, url, opts, done) {
  const user = gitUser(req, opts);
  if (!user) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake-forge"', 'Content-Type': 'text/plain' });
    res.end('Authentification requise\n');
    return done(401);
  }
  let pathInfo;
  try {
    pathInfo = decodeURIComponent(url.pathname);
  } catch {
    pathInfo = null;
  }
  if (!pathInfo || pathInfo.split('/').includes('..')) {
    res.writeHead(400);
    res.end();
    return done(400);
  }
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    // Configuration du poste ignorée (comportement reproductible).
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_PROJECT_ROOT: opts.repos,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: url.search.replace(/^\?/, ''),
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers['content-type'] || '',
    REMOTE_USER: user, // permet receive-pack (push)
    REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
  };
  if (req.headers['content-length'] !== undefined) env.CONTENT_LENGTH = String(req.headers['content-length']);
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
  if (req.headers['git-protocol']) env.GIT_PROTOCOL = String(req.headers['git-protocol']);
  const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  req.pipe(child.stdin);
  child.stdin.on('error', () => {});
  let head = Buffer.alloc(0);
  let headersSent = false;
  let status = 200;
  child.stdout.on('data', (chunk) => {
    if (headersSent) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    let end = head.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (end < 0) {
      end = head.indexOf('\n\n');
      sepLen = 2;
    }
    if (end < 0) return;
    const headers = {};
    for (const line of head.slice(0, end).toString('latin1').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 500;
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    headersSent = true;
    const rest = head.slice(end + sepLen);
    if (rest.length) res.write(rest);
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  // `error` (git introuvable) et `close` peuvent arriver tous les deux : une seule réponse, un seul journal.
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    if (!headersSent) {
      status = 500;
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end();
    if (opts.log && code !== 0 && stderr.trim()) process.stderr.write(`http-backend : ${stderr.trim().split('\n').pop()}\n`);
    done(status);
  };
  child.on('error', () => finish(-1));
  child.on('close', (code) => finish(code));
}

let baseUrl = '';

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const done = (status) => {
      // Jamais d'en-tête (Authorization) ni de requête (?…) dans le journal.
      if (opts.log) process.stderr.write(`${req.method} ${url.pathname} ${status}\n`);
    };
    if (url.pathname.startsWith('/github/') || url.pathname.startsWith('/api/v4/')) {
      handleApi(req, res, url, opts);
      return done(res.statusCode);
    }
    if (opts.repos) return handleGit(req, res, url, opts, done);
    json(res, 404, { message: '404 Not Found' });
    done(404);
  });
  server.listen(opts.port, '127.0.0.1', () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    process.stdout.write(JSON.stringify({ url: baseUrl, port }) + '\n');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
