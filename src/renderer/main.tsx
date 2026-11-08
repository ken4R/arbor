import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadPreferences } from './prefs';
import './styles.css';

// Imports à effet de bord des fonctionnalités (enregistrement de commandes, etc.) : un bloc par fonctionnalité.
// palette
import './commands/git';
import { CommandPalette } from './components/CommandPalette';

// préférences
import { ThemeSync } from './theme';
import { PreferencesDialog } from './components/PreferencesDialog';
import './commands/prefs';

// onglets
import './commands/tabs';

// rebase interactif
import './commands/rebase';

// Préférences enregistrées lues dès le démarrage (et migration des anciennes clés localStorage).
void loadPreferences();

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    {/* Montages hors de l'application (surcouches globales) : un bloc par fonctionnalité. */}
    {/* palette */}
    <CommandPalette />

    {/* préférences */}
    <ThemeSync />
    <PreferencesDialog />

    {/* onglets */}
  </>,
);
