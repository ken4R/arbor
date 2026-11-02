import { describe, expect, it } from 'vitest';
import type { Commit } from '../shared/types';
import { isShaQuery, matchCommit, normalize } from './search';

const commit = (over: Partial<Commit> = {}): Commit => ({
  sha: '34a7ed5c61f18350e575b9a074ac972dcfeb40ee',
  parents: [],
  author: 'Léa Dubois',
  email: 'lea@example.com',
  date: 0,
  subject: 'Écran de connexion',
  body: 'Ajoute le formulaire\net la validation côté client.',
  refs: [],
  ...over,
});

describe('normalize', () => {
  it('retire les accents et la casse', () => {
    expect(normalize('Écran Léa ÇÀ')).toBe('ecran lea ca');
  });
});

describe('matchCommit', () => {
  it('ignore accents et casse dans le message', () => {
    expect(matchCommit(commit(), 'message', 'ecran')).toBe(true);
    expect(matchCommit(commit(), 'message', 'ÉCRAN DE')).toBe(true);
    expect(matchCommit(commit(), 'message', 'inexistant')).toBe(false);
  });

  it('cherche aussi dans le corps du message', () => {
    expect(matchCommit(commit(), 'message', 'cote client')).toBe(true);
  });

  it("cherche l'auteur par nom ou par e-mail", () => {
    expect(matchCommit(commit(), 'author', 'lea')).toBe(true);
    expect(matchCommit(commit(), 'author', 'LÉA DUB')).toBe(true);
    expect(matchCommit(commit(), 'author', 'example.com')).toBe(true);
    expect(matchCommit(commit(), 'author', 'connexion')).toBe(false);
  });

  it('exige un préfixe de SHA hexadécimal de 4 caractères au moins', () => {
    expect(matchCommit(commit(), 'sha', '34a')).toBe(false);
    expect(matchCommit(commit(), 'sha', '34a7')).toBe(true);
    expect(matchCommit(commit(), 'sha', '34A7ED5')).toBe(true);
    expect(matchCommit(commit(), 'sha', 'a7ed')).toBe(false); // préfixe, pas sous-chaîne
    expect(isShaQuery('zzzz')).toBe(false);
  });

  it('« Tout » combine message, auteur et SHA', () => {
    expect(matchCommit(commit(), 'all', 'formulaire')).toBe(true);
    expect(matchCommit(commit(), 'all', 'dubois')).toBe(true);
    expect(matchCommit(commit(), 'all', '34a7ed')).toBe(true);
    expect(matchCommit(commit(), 'all', '34a')).toBe(false);
  });

  it('ne correspond à rien pour un texte vide ou le champ fichier', () => {
    expect(matchCommit(commit(), 'all', '   ')).toBe(false);
    expect(matchCommit(commit(), 'file', 'ecran')).toBe(false);
  });
});
