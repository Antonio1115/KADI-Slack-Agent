import pkg from "@slack/bolt";
const { App } = pkg;
import dotenv from "dotenv";

import { sendDM } from "./utils/slack.js";
import { registerEventHandlers } from "./handlers/eventHandlers.js";
import {
  initializeKadiClient,
  fetchAndCacheCapabilities,
  fetchChannelsFromMCP,
} from "./services/kadiClient.js";
import { CachedChannel, ToolDefinition } from "./types/index.js";
import type { LoadedAbility } from "@kadi.build/core";

dotenv.config();

async function main() {
  console.log("Starting Slack Agent with OpenAI + MCP...");

  // Read Slack credentials from environment
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackSigning = process.env.SLACK_SIGNING_SECRET;
  const slackAppToken = process.env.SLACK_APP_TOKEN;

  if (!slackToken || !slackAppToken) {
    throw new Error(
      "Missing Slack credentials. Ensure SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set."
    );
  }

  // Initialize Slack Bolt App (Socket Mode)
  // This allows the bot to receive Slack events in real-time
  const appOptions: any = {
    token: slackToken,
    socketMode: true,
    appToken: slackAppToken,
  };
  if (slackSigning) appOptions.signingSecret = slackSigning;
  const slackApp = new App(appOptions);

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
     Connect to Kadi broker and initialize capabilities
     - This allows the agent to call MCP tools
     - Brokers manage communication between agents
  --------------------------------------------------------- */

  const client = await initializeKadiClient();

  const toolsCache: Map<string, ToolDefinition[]> = new Map();
  const slackAbility = await fetchAndCacheCapabilities(client, toolsCache);

  const auth2 = await slackApp.client.auth.test();
  const botUserId = auth2.user_id;
  if (!botUserId) {
    throw new Error("Slack auth.test() did not return a bot user id");
  }

  /* ---------------------------------------------------------
     Preload Slack Channels Using MCP channels_list (CSV-safe)
     - Calls MCP tool "slack_channels_list"
     - Parses returned CSV data into objects
     - Lets the LLM reference channels by name in prompts
  --------------------------------------------------------- */

  let cachedChannels: CachedChannel[] = [];

  // Initial load + 10 min refresh (mutate in place to keep reference stable)
  // Non-blocking: agent starts even if MCP tools aren't available yet
  {
    try {
      const initial = await fetchChannelsFromMCP(slackAbility, cachedChannels);
      cachedChannels.splice(0, cachedChannels.length, ...initial);
      console.log(`Cached ${cachedChannels.length} channels from Slack`);
    } catch (err: any) {
      console.log(
        "Warning: Could not preload channels. Agent will fetch them on-demand."
      );
      console.log(
        "Ensure Slack MCP server is connected to broker and tools are registered."
      );
      console.log(`Error: ${err.message}`);
    }
  }
  setInterval(async () => {
    try {
      const latest = await fetchChannelsFromMCP(slackAbility, cachedChannels);
      cachedChannels.splice(0, cachedChannels.length, ...latest);
    } catch (err: any) {
      console.log(`Channel refresh failed: ${err.message}`);
    }
  }, 10 * 60 * 1000);

  /* ---------------------------------------------------------
     Register event handlers
     - @mention listener
     - Direct message listener
  --------------------------------------------------------- */

  registerEventHandlers(slackApp, botUserId, toolsCache, cachedChannels, () => slackAbility);

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
