import type { ThemePreference } from '../../shared/prefs';
import { registerCommands, type Command } from '../commands';
import { openPreferences, PREFERENCES_SHORTCUT } from '../components/PreferencesDialog';
import { getPreferences, updatePreferences } from '../prefs';

// Commandes des préférences (palette) : ouvrir le dialogue, changer de thème.

const THEMES: { value: ThemePreference; label: string; keywords: string[] }[] = [
  { value: 'light', label: 'clair', keywords: ['light', 'jour'] },
  { value: 'dark', label: 'sombre', keywords: ['dark', 'nuit'] },
  { value: 'system', label: 'système', keywords: ['system', 'auto'] },
];

registerCommands('prefs', (): Command[] => [
  {
    id: 'prefs.open',
    title: 'Préférences…',
    group: 'Préférences',
    keywords: ['réglages', 'paramètres', 'options', 'settings'],
    shortcut: PREFERENCES_SHORTCUT,
    run: () => openPreferences(),
  },
  ...THEMES.map(
    (t): Command => ({
      id: `prefs.theme.${t.value}`,
      title: `Thème : ${t.label}`,
      group: 'Préférences',
      keywords: ['apparence', 'couleurs', 'theme', ...t.keywords],
      enabled: () => getPreferences().theme !== t.value,
      // `updatePreferences` remet le thème enregistré en cas d'échec ; le dialogue d'information
      // n'ayant pas de variante à un seul bouton, l'erreur est consignée dans la console.
      run: () =>
        void updatePreferences({ theme: t.value }).catch((e: unknown) => {
          console.error(`Thème non enregistré : ${e instanceof Error ? e.message : String(e)}`);
        }),
    }),
  ),
]);
