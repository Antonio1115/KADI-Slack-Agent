export interface UserRateLimit {
  lastToolCallTime: number;
  messageCount: number;
  messageWindowStart: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
  };
}

export interface CachedChannel {
  ID: string;
  Name: string;
  [key: string]: any;
}

export interface LLMResponse {
  answer?: string;
  tool?: string;
  input?: Record<string, any>;
}

export interface ToolResult {
  result?: string;
}
