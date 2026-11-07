import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_COMMAND_CONTEXT,
  formatShortcut,
  getCommandContext,
  getCommands,
  matchShortcut,
  registerCommands,
  runCommand,
  setCommandContext,
  type CommandContext,
} from './commands';

const ev = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; code?: string } = {}) => ({
  key,
  code: mods.code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('matchShortcut', () => {
  it('Mod = Ctrl hors macOS, Cmd sur macOS', () => {
    expect(matchShortcut(ev('p', { ctrl: true, shift: true }), 'Mod+Shift+P', false)).toBe(true);
    expect(matchShortcut(ev('P', { ctrl: true, shift: true }), 'Mod+Shift+P', false)).toBe(true);
    expect(matchShortcut(ev('p', { meta: true, shift: true }), 'Mod+Shift+P', false)).toBe(false);
    expect(matchShortcut(ev('p', { meta: true, shift: true }), 'Mod+Shift+P', true)).toBe(true);
    expect(matchShortcut(ev('p', { ctrl: true, shift: true }), 'Mod+Shift+P', true)).toBe(false);
  });

  it('exige exactement les modificateurs demandés', () => {
    expect(matchShortcut(ev('p', { ctrl: true }), 'Mod+Shift+P', false)).toBe(false);
    expect(matchShortcut(ev('p', { ctrl: true, shift: true, alt: true }), 'Mod+Shift+P', false)).toBe(false);
    expect(matchShortcut(ev('k', { ctrl: true }), 'Mod+P', false)).toBe(false);
  });

  it('accepte touches nommées, ponctuation et « + »', () => {
    expect(matchShortcut(ev('Escape'), 'Escape', false)).toBe(true);
    expect(matchShortcut(ev('Escape'), 'Esc', false)).toBe(true);
    expect(matchShortcut(ev('F5'), 'F5', false)).toBe(true);
    expect(matchShortcut(ev(',', { ctrl: true }), 'Mod+,', false)).toBe(true);
    expect(matchShortcut(ev('+', { ctrl: true }), 'Mod++', false)).toBe(true);
    expect(matchShortcut(ev(' ', { alt: true }), 'Alt+Space', false)).toBe(true);
    expect(matchShortcut(ev('Tab', { ctrl: true }), 'Ctrl+Tab', true)).toBe(true);
  });

  it('ne dépend pas de la disposition du clavier', () => {
    // AZERTY : Ctrl+1 donne « & », la touche physique reste Digit1.
    expect(matchShortcut(ev('&', { ctrl: true, code: 'Digit1' }), 'Mod+1', false)).toBe(true);
    // macOS : Alt+P donne « π ».
    expect(matchShortcut(ev('π', { alt: true, code: 'KeyP' }), 'Alt+P', true)).toBe(true);
    // « + » demande Maj en QWERTY/AZERTY : Maj est ignorée pour la ponctuation.
    expect(matchShortcut(ev('+', { ctrl: true, shift: true, code: 'Equal' }), 'Mod++', false)).toBe(true);
    // Maj reste exigée exactement pour les lettres et les touches nommées.
    expect(matchShortcut(ev('P', { ctrl: true, shift: true, code: 'KeyP' }), 'Mod+P', false)).toBe(false);
    expect(matchShortcut(ev('Tab', { ctrl: true, shift: true }), 'Ctrl+Tab', false)).toBe(false);
    expect(matchShortcut(ev('Tab', { ctrl: true, shift: true }), 'Ctrl+Shift+Tab', false)).toBe(true);
  });

  it('refuse un modificateur inconnu', () => {
    expect(matchShortcut(ev('p'), 'Hyper+P', false)).toBe(false);
  });
});

describe('formatShortcut', () => {
  it('affiche le raccourci selon la plateforme', () => {
    expect(formatShortcut('Mod+Shift+P', false)).toBe('Ctrl+Maj+P');
    expect(formatShortcut('Mod+Shift+P', true)).toBe('⌘⇧P');
    expect(formatShortcut('Mod++', false)).toBe('Ctrl++');
    expect(formatShortcut('Escape', false)).toBe('Échap');
    expect(formatShortcut('Mod+Enter', false)).toBe('Ctrl+Entrée');
  });
});

describe('registre de commandes', () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    disposers.splice(0).forEach((d) => d());
    setCommandContext(EMPTY_COMMAND_CONTEXT);
  });

  const withRepo: CommandContext = { ...EMPTY_COMMAND_CONTEXT, repo: '/tmp/x' };

  it('filtre les commandes dont enabled renvoie faux', () => {
    disposers.push(
      registerCommands('test', () => [
        { id: 'a.toujours', title: 'Toujours', group: 'Test', run: () => {} },
        { id: 'a.depot', title: 'Avec dépôt', group: 'Test', enabled: (c) => !!c.repo, run: () => {} },
      ]),
    );
    expect(getCommands(EMPTY_COMMAND_CONTEXT).map((c) => c.id)).toEqual(['a.toujours']);
    expect(getCommands(withRepo).map((c) => c.id)).toEqual(['a.toujours', 'a.depot']);
  });

  it('remplace un fournisseur de même identifiant et le retire', () => {
    disposers.push(registerCommands('dom', () => [{ id: 'x.un', title: 'Un', group: 'T', run: () => {} }]));
    const off = registerCommands('dom', () => [{ id: 'x.deux', title: 'Deux', group: 'T', run: () => {} }]);
    expect(getCommands(EMPTY_COMMAND_CONTEXT).map((c) => c.id)).toEqual(['x.deux']);
    off();
    expect(getCommands(EMPTY_COMMAND_CONTEXT)).toEqual([]);
  });

  it('utilise le contexte publié et exécute une commande disponible', () => {
    const run = vi.fn();
    disposers.push(registerCommands('run', () => [{ id: 'r.go', title: 'Go', group: 'T', enabled: (c) => !!c.repo, run }]));
    expect(runCommand('r.go')).toBe(false);
    setCommandContext(withRepo);
    expect(getCommandContext()).toBe(withRepo);
    expect(runCommand('r.go')).toBe(true);
    expect(run).toHaveBeenCalledWith(withRepo);
  });
});
