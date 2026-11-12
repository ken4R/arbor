// Chiffrement des secrets (jetons) par `safeStorage` d'Electron : à n'appeler qu'après `app.whenReady()`.
// Aucune fonction ne journalise ni ne met dans un message d'erreur le contenu chiffré ou déchiffré.
import { safeStorage } from 'electron';
import type { AccountStorageStatus } from '../shared/types';

/** Interface injectée dans le magasin de comptes (remplacée par un chiffrement factice dans les tests). */
export interface SecretCrypto {
  status(): AccountStorageStatus;
  /** Chiffre un objet sérialisable ; renvoie du base64. */
  encrypt(obj: unknown): string;
  /** Déchiffre du base64 produit par `encrypt` ; lève une erreur sans détail si c'est impossible. */
  decrypt(b64: string): unknown;
}

/** Trousseaux Linux reconnus comme sûrs ; tout autre backend (`basic_text`, `unknown`…) est traité comme faible. */
const LINUX_SAFE_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/**
 * `unavailable` : pas de chiffrement ; `weak` : Linux sans trousseau reconnu (`basic_text` : clé codée en dur,
 * équivalent à du clair ; `unknown`) : refusé ; sinon `available`.
 */
export function storageStatus(): AccountStorageStatus {
  if (!safeStorage.isEncryptionAvailable()) return { encryption: 'unavailable', backend: null };
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend();
    return { encryption: LINUX_SAFE_BACKENDS.has(backend) ? 'available' : 'weak', backend };
  }
  return { encryption: 'available', backend: process.platform === 'darwin' ? 'keychain' : 'dpapi' };
}

export function encrypt(obj: unknown): string {
  try {
    return safeStorage.encryptString(JSON.stringify(obj)).toString('base64');
  } catch {
    // Accès au trousseau refusé (macOS) ou indisponible : message fixe, jamais le contenu.
    throw new Error('Chiffrement impossible (accès au trousseau refusé ou indisponible).');
  }
}

export function decrypt(b64: string): unknown {
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(b64, 'base64')));
  } catch {
    // Jamais le contenu dans le message.
    throw new Error('Secret illisible (trousseau réinitialisé ou autre machine).');
  }
}

export const electronCrypto: SecretCrypto = { status: storageStatus, encrypt, decrypt };
