import {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray,
} from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SOCKET } from './socket';

const HOTKEY = 'Alt+Shift+A';
const STATIC = path.join(app.getAppPath(), 'static');
const ICON = path.join(STATIC, 'icon.png');
const SHOTS_DIR = path.join(app.getPath('pictures'), 'Pinpoint');
const preload = path.join(app.getAppPath(), 'dist', 'preload.js');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

app.commandLine.appendSwitch('enable-transparent-visuals');
// A second launch only pings the running copy ('second-instance'); quit() lets that message go out first.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

let overlay: BrowserWindow | null = null;
let overlayReady = Promise.resolve();
let pinBar: BrowserWindow | null = null;
let shotsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let shots: string[] = [];

// ponytail: one overlay on the display under the cursor; one per display if multi-monitor drawing matters.
type Start = 'screen' | 'white' | 'black';

// forAgent: open click-through without taking focus, on the display the agent last captured.
function openOverlay(start: Start = 'screen', forAgent = false) {
  if (overlay) {
    setPinned(false);
    overlay.webContents.send('unpin');
    overlay.focus();
    return;
  }
  const d = (forAgent && agentDisplay) || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // Fullscreen, or Cinnamon shoves the window off any monitor whose panel it would cover.
  overlay = new BrowserWindow({
    ...d.bounds, fullscreen: true, transparent: true, frame: false, resizable: false, movable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true, show: false, backgroundColor: '#00000000',
    webPreferences: { preload },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.loadFile(path.join(STATIC, 'overlay.html'), { query: { start, ...(forAgent && { pinned: '1' }) } });
  overlayReady = new Promise(r => overlay!.webContents.once('did-finish-load', () => r()));
  overlay.once('ready-to-show', () => {
    overlay?.showInactive(); // show() lets Cinnamon place it first, often on the wrong monitor
    if (!forAgent) overlay?.focus();
    shotsWin?.moveTop();
  });
  overlay.on('closed', () => {
    overlay = null;
    pinBar?.close();
  });
}

// Pinned = the overlay ignores the mouse entirely (Linux can't forward hover to bring its bar back),
// so a small separate window carries Draw / Clear / Close.
function setPinned(on: boolean) {
  if (!overlay) return;
  overlay.setIgnoreMouseEvents(on);
  overlay.setFocusable(!on);
  if (!on) {
    overlay.focus();
    pinBar?.close();
    return;
  }
  if (pinBar) return;
  const b = overlay.getBounds(), [width, height] = [380, 56];
  pinBar = new BrowserWindow({
    width, height, x: Math.round(b.x + (b.width - width) / 2), y: b.y + 8, transparent: true, frame: false, resizable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload },
  });
  pinBar.setAlwaysOnTop(true, 'screen-saver');
  pinBar.setVisibleOnAllWorkspaces(true);
  pinBar.loadFile(path.join(STATIC, 'pinbar.html'));
  pinBar.once('ready-to-show', () => pinBar?.showInactive());
  pinBar.on('closed', () => { pinBar = null; });
}

ipcMain.on('pinbar', (_e, action: 'draw' | 'clear' | 'close') => {
  if (!overlay) return;
  if (action === 'draw') {
    setPinned(false);
    overlay.webContents.send('unpin');
  }
  if (action === 'clear') void overlay.webContents.executeJavaScript(`agent({ op: 'clear' })`);
  if (action === 'close') overlay.close();
});

// A short-lived card on launch; it fades and closes itself, or on click.
function showSplash() {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [width, height] = [640, 410];
  const win = new BrowserWindow({
    width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    transparent: true, frame: false, resizable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    focusable: false, show: false, backgroundColor: '#00000000', icon: ICON,
  });
  win.loadFile(path.join(STATIC, 'splash.html'), { query: { v: app.getVersion(), key: HOTKEY } });
  win.once('ready-to-show', () => win.showInactive());
}

function openEditor(file: string) {
  const win = new BrowserWindow({
    width: 1280, height: 820, title: 'Pinpoint — Edit Screenshot', icon: ICON, backgroundColor: '#232326', webPreferences: { preload },
  });
  win.setMenu(null);
  win.loadFile(path.join(STATIC, 'overlay.html'), { query: { edit: file } });
}

// Screens on X11 can come back as one source per monitor or as one spanning every monitor; handle both.
async function captureDisplay(d: Electron.Display) {
  const all = screen.getAllDisplays();
  const union = all.reduce((u, x) => ({
    x: Math.min(u.x, x.bounds.x), y: Math.min(u.y, x.bounds.y),
    r: Math.max(u.r, x.bounds.x + x.bounds.width), b: Math.max(u.b, x.bounds.y + x.bounds.height),
  }), { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity });
  const probe = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const own = probe.find(s => s.display_id === String(d.id)) ?? (probe.length === all.length && all.length === 1 ? probe[0] : null);
  const s = d.scaleFactor;
  if (own) {
    const size = { width: d.bounds.width * s, height: d.bounds.height * s };
    const src = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })).find(x => x.id === own.id)!;
    return src.thumbnail;
  }
  const size = { width: (union.r - union.x) * s, height: (union.b - union.y) * s };
  const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  return src.thumbnail.crop({
    x: (d.bounds.x - union.x) * s, y: (d.bounds.y - union.y) * s, width: d.bounds.width * s, height: d.bounds.height * s,
  });
}

