import { describe, expect, it } from 'vitest';
import { parseBlame, parseFileLog } from './git';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const Z = '0'.repeat(40);

/** Reproduit la sortie de `git log --follow -z --name-status --format=%x1e…`. */
const rec = (sha: string, parents: string, subject: string, ...status: string[]) =>
  `\x1e${[sha, parents, 'Léa Dubois', 'lea@example.com', '1700000000', subject].join('\x1f')}\0` + (status.length ? `\n${status.join('\0')}\0` : '');

describe('parseFileLog', () => {
  it('suit un renommage R100 : les commits plus anciens gardent l\'ancien chemin', () => {
    const out = rec(C, B, 'Modifie', 'M', 'auth/login.js') + rec(B, A, 'Déplace', 'R100', 'login.js', 'auth/login.js') + rec(A, '', 'Écran de connexion', 'A', 'login.js');
    const revs = parseFileLog(out, 'auth/login.js');
    expect(revs.map((r) => [r.sha, r.status, r.path, r.oldPath])).toEqual([
      [C, 'M', 'auth/login.js', undefined],
      [B, 'R', 'auth/login.js', 'login.js'],
      [A, 'A', 'login.js', undefined],
    ]);
    expect(revs[2].parents).toEqual([]);
    expect(revs[0].parents).toEqual([B]);
    expect(revs[0]).toMatchObject({ author: 'Léa Dubois', email: 'lea@example.com', date: 1700000000 });
  });

  it('garde un sujet contenant le séparateur \\x1f', () => {
    const revs = parseFileLog(rec(A, '', 'un \x1f deux', 'A', 'x.txt'), 'x.txt');
    expect(revs[0].subject).toBe('un \x1f deux');
  });

  it('renvoie une liste vide pour un fichier sans historique', () => {
    expect(parseFileLog('', 'absent.txt')).toEqual([]);
  });

  it('reprend le chemin connu pour un commit sans ligne de statut (fusion)', () => {
    const out = rec(C, `${A} ${B}`, 'Fusionne') + rec(B, A, 'Renomme', 'R090', 'vieux nom.txt', 'nouveau nom.txt') + rec(A, '', 'Crée', 'A', 'vieux nom.txt');
    const revs = parseFileLog(out, 'nouveau nom.txt');
    expect(revs[0]).toMatchObject({ path: 'nouveau nom.txt', status: 'M', parents: [A, B] });
    expect(revs[2].path).toBe('vieux nom.txt');
  });
});

describe('parseBlame', () => {
  const porcelain = [
    `${A} 1 1 2`,
    'author Léa Dubois',
    'author-mail <lea@example.com>',
    'author-time 1700000000',
    'author-tz +0100',
    'committer Léa Dubois',
    'committer-mail <lea@example.com>',
    'committer-time 1700000000',
    'committer-tz +0100',
    'summary Écran de connexion',
    'boundary',
    'filename mon fichier.js',
    '\tlogin()',
    `${A} 2 2`,
    '\tvalidate()',
    `${B} 1 3 1`,
    'author Hugo Petit',
    'author-mail <hugo@example.com>',
    'author-time 1700001000',
    'author-tz +0000',
    'summary Indente',
    `previous ${A} mon fichier.js`,
    'filename mon fichier.js',
    '\t\tindenté()',
    `${A} 3 4 1`,
    '\tfin()',
    `${Z} 5 5 1`,
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'author-time 1700002000',
    'author-tz +0000',
    'summary Version of mon fichier.js from mon fichier.js',
    `previous ${B} mon fichier.js`,
    'filename mon fichier.js',
    '\tauthor pas une métadonnée',
    '',
  ].join('\n');

  it('associe chaque ligne à son commit, y compris un SHA répété sans métadonnées', () => {
    const b = parseBlame(porcelain);
    expect(b.lines.map((l) => [l.sha[0], l.origLine, l.line])).toEqual([
      ['a', 1, 1],
      ['a', 2, 2],
      ['b', 1, 3],
      ['a', 3, 4],
      ['0', 5, 5],
    ]);
    expect(b.commits[A]).toEqual({ sha: A, author: 'Léa Dubois', email: 'lea@example.com', date: 1700000000, summary: 'Écran de connexion' });
    expect(b.commits[B].author).toBe('Hugo Petit');
    expect(Object.keys(b.commits)).toHaveLength(3);
  });

  it('conserve une tabulation en début de contenu et ne lit pas le contenu comme métadonnée', () => {
    const b = parseBlame(porcelain);
    expect(b.lines[2].text).toBe('\tindenté()');
    expect(b.lines[4].text).toBe('author pas une métadonnée');
    expect(b.commits[Z]).toMatchObject({ author: 'Not Committed Yet', email: 'not.committed.yet' });
  });

  it('gère une sortie vide (fichier vide)', () => {
    expect(parseBlame('')).toEqual({ commits: {}, lines: [] });
  });
});
