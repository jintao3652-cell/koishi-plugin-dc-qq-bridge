import { Schema } from 'koishi';

export interface Constant {
  enable: boolean,
  note: string,
  from: Array<BasicType>,
  to: Array<BasicType>
}

export interface BasicType {
  platform: string,
  channel_id: string,
  self_id: string
}

export interface Config {
  debug: boolean,
  discord_app_id: string,
  file_processor: "Koishi" | "QQBot",
  sync_edit_delete: boolean,
  download_threads: number,
  qq_file_limit: number,
  discord_file_limit: number,
  forward_group_announcements: boolean,
  announcement_poll_interval: number,
  constant?: Array<Constant>
};

declare module "koishi" {
  interface Tables {
    bridge_message: BridgeMessage
  }
}

export interface BridgeMessage {
  id: number,
  timestamp: bigint,
  from_message_id: string,
  from_platform: string,
  from_channel_id: string,
  from_guild_id: string,
  from_sender_id: string,
  from_sender_name: string,
  to_message_id: string,
  to_platform: string,
  to_channel_id: string,
  to_guild_id: string,
  onebot_real_message_id: string
}

export const Config: Schema<Config> = Schema.object({
  debug: Schema.boolean().description("开启 Debug 模式").default(false),

  discord_app_id: Schema.string().description("基础设置：指定 DC 机器人 APP ID（Discord 应用程序 ID / 机器人账号 ID）。存在多个 Discord 机器人时，桥接仅处理该机器人收到的消息，避免与 X 转发等插件的机器人冲突。留空则不限制").default(""),

  file_processor: Schema.union([
    Schema.const("Koishi").description("Koishi downloads Discord media and sends an inline data URL. Recommended when QQ cannot access Discord."),
    Schema.const("QQBot").description("Passes the original Discord media URL to the OneBot/QQ client. Use when the QQ client can access Discord directly.")
  ]).default("Koishi").description("将由哪个平台处理文件（对于 Discord -> QQ 来说，建议使用可以访问 Discord 的平台处理，通常为 Koishi）"),

  sync_edit_delete: Schema.boolean().description("同步消息的编辑和删除").default(false),

  download_threads: Schema.number().description("下载文件时的默认线程数").default(4),
  qq_file_limit: Schema.number().description("QQ 文件上传大小上限，单位为字节").default(20971520),
  discord_file_limit: Schema.number().description("Discord 文件上传大小上限，单位为字节（该选项不宜设置太高，避免超过 Discord 本身的限制）").default(10485760),

  forward_group_announcements: Schema.boolean().description("是否将 QQ 群公告转发至 Discord；关闭后不会轮询 OneBot 的群公告接口。").default(true),
  announcement_poll_interval: Schema.number().min(10).description("QQ group-announcement polling interval, in seconds.").default(30),

  constant: Schema.array(Schema.object({
    enable: Schema.boolean().description("启用").default(true),
    note: Schema.string().description("备注"),
    from: Schema.array(Schema.object({
      platform: Schema.string().description("来源平台"),
      channel_id: Schema.string().description("频道ID"),
      self_id: Schema.string().description("自身ID")
    })),
    to: Schema.array(Schema.object({
      platform: Schema.string().description("目标平台"),
      channel_id: Schema.string().description("频道ID"),
      self_id: Schema.string().description("自身ID")
    }))
  }).collapse())
});
