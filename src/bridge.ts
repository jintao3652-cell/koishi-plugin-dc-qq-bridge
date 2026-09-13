import { Bot, Context } from "koishi";
import { BasicType, Config } from "./config";
import { logger } from "./utils";

export interface BridgeRoute {
  from: BasicType;
  to: BasicType;
}

export interface BridgeMessageRecord {
  timestamp: number;
  fromMessageId: string;
  fromPlatform: string;
  fromChannelId: string;
  fromSenderId: string;
  fromSenderName: string;
  toMessageId: string;
  toPlatform: string;
  toChannelId: string;
  onebotRealMessageId: string;
}

export interface DiscordRouteChannel {
  routeChannelId: string;
  thread?: {
    id: string;
    name: string;
  };
}

export function findBridgeRoutes(config: Config, platform: string, selfId: string, channelId: string): BridgeRoute[] {
  const routes: BridgeRoute[] = [];

  for (const constant of config.constant ?? []) {
    if (!constant.enable) continue;

    for (const from of constant.from) {
      if (from.platform !== platform || from.self_id !== selfId || from.channel_id !== channelId) continue;

      for (const to of constant.to) {
        routes.push({ from, to });
      }
    }
  }

  return routes;
}

export function isBridgeableDiscordMessage(message): boolean {
  if (message?.type === undefined) return true;
  return [0, 19].includes(Number(message.type));
}

export async function isBridgeableDiscordChannelMessage(ctx: Context, selfId: string, channelId: string, message): Promise<boolean> {
  if (!isBridgeableDiscordMessage(message)) {
    logger.warn(`Skipping unsupported Discord message type ${message.type} in channel ${channelId}.`);
    return false;
  }
  if (message?.type !== undefined) return true;

  try {
    const data = await ctx.bots[`discord:${selfId}`].internal.getChannelMessage(channelId, message.id);
    if (!isBridgeableDiscordMessage(data)) {
      logger.warn(`Skipping unsupported Discord message type ${data.type} in channel ${channelId}.`);
      return false;
    }
    return isBridgeableDiscordMessage(data);
  } catch (error) {
    logger.warn(`Skipping Discord message in channel ${channelId}: unable to determine its type. ${formatError(error)}`);
    return false;
  }
}

export async function resolveDiscordRouteChannel(ctx: Context, config: Config, platform: string, selfId: string, channelId: string): Promise<DiscordRouteChannel> {
  if (platform !== "discord") return { routeChannelId: channelId };

  const dcBot = ctx.bots[`discord:${selfId}`];
  let channel;
  try {
    channel = await dcBot.internal.getChannel(channelId);
  } catch (error) {
    logger.error(error);
    return { routeChannelId: channelId };
  }
  const channelType = Number(channel.type);
  if (channelType === 12) return { routeChannelId: "" };
  if (findBridgeRoutes(config, platform, selfId, channelId).length > 0) return { routeChannelId: channelId };
  if (![10, 11].includes(channelType) || !channel.parent_id) return { routeChannelId: channelId };

  const routes = findBridgeRoutes(config, platform, selfId, channel.parent_id);
  if (routes.length === 0) return { routeChannelId: channelId };

  return {
    routeChannelId: channel.parent_id,
    thread: {
      id: channelId,
      name: channel.name ?? channelId,
    },
  };
}

export async function createBridgeMessageRecord(ctx: Context, record: BridgeMessageRecord) {
  const fromGuild = await ctx.database.get("channel", {
    id: record.fromChannelId,
  });
  const toGuild = await ctx.database.get("channel", {
    id: record.toChannelId,
  });

  const fromGuildId = fromGuild[0]?.guildId ?? "";
  const toGuildId = toGuild[0]?.guildId ?? "";
  if (!fromGuild[0]) logger.warn(`Failed to find guild for channel ${record.fromChannelId}`);
  if (!toGuild[0]) logger.warn(`Failed to find guild for channel ${record.toChannelId}`);

  await ctx.database.create("bridge_message", {
    timestamp: BigInt(record.timestamp),
    from_message_id: record.fromMessageId,
    from_platform: record.fromPlatform,
    from_channel_id: record.fromChannelId,
    from_guild_id: fromGuildId,
    from_sender_id: record.fromSenderId,
    from_sender_name: record.fromSenderName,
    to_message_id: record.toMessageId,
    to_platform: record.toPlatform,
    to_channel_id: record.toChannelId,
    to_guild_id: toGuildId,
    onebot_real_message_id: record.onebotRealMessageId,
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const detail = error as Error & { response?: { data?: unknown }, data?: unknown, retcode?: unknown, code?: unknown };
    const response = detail.response?.data ?? detail.data;
    const metadata = [detail.retcode, detail.code, response]
      .filter(value => value !== undefined)
      .map(value => typeof value === "string" ? value : JSON.stringify(value))
      .join(" | ");
    return `${error.stack ?? error.message}${metadata ? ` | ${metadata}` : ""}`;
  }

  return typeof error === "string" ? error : JSON.stringify(error);
}

function isNonRetryableQQError(error: unknown): boolean {
  const detail = formatError(error).toLowerCase();
  return /(?:retcode|code)[^\d]*(?:120|10003|10004)|风控|risk control|permission denied|权限不足|not support/.test(detail);
}

export async function sendQQMessageWithRetry(qqbot: Bot, channelId: string, message: string, maxAttempts = 3): Promise<string[] | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const messageIds = await qqbot.sendMessage(channelId, message);
      logger.debug(`Sent QQ message to ${qqbot.sid}:${channelId}; message IDs: ${messageIds.join(", ")}.`);
      return messageIds;
    } catch (error) {
      const errorDetail = formatError(error);
      if (isNonRetryableQQError(error) || attempt >= maxAttempts) {
        logger.error(`Failed to send QQ message to ${qqbot.sid}:${channelId} after ${attempt}/${maxAttempts} attempt(s): ${errorDetail}`);
        return null;
      }

      logger.info(`发送消息失败，正在重试... (${attempt}/${maxAttempts})`);
      const delay = 1000 * 2 ** (attempt - 1);
      logger.warn(`Retrying QQ message to ${qqbot.sid}:${channelId} in ${delay}ms.`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return null;
}

export async function findDiscordToQQBot(ctx: Context, config: Config, fromChannelId: string, toChannelId: string): Promise<Bot | null> {
  for (const constant of config.constant ?? []) {
    if (!constant.enable) continue;

    for (const from of constant.from) {
      if (from.platform !== "discord") continue;

      for (const to of constant.to) {
        if (to.platform === "onebot" && to.channel_id === toChannelId) {
          const dcBot = ctx.bots[`discord:${from.self_id}`];
          let channel;
          try {
            channel = await dcBot.internal.getChannel(fromChannelId);
          } catch (error) {
            logger.error(error);
            continue;
          }
          const channelType = Number(channel.type);
          if (channelType === 12) continue;
          if (from.channel_id === fromChannelId) return ctx.bots[`${to.platform}:${to.self_id}`];
          if ([10, 11].includes(channelType) && channel.parent_id === from.channel_id) {
            return ctx.bots[`${to.platform}:${to.self_id}`];
          }
        }
      }
    }
  }

  return null;
}
