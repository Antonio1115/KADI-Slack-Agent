import pkg from "@slack/bolt";
const { App } = pkg;
import { KadiClient } from "@kadi.build/core";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const brokerUrl = process.env.BROKER_URL || "ws://localhost:8080";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------------------------------------------------
   Rate Limiting & Throttling
   - Tracks user activity to prevent abuse
   - Enforces cooldown between tool calls
   - Limits requests per time window
--------------------------------------------------------- */

interface UserRateLimit {
  lastToolCallTime: number;
  messageCount: number;
  messageWindowStart: number;
}

const userRateLimits = new Map<string, UserRateLimit>();
const TOOL_CALL_COOLDOWN_MS = 2000; // 2 seconds between tool calls per user
const MAX_MESSAGES_PER_MINUTE = 20; // 20 messages per minute per user
const MESSAGE_WINDOW_MS = 60000; // 1 minute window

function checkRateLimit(userId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let limit = userRateLimits.get(userId);

  if (!limit) {
    limit = {
      lastToolCallTime: 0,
      messageCount: 1,
      messageWindowStart: now,
    };
    userRateLimits.set(userId, limit);
    return { allowed: true };
  }

  // Check message rate limit
  if (now - limit.messageWindowStart > MESSAGE_WINDOW_MS) {
    limit.messageCount = 1;
    limit.messageWindowStart = now;
  } else {
    limit.messageCount++;
    if (limit.messageCount > MAX_MESSAGES_PER_MINUTE) {
      return {
        allowed: false,
        reason: "Rate limit exceeded: max 20 messages per minute",
      };
    }
  }

  userRateLimits.set(userId, limit);
  return { allowed: true };
}

function checkToolCallThrottle(userId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let limit = userRateLimits.get(userId);

  if (!limit) {
    limit = { lastToolCallTime: now, messageCount: 0, messageWindowStart: now };
    userRateLimits.set(userId, limit);
    return { allowed: true };
  }

  const timeSinceLastTool = now - limit.lastToolCallTime;
  if (timeSinceLastTool < TOOL_CALL_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: `Tool calls are throttled: wait ${Math.ceil((TOOL_CALL_COOLDOWN_MS - timeSinceLastTool) / 1000)} seconds`,
    };
  }

  limit.lastToolCallTime = now;
  userRateLimits.set(userId, limit);
  return { allowed: true };
}

/* ---------------------------------------------------------
   Helper: Send a DM diagnostic using Slack API directly
   - This tests whether the Slack bot token works
   - Uses conversations.open to open a DM channel to a user
   - Sends a simple startup message
--------------------------------------------------------- */

async function sendDM(slackApp: any, userId: string, text: string) {
  const im = await slackApp.client.conversations.open({ users: userId });
  const channelId = im?.channel?.id;
  if (!channelId) throw new Error("Failed to open IM: no channel id returned");
  await slackApp.client.chat.postMessage({
    channel: channelId,
    text,
  });
}

/* ---------------------------------------------------------
   Main Agent Logic
   - Initializes Slack
   - Connects to MCP broker
   - Loads available tools
   - Preloads Slack channels through MCP
   - Handles messages and tool calls
--------------------------------------------------------- */

