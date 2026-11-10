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
// éditeur de fusion
import './commands/conflicts';
// remotes
import './commands/remotes';
// tags
import './commands/tags';
// reflog
import './commands/reflog';
// sous-modules
import './commands/submodules';
// lfs
import './commands/lfs';
// glisser-déposer
import './commands/branches';
import { clearDropHover, endRefDrag } from './refDrop';

// Préférences enregistrées lues dès le démarrage (et migration des anciennes clés localStorage).
void loadPreferences();

// glisser-déposer : hors des cibles d'Arbor, rien ne se dépose (un fichier externe ne charge jamais file:// dans la
// fenêtre) ; la source glissée est oubliée au dépôt et à la fin du glisser, même si son élément a été démonté.
const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName));
window.addEventListener('dragover', (e) => {
  if (e.defaultPrevented || editable(e.target)) return;
  clearDropHover();
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (e) => {
  endRefDrag();
  if (!editable(e.target)) e.preventDefault();
});
window.addEventListener('dragend', () => endRefDrag(), true);

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
