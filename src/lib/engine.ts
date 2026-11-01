// Where the site gets its data, and the channel to the background engine.

/** The live relay. Set VITE_LIVE_URL when building; without it the site shows schedules only. */
export const LIVE_URL: string = (import.meta.env.VITE_LIVE_URL ?? (import.meta.env.DEV ? '/live' : '')).replace(/\/$/, '');

export const dataUrl = (name: string) => new URL(`data/${name}`, document.baseURI).href;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve(value: never): void; reject(error: Error): void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../transit/engine.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const { id, ok, result, error } = event.data;
    const call = pending.get(id);
    pending.delete(id);
    if (ok) call?.resolve(result as never);
    else call?.reject(new Error(error));
  };
  worker.postMessage({
    id: nextId++,
    method: 'init',
    arg: {
      dataBase: new URL('data/', document.baseURI).href,
      liveBase: LIVE_URL ? new URL(LIVE_URL, window.location.href).href.replace(/\/$/, '') : '',
    },
  });
  return worker;
}

export function callEngine<T>(method: string, arg?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (value: never) => void, reject });
    getWorker().postMessage({ id, method, arg });
  });
}
