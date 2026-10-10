// @ts-nocheck
import { Context, h, Session } from "koishi";
import { } from "koishi-plugin-adapter-onebot";
import { Config, BasicType } from "./config";

export * from "./config";
import { MessageBody } from "./types";
import { createBridgeMessageRecord, findBridgeRoutes, isBridgeableDiscordChannelMessage, resolveDiscordRouteChannel, sendQQMessageWithRetry } from "./bridge";
import { announcementStateFile, logger, BlacklistDetector, generateMessageBody, loadBlacklistWords } from "./utils";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import ProcessorQQ from "./qq";
import { getWebhook } from "./discord/webhook";
import ProcessorDiscord from "./discord";
import onDiscordMessageDeleted from "./discord/message/delete";
import onDiscordMessageUpdated from "./discord/message/update";

export const name = "bridge-qq-discord";

export const inject = ["database"];

const MESSAGE_REORDER_WINDOW = 350;
let messageSequence = 0;

interface OrderedMessageTask {
  timestamp: number;
  sequence: number;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface OrderedMessageQueue {
  pending: OrderedMessageTask[];
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
}

const orderedMessageQueues = new Map<string, OrderedMessageQueue>();

function getServerMessageTimestamp(session: Session): number {
  const raw = Number(session.event.message?.createdAt ?? session.timestamp ?? Date.now());
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  return raw < 1_000_000_000_000 ? raw * 1000 : Math.trunc(raw);
}

function enqueueOrderedMessage(key: string, timestamp: number, run: () => Promise<void>): Promise<void> {
  let queue = orderedMessageQueues.get(key);
  if (!queue) {
    queue = { pending: [], running: false };
    orderedMessageQueues.set(key, queue);
  }

  return new Promise<void>((resolve, reject) => {
    queue!.pending.push({ timestamp, sequence: messageSequence++, run, resolve, reject });
    if (queue!.timer || queue!.running) return;
    queue!.timer = setTimeout(() => {
      queue!.timer = undefined;
      void flushOrderedMessages(key, queue!);
    }, MESSAGE_REORDER_WINDOW);
  });
}

async function flushOrderedMessages(key: string, queue: OrderedMessageQueue) {
  if (queue.running) return;
  queue.running = true;
  try {
    while (queue.pending.length) {
      const batch = queue.pending.splice(0).sort((left, right) =>
        left.timestamp - right.timestamp || left.sequence - right.sequence);
      for (const task of batch) {
        try {
          await task.run();
          task.resolve();
        } catch (error) {
          task.reject(error);
        }
      }
      if (queue.pending.length) {
        await new Promise(resolve => setTimeout(resolve, MESSAGE_REORDER_WINDOW));
      }
    }
  } finally {
    queue.running = false;
    if (!queue.pending.length) orderedMessageQueues.delete(key);
  }
}

function getInitialNickname(session: Session, sender) {
  if (sender.isBot) return sender.name;

  return "member" in session.event ? session.event.member.nick : sender.name;
}

function shouldIgnoreMessage(session: Session, sender) {
  if (!sender) return true;
  if (sender.id === session.bot.selfId) return true;

  const pattern = /\[QQ:\d+\]/;
  return pattern.test(sender.name ?? "[QQ:10000]");
}

// 基础设置：指定 DC 机器人 APP ID 后，仅处理该机器人收到的事件，
// 避免多个 Discord 机器人并存时与 X 转发等插件互相冲突。
function isOwnedDiscordBot(config: Config, session: Session): boolean {
  if (session.platform !== "discord") return true;
  if (!config.discord_app_id) return true;
  return session.selfId === config.discord_app_id;
}

async function appendQQQuoteReply(
  ctx: Context,
  dcBot,
  messageBody: MessageBody,
  messageData,
  elements: h[],
  channelId: string,
  selfId: string,
) {
  if (!("quote" in messageData)) return true;

  // 不同平台之间回复 & 同平台之间回复
  const diffPlatformQuoteMessage = await ctx.database.get("bridge_message", {
    to_message_id: messageData.quote.id,
    to_channel_id: channelId,
  });
  const samePlatformQuoteMessage = await ctx.database.get("bridge_message", {
    from_message_id: messageData.quote.id,
    from_channel_id: channelId,
  });

  const quoteMessage = {
    type: diffPlatformQuoteMessage.length !== 0 ? "diff" : "same",
    data: diffPlatformQuoteMessage.length !== 0 ? diffPlatformQuoteMessage : samePlatformQuoteMessage,
  };

  if (quoteMessage.data.length === 0) return true;

  let source = "";

  switch (quoteMessage.type) {
    case "same": {
      source = "to";
      break;
    }
    case "diff": {
      source = "from";
      // 删除 QQ 回复时自动带上的 @
      if (elements[0]?.type === "at" && elements[0].attrs.id === selfId) {
        elements.shift();
      }
      break;
    }
    default: {
      break;
    }
  }
  if (source === "") return false;

  const dcMessage = await dcBot.getMessage(quoteMessage.data[0][`${source}_channel_id`], quoteMessage.data[0][`${source}_message_id`]);
  if (source === "from") {
    messageBody.text += `<@${dcMessage.user.id}>`;
    messageBody.validElement = true;
  }

  messageBody.reply = {
    message_id: dcMessage.id,
    channel_id: quoteMessage.data[0][`${source}_channel_id`],
    guild_id: quoteMessage.data[0][`${source}_guild_id`],
    fail_if_not_exists: false,
  };

  return true;
}

async function sendDiscordVoices(
  ctx: Context,
  webhookUrl: string,
  messageBody: MessageBody,
  sender,
  nickname: string,
  includeReply: boolean,
): Promise<string[]> {
  const messageIds: string[] = [];
  for (const voice of messageBody.voices) {
    const form = new FormData();
    form.append("files[0]", voice.blob, voice.filename);
    form.append("payload_json", JSON.stringify({
      username: `[QQ:${sender.id}] ${nickname}`,
      avatar_url: sender.avatar,
      flags: 1 << 13,
      attachments: [{
        id: 0,
        filename: voice.filename,
        duration_secs: voice.duration,
        waveform: "",
      }],
      ...(includeReply && messageBody.reply !== null
        ? { message_reference: messageBody.reply }
        : {}),
      allowed_mentions: { parse: [] },
    }));
    const response: any = await ctx.http.post(`${webhookUrl}?wait=true`, form);
    messageIds.push(response.id);
  }
  return messageIds;
}

async function handleQQToDiscord(
  ctx: Context,
  config: Config,
  session: Session,
  from: BasicType,
  to: BasicType,
  messageData,
  elements: h[],
  sender,
  nickname: string,
  platform: string,
  channelId: string,
  selfId: string,
  blacklist: BlacklistDetector,
  sourceTimestamp: number,
) {
  if (nickname === null) nickname = sender.name;

  const dcBot = ctx.bots[`discord:${to.self_id}`];
  const messageBody = generateMessageBody();
  const quoteReady = await appendQQQuoteReply(ctx, dcBot, messageBody, messageData, elements, channelId, selfId);
  if (!quoteReady) return false;

  const [stop] = await ProcessorQQ.process(elements, session, config, [from, to], ctx, messageBody, blacklist);
  if (stop || !messageBody.validElement) return false;

  if (nickname === null || nickname === "") nickname = sender.name;

  const [webhookUrl, webhookId, hasWebhook] = await getWebhook(dcBot, to.self_id, to.channel_id);
  const hasRegularMessage = Boolean(messageBody.text || messageBody.n || messageBody.embed.length);
  if (!hasRegularMessage) {
    try {
      const [voiceMessageId] = await sendDiscordVoices(ctx, webhookUrl, messageBody, sender, nickname, true);
      if (voiceMessageId) {
        await createBridgeMessageRecord(ctx, {
          timestamp: sourceTimestamp,
          fromMessageId: messageData.id,
          fromPlatform: platform,
          fromChannelId: channelId,
          fromSenderId: sender.id,
          fromSenderName: nickname,
          toMessageId: voiceMessageId,
          toPlatform: "discord",
          toChannelId: to.channel_id,
          onebotRealMessageId: messageData.id,
        });
      }
    } catch (error) {
      logger.error(error);
    } finally {
      if (!hasWebhook) await dcBot.internal.deleteWebhook(webhookId);
    }
    return true;
  }

  const payloadJson = JSON.stringify({
    content: messageBody.text,
    username: `[QQ:${sender.id}] ${nickname}`,
    avatar_url: sender.avatar,
    embeds: messageBody.embed,
    ...(messageBody.reply === null ? {} : { message_reference: messageBody.reply }),
    // https://github.com/Cola-Ace/koishi-plugin-bridge-discord-qq/issues/8
    allowed_mentions: {
      parse: messageBody.mentionEveryone ? ["everyone"] : [],
    },
  });
  messageBody.form.append("payload_json", payloadJson);

  try {
    const res = await ctx.http.post(`${webhookUrl}?wait=true`, messageBody.form);

    // 消息发送成功后才记录
    try {
      await createBridgeMessageRecord(ctx, {
        timestamp: sourceTimestamp,
        fromMessageId: messageData.id,
        fromPlatform: platform,
        fromChannelId: channelId,
        fromSenderId: sender.id,
        fromSenderName: nickname,
        toMessageId: res.id,
        toPlatform: "discord",
        toChannelId: to.channel_id,
        onebotRealMessageId: messageData.id,
      });
    } catch (error) {
      logger.error(error);
    }
  } catch (error) {
    logger.error(error);

    // 确保文件传输失败时能发送通知
    if (messageBody.hasFile) {
      for (let i = 0; i < messageBody.n; i++) {
        messageBody.form.delete(`files[${i}]`);
      }

      await ctx.http.post(`${webhookUrl}?wait=true`, messageBody.form);
    }
  }

  if (messageBody.voices.length) {
    try {
      await sendDiscordVoices(ctx, webhookUrl, messageBody, sender, nickname, false);
    } catch (error) {
      logger.error(error);
    }
  }

  if (!hasWebhook) {
    await dcBot.internal.deleteWebhook(webhookId);
  }

  return true;
}

async function resolveDiscordQuotePrefix(ctx: Context, config: Config, dcBot, messageData, elements: h[], channelId: string) {
  let message = "";
  let quotedMessageId = null;

  if ("quote" in messageData && messageData.content === "") {
    // 处理转发消息事件和标注消息事件
    const data = await dcBot.internal.getChannelMessage(channelId, messageData.id);

    if (data.type === 6) return null;

    const guildId = await dcBot.internal.getChannel(messageData.quote.channel.id);
    const quotedNick = messageData.quote.user.nick === null ? messageData.quote.user.name : messageData.quote.user.nick;

    message += `===== 转发消息 =====\nhttps://discord.com/channels/${guildId.guild_id}/${messageData.quote.channel.id}/${messageData.quote.id}\n===== 以下为转发内容 =====\n${quotedNick.indexOf("[QQ:") !== -1 ? "" : "[Discord] "}${quotedNick}:\n`;
  }

  if ("quote" in messageData && elements.length !== 0) {
    // 不同平台之间回复 & 同平台之间回复
    const diffPlatformQuoteMessage = await ctx.database.get("bridge_message", {
      to_message_id: messageData.quote.id,
      to_channel_id: messageData.quote.channel.id,
    });
    const samePlatformQuoteMessage = await ctx.database.get("bridge_message", {
      from_message_id: messageData.quote.id,
      from_channel_id: messageData.quote.channel.id,
    });

    const quoteMessage = diffPlatformQuoteMessage.length !== 0 ? diffPlatformQuoteMessage : samePlatformQuoteMessage;

    if (quoteMessage.length !== 0) {
      quotedMessageId = quoteMessage[0].onebot_real_message_id;
    }
  }

  return { message, quotedMessageId };
}

async function handleDiscordToQQ(
  ctx: Context,
  config: Config,
  session: Session,
  from: BasicType,
  to: BasicType,
  messageData,
  elements: h[],
  sender,
  nickname: string,
  platform: string,
  channelId: string,
  thread,
  blacklist: BlacklistDetector,
  sourceTimestamp: number,
) {
  const qqbot = ctx.bots[`${to.platform}:${to.self_id}`];
  const targetBotId = `${to.platform}:${to.self_id}`;
  if (!qqbot) {
    logger.error(`Cannot bridge Discord message: target bot ${targetBotId} was not found.`);
    return false;
  }
  if (!qqbot.isActive) {
    logger.warn(`Cannot bridge Discord message: target bot ${targetBotId} is not online (status: ${qqbot.status}).`);
    return false;
  }

  const dcBot = ctx.bots[`discord:${from.self_id}`];
  const quotePrefix = await resolveDiscordQuotePrefix(ctx, config, dcBot, messageData, elements, channelId);
  if (quotePrefix === null) return false;

  let { message, quotedMessageId } = quotePrefix;

  let discordEmbeds: any[] = [];
  let discordStickers: any[] = [];
  try {
    const rawMessage = await dcBot.internal.getChannelMessage(channelId, messageData.id);
    if (Array.isArray(rawMessage?.embeds)) discordEmbeds = rawMessage.embeds;
    if (Array.isArray(rawMessage?.sticker_items)) discordStickers = rawMessage.sticker_items;
  } catch (error) {
    logger.warn(`Unable to load Discord embeds/stickers for message ${messageData.id}: ${error}`);
  }

  // 处理消息元素
  message = await ProcessorDiscord.process(elements, config, [from, to], ctx, message, messageData, dcBot, qqbot, blacklist, discordEmbeds, discordStickers);
  if (!message.trim()) return false;

  // https://github.com/Cola-Ace/koishi-plugin-bridge-discord-qq/issues/6
  if (!sender.isBot) {
    const member = await dcBot.internal.getGuildMember(session.guildId, sender.id);
    nickname = member.nick === null ? member.user.global_name : member.nick;
  }

  const messageContent = `${quotedMessageId === null ? "" : h.quote(quotedMessageId)}[Discord] ${nickname}:\n${message}`;
  if (config.debug) logger.debug(`Bridging Discord message ${messageData.id} to ${targetBotId}:${to.channel_id}.`);
  const messageId = await sendQQMessageWithRetry(qqbot, to.channel_id, messageContent);
  if (messageId === null) return true;

  // Record the message mapping in the database after the message is sent successfully
  try {
    await createBridgeMessageRecord(ctx, {
      timestamp: sourceTimestamp,
      fromMessageId: messageData.id,
      fromPlatform: platform,
      fromChannelId: channelId,
      fromSenderId: sender.id,
      fromSenderName: nickname,
      toMessageId: messageId[0],
      toPlatform: "onebot",
      toChannelId: to.channel_id,
      onebotRealMessageId: messageId[0],
    });
  } catch (error) {
    logger.error(error);
  }

  return true;
}

const main = async (ctx: Context, config: Config, session: Session, sourceTimestamp: number) => {
  const sender = session.event.user;
  if (shouldIgnoreMessage(session, sender)) return;

  const platform = session.event.platform;
  const selfId = session.event.selfId;
  const channelId = session.event.channel.id;
  const messageData = session.event.message;
  const blacklist = new BlacklistDetector(await loadBlacklistWords());

  // 测试用
  if (config.debug) {
  }

  // 基础设置：仅处理指定 DC 机器人的消息，避免机器人冲突
  if (!isOwnedDiscordBot(config, session)) return;

  // 如果 message_data 不包含 id 字段，则代表该消息为 QQ 文件的占位符消息，直接跳过
  if (!(messageData && "id" in messageData)) return;
  if (platform === "discord" && !await isBridgeableDiscordChannelMessage(ctx, selfId, channelId, messageData)) return;

  let nickname = getInitialNickname(session, sender);
  const elements = messageData.elements ?? [];

  if (elements.length <= 0 && !Object.keys(messageData).includes("quote") && platform !== "discord") return;

  const routeChannel = await resolveDiscordRouteChannel(ctx, config, platform, selfId, channelId);
  const routes = findBridgeRoutes(config, platform, selfId, routeChannel.routeChannelId);

  if (config.debug && routes.length > 0) {
    logger.info("-------Message-------");
    logger.info(messageData);
    logger.info("-------Sender-------");
    logger.info(sender);
    logger.info("-------End--------");
  }

  for (const { from, to } of routes) {
    try {
      const shouldContinue = to.platform === "discord"
        ? await handleQQToDiscord(ctx, config, session, from, to, messageData, elements, sender, nickname, platform, channelId, selfId, blacklist, sourceTimestamp)
        : await handleDiscordToQQ(ctx, config, session, from, to, messageData, elements, sender, nickname, platform, channelId, routeChannel.thread, blacklist, sourceTimestamp);

      if (!shouldContinue) return;
    } catch (error) {
      logger.error(error);
    }
  }
};

interface AnnouncementState {
  initialized: Record<string, true>;
  seen: Record<string, true>;
}

async function loadAnnouncementState(): Promise<AnnouncementState> {
  try {
    const state = JSON.parse(await readFile(announcementStateFile, "utf8"));
    return {
      initialized: state?.initialized && typeof state.initialized === "object" ? state.initialized : {},
      seen: state?.seen && typeof state.seen === "object" ? state.seen : {},
    };
  } catch (error: any) {
    if (error?.code !== "ENOENT") logger.warn(`Unable to read announcement state: ${error}`);
    return { initialized: {}, seen: {} };
  }
}

async function saveAnnouncementState(state: AnnouncementState) {
  await mkdir(dirname(announcementStateFile), { recursive: true });
  await writeFile(announcementStateFile, JSON.stringify(state), "utf8");
}

function getAnnouncementText(notice: any): string {
  const title = String(notice?.title ?? "").trim();
  const text = String(notice?.message?.text ?? notice?.content ?? notice?.text ?? "").trim();
  return [title && `# ${title}`, text].filter(Boolean).join("\n\n");
}

async function forwardQQGroupAnnouncements(
  ctx: Context,
  config: Config,
  state: AnnouncementState,
  unsupportedAnnouncementBots: Set<string>,
) {
  const sourceRoutes = (config.constant ?? []).flatMap(constant => {
    if (!constant.enable) return [];
    return constant.from.flatMap(from => from.platform === "onebot"
      ? constant.to.filter(to => to.platform === "discord").map(to => ({ from, to }))
      : []);
  });

  for (const { from, to } of sourceRoutes) {
    const routeKey = `${from.self_id}:${from.channel_id}->${to.self_id}:${to.channel_id}`;
    const botKey = `onebot:${from.self_id}`;
    // Some OneBot implementations do not expose get_group_notice at all.
    // Do not retry such a capability check on every polling interval.
    if (unsupportedAnnouncementBots.has(botKey)) continue;

    const qqBot = ctx.bots[botKey];
    const getGroupNotice = qqBot?.internal?.getGroupNotice;
    if (typeof getGroupNotice !== "function") {
      unsupportedAnnouncementBots.add(botKey);
      logger.warn(`QQ group announcement polling disabled for ${botKey}: the OneBot implementation does not provide getGroupNotice().`);
      continue;
    }

    let notices: any[];
    try {
      notices = await getGroupNotice.call(qqBot.internal, from.channel_id);
    } catch (error) {
      logger.warn(`Failed to fetch QQ group announcements for ${from.channel_id}: ${error}`);
      continue;
    }

    if (!Array.isArray(notices)) continue;
    const keys = notices.map(notice => `${routeKey}:${notice?.notice_id ?? `${notice?.publish_time}:${getAnnouncementText(notice)}`}`);
    if (!state.initialized[routeKey]) {
      // Establish a baseline: existing notices must not be replayed on first startup.
      keys.forEach(key => state.seen[key] = true);
      state.initialized[routeKey] = true;
      await saveAnnouncementState(state);
      continue;
    }

    for (let index = notices.length - 1; index >= 0; index--) {
      const notice = notices[index];
      const key = keys[index];
      if (state.seen[key]) continue;
      const content = getAnnouncementText(notice);
      state.seen[key] = true;
      if (!content) continue;

      try {
        const dcBot = ctx.bots[`discord:${to.self_id}`];
        const [webhookUrl, webhookId, hasWebhook] = await getWebhook(dcBot, to.self_id, to.channel_id);
        await ctx.http.post(`${webhookUrl}?wait=true`, {
          content: `[QQ 群公告]\n${content}`,
          username: "QQ 群公告",
          allowed_mentions: { parse: [] },
        });
        if (!hasWebhook) await dcBot.internal.deleteWebhook(webhookId);
        logger.info(`Forwarded QQ group announcement from ${from.channel_id} to Discord channel ${to.channel_id}.`);
      } catch (error) {
        delete state.seen[key];
        logger.error(`Failed to forward QQ group announcement from ${from.channel_id}: ${error}`);
      }
    }
    await saveAnnouncementState(state);
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.model.extend("bridge_message", {
    id: "unsigned",
    timestamp: "bigint",
    from_message_id: "string",
    from_platform: "string",
    from_channel_id: "string",
    from_guild_id: "string",
    from_sender_id: "string",
    from_sender_name: "string",
    to_message_id: "string",
    to_platform: "string",
    to_channel_id: "string",
    to_guild_id: "string",
    onebot_real_message_id: "string",
  }, {
    primary: "id",
    autoInc: true,
  });

  ctx.on("message", async session => {
    const timestamp = getServerMessageTimestamp(session);
    const key = `${session.platform}:${session.selfId}:${session.channelId}`;
    await enqueueOrderedMessage(key, timestamp, () => main(ctx, config, session, timestamp));
  });

  // QQ group announcements are not ordinary OneBot message events. Poll the
  // notice endpoint only when the administrator has enabled announcement forwarding.
  if (config.forward_group_announcements) {
    const announcementState = loadAnnouncementState();
    const unsupportedAnnouncementBots = new Set<string>();
    let announcementPolling = false;
    const pollAnnouncements = async () => {
      if (announcementPolling) return;
      announcementPolling = true;
      try {
        await forwardQQGroupAnnouncements(ctx, config, await announcementState, unsupportedAnnouncementBots);
      } finally {
        announcementPolling = false;
      }
    };
    void pollAnnouncements();
    ctx.setInterval(pollAnnouncements, config.announcement_poll_interval * 1000);
  }

  // for Discord（同样受基础设置 APP ID 限制，避免机器人冲突）
  ctx.on("discord/message-update", async session => {
    if (!isOwnedDiscordBot(config, session)) return;
    await onDiscordMessageUpdated(ctx, config, session);
  });
  ctx.on("discord/message-delete", async session => {
    if (!isOwnedDiscordBot(config, session)) return;
    await onDiscordMessageDeleted(ctx, config, session);
  });
}
