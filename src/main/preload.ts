import { contextBridge, ipcRenderer } from 'electron';

// Chaque méthode de l'API est relayée vers le processus principal sous le canal `arbor:<méthode>`.
const api = new Proxy(
  {},
  {
    get: (_t, method: string) =>
      async (...args: unknown[]) => {
        const res = await ipcRenderer.invoke(`arbor:${method}`, ...args);
        if (res && typeof res === 'object' && 'error' in res) throw new Error(res.error);
        return res?.value;
      },
  },
);

contextBridge.exposeInMainWorld('arbor', {
  call: (method: string, ...args: unknown[]) => (api as any)[method](...args),
});
