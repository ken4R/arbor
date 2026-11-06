import { useSyncExternalStore } from 'react';
import type { DiffTarget, RepoSnapshot } from '../shared/types';
import type { Ui } from './ui';

// Registre des commandes de l'application, consommé par la palette (et les raccourcis clavier).
// Chaque domaine déclare ses commandes dans `commands/<domaine>.ts` via `registerCommands`, importé pour son
// effet de bord depuis `main.tsx`. Les commandes sont recalculées à partir du contexte courant de l'application.

/** Fonctions de l'application que les commandes peuvent appeler (publiées par `App`). */
export interface AppHooks {
  /** Ouvre (ou active) un dépôt déjà validé par le processus principal. */
  openRepo(path: string): void;
  closeRepo(): void;
  refresh(): void;
  /** Sélectionne un commit dans le graphe (ferme le diff et la vue fichier). */
  selectCommit(sha: string): void;
  showDiff(t: DiffTarget): void;
}

export interface CommandContext {
  /** null tant qu'aucun dépôt n'est ouvert (écran d'accueil). */
  ui: Ui | null;
  repo: string | null;
  /** null pendant le chargement du dépôt. */
  snap: RepoSnapshot | null;
  /** Libellé de l'opération Git en cours, ou null. Les commandes Git doivent être désactivées tant qu'elle tourne. */
  busy: string | null;
  app: AppHooks;
}

export interface Command {
  /** Identifiant stable, `<domaine>.<action>` (ex. `git.fetch`). */
  id: string;
  /** Libellé affiché, en français. */
  title: string;
  /** Groupe d'affichage (ex. « Git », « Affichage »). */
  group: string;
  /** Mots supplémentaires pour la recherche. */
  keywords?: string[];
  /** Raccourci au format de `matchShortcut` (ex. `Mod+Shift+P`). */
  shortcut?: string;
  /** Absent = toujours disponible. */
  enabled?: (c: CommandContext) => boolean;
  run: (c: CommandContext) => void;
}

export type CommandProvider = (c: CommandContext) => Command[];

const NOOP_HOOKS: AppHooks = {
  openRepo: () => {},
  closeRepo: () => {},
  refresh: () => {},
  selectCommit: () => {},
  showDiff: () => {},
};

export const EMPTY_COMMAND_CONTEXT: CommandContext = { ui: null, repo: null, snap: null, busy: null, app: NOOP_HOOKS };

const providers = new Map<string, CommandProvider>();
// Contexte courant, publié par `App` à chaque changement (dépôt, instantané, ui).
let context: CommandContext = EMPTY_COMMAND_CONTEXT;
const listeners = new Set<() => void>();

/** Déclare (ou remplace) les commandes d'un domaine. Renvoie la fonction de retrait. */
export function registerCommands(providerId: string, provider: CommandProvider): () => void {
  providers.set(providerId, provider);
  return () => {
    if (providers.get(providerId) === provider) providers.delete(providerId);
  };
}

/** Commandes disponibles dans ce contexte (celles dont `enabled` renvoie faux sont écartées). */
export function getCommands(c: CommandContext = context): Command[] {
  const out: Command[] = [];
  for (const provider of providers.values()) {
    for (const cmd of provider(c)) {
      if (!cmd.enabled || cmd.enabled(c)) out.push(cmd);
    }
  }
  return out;
}

/** Exécute une commande par son identifiant si elle est disponible ; renvoie `true` si elle a été lancée. */
export function runCommand(id: string, c: CommandContext = context): boolean {
  const cmd = getCommands(c).find((x) => x.id === id);
  if (!cmd) return false;
  cmd.run(c);
  return true;
}

export function getCommandContext(): CommandContext {
  return context;
}

export function setCommandContext(c: CommandContext): void {
  context = c;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useCommandContext(): CommandContext {
  return useSyncExternalStore(subscribe, getCommandContext);
}

/** Événement clavier réduit à ce que lit `matchShortcut` (compatible avec `KeyboardEvent` et `React.KeyboardEvent`). */
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Vrai si l'événement correspond au raccourci `spec` : modificateurs `Mod` (Cmd sur macOS, Ctrl ailleurs), `Ctrl`,
 * `Meta`/`Cmd`, `Shift`, `Alt` puis une touche (`P`, `Enter`, `Escape`, `,`, `F5`…), séparés par `+`.
 * Les modificateurs doivent correspondre exactement ; la touche est comparée sans tenir compte de la casse.
 */
export function matchShortcut(e: ShortcutEvent, spec: string, mac: boolean = isMac()): boolean {
  const parts = spec.split('+').map((p) => p.trim());
  // `Mod++` : la touche est « + ».
  const key = spec.endsWith('++') ? '+' : parts.pop();
  if (!key) return false;
  const want = { ctrl: false, meta: false, shift: false, alt: false };
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case 'mod':
        if (mac) want.meta = true;
        else want.ctrl = true;
        break;
      case 'ctrl':
      case 'control':
        want.ctrl = true;
        break;
      case 'meta':
      case 'cmd':
        want.meta = true;
        break;
      case 'shift':
        want.shift = true;
        break;
      case 'alt':
      case 'option':
        want.alt = true;
        break;
      case '':
        break;
      default:
        return false;
    }
  }
  if (e.ctrlKey !== want.ctrl || e.metaKey !== want.meta || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const k = key.toLowerCase();
  const ek = e.key.toLowerCase();
  if (ek === k) return true;
  // Raccourcis lettres avec Maj : `e.key` peut valoir « P » ; espace nommée.
  return (k === 'space' && ek === ' ') || (k === 'esc' && ek === 'escape');
}

/** Texte affichable d'un raccourci (ex. `Ctrl+Maj+P` ou `⌘⇧P`). */
export function formatShortcut(spec: string, mac: boolean = isMac()): string {
  const parts = spec.endsWith('++') ? [...spec.slice(0, -2).split('+').filter(Boolean), '+'] : spec.split('+');
  const names: Record<string, [string, string]> = {
    mod: ['⌘', 'Ctrl'],
    ctrl: ['⌃', 'Ctrl'],
    control: ['⌃', 'Ctrl'],
    meta: ['⌘', 'Méta'],
    cmd: ['⌘', 'Méta'],
    shift: ['⇧', 'Maj'],
    alt: ['⌥', 'Alt'],
    option: ['⌥', 'Alt'],
  };
  const out = parts.map((p) => {
    const n = names[p.toLowerCase()];
    return n ? n[mac ? 0 : 1] : p.length === 1 ? p.toUpperCase() : p;
  });
  return mac ? out.join('') : out.join('+');
}
