import { describe, expect, it } from 'vitest';
import { layoutGraph } from './graph';
import type { Commit } from '../shared/types';

const c = (sha: string, ...parents: string[]): Commit => ({ sha, parents, author: '', email: '', date: 0, subject: sha, body: '', refs: [] });

describe('layoutGraph', () => {
  it('garde une histoire linéaire dans une seule colonne', () => {
    const rows = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows[0].incoming).toEqual([]);
    expect(rows[1].incoming).toEqual([{ col: 0, color: 0 }]);
    expect(rows[2].outgoing).toEqual([]);
  });

  it('ouvre une colonne pour le second parent d’un merge et la referme', () => {
    // m fusionne f (branche) dans b
    const rows = layoutGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
    expect(rows[0].outgoing.map((e) => e.col)).toEqual([0, 1]);
    expect(rows[1].col).toBe(1);
    expect(rows[1].pass.map((e) => e.col)).toEqual([0]);
    expect(rows[2].col).toBe(0);
    // a reçoit les deux lignes
    expect(rows[3].incoming.map((e) => e.col).sort()).toEqual([0, 1]);
    expect(rows[3].width).toBe(2);
  });

  it('place deux pointes de branche dans des colonnes distinctes', () => {
    const rows = layoutGraph([c('x', 'a'), c('y', 'a'), c('a')]);
    expect(rows[0].col).toBe(0);
    expect(rows[1].col).toBe(1);
    expect(rows[1].pass.map((e) => e.col)).toEqual([0]);
    expect(rows[2].incoming.map((e) => e.col)).toEqual([0, 1]);
  });
});
