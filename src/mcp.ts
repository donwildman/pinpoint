// MCP server for AI agents. Speaks JSON-RPC over stdio and forwards each tool call to the running
// Pinpoint app over a Unix socket; the app asks the user once per session, then captures and draws.
// Register: claude mcp add --scope user pinpoint -- bun "<this folder>/src/mcp.ts"
import net from 'node:net';
import readline from 'node:readline';
import { SOCKET } from './socket';

const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] in capture_screen pixels' };
const TOOLS = [
  {
    name: 'capture_screen',
    description: "See the user's screen: the monitor Pinpoint is drawing on, or the one under the mouse, including any marks on it. " +
      'The picture is in device pixels; draw coordinates use the same pixels.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'draw',
    description: "Draw marks on the user's screen (or the open board) to point things out. Opens the overlay click-through if it's closed, " +
      'so the user keeps working underneath. arrow/line take from+to; rect/ellipse take box; pen/highlight take points; ' +
      'text takes at (top-left) + text; step draws the next numbered circle at at, with optional text as its label. ' +
      'Call capture_screen first so coordinates match what is on screen.',
    inputSchema: {
      type: 'object',
      required: ['marks'],
      properties: {
        marks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { enum: ['arrow', 'line', 'rect', 'ellipse', 'pen', 'highlight', 'text', 'step'] },
              from: point,
              to: point,
              box: {
                type: 'object', required: ['x', 'y', 'width', 'height'],
                properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
              },
              points: { type: 'array', items: point },
              at: point,
              text: { type: 'string' },
              color: { type: 'string', description: 'red (default), orange, yellow, green, blue, purple, white, black, or #rrggbb' },
              size: { type: 'integer', minimum: 1, maximum: 3, description: 'stroke weight, default 2' },
            },
          },
        },
      },
    },
  },
  {
    name: 'clear_drawing',
    description: 'Remove every mark from the current page. The user can undo it with Ctrl+Z.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'new_board',
    description: 'Open a blank, endless board to sketch on, shown click-through over the screen.',
    inputSchema: { type: 'object', properties: { kind: { enum: ['white', 'black'], description: 'default white' } } },
  },
  {
    name: 'move_board',
    description: 'Move the view of the current board: fit zooms to show every mark, zoom sets the level (1 = 100%), by pans by [dx, dy] pixels. Applied in that order.',
    inputSchema: { type: 'object', properties: { fit: { type: 'boolean' }, zoom: { type: 'number', minimum: 0.1, maximum: 8 }, by: point } },
  },
  {
    name: 'get_screenshot',
    description: 'Get the newest screenshot the user took with Pinpoint (S key), with their annotations. Use it when they say they marked something up for you.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// --- Socket to the app ----------------------------------------------------------

type Reply = { text: string; image?: string };
const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
let conn: Promise<net.Socket> | null = null;
let nextId = 1;

function connect() {
  return (conn ??= new Promise((resolve, reject) => {
    const s = net.createConnection(SOCKET, () => resolve(s));
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const { id, result, error } = JSON.parse(buf.slice(0, i));
        const p = pending.get(id);
        pending.delete(id);
        if (error) p?.reject(new Error(error));
        else p?.resolve(result);
      }
    });
    s.on('error', () => reject(new Error("Pinpoint isn't running. Ask the user to start it (`bun start` in the Pinpoint folder), then try again.")));
    s.on('close', () => {
      conn = null;
      for (const p of pending.values()) p.reject(new Error('Pinpoint quit during the call.'));
      pending.clear();
    });
  }));
}

async function callTool(name: string, args: unknown) {
  try {
    const s = await connect(), id = nextId++;
    const r = await new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      s.write(JSON.stringify({ id, name, args }) + '\n');
    });
    return {
      content: [...(r.image ? [{ type: 'image', data: r.image, mimeType: 'image/jpeg' }] : []), { type: 'text', text: r.text }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
  }
}

// --- MCP over stdio ------------------------------------------------------------

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', async line => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // notifications need no answer
  if (method === 'initialize') {
    return send({
      id,
      result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pinpoint', version: '0.1.0' } },
    });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
  if (method === 'tools/call') return send({ id, result: await callTool(params.name, params.arguments ?? {}) });
  send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
});
