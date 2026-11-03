import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

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

// Événements que le processus principal peut pousser au rendu (canal `arbor:event:<nom>`).
const EVENTS = ['repoChanged', 'watchLimited'];

contextBridge.exposeInMainWorld('arbor', {
  call: (method: string, ...args: unknown[]) => (api as any)[method](...args),
  /** S'abonne à un événement de la liste blanche ; renvoie la fonction de désabonnement. */
  on: (event: string, cb: (payload: unknown) => void) => {
    if (!EVENTS.includes(event)) throw new Error(`Événement inconnu : ${event}`);
    const channel = `arbor:event:${event}`;
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});
