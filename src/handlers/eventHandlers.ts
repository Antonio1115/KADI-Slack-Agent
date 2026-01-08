import { checkRateLimit } from "../utils/rateLimit.js";
import { handleSlackInput } from "./messageHandler.js";
import { CachedChannel, ToolDefinition } from "../types/index.js";
import type { LoadedAbility } from "@kadi.build/core";

export function registerEventHandlers(
  slackApp: any,
  botUserId: string,
  toolsCache: Map<string, ToolDefinition[]>,
  cachedChannels: CachedChannel[],
  getSlackAbility: () => LoadedAbility | null
) {
  const slackAgentName = "Slack MCP Server";

  /* ---------------------------------------------------------
     @mention listener
     - Detects messages where bot is tagged
     - Removes the mention tag and processes remaining text
  --------------------------------------------------------- */

  slackApp.event("app_mention", async ({ event, say }: any) => {
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
    await handleSlackInput(
      cleanedText,
      user,
      say,
      event.channel,
      toolsCache,
      cachedChannels,
      getSlackAbility,
      slackAgentName
    );
  });

  /* ---------------------------------------------------------
     Direct Message listener
     - Handles normal DM messages
     - Passes content into LLM + MCP pipeline
  --------------------------------------------------------- */

  slackApp.message(async ({ message, say }: any) => {
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
      await handleSlackInput(
        text,
        user,
        say,
        channelId,
        toolsCache,
        cachedChannels,
        getSlackAbility,
        slackAgentName
      );
    }
  });
}
