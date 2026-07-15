#!/usr/bin/env node
// Flowmie agent-skills MCP server (F002 Phase 1).
//
// A dependency-free stdio MCP server: newline-delimited JSON-RPC 2.0 over
// stdin/stdout (the MCP stdio transport). Each coding agent Flowmie spawns is
// configured to launch this shim; its tools let the agent see the canvas it
// lives on. The agent's identity and how to reach the backend bridge are
// baked into this process's environment by the spawner:
//
//   FLOWMIE_NODE_ID      this agent's canvas node id
//   FLOWMIE_BRIDGE_URL   http://127.0.0.1:<port>
//   FLOWMIE_BRIDGE_TOKEN shared secret sent as X-Flowmie-Token
//
// The shim holds no state; every tool call is a request to the bridge, so
// results always reflect the live canvas.

const NODE_ID = process.env.FLOWMIE_NODE_ID ?? "";
const BRIDGE_URL = process.env.FLOWMIE_BRIDGE_URL ?? "";
const TOKEN = process.env.FLOWMIE_BRIDGE_TOKEN ?? "";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "flowmie", version: "0.1.0" };

const node = () => encodeURIComponent(NODE_ID);

const TOOLS = [
  {
    name: "whoami",
    description:
      "Return this agent's own identity on the Flowmie canvas: its node id, " +
      "agent type, assigned role, and working directory. Call this first to " +
      "learn who you are before reasoning about other agents.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    request: () => ({ method: "GET", path: `/whoami?node=${node()}` }),
  },
  {
    name: "list_agents",
    description:
      "List the other agents on the canvas. Each entry reports the peer's " +
      "role/type and whether you are connected to it (canSend = you may " +
      "message it, canReceive = its replies reach you). By default only " +
      "connected peers are returned; pass connectedOnly=false to see every " +
      "agent on the canvas.",
    inputSchema: {
      type: "object",
      properties: {
        connectedOnly: {
          type: "boolean",
          description: "Only peers reachable by an enabled connection (default true).",
        },
      },
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path: `/agents?node=${node()}&connectedOnly=${args?.connectedOnly === false ? "false" : "true"}`,
    }),
  },
  {
    name: "get_connections",
    description:
      "List your connections to other agents and their direction relative to " +
      "you (outgoing = you can send, incoming = you can receive, " +
      "bidirectional = both). This is your local view of the canvas wiring.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    request: () => ({ method: "GET", path: `/connections?node=${node()}` }),
  },
  {
    name: "send_message",
    description:
      "Send a directed message to another agent's input. The target must be a " +
      "peer you can send to (see list_agents / get_connections). Returns a " +
      "messageId you can pass to wait_for_reply to await the peer's answer. " +
      "Fails if you have no enabled outgoing connection to that agent.",
    inputSchema: {
      type: "object",
      properties: {
        toNodeId: { type: "string", description: "The peer agent's node id." },
        text: { type: "string", description: "The message to deliver as the peer's input." },
      },
      required: ["toNodeId", "text"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "POST",
      path: `/message?node=${node()}`,
      body: { toNodeId: args?.toNodeId, text: args?.text },
    }),
  },
  {
    name: "reply",
    description:
      "Answer the agent that most recently messaged you — no node id needed. " +
      "When you receive a '[flowmie] Message from …' prompt and want to respond, " +
      "call this with your reply text; it's delivered straight back to that agent " +
      "and resolves its wait_for_reply. Prefer this over send_message for replies.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Your reply, delivered to the sender." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "POST",
      path: `/reply?node=${node()}`,
      body: { text: args?.text },
    }),
  },
  {
    name: "wait_for_reply",
    description:
      "Block until the agent you messaged produces its next response, then " +
      "return that reply. Pass the messageId returned by send_message. Use " +
      "this to delegate a task and wait for the result. Requires an enabled " +
      "connection that lets the peer's reply reach you. Returns {timedOut:true} " +
      "if no reply arrives within the timeout.",
    inputSchema: {
      type: "object",
      properties: {
        sinceMessageId: {
          type: "string",
          description: "The messageId returned by a prior send_message call.",
        },
        timeoutMs: {
          type: "number",
          description: "How long to wait, in milliseconds (default 60000, max 300000).",
        },
      },
      required: ["sinceMessageId"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path:
        `/reply?node=${node()}` +
        `&since=${encodeURIComponent(args?.sinceMessageId ?? "")}` +
        `&timeoutMs=${Number(args?.timeoutMs) > 0 ? Math.floor(args.timeoutMs) : 60000}`,
    }),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// --- JSON-RPC plumbing -----------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function callBridge({ method, path, body }) {
  if (!BRIDGE_URL) throw new Error("skills bridge URL not configured");
  const init = { method: method ?? "GET", headers: { "X-Flowmie-Token": TOKEN } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  // The reply long-poll can run up to its timeout; abort a bit after that so a
  // wedged bridge doesn't hang the tool call forever. Other calls are quick.
  const timeoutMs = path.startsWith("/reply") ? 305_000 : 15_000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;
  try {
    const res = await fetch(BRIDGE_URL + path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`bridge ${res.status}: ${text}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function handleToolCall(id, params) {
  const tool = TOOLS_BY_NAME.get(params?.name);
  if (!tool) {
    replyError(id, -32602, `unknown tool: ${params?.name}`);
    return;
  }
  try {
    const body = await callBridge(tool.request(params.arguments ?? {}));
    reply(id, { content: [{ type: "text", text: body }] });
  } catch (err) {
    // Surface as a tool error the agent can read and react to, not a
    // protocol-level failure.
    reply(id, {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    });
  }
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications: no response
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
      return;
    case "tools/call":
      await handleToolCall(id, params);
      return;
    default:
      if (id !== undefined && id !== null) {
        replyError(id, -32601, `method not found: ${method}`);
      }
  }
}

// --- stdin loop ------------------------------------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed lines
    }
    // Fire-and-forget; responses carry their own id so ordering is fine.
    handleMessage(msg).catch((err) => {
      if (msg && msg.id !== undefined && msg.id !== null) {
        replyError(msg.id, -32603, String(err));
      }
    });
  }
});
process.stdin.on("end", () => process.exit(0));
