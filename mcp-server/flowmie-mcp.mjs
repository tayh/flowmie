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

// Returned from `initialize`; MCP clients surface this to the model as context
// for the server. This is how an agent learns it is on a canvas at all, rather
// than having to infer it from a list of oddly-named tools.
//
// It describes the *server and its tools*. The spawner separately appends a
// preamble describing the agent's *situation* (see `canvas_preamble` in
// src-tauri/src/skills/mod.rs) — the overlap is deliberate, so an agent whose
// client ignores one still gets the other. Keep the two consistent.
//
// Deliberately no peer roster: the canvas is live, so the agent is told how to
// look rather than handed a list that goes stale the moment a wire changes.
const INSTRUCTIONS = [
  "Flowmie is the canvas this agent is running on. The user arranges agents,",
  "notes, embedded browsers (Portals), and files as nodes, and wires them",
  "together with edges.",
  "",
  "An edge is a permission. These tools only reach a node that an enabled edge",
  "connects to this agent, respecting its direction. A 'not connected' error is",
  "the canvas working as intended, not a bug to route around — if something is",
  "needed but unreachable, say so; the user can draw the wire.",
  "",
  "The canvas changes while the agent runs, so treat every answer as a snapshot:",
  "call list_agents / get_connections when the topology matters rather than",
  "relying on a memory of it.",
  NODE_ID ? `\nThis agent is node ${NODE_ID}.` : "",
]
  .join("\n")
  .trim();

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
  {
    name: "list_resources",
    description:
      "List the resources you can access on the canvas: images and files a " +
      "connected peer published, screenshots you captured, the text of any " +
      "note wired to you, and any file or folder pinned to the canvas and " +
      "wired to you (resourceId 'file:<nodeId>'). Each entry has a resourceId " +
      "you pass to get_resource. Pass nodeId to see only that node's resources.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Only resources owned by this node." },
      },
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path:
        `/resources?node=${node()}` +
        (args?.nodeId ? `&owner=${encodeURIComponent(args.nodeId)}` : ""),
    }),
  },
  {
    name: "get_resource",
    description:
      "Fetch a resource into your context by its resourceId (from " +
      "list_resources). as='path' (default) returns a local path — best for " +
      "large or binary content a CLI reads by path. as='inline' returns text " +
      "directly, or image data you can view if your client renders images. " +
      "For a 'file:<nodeId>' resource (a file pinned to the canvas) as='path' " +
      "returns the file's REAL path, not a copy, and every read reflects the " +
      "current contents on disk — so re-read it if it may have changed. " +
      "Fails if you are not connected to the owner.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: { type: "string", description: "The resource's id." },
        as: {
          type: "string",
          enum: ["path", "inline"],
          description: "How to materialize it (default 'path').",
        },
      },
      required: ["resourceId"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path:
        `/resource?node=${node()}` +
        `&id=${encodeURIComponent(args?.resourceId ?? "")}` +
        `&as=${args?.as === "inline" ? "inline" : "path"}`,
    }),
    // Turn an inline-image bridge result into a proper MCP image content block
    // so a vision-capable client renders it; everything else stays text.
    transform: (body) => {
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.inlineImage) {
          return [
            {
              type: "image",
              data: parsed.inlineImage.dataBase64,
              mimeType: parsed.inlineImage.mime,
            },
          ];
        }
      } catch {
        // fall through to text
      }
      return [{ type: "text", text: body }];
    },
  },
  {
    name: "share_resource",
    description:
      "Publish a resource (an image, text, or file) onto the canvas so peers " +
      "connected to you can fetch it with get_resource. Provide the bytes as " +
      "base64 (dataBase64) or point at an existing file (path). Returns the " +
      "resourceId others will use.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "text", "file"], description: "Resource kind." },
        mime: { type: "string", description: "MIME type, e.g. image/png, text/markdown." },
        label: { type: "string", description: "A human/agent-readable name." },
        dataBase64: { type: "string", description: "The resource bytes, base64-encoded." },
        path: { type: "string", description: "Alternatively, a path to an existing file." },
      },
      required: ["kind", "mime", "label"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "POST",
      path: `/resource/share?node=${node()}`,
      body: {
        kind: args?.kind,
        mime: args?.mime,
        label: args?.label,
        dataBase64: args?.dataBase64,
        path: args?.path,
      },
    }),
  },
  {
    name: "capture_webview",
    description:
      "Screenshot a connected webview (Portal) node and register it as an image " +
      "resource — this is how you 'get an image' of a running web page on the " +
      "canvas. Pass the webview node's id. Returns a resourceId (and path) you " +
      "then read with get_resource. Requires an enabled edge to that webview.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The webview node's id." },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "POST",
      path: `/capture?node=${node()}`,
      body: { nodeId: args?.nodeId },
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
    const content = tool.transform
      ? tool.transform(body)
      : [{ type: "text", text: body }];
    reply(id, { content });
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
        instructions: INSTRUCTIONS,
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
