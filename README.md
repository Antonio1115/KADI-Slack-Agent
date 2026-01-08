# Slack Agent - Kadi MCP + Slack Bolt + OpenAI

This is a TypeScript agent that connects Slack to the Kadi MCP broker and OpenAI. It listens to messages in your Slack workspace, processes them through a language model, and executes MCP tools based on what people are asking for.

This documentation walks through the architecture, how to set it up, what environment variables you need, how it behaves at runtime, and the development workflow you'll follow.

---

## Overview

Think of this agent as a real-time automation layer that sits between your team's Slack workspace and your MCP tools:

- It receives Slack events through Socket Mode (so you don't need to expose any public endpoints)
- It maintains a connection to the Kadi MCP broker, which gives it access to all the tools other agents have registered
- On startup, it fetches your workspace's channel list using the `slack_channels_list` MCP tool
- When someone messages the bot, it asks OpenAI to figure out whether to respond directly or call an MCP tool
- If a tool needs to be called, it handles the invocation and sends the results back to Slack

What this gives you is essentially a conversational interface to your entire MCP ecosystem. Your team can interact with distributed tools using natural language in Slack.

---

## Project Structure

```
slack-agent/
  ├── src/
  │   ├── index.ts            # Entrypoint
  │   ├── handlers/           # Slack event + message routing
  │   ├── services/           # KADI client + capability cache
  │   └── utils/              # Rate limiting helpers
  ├── package.json            # Node dependencies + scripts
  ├── tsconfig.json           # TypeScript compiler config
  ├── agent.json              # Kadi agent metadata & CLI configuration
  ├── README.md               # This documentation
  └── dist/                   # Compiled JavaScript output (generated)
```

---

## Technology Stack

**Runtime and Language**
- Node.js version 18 or later
- TypeScript 5
- ESM modules (the package.json has `"type": "module"`)

**Core Libraries**
- Slack Bolt SDK handles all the event processing, commands, and socket mode connections
- Kadi MCP Core manages the connection to the broker and handles tool discovery and invocation
- OpenAI SDK provides the LLM reasoning that routes requests and summarizes responses
- dotenv loads environment variables from your `.env` file
- tsx lets you run TypeScript files directly during development

---

## Detailed Architecture

### Slack Initialization

When the agent starts up, it initializes a Bolt app like this:

```ts
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN!,
});
```

Socket Mode is important here because it means the agent doesn't need a public HTTP endpoint—everything happens over a WebSocket connection. When the bot starts, it sends a diagnostic direct message to verify that credentials are working. From that point on, it handles all Slack events in real time.

---

### Connection to the Kadi MCP Broker

The agent creates a client and connects to the broker using the single `broker` field:

```ts
const client = new KadiClient({
  name: "slack-agent",
  broker: process.env.KADI_BROKER_URL || "ws://localhost:8080/kadi",
});

await client.connect();
```

Tools from the Slack MCP upstream are not loaded as KADI abilities; they are invoked directly via the broker protocol using `targetAgent: "upstream:slack"`.

---

### Slack Channel Preloading via MCP

Slack channels are fetched via the broker using the Slack upstream:

```ts
await ability.invoke("slack_channels_list", {
  channel_types: "public_channel,private_channel,im,mpim",
  limit: 999,
});
```

The agent waits for the asynchronous `kadi.ability.response` notification from the broker to get the actual tool result (the broker first returns a pending status). Preloading gives the LLM accurate channel names/IDs and avoids hallucinated IDs.

---

### LLM-Based Routing System

When someone sends a message to the bot, the LLM looks at it and decides how to respond. There are two paths it can take:

**Direct response** — If the request is straightforward or informational, the LLM just answers directly:

```json
{ "answer": "Here is the explanation..." }
```

**MCP tool invocation** — If the request needs action (like posting a message to a channel, searching for information, or running some computation), it calls an MCP tool:

```json
{
  "tool": "slack_conversations_add_message",
  "input": { "channel_id": "C0123", "text": "Hello!" }
}
```

The system prompt includes explicit safety rules to keep things reliable. The LLM is told to only use channels that actually exist, only call tools that are available in the capabilities list, never invent agent names, and always return valid JSON. This keeps the behavior deterministic and prevents the kind of hallucination issues you'd run into otherwise.

---

### Slack Event Listeners

The agent listens for two types of Slack events:

**Mentions** - When someone tags the bot with `@bot` in a channel:

```ts
slackApp.event("app_mention", ...)
```

**Direct Messages** - When someone sends the bot a DM:

```ts
slackApp.message(async ({ message, say }) => ...)
```

Both of these just extract the text from the message and pass it along to the LLM routing logic. The routing system then figures out what to do next.

---

## Development Workflow

**Install Dependencies**

```
npm install
```

**Run in Dev Mode (TypeScript directly)**

```
npm run dev
```

This uses `tsx` so there's no compilation step—you can just edit TypeScript files and restart the process.

**Build and Run Production Mode**

```
npm run build
npm start
```

This compiles everything to `dist/index.js` using TypeScript's compiler, then runs the compiled JavaScript.

---

## Environment Variables

You'll need to create a `.env` file in the project root with these variables:

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

**Required Slack Scopes**

When you set up your Slack app, make sure it has these OAuth scopes:

- `chat:write`
- `channels:history`
- `channels:read`
- `im:history`
- `im:write`
- `mpim:write`
- `app_mentions:read`

You also need to enable Socket Mode in your Slack app settings. Without Socket Mode, the bot won't be able to receive events.

---

## Scripts Reference

**From package.json**
```
npm run build    → compile TypeScript
npm run start    → run dist/index.js
npm run dev      → run index.ts with tsx
```

**From agent.json (Kadi CLI)**
```
kadi run slack-agent setup
kadi run slack-agent dev
kadi run slack-agent start
```

---

## How Tool Calls Work in Detail

Here's what happens when someone sends the bot a message:

1. The agent builds a system prompt that includes the Slack upstream tools, channel information, and safety rules
2. It asks OpenAI for structured JSON: either `{ "answer": ... }` or a `{ "tool": ..., "input": ... }` payload
3. For tool calls, the agent injects the channel ID when missing and invokes via `targetAgent: "upstream:slack"`
4. The broker returns `{status: "pending", requestId: "..."}` immediately; the agent then waits for `kadi.ability.response` with the actual result
5. Results are formatted and posted back to Slack

This makes Slack a natural-language front end for MCP without exposing internal APIs to end users.

---

## Known Issues

No known blocking issues. Tool invocations now wait for `kadi.ability.response` and return the actual results.

---

## Troubleshooting

**"Cannot find module src/index.ts"**

Your dev script is pointing to the wrong path. Update it in package.json:

```json
"dev": "npx tsx index.ts"
```

**Bolt auth test failing**

Double-check the Slack tokens in your `.env` file. Make sure you're using the bot token (starts with `xoxb-`), not a user token.

**"Broker connection refused"**

The MCP broker might not be running. Start it with:

```
kadi run broker dev
```

**No MCP tools showing up**

Make sure the Slack MCP Server agent is actually running. The Slack agent depends on it for channel operations.

---

## License

MIT License. See package.json for details.