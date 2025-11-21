# Slack Agent — Kadi MCP + Slack Bolt + OpenAI

This repository contains a TypeScript-based agent that bridges **Slack**, the **Kadi MCP broker**, and **OpenAI**.  
The agent listens to Slack messages, routes them through an LLM, and dynamically executes MCP tools depending on user intent.

This README fully documents the architecture, setup, environment variables, runtime behavior, and development workflow.

---

# 🔧 Overview

The Slack Agent acts as a real-time automation bridge:

- Receives Slack events using **Slack Bolt Socket Mode**.
- Connects to the **Kadi MCP broker** to:
  - Discover all tools exposed by other agents.
  - Query and invoke MCP tools dynamically.
- Preloads the Slack workspace channel list via MCP (`slack_channels_list` tool).
- Uses **OpenAI** to interpret user messages and decide:
  - Whether to **answer directly** in Slack.
  - Or call an **MCP tool**, passing structured JSON input.
- Executes tool calls and sends responses back into Slack.

This architecture allows Slack to act as a natural-language control panel for your distributed MCP tools.

---

# 📁 Project Structure

```
slack-agent/
  ├── index.ts               # Main TypeScript entrypoint
  ├── package.json           # Node dependencies + scripts
  ├── tsconfig.json          # TypeScript compiler config
  ├── agent.json             # Kadi agent metadata & CLI configuration
  ├── README.md              # This documentation
  └── dist/                  # Compiled JavaScript output (generated)
```

---

# ⚙️ Technology Stack

### Runtime / Language
- **Node.js ≥18**
- **TypeScript 5**
- **ESM modules** (`type: "module"`)

### Core Libraries
- **Slack Bolt SDK** — event handling, commands, socket mode.
- **Kadi MCP Core** — connects to the broker, discovers MCP agents and tools.
- **OpenAI SDK** — LLM reasoning for routing and summarization.
- **dotenv** — environment variable loading.
- **tsx** — runs TS directly for development.

---

# 🧩 Detailed Architecture

## 1. Slack Initialization

The agent starts by configuring a Bolt `App`:

```ts
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN!,
});
```

### Features
- Socket Mode ensures the agent does **not** need a public HTTP endpoint.
- On startup, the bot sends a **diagnostic DM** to verify credentials.
- All Slack events are handled in real time.

---

## 2. Connection to the Kadi MCP Broker

The agent creates a client:

```ts
const client = new KadiClient({
  name: "slack-agent",
  role: "agent",
  transport: "broker",
  brokers: { local: brokerUrl },
  defaultBroker: "local",
});
```

### Responsibilities
- Connect to the MCP broker via WebSocket.
- Discover all other MCP agents.
- Query and cache their available tools.
- Allow the LLM to reliably invoke these tools.

A refresh runs every **5 minutes**, ensuring updated tool discovery without restarting.

---

## 3. Slack Channel Preloading via MCP

Slack channels are fetched using the `slack_channels_list` MCP tool:

```ts
await protocol.invokeTool({
  targetAgent: "Slack MCP Server",
  toolName: "slack_channels_list",
  toolInput: {
    channel_types: "public_channel,private_channel,im,mpim",
    limit: 999,
  },
});
```

### Why preload channels?

This allows the LLM to:

- Reference channels by **name** instead of ID.
- Avoid hallucinating channel IDs.
- Follow safety rules enforced in the system prompt.

---

## 4. LLM-Based Routing System

The LLM decides what to do:

### Option A — Respond directly  
Example JSON:

```json
{ "answer": "Here is the explanation..." }
```

### Option B — Call an MCP Tool  
Example JSON:

```json
{
  "tool": "slack_conversations_add_message",
  "input": { "channel_id": "C0123", "text": "Hello!" }
}
```

### Safety Rules in System Prompt
The LLM is explicitly instructed to:

- Use **only** known channels.
- Use **only** MCP tools that exist.
- Never invent agent names.
- Always return valid JSON objects.

This ensures reliable and deterministic behavior in Slack.

---

## 5. Slack Event Listeners

### Mentions (`@bot`)
Triggered when the bot is tagged:

```ts
slackApp.event("app_mention", ...)
```

### Direct Messages
Triggered when the bot receives a DM:

```ts
slackApp.message(async ({ message, say }) => ...)
```

Both pass their text directly to the LLM routing logic.

---

# 🧪 Development Workflow

## Install Dependencies

```
npm install
```

## Run in Dev Mode (TypeScript directly)

```
npm run dev
```

Uses `tsx` → no compilation step required.

## Build & Run Production Mode

```
npm run build
npm start
```

Builds to `dist/index.js` using `tsc`.

---

# 🌱 Environment Variables

You **must** create a `.env` file:

```env
# Slack configuration
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
SLACK_TEST_USER_ID=U123456789

# MCP broker settings
BROKER_URL=ws://localhost:8080

# OpenAI API Key
OPENAI_API_KEY=sk-...
```

### Required Slack Scopes

Your Slack bot should have:

- `chat:write`
- `channels:history`
- `channels:read`
- `im:history`
- `im:write`
- `mpim:write`
- `app_mentions:read`

And **Socket Mode must be enabled**.

---

# 🛠 Scripts Reference

### From `package.json`
```
npm run build    → compile TypeScript
npm run start    → run dist/index.js
npm run dev      → run index.ts with tsx
```

### From `agent.json` (Kadi CLI)
```
kadi run slack-agent setup
kadi run slack-agent dev
kadi run slack-agent start
```

---

# 🧵 How Tool Calls Work in Detail

When the agent receives a Slack message:

1. Build a strict system prompt  
2. Query OpenAI with `response_format: json_object`  
3. Validate if result contains:
   - `"answer"` → reply directly
   - `"tool"` → call MCP tool
4. If tool:
   - Inject channel_id if missing
   - Ensure tool exists in capabilities
   - Run tool via broker protocol
   - Return results JSON → Slack

This transforms Slack into a natural-language command hub for MCP.

---

# 🐛 Troubleshooting

### ❗ “Cannot find module src/index.ts”
Fix your `dev` script:

```json
"dev": "npx tsx index.ts"
```

### ❗ Bolt auth test failing
Check Slack tokens in `.env`.

### ❗ “Broker connection refused”
Ensure Kadi MCP broker is running:

```
kadi run broker dev
```

### ❗ No MCP tools showing up
Verify that **Slack MCP Server** agent is running.

---

# 📜 License
MIT License. See `package.json`.

---

# 🧭 Future Enhancements (Optional Ideas)

- Add internal caching to reduce repeated OpenAI calls.
- Add support for multiprompt + tools ranking.
- Provide analytics Dashboard for message routing.
- Add retry logic for MCP tool failures.

---

If you need this README customized, branded, or expanded into a full onboarding guide, I can generate that too.
