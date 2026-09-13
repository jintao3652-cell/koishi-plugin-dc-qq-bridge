import { Bot, Context, h } from "koishi";
import type { Session } from "koishi";
import { getBinary, logger, BlacklistDetector, toDataUrl } from "../utils";
import { Config, BasicType } from "../config";

import { URL } from "url";

async function resolveMediaUrl(url: string, config: Config, ctx: Context): Promise<string> {
	if (config.file_processor !== "Koishi") return url;

	const [blob, type, error] = await getBinary(url, ctx.http);
	if (error) {
		logger.warn(`Koishi failed to download Discord media; falling back to the QQBot URL. ${error}`);
		return url;
	}

	return toDataUrl(await blob.arrayBuffer(), type);
}

// return stop = false 相当于 break

export default class ProcessorDiscord {
	static formatEmbeds(embeds: any[]): string {
		const blocks: string[] = [];
		for (const embed of embeds ?? []) {
			const lines: string[] = [];
			if (embed.author?.name) {
				lines.push(`作者：${embed.author.name}${embed.author.url ? `\n${embed.author.url}` : ""}`);
			}
			if (embed.title) lines.push(`标题：${embed.title}`);
			if (embed.url) lines.push(`链接：${embed.url}`);
			if (embed.description) lines.push(String(embed.description));
			for (const field of embed.fields ?? []) {
				const name = String(field?.name ?? "字段").trim() || "字段";
				const value = String(field?.value ?? "").trim();
				if (value) lines.push(`【${name}】\n${value}`);
			}
			if (embed.footer?.text) lines.push(`页脚：${embed.footer.text}`);
			if (embed.timestamp) {
				const timestamp = new Date(embed.timestamp);
				if (!Number.isNaN(timestamp.valueOf())) {
					lines.push(`时间：${timestamp.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
				}
			}
			if (lines.length) blocks.push(`【Discord Embed】\n${lines.join("\n")}`);
		}
		return blocks.join("\n\n");
	}

	static async process(
		elements: h[],
		config: Config,
		[from, to]: [BasicType, BasicType],
		ctx: Context,
		message: string,
		message_data: Session["event"]["message"],
		dc_bot: Bot,
		qqbot: Bot,
		Blacklist: BlacklistDetector,
		discordEmbeds: any[] = [],
	): Promise<string> {
		for (const element of elements.length === 0 ? message_data.quote.elements : elements) {
			switch (element.type) {
				case "text": {
					if (Blacklist.check(element.attrs.content)) return ""; // 黑名单检测

					message += element.attrs.content;

					break;
				}

				case "at": {
					// https://github.com/Cola-Ace/koishi-plugin-bridge-discord-qq/issues/4
					if (element.attrs.type === "all") {
						message += "@everyone ";
						break;
					}

					// https://github.com/Cola-Ace/koishi-plugin-bridge-discord-qq/issues/5
					if (element.attrs.type === "here") {
						message += "@here ";
						break;
					}

					const user_info = await dc_bot.internal.getUser(element.attrs.id);
					message += `@${user_info["global_name"] === null ? element.attrs.name : user_info["global_name"]}`;

					break;
				}

				case "sharp": {
					// Discord channel mentions are decoded by the adapter as `sharp`
					// elements (the textual form is `<#channel-id>`).  QQ does not
					// understand that Discord markup, so preserve the visible channel
					// name instead of silently dropping the element.
					message += `#${element.attrs.name || element.attrs.id || ""}`;

					break;
				}

				case "https:": {
					message += `https:${Object.keys(element.attrs).join("=")}`;

					break;
				}

				case "img": {
					message += h.image(await resolveMediaUrl(element.attrs.src, config, ctx));

					break;
				}

				case "face": {
					const src = element.children[0].attrs.src;
          const url = `${src}${src.indexOf("?quality=lossless") !== -1 ? "&size=44" : ""}`

					message += h.image(await resolveMediaUrl(url, config, ctx));

					break;
				}

				case "record":
				case "audio": {
					// Audio attachments must remain audio messages.  Uploading them
					// through uploadGroupFile turns them into ordinary files and QQ
					// clients will not play them as voice.  Keep the audio element in
					// the outgoing message so the OneBot encoder can transcode/send it.
					if (element.attrs.size && parseInt(element.attrs.size) > config.qq_file_limit) {
						message += "【检测到语音大小超过设置上限，请到 Discord 查看】";
						break;
					}
					message += h("audio", {
						src: await resolveMediaUrl(element.attrs.src, config, ctx),
						file: element.attrs.file,
						type: element.attrs.type,
					}).toString();

					break;
				}

				case "file": {
					if (parseInt(element.attrs.size) > config.qq_file_limit) {
						message += "【检测到大小超过设置上限的文件，请到 Discord 查看】";
						break;
					}
					try {
						const path = await qqbot.internal.downloadFile(element.attrs.src);
						await qqbot.internal.uploadGroupFile(to.channel_id, path, element.attrs.file);
					} catch (error) {
						logger.error(`Failed to transfer Discord file to QQ group ${to.channel_id}: ${error}`);
					}

					break;
				}

				case "video": {
					if (parseInt(element.attrs.size) > config.qq_file_limit) {
						message += "【检测到大小超过设置上限的视频，请到 Discord 查看】";
						break;
					}

					try {
						const urlHost = new URL(element.attrs.src).host;
						const allowedHosts = ["youtube.com", "www.youtube.com"];
						if (allowedHosts.includes(urlHost)) break;
					} catch (error) {
						logger.error(`Invalid URL: ${element.attrs.src}`);
						break;
					}

					message += h.video(await resolveMediaUrl(element.attrs.src, config, ctx));

					break;
				}

				default: {
					break;
				}
			}
		}

		const embedText = this.formatEmbeds(discordEmbeds);
		if (embedText && !Blacklist.check(embedText)) {
			message += `${message && !message.endsWith("\n") ? "\n\n" : ""}${embedText}`;
		}

		return message;
	}
}
