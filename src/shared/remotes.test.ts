import { describe, expect, it } from 'vitest';
import { remoteOf } from './remotes';

describe('remoteOf', () => {
  const remotes = [{ name: 'a' }, { name: 'a/b' }, { name: 'origin' }];

  it('rattache une branche au plus long remote qui la préfixe', () => {
    expect(remoteOf(remotes, 'a/b/x')).toBe('a/b');
    expect(remoteOf(remotes, 'a/x')).toBe('a');
    expect(remoteOf(remotes, 'a/bc')).toBe('a');
    expect(remoteOf(remotes, 'origin/main')).toBe('origin');
  });

  it('ne dépend pas de l’ordre des remotes', () => {
    expect(remoteOf([...remotes].reverse(), 'a/b/x')).toBe('a/b');
  });

  it('aucun remote ne correspond : null', () => {
    expect(remoteOf(remotes, 'autre/main')).toBeNull();
    expect(remoteOf([], 'origin/main')).toBeNull();
    expect(remoteOf(remotes, 'origin')).toBeNull();
  });
});
