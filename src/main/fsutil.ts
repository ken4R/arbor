// Utilitaires de fichiers du processus principal (sans Electron : testables sous Vitest).
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

/**
 * Écriture atomique : un arrêt brutal ne laisse jamais un fichier tronqué. `mode` (ex. 0o600) s'applique au fichier
 * final, y compris si un fichier temporaire de même nom existait avec des droits plus larges.
 */
export function writeFileAtomic(file: string, content: string, mode?: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      if (mode !== undefined) fchmodSync(fd, mode);
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
