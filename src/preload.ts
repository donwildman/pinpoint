import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pin', {
  capture: (): Promise<string | null> => ipcRenderer.invoke('capture'),
  close: () => ipcRenderer.send('close'),
  setPinned: (on: boolean) => ipcRenderer.send('pinned', on),
  pinbar: (action: 'draw' | 'clear' | 'close') => ipcRenderer.send('pinbar', action),
  shot: (action: string, ...args: unknown[]) => ipcRenderer.send(`shot:${action}`, ...args),
  shotsHeight: (h: number) => ipcRenderer.send('shots:height', h),
  onShots: (cb: (files: string[]) => void) => ipcRenderer.on('shots', (_e, files) => cb(files)),
  onUnpin: (cb: () => void) => ipcRenderer.on('unpin', () => cb()),
});
