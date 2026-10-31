# Pinpoint

Draw on anything on your Linux screen. Press **Alt+Shift+A** and a transparent canvas covers the display under your cursor; press **Esc** and it's gone.

A Linux take on the macOS app Lasso (Electron + TypeScript, X11). Lives in the system tray.

## Run

    bun install
    bun start          # tray only; add -- --draw to open the overlay immediately
    bun test           # engine checks

## Package and install

```
bun run dist          # release/Pinpoint.AppImage (about 115 MB, includes Electron; needs libfuse2)
bun run install-app   # builds, then copies it to ~/Applications/Pinpoint.AppImage
```

When the AppImage runs, it adds itself to the app menu (`~/.local/share/applications/pinpoint.desktop` plus its icon) and, the first time, to Start at Login (`~/.config/autostart/pinpoint.desktop`, launched with `--hidden` so there is no splash). Both entries point at wherever the AppImage was run from and are refreshed on every launch. Turn login start off or on from the tray menu. Launching it from the menu while it's running opens the overlay.

## Keys (press ? while drawing)

| Tools | | Actions | |
|---|---|---|---|
| P pen | H highlighter | S screenshot | F pin (click through) |
| A arrow | I line | W whiteboard | K blackboard |
| R rectangle | O ellipse | PgUp/PgDn pages | Shift+1 fit all |
| T text | N numbered steps | Ctrl+Z / Ctrl+Shift+Z | Delete clears page |
| L laser | E eraser | 1–8 colours | [ ] stroke size |

Shift draws straight lines and squares, Alt draws from the centre. On boards, scroll pans and Ctrl+scroll (or pinch) zooms. On a screen page, a two-finger sideways swipe flips pages.

Screenshots land in `~/Pictures/Pinpoint` and wait in a stack in the bottom-right corner: copy, save, drag into another app, or click to crop and draw on them.

## Logo

`static/logo.svg` is the app icon (a red push pin in a yellow loop on a dark tile) and `static/mark.svg` is the same art without the tile, used on the splash. `static/icon.png` is the 512px render of `logo.svg`; re-render it if the SVG changes. The splash uses Montserrat from `static/fonts` (SIL OFL, licence alongside).

## AI agents (MCP)

Agents such as Claude Code can see your screen and draw on it through Pinpoint. Register once:

```
claude mcp add --scope user pinpoint -- bun "/path/to/Pinpoint/src/mcp.ts"
```

Claude Code starts `src/mcp.ts` itself; it talks to the running tray app over `$XDG_RUNTIME_DIR/pinpoint.sock`, so only Pinpoint needs to be running. The first call from each agent session asks you to Allow or Deny.

| Tool | Does |
|------|------|
| `capture_screen` | Picture of the screen (with any marks); its pixels are draw's coordinates |
| `draw` | Arrows, lines, boxes, ellipses, pen, highlight, text, numbered steps; opens the overlay click-through |
| `clear_drawing` | Clears the page (Ctrl+Z brings it back) |
| `new_board` | Opens a white or black board |
| `move_board` | Fit, zoom or pan the board |
| `get_screenshot` | Your newest Pinpoint screenshot, annotations included |

## To revisit

- **Panel hides while the overlay is open.** The overlay is fullscreen because Cinnamon moves an ordinary window off any monitor whose panel it would cover. Cinnamon hides its panel for fullscreen windows, so the panel vanishes while you draw. Possible fix: open the overlay as `type: 'dock'`. In testing it landed on the intended monitor (at 1919×1079, 1px short) and the panel stayed visible, but keyboard focus (tool keys, Esc) is untested. See `openOverlay()` in `src/main.ts`.
