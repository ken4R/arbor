import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadPreferences } from './prefs';
import './styles.css';

// Imports à effet de bord des fonctionnalités (enregistrement de commandes, etc.) : un bloc par fonctionnalité.
// palette

// préférences

// onglets

// Préférences enregistrées lues dès le démarrage (et migration des anciennes clés localStorage).
void loadPreferences();

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    {/* Montages hors de l'application (surcouches globales) : un bloc par fonctionnalité. */}
    {/* palette */}

    {/* préférences */}

    {/* onglets */}
  </>,
);