async function main() {
  console.log("Starting Slack Agent with OpenAI + MCP...");

  // Load secret-ability
  const secretClient = new KadiClient({
    name: "slack-agent"
  });
  const secrets = await secretClient.load('secret-ability', 'native');
  await secrets.init({ vaults: [] });

  // Get Slack tokens from vault (fallback to env vars)
  const slackTokenResult = await secrets.get({ key: 'SLACK_BOT_TOKEN' });
  const slackSigningResult = await secrets.get({ key: 'SLACK_SIGNING_SECRET' });
  const slackAppTokenResult = await secrets.get({ key: 'SLACK_APP_TOKEN' });

  // Initialize Slack Bolt App (Socket Mode)
  // This allows the bot to receive Slack events in real-time
  const slackApp = new App({
    token: slackTokenResult.value || process.env.SLACK_BOT_TOKEN!,
    signingSecret: slackSigningResult.value || process.env.SLACK_SIGNING_SECRET!,
    socketMode: true,
    appToken: slackAppTokenResult.value || process.env.SLACK_APP_TOKEN!,
  });

  /* ---------------------------------------------------------
     Diagnostic DM test
     - Sends a DM on startup to confirm bot token is valid
     - If this fails, Slack credentials are incorrect
  --------------------------------------------------------- */

  try {
    const auth = await slackApp.client.auth.test();
    const botUserId = auth.user_id;
    const targetUser = process.env.SLACK_TEST_USER_ID || botUserId;
    console.log(`Sending startup DM diagnostic to ${targetUser}...`);
    await sendDM(slackApp, targetUser!, "Slack agent online and ready!");
    console.log("DM diagnostic succeeded.");
  } catch (err: any) {
    console.error("Startup DM failed:", err.data || err);
  }

  /* ---------------------------------------------------------
     Connect to Kadi broker
     - This allows the agent to call MCP tools
     - Brokers manage communication between agents
  --------------------------------------------------------- */

  const client = new KadiClient({
    name: "slack-agent",
    role: "agent",
    transport: "broker",
    brokers: { local: brokerUrl },
    defaultBroker: "local",
  });

  await (client as any).connect();
  console.log(`Connected to broker at ${brokerUrl}`);

  const protocol = (client as any).getBrokerProtocol();

  /* ---------------------------------------------------------
     Capability Cache
     - Stores list of all MCP tools available from agents
     - Refreshed automatically every 5 minutes
  --------------------------------------------------------- */

  const toolsCache: Map<string, any[]> = new Map();
  const TOOL_REFRESH_MS = 5 * 60 * 1000;

  async function fetchAndCacheCapabilities() {
    try {
      const networks = (client as any).networks || ["global"];
      const agents = await (protocol as any).discoverAgents(networks);
      console.log(`Found ${agents.length} agents`);

      // Query each agent for its tools and cache them
      for (const agent of agents) {
        const capabilities = await (protocol as any).queryCapabilities(agent.name, networks);
        toolsCache.set(agent.name, capabilities || []);
      }

      console.log("Cached Slack MCP tools:");
      for (const [agentName, caps] of toolsCache.entries()) {
        for (const t of caps) {
          console.log(`  - ${agentName}/${t.name}`);
        }
      }
    } catch (err) {
      console.error("Capability fetch failed:", err);
    }
  }

  // Initial load + auto-refresh
  await fetchAndCacheCapabilities();
  setInterval(fetchAndCacheCapabilities, TOOL_REFRESH_MS);

  const auth2 = await slackApp.client.auth.test();
  const botUserId = auth2.user_id;

 /* ---------------------------------------------------------
   Preload Slack Channels Using MCP channels_list (CSV-safe)
   - Calls MCP tool "slack_channels_list"
   - Parses returned CSV data into objects
   - Lets the LLM reference channels by name in prompts
--------------------------------------------------------- */

let cachedChannels: any[] = [];

async function fetchChannelsFromMCP() {
  try {
    const slackAgentName = "Slack MCP Server";
    const tools = toolsCache.get(slackAgentName) || [];

    // Find the correct tool
    const listTool = tools.find((t: any) => t.name === "slack_channels_list");

    if (!listTool) {
      console.log("No slack_channels_list tool found — cannot preload channels.");
      return;
    }

    console.log("Fetching channels from Slack MCP...");

    // Request full channel list
    const response = await protocol.invokeTool({
      targetAgent: slackAgentName,
      toolName: "slack_channels_list",
      toolInput: {
        channel_types: "public_channel,private_channel,im,mpim",
        limit: 999,
      },
      timeout: 15000,
    });

    if (!response?.result) {
      console.log("Channel fetch returned no result.");
      return;
    }

    const raw = response.result.trim();

    // Detect CSV format
    const isCSV = raw.startsWith("ID,") || raw.includes("\n");

    if (!isCSV) {
      console.log("channels_list returned non-CSV data:", raw);
      return;
    }

    // Parse CSV manually
    const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);

    const headers = lines[0].split(",").map((h: string) => h.trim());
    const rows = lines.slice(1);

    const parsedChannels = rows.map((line: string) => {
      const cols = line.split(",").map((c: string) => c.trim());
      const obj: any = {};
      headers.forEach((h : any, i : any) => (obj[h] = cols[i]));
      return obj;
    });

    // Save final parsed list
    cachedChannels = parsedChannels;

    console.log(`Cached ${cachedChannels.length} Slack channels:`);
    cachedChannels.forEach((ch) =>
      console.log(`  - ${ch.ID}: ${ch.Name}`)
    );

  } catch (err) {
    console.error("Failed to preload channels:", err);
  }
}

  // Initial load + 10 min refresh
  await fetchChannelsFromMCP();
  setInterval(fetchChannelsFromMCP, 10 * 60 * 1000);

  /* ---------------------------------------------------------
     Core LLM Handler
     - Receives Slack text
     - Builds a context-rich system prompt
     - LLM decides: answer vs MCP tool call
     - Executes the tool if needed
     - Summarizes results if user asked for summary
--------------------------------------------------------- */

  async function handleSlackInput(
    text: string,
    user: string,
    say: any,
    channelId: string
  ) {
    const slackAgentName = "Slack MCP Server";
    const slackTools = toolsCache.get(slackAgentName) || [];

    /* Build tool summary for prompt
       - Provides LLM a list of permitted tools
       - Includes sample input shape (schema keys)
    */
    const slackToolsSummary = slackTools.length
      ? slackTools
          .map((t: any) => {
            const props = t.inputSchema?.properties
              ? Object.keys(t.inputSchema.properties).slice(0, 8) 
              : [];
            const sample = props.length ? `{ ${props.join(", ")} }` : "{}";
            const desc = (t.description || "").replace(/\s+/g, " ").slice(0, 140);
            return `- ${t.name} — ${desc} — input: ${sample}`;
          })
          .join("\n")
      : "(no Slack tools found)";

    // Simplified text list for channels (passed into system prompt)
    const channelLookupText = cachedChannels.length
      ? cachedChannels.map((c) => `${c.name} = ${c.id}`).join("\n")
      : "(no channels cached)";

    /* ---------------------------------------------------------
       System Prompt
       - Hard constraints for safety
       - Tells the LLM which tools it may call
       - Tells it NOT to guess channel IDs
       - Forces JSON output: answer OR tool call
    --------------------------------------------------------- */

    const systemPrompt = `
You are an automation assistant that controls Slack through MCP.

RULES:
1. You may ONLY call Slack MCP tools that appear in the "AVAILABLE TOOLS" list below.
2. If a tool does not appear in the list, you MUST NOT call it. Do not guess tool names.
3. If a channel ID is needed, ONLY use a channel from the "KNOWN SLACK CHANNELS" list.
4. Do NOT guess channel IDs, usernames, or agent names.
5. Always return one of the following JSON formats:
   {"answer":"text"}
   OR
   {"tool":"tool_name","input":{...}}

KNOWN SLACK CHANNELS (from MCP slack_channels_list):
${channelLookupText || "(no cached channels yet)"}

AVAILABLE TOOLS (from MCP capability discovery):
${slackToolsSummary || "(no tools found)"}

Your job is to decide:
- If the user is asking for an explanation → return {"answer": "..."}
- If the user is asking you to perform an action in Slack → return a tool call
`;


    /* ---------------------------------------------------------
       Ask the OpenAI model for decision
       - Model chooses: answer or tool call
       - Forced JSON response for safety
    --------------------------------------------------------- */

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices?.[0]?.message?.content ?? "{}";

    let parsed: any = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("Invalid JSON from LLM:", raw);
      await say("I couldn't parse the assistant's response.");
      return;
    }

    // If the LLM just answers text, send it to Slack
    if (parsed.answer) {
      await say(parsed.answer);
      return;
    }

    // Otherwise: Tool call path
    const toolName = parsed.tool;
    const toolInput = parsed.input || {};

    if (!toolName) {
      await say("I'm not sure which tool to call.");
      return;
    }

    // If missing channel_id, inject the current Slack channel automatically
    if (!toolInput.channel_id && channelId) {
      toolInput.channel_id = channelId;
      console.log("Injected channel_id:", channelId);
    }

    // Ensure the requested tool actually exists
    const toolDefinition = slackTools.find((t: any) => t.name === toolName);
    if (!toolDefinition) {
      await say(`Tool "${toolName}" not available.`);
      return;
    }

    /* ---------------------------------------------------------
       TOOL EXECUTION BLOCK
       - Calls Slack MCP tool through broker
       - Parses returned output
       - If "summarize" is in user input, runs a second LLM call to summarize
       - Sends final content back to Slack
    --------------------------------------------------------- */

    // Check tool call throttle before executing
    const throttleCheck = checkToolCallThrottle(user);
    if (!throttleCheck.allowed) {
      await say(`Throttle: ${throttleCheck.reason}`);
      return;
    }

    try {
  if (toolInput.content_type === "text") {
    toolInput.content_type = "text/plain";
  }

  // Run the MCP tool
  const result = await protocol.invokeTool({
    targetAgent: slackAgentName,
    toolName,
    toolInput,
    timeout: 30000,
  });

  const raw = result?.result;

  // If there is no returned data, just acknowledge success
  if (!raw) {
    await say(`Tool "${toolName}" executed.`);
    return;
  }

  let parsed: any = raw;

  // Try parsing JSON result
  try {
    parsed = JSON.parse(raw);
  } catch {
    // If JSON fails, keep as text — may be CSV or other text
  }

  // If user asked for a summary → summarize tool output
  if (text.toLowerCase().includes("summarize")) {
    const summary = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Summarize this Slack history:" },
        {
          role: "user",
          content:
            typeof parsed === "string"
              ? parsed
              : JSON.stringify(parsed, null, 2),
        },
      ],
    });

    await say(summary.choices[0].message?.content || "Summary complete.");
    return;
  }

  // Otherwise, return raw parsed result
  await say(
    "Tool Result:\n```json\n" +
      (typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)) +
      "\n```"
  );

} catch (err: any) {
  console.error("Tool error:", err);
  await say(`Tool call failed: ${err.message || String(err)}`);
}

  }

  /* ---------------------------------------------------------
     @mention listener
     - Detects messages where bot is tagged
     - Removes the mention tag and processes remaining text
--------------------------------------------------------- */

  slackApp.event("app_mention", async ({ event, say }) => {
    const user = event.user ?? "unknown";
    if (user === botUserId || (event as any).bot_id) return;

    // Check rate limit for general messages
    const rateCheck = checkRateLimit(user);
    if (!rateCheck.allowed) {
      await say(`Rate limit: ${rateCheck.reason}`);
      return;
    }

    const mentionRegex = new RegExp(`<@${botUserId}>`, "g");
    const cleanedText = (event.text || "").replace(mentionRegex, "").trim();

    console.log(`Mention from ${user}: ${cleanedText}`);
    await handleSlackInput(cleanedText, user, say, event.channel);
  });

  /* ---------------------------------------------------------
     Direct Message listener
     - Handles normal DM messages
     - Passes content into LLM + MCP pipeline
--------------------------------------------------------- */

  slackApp.message(async ({ message, say }) => {
    if (message.channel_type === "im" && !(message as any).bot_id) {
      const user = (message as any).user;
      const text = (message as any).text || "";
      const channelId = (message as any).channel;

      // Check rate limit for general messages
      const rateCheck = checkRateLimit(user);
      if (!rateCheck.allowed) {
        await say(`Rate limit: ${rateCheck.reason}`);
        return;
      }

      console.log(`DM from ${user}: ${text}`);

      // Default behaviour — pass to LLM + MCP pipeline
      await handleSlackInput(text, user, say, channelId);
    }
  });

  /* ---------------------------------------------------------
     Start Slack Socket server
     - Required for Slack events to be received
--------------------------------------------------------- */
  await slackApp.start();
  console.log("Slack Agent is running!");
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});