// Capture a display with our own windows out of the picture.
async function captureClean(d: Electron.Display, win?: BrowserWindow) {
  const shotsVisible = shotsWin?.isVisible();
  win?.hide();
  shotsWin?.hide();
  if (win || shotsVisible) await sleep(400); // let the compositor repaint without us
  try {
    return await captureDisplay(d);
  } finally {
    if (win) {
      win.showInactive();
      if (win.isFocusable()) win.focus();
    }
    if (shotsVisible) shotsWin?.showInactive();
  }
}

ipcMain.handle('capture', async e => {
  const win = BrowserWindow.fromWebContents(e.sender)!;
  try {
    return (await captureClean(screen.getDisplayMatching(win.getBounds()), win)).toDataURL();
  } catch (err) {
    console.error('capture failed', err);
    return null;
  }
});

ipcMain.on('close', e => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('pinned', (_e, on: boolean) => setPinned(on));

// --- Screenshot stack -------------------------------------------------------

function dataToFile(file: string, dataURL: string) {
  fs.writeFileSync(file, Buffer.from(dataURL.split(',')[1], 'base64'));
}

function refreshShots() {
  if (!shots.length) return shotsWin?.hide();
  if (!shotsWin) {
    shotsWin = new BrowserWindow({
      width: 280, height: 200, transparent: true, frame: false, resizable: false, skipTaskbar: true, hasShadow: false,
      alwaysOnTop: true, focusable: true, show: false, backgroundColor: '#00000000', webPreferences: { preload },
    });
    shotsWin.setAlwaysOnTop(true, 'screen-saver');
    shotsWin.setVisibleOnAllWorkspaces(true);
    shotsWin.loadFile(path.join(STATIC, 'shots.html'));
    shotsWin.webContents.once('did-finish-load', refreshShots);
    shotsWin.on('closed', () => { shotsWin = null; });
    return;
  }
  shotsWin.webContents.send('shots', shots);
  shotsWin.showInactive();
  shotsWin.moveTop();
}

ipcMain.on('shots:height', (_e, h: number) => {
  if (!shotsWin) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  shotsWin.setBounds({ x: area.x + area.width - 296, y: area.y + area.height - h - 16, width: 280, height: Math.ceil(h) });
});

ipcMain.on('shot:add', (_e, dataURL: string) => {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const now = new Date();
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(SHOTS_DIR, `Pinpoint ${stamp}.png`);
  dataToFile(file, dataURL);
  shots = [file, ...shots].slice(0, 5);
  refreshShots();
});
ipcMain.on('shot:saved', (_e, file: string, dataURL: string) => {
  dataToFile(file, dataURL);
  refreshShots();
});
ipcMain.on('shot:copy', (_e, file: string) => clipboard.writeImage(nativeImage.createFromPath(file)));
ipcMain.on('shot:edit', (_e, file: string) => openEditor(file));
ipcMain.on('shot:dismiss', (_e, file: string) => { shots = shots.filter(f => f !== file); refreshShots(); });
ipcMain.on('shot:folder', () => shell.openPath(SHOTS_DIR));
ipcMain.on('shot:drag', (e, file: string) => {
  e.sender.startDrag({ file, icon: nativeImage.createFromPath(file).resize({ width: 160 }) });
});
ipcMain.on('shot:save', async (_e, file: string) => {
  const { filePath } = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath('pictures'), path.basename(file)) });
  if (filePath) fs.copyFileSync(file, filePath);
});

