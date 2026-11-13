import { api } from '../api';
import { registerCommands, type Command } from '../commands';

// Commandes des identifiants (palette) : oublier les identifiants mémorisés « pendant cette session ».
// Disponible aussi sur l'écran d'accueil (pas de `ui` : l'oubli est silencieux).

registerCommands('credentials', (c): Command[] => [
  {
    id: 'credentials.forgetSession',
    title: 'Oublier les identifiants de la session',
    group: 'Identifiants',
    keywords: ['mot de passe', 'password', 'identifiants', 'credentials', 'oublier', 'déconnexion', 'https'],
    run: () => {
      if (c.ui) void c.ui.run('Oubli des identifiants…', () => api.forgetSessionCredentials(), 'Identifiants de la session oubliés.');
      else void api.forgetSessionCredentials().catch(() => {});
    },
  },
]);
