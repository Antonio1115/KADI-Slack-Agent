import { CachedChannel, ToolDefinition, LLMResponse } from "../types/index.js";
import OpenAI from "openai";
import { checkToolCallThrottle } from "../utils/rateLimit.js";
import type { LoadedAbility } from "@kadi.build/core";

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export async function handleSlackInput(
  text: string,
  user: string,
  say: any,
  channelId: string,
  toolsCache: Map<string, ToolDefinition[]>,
  cachedChannels: CachedChannel[],
  getSlackAbility: () => LoadedAbility | null,
  slackAgentName: string
) {
  const openai = getOpenAI();
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
    ? cachedChannels.map((c) => `${c.Name} = ${c.ID}`).join("\n")
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

  const rawResponse = completion.choices?.[0]?.message?.content ?? "{}";

  let parsed: LLMResponse = {};
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    console.error("Invalid JSON from LLM:", rawResponse);
    await say("I couldn't parse the assistant's response.");
    return;
  }

  if (parsed.answer) {
    await say(parsed.answer);
    return;
  }

  const toolName = parsed.tool;
  const toolInput = parsed.input || {};

  if (!toolName) {
    await say("I'm not sure which tool to call.");
    return;
  }

  if (!toolInput.channel_id && channelId) {
    toolInput.channel_id = channelId;
    console.log("Injected channel_id:", channelId);
  }

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

  const throttleCheck = checkToolCallThrottle(user);
  if (!throttleCheck.allowed) {
    await say(`Throttle: ${throttleCheck.reason}`);
    return;
  }

  try {
    if (toolInput.content_type === "text") {
      toolInput.content_type = "text/plain";
    }

    const ability = getSlackAbility();
    if (!ability) {
      await say("Slack ability not loaded; cannot call tools right now.");
      return;
    }

    const rawResult = await ability.invoke(toolName, toolInput);

    if (!rawResult) {
      await say(`Tool "${toolName}" executed.`);
      return;
    }

    let resultParsed: any = rawResult;

    try {
      if (typeof rawResult === "string") {
        resultParsed = JSON.parse(rawResult);
      }
    } catch {}

    if (text.toLowerCase().includes("summarize")) {
      const summary = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Summarize this Slack history:" },
          {
            role: "user",
            content:
              typeof resultParsed === "string"
                ? resultParsed
                : JSON.stringify(resultParsed, null, 2),
          },
        ],
      });

      await say(summary.choices[0].message?.content || "Summary complete.");
      return;
    }

    await say(
      "Tool Result:\n```json\n" +
        (typeof resultParsed === "string" ? resultParsed : JSON.stringify(resultParsed, null, 2)) +
        "\n```"
    );
  } catch (err: any) {
    console.error("Tool error:", err);
    await say(`Tool call failed: ${err.message || String(err)}`);
  }
}
