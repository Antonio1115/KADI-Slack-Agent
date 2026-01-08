import { UserRateLimit, RateLimitResult } from "../types/index.js";

const TOOL_CALL_COOLDOWN_MS = 2000; // 2 seconds between tool calls per user
const MAX_MESSAGES_PER_MINUTE = 20; // 20 messages per minute per user
const MESSAGE_WINDOW_MS = 60000; // 1 minute window

export const userRateLimits = new Map<string, UserRateLimit>();

export function checkRateLimit(userId: string): RateLimitResult {
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

export function checkToolCallThrottle(userId: string): RateLimitResult {
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
