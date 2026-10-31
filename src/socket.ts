import os from 'node:os';
import path from 'node:path';

// Where the running app listens for agent commands from mcp.ts. XDG_RUNTIME_DIR is private to the user.
export const SOCKET = path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'pinpoint.sock');
