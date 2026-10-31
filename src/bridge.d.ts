// What preload.ts exposes to the pages.
declare const pin: {
  capture(): Promise<string | null>;
  close(): void;
  setPinned(on: boolean): void;
  pinbar(action: 'draw' | 'clear' | 'close'): void;
  shot(action: 'add' | 'saved' | 'copy' | 'edit' | 'dismiss' | 'folder' | 'drag' | 'save', ...args: unknown[]): void;
  shotsHeight(h: number): void;
  onShots(cb: (files: string[]) => void): void;
  onUnpin(cb: () => void): void;
};
