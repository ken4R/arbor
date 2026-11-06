import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('normalise une liste déjà écrite', () => {
    expect(monoFontStack("'Fira Code', Menlo")).toBe('"Fira Code", "Menlo", monospace');
    expect(monoFontStack('Menlo, monospace')).toBe('"Menlo", monospace');
    expect(monoFontStack('Menlo, ui-monospace')).toBe('"Menlo", ui-monospace, monospace');
  });

  it('reste valide pendant la saisie (guillemet non fermé, virgule finale)', () => {
    expect(monoFontStack('"Fira Code')).toBe('"Fira Code", monospace');
    expect(monoFontStack('Menlo,')).toBe('"Menlo", monospace');
    expect(monoFontStack(' , ,')).toBeNull();
    expect(monoFontStack('"')).toBeNull();
    expect(monoFontStack("Fira   Code,,'Menlo")).toBe('"Fira Code", "Menlo", monospace');
  });
});

describe('styles.css', () => {
  // Le thème clair est déclaré deux fois : `data-theme='light'` et le repli avant le JS (`:root:not([data-theme])`).
  const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
  const block = (start: string) => {
    const i = css.indexOf(start);
    expect(i).toBeGreaterThan(-1);
    const body = css.slice(i + start.length);
    return body.slice(0, body.indexOf('}')).trim();
  };

  it('le repli clair avant le JS reprend exactement le thème clair', () => {
    const light = block(":root[data-theme='light'] {");
    const fallback = block(':root:not([data-theme]) {');
    expect(fallback.replace(/\s+/g, ' ')).toBe(light.replace(/\s+/g, ' '));
  });
});