// --- Agents (MCP) -------------------------------------------------------------
// src/mcp.ts forwards each tool call here as one JSON line: {id, name, args} -> {id, result | error}.

let agentDisplay: Electron.Display | null = null;

async function inOverlay(cmd: object, start: Start = 'screen') {
  if (!overlay) openOverlay(start, true);
  await overlayReady;
  const r = await overlay!.webContents.executeJavaScript(`agent(${JSON.stringify(cmd)})`);
  if (r.error) throw new Error(r.error);
  return r.ok;
}

const jpeg = (img: Electron.NativeImage) => img.toJPEG(85).toString('base64');

async function agentCall(name: string, args: Record<string, unknown>): Promise<{ text: string; image?: string }> {
  switch (name) {
    case 'capture_screen': {
      let img: Electron.NativeImage;
      if (overlay) {
        agentDisplay = screen.getDisplayMatching(overlay.getBounds());
        img = nativeImage.createFromDataURL(await inOverlay({ op: 'capture' }));
      } else {
        agentDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        img = await captureClean(agentDisplay);
      }
      const { width, height } = img.getSize();
      return { image: jpeg(img), text: `Screen is ${width}×${height} px; draw takes coordinates in these pixels.` };
    }
    case 'draw':
      return { text: await inOverlay({ op: 'draw', marks: args.marks }) };
    case 'clear_drawing':
      return { text: overlay ? await inOverlay({ op: 'clear' }) : 'Nothing to clear; the overlay is closed.' };
    case 'new_board': {
      const kind = args.kind === 'black' ? 'black' : 'white';
      if (!overlay) {
        await inOverlay({ op: 'noop' }, kind);
        return { text: `Opened a ${kind === 'black' ? 'blackboard' : 'whiteboard'}.` };
      }
      return { text: await inOverlay({ op: 'board', kind }) };
    }
    case 'move_board':
      if (!overlay) throw new Error('No board is open; call new_board first.');
      return { text: await inOverlay({ op: 'move', by: args.by, zoom: args.zoom, fit: args.fit }) };
    case 'get_screenshot': {
      const file = shots[0] ?? (fs.existsSync(SHOTS_DIR) ? fs.readdirSync(SHOTS_DIR).filter(f => f.endsWith('.png')).sort().at(-1) : undefined);
      if (!file) throw new Error('The user has no Pinpoint screenshots yet; ask them to press S on the overlay.');
      const full = path.resolve(SHOTS_DIR, file);
      return { image: jpeg(nativeImage.createFromPath(full)), text: full };
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

// Asked once per agent connection, i.e. once per Claude Code session.
async function askAgent() {
  overlay?.setAlwaysOnTop(false); // keep the dialog above the overlay
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, title: 'Pinpoint',
    message: 'An AI agent wants to use Pinpoint',
    detail: 'It will be able to see your screen and draw on it until its session ends.',
  });
  overlay?.setAlwaysOnTop(true, 'screen-saver');
  return response === 0;
}

const agentServer = net.createServer(sock => {
  let allowed: Promise<boolean> | null = null;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', (d: string) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) void handle(buf.slice(0, i));
  });
  async function handle(line: string) {
    let id;
    try {
      const req = JSON.parse(line);
      id = req.id;
      if (!(await (allowed ??= askAgent()))) throw new Error('The user declined access to Pinpoint for this session.');
      sock.write(JSON.stringify({ id, result: await agentCall(req.name, req.args ?? {}) }) + '\n');
    } catch (err) {
      sock.write(JSON.stringify({ id, error: (err as Error).message }) + '\n');
    }
  }
});

