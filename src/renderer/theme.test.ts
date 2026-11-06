import { describe, expect, it } from 'vitest';
import { monoFontStack, resolveTheme } from './theme';

describe('resolveTheme', () => {
  it('respecte une préférence explicite quel que soit le système', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('suit le système pour « system »', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('monoFontStack', () => {
  it('garde la police par défaut pour une chaîne vide', () => {
    expect(monoFontStack('')).toBeNull();
    expect(monoFontStack('   ')).toBeNull();
  });

  it('met un nom simple entre guillemets et ajoute un repli', () => {
    expect(monoFontStack('Fira Code')).toBe('"Fira Code", monospace');
    expect(monoFontStack('  Menlo ')).toBe('"Menlo", monospace');
  });

  it('reprend une liste déjà écrite', () => {
    expect(monoFontStack("'Fira Code', Menlo")).toBe("'Fira Code', Menlo, monospace");
    expect(monoFontStack('Menlo, monospace')).toBe('Menlo, monospace');
  });
});
