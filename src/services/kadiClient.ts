import { KadiClient, type LoadedAbility } from "@kadi.build/core";
import type { CachedChannel, ToolDefinition } from "../types/index.js";

export async function initializeKadiClient() {
  /* ---------------------------------------------------------
     Connect to KADI broker
     - Resolves broker URL from env (KADI_BROKER_URL/BROKER_URL)
     - Defaults to localhost:8080 for development
  --------------------------------------------------------- */

  const brokerUrl =
    process.env.KADI_BROKER_URL ||
    process.env.BROKER_URL ||
    "ws://localhost:8080/kadi";

  const client = new KadiClient({
    name: "slack-agent",
    broker: brokerUrl,
  });

  await client.connect();
  console.log(`Connected to broker at ${brokerUrl}`);

  /* Register a placeholder tool to transition client to 'ready' state
     - Required before invoking remote tools via broker
     - Placeholder has no real functionality (noop handler)
  */
  client.registerTool({
    name: "placeholder",
    description: "Placeholder tool",
    inputSchema: { type: "object", properties: {} },
  }, async () => ({}));

  await new Promise(resolve => setTimeout(resolve, 100));

  return client;
}

export async function fetchAndCacheCapabilities(
  client: KadiClient,
  toolsCache: Map<string, ToolDefinition[]>
): Promise<LoadedAbility | null> {
  /* Define all available Slack MCP tools
     - MCP upstreams expose tools directly (not as KADI abilities)
     - Tools prefixed with slack_ (slack_channels_list, etc.)
     - Each tool maps to a Slack API method
  */
  const slackTools: ToolDefinition[] = [
    {
      name: "slack_channels_list",
      description: "List all Slack channels",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slack_conversations_history",
      description: "Fetch message history from a conversation",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slack_conversations_replies",
      description: "Fetch replies in a thread",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slack_conversations_search_messages",
      description: "Search for messages across conversations",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slack_conversations_add_message",
      description: "Post a message to a Slack conversation",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  // Cache the tool list for reference in prompts
  toolsCache.set("slack", slackTools);

  console.log("Cached Slack tools:");
  slackTools.forEach((t: ToolDefinition) => {
    console.log(`  - ${t.name}`);
  });

  /* Create a wrapper ability that routes through the broker protocol
     - Mimics LoadedAbility interface for consistent API
     - Invokes tools via upstream:slack provider on the broker
     - Handles async response pattern: broker returns pending immediately,
       then sends actual result via kadi.ability.result notification
  */
  const ability: LoadedAbility = {
    name: "slack",
    transport: "broker",
    async invoke<T = unknown>(toolName: string, params: unknown): Promise<T> {
      const protocol = client.getBrokerProtocol();
      const manager = client.getBrokerManager();
      const connection = manager.getConnection('default');

      if (!connection) {
        throw new Error("No broker connection available");
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          listener();
          reject(new Error(`Tool invocation timeout for ${toolName}`));
        }, 300000);

        const handleMessage = (message: any) => {
        // Check if this is an ABILITY_RESPONSE notification with matching request ID
        if (
            message.method === "kadi.ability.response" &&
            message.params?.requestId === currentRequestId
        ) {
            clearTimeout(timeout);
            listener();
            const result = message.params?.result;
            resolve(result as T);
        }
        };

        const listener = () => {
          connection.off("message", handleMessage);
        };

        connection.on("message", handleMessage);

        // Send the tool invocation request
        let currentRequestId: string;

        protocol
          .invokeTool({
            targetAgent: "upstream:slack",
            toolName,
            toolInput: params,
          })
          .then((response) => {
            // If response has a requestId (pending status), wait for actual result
            if (response && typeof response === "object" && "requestId" in response) {
              currentRequestId = (response as any).requestId;
            } else {
              // If we got immediate result (not pending), resolve with it
              clearTimeout(timeout);
              listener();
              resolve(response as T);
            }
          })
          .catch((error) => {
            clearTimeout(timeout);
            listener();
            reject(error);
          });
      });
    },
    async getTools(): Promise<ToolDefinition[]> {
      return slackTools;
    },
    on() {
      throw new Error("Events not supported for MCP upstreams");
    },
    off() {
      throw new Error("Events not supported for MCP upstreams");
    },
    async disconnect() {},
  } as unknown as LoadedAbility;

  return ability;
}

export async function fetchChannelsFromMCP(
  ability: LoadedAbility | null,
  cachedChannels: CachedChannel[]
): Promise<CachedChannel[]> {
  try {
    if (!ability) {
      console.log("Slack ability not loaded; cannot preload channels.");
      return cachedChannels;
    }

    console.log("Fetching channels from Slack MCP...");

    /* Invoke slack_channels_list to get full channel inventory
       - Requests all channel types: public, private, IMs, group DMs
       - Limits to 999 to avoid pagination for now
    */
    const response = await ability.invoke("slack_channels_list", {
      channel_types: "public_channel,private_channel,im,mpim",
      limit: 999,
    });

    if (!response) {
      console.log("Channel fetch returned no result.");
      return cachedChannels;
    }

    let raw = "";

    if (typeof response === "string") {
      raw = response.trim();
    } else if (response && typeof response === "object") {
      const content = (response as any).content;
      if (Array.isArray(content)) {
        raw = content
          .map((item) => (typeof item?.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join("\n")
          .trim();
      } else if ((response as any).result) {
        raw = String((response as any).result).trim();
      } else {
        raw = JSON.stringify(response).trim();
      }
    } else {
      raw = String(response).trim();
    }

    const isCSV = raw.startsWith("ID,") || raw.includes("\n");

    if (!isCSV) {
      console.log("channels_list returned non-CSV data:", raw);
      return cachedChannels;
    }

    /* Parse CSV response manually
       - First line is header (ID, Name, Is_Private, etc.)
       - Each subsequent line is a channel record
    */
    const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);

    const headers = lines[0].split(",").map((h: string) => h.trim());
    const rows = lines.slice(1);

    const parsedChannels: CachedChannel[] = rows.map((line: string) => {
      const cols = line.split(",").map((c: string) => c.trim());
      const obj: any = {};
      headers.forEach((h: any, i: any) => (obj[h] = cols[i]));
      return obj;
    });

    console.log(`Cached ${parsedChannels.length} Slack channels:`);
    parsedChannels.forEach((ch) => console.log(`  - ${ch.ID}: ${ch.Name}`));

    return parsedChannels;
  } catch (err) {
    console.error("Failed to preload channels:", err);
    return cachedChannels;
  }
}