// --- Desktop integration (AppImage only) ---------------------------------------
// The AppImage runtime sets APPIMAGE to its own path; rewrite the entries each launch so they follow the file.

const APPIMAGE = process.env.APPIMAGE;
const HOME = app.getPath('home');
const MENU_ENTRY = path.join(HOME, '.local/share/applications/pinpoint.desktop');
const AUTOSTART = path.join(app.getPath('appData'), 'autostart/pinpoint.desktop');

const writeFile = (file: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

const desktopEntry = (args = '') => `[Desktop Entry]
Type=Application
Name=Pinpoint
Comment=Draw on anything. Screen annotation overlay.
Exec="${APPIMAGE}"${args}
Icon=pinpoint
Categories=Graphics;
StartupWMClass=pinpoint
Terminal=false
`;

function setAutostart(on: boolean) {
  if (on) writeFile(AUTOSTART, desktopEntry(' --hidden') + 'X-GNOME-Autostart-enabled=true\n');
  else fs.rmSync(AUTOSTART, { force: true });
}

function integrateDesktop() {
  if (!APPIMAGE) return;
  const firstRun = !fs.existsSync(MENU_ENTRY);
  writeFile(path.join(HOME, '.local/share/icons/hicolor/512x512/apps/pinpoint.png'), fs.readFileSync(ICON));
  writeFile(MENU_ENTRY, desktopEntry());
  if (firstRun || fs.existsSync(AUTOSTART)) setAutostart(true); // on by default; keep its path current
}

// --- Tray -------------------------------------------------------------------

// A push pin, drawn upright then tilted 45° so the needle points down-left; 4x4 supersampled.
function trayIcon() {
  const n = 22, px = Buffer.alloc(n * n * 4), c = Math.SQRT1_2;
  const inPin = (x: number, y: number) =>
    (Math.abs(x) < 4 && y > -9 && y < -6) ||       // head
    (Math.abs(x) < 2.2 && y > -6.5 && y < -1) ||   // body
    (Math.abs(x) < 5.5 && y > -1.5 && y < 0.5) ||  // flange
    (Math.abs(x) < 0.7 && y > 0 && y < 9);         // needle
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let hits = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const dx = x + (sx + 0.5) / 4 - 11, dy = y + (sy + 0.5) / 4 - 11;
      if (inPin(c * dx + c * dy, c * dy - c * dx)) hits++;
    }
    px.fill(255, (y * n + x) * 4, (y * n + x) * 4 + 3);
    px[(y * n + x) * 4 + 3] = Math.round(hits / 16 * 255);
  }
  return nativeImage.createFromBitmap(px, { width: n, height: n });
}

app.whenReady().then(() => {
  if (!primary) return;
  integrateDesktop();
  if (!process.argv.includes('--hidden')) showSplash(); // --hidden: started at login
  tray = new Tray(trayIcon());
  tray.setToolTip('Pinpoint');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Draw on Screen  (${HOTKEY.replace(/\+/g, ' ')})`, click: () => openOverlay() },
    { label: 'Open a Whiteboard', click: () => openOverlay('white') },
    { type: 'separator' },
    { label: 'Start at Login', type: 'checkbox', visible: !!APPIMAGE, checked: fs.existsSync(AUTOSTART), click: m => setAutostart(m.checked) },
    { label: 'Open Screenshots Folder', click: () => { fs.mkdirSync(SHOTS_DIR, { recursive: true }); shell.openPath(SHOTS_DIR); } },
    { type: 'separator' },
    { label: 'Quit Pinpoint', click: () => app.quit() },
  ]));
  if (!globalShortcut.register(HOTKEY, () => openOverlay())) console.error(`Couldn't register ${HOTKEY}; another app has it.`);
  if (process.argv.includes('--draw')) openOverlay();
  fs.rmSync(SOCKET, { force: true }); // stale from a crash; the single-instance lock says it isn't live
  agentServer.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
});

app.on('second-instance', () => openOverlay());
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  agentServer.close();
});
