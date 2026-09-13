import { Buffer } from "buffer";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Logger, HTTP } from "koishi";
import { MessageBody } from "./types";
import type { DiscordVoice } from "./types";
import ffmpegPath from "ffmpeg-static";

export const logger = new Logger("bridge");
export const blacklistFile = resolve(process.cwd(), "data", "dc-qq-bridge", "blacklist.json");
export const announcementStateFile = resolve(process.cwd(), "data", "dc-qq-bridge", "announcement-state.json");

let cachedBlacklist: string[] = [];
let blacklistMtime = -1;
let blacklistLastCheck = 0;

export async function loadBlacklistWords(): Promise<string[]> {
  const now = Date.now();
  if (now - blacklistLastCheck < 2000) return cachedBlacklist;
  blacklistLastCheck = now;

  try {
    const fileStat = await stat(blacklistFile);
    if (fileStat.mtimeMs === blacklistMtime) return cachedBlacklist;

    const data: unknown = JSON.parse(await readFile(blacklistFile, "utf8"));
    if (!Array.isArray(data) || data.some(word => typeof word !== "string")) {
      throw new TypeError("The blacklist JSON must be an array of strings.");
    }

    cachedBlacklist = data.map(word => word.trim()).filter(Boolean);
    blacklistMtime = fileStat.mtimeMs;
    logger.info(`Loaded ${cachedBlacklist.length} blacklist word(s) from ${blacklistFile}.`);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      await mkdir(dirname(blacklistFile), { recursive: true });
      await writeFile(blacklistFile, "[]\n", "utf8");
      cachedBlacklist = [];
      blacklistMtime = (await stat(blacklistFile)).mtimeMs;
      logger.info(`Created blacklist file at ${blacklistFile}.`);
      return cachedBlacklist;
    }

    logger.error(`Failed to load blacklist file ${blacklistFile}: ${error}`);
  }

  return cachedBlacklist;
}
export function convertMsTimestampToISO8601(msTimestamp: number): string {
  // 创建一个 Date 对象，传入毫秒级的时间戳
  const date = new Date(msTimestamp);

  // 使用 .toISOString() 方法转换为 ISO 8601 格式
  // 注意：此方法返回的是 UTC 时间
  return date.toISOString();
}

export function generateMessageBody(): MessageBody {
  return {
    text: "",
    form: new FormData(),
    n: 0,
    embed: [],
    reply: null,
    validElement: false,
    hasFile: false,
    mentionEveryone: false,
    voices: [],
  };
}

export async function transcodeToDiscordVoice(input: Blob): Promise<DiscordVoice> {
  if (!ffmpegPath) throw new Error("ffmpeg-static did not provide an executable path.");

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-vn",
    "-c:a", "libopus",
    "-b:a", "64k",
    "-vbr", "on",
    "-application", "voip",
    "-f", "ogg",
    "-progress", "pipe:2",
    "pipe:1",
  ];

  const source = Buffer.from(await input.arrayBuffer());
  return await new Promise<DiscordVoice>((resolvePromise, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const output: Buffer[] = [];
    let progress = "";

    child.stdout.on("data", chunk => output.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => progress += chunk.toString());
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`FFmpeg voice conversion failed with exit code ${code}: ${progress.trim()}`));
        return;
      }

      const values = [...progress.matchAll(/out_time_(?:us|ms)=(\d+)/g)].map(match => Number(match[1]));
      const duration = values.length ? Math.max(0.01, values.at(-1)! / 1_000_000) : 0.01;
      const encoded = Buffer.concat(output);
      const encodedBytes = new Uint8Array(encoded.byteLength);
      encodedBytes.set(encoded);
      resolvePromise({
        blob: new Blob([encodedBytes.buffer], { type: "audio/ogg" }),
        filename: `voice-${Date.now()}.ogg`,
        contentType: "audio/ogg",
        duration,
      });
    });

    child.stdin.end(source);
  });
}

export function toDataUrl(data: ArrayBuffer | Uint8Array, type?: string | null): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return `data:${type ?? ""};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function getDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export async function getBinary(url: string, http: HTTP): Promise<[Blob, string, string]> {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    }

    // const response = await fetch(url, {
    //   method: "GET",
    //   headers,
    // });

    const response = await http(url, {
      method: "GET",
      headers,
    });
    if (response.status !== 200) {
      throw new Error(`Request Error! URL: ${url} | Status: ${response.status} | Response: ${response.data}`);
    }
    const blob = new Blob([response.data], { type: response.headers.get("Content-Type") });
    return [blob, response.headers.get("Content-Type"), null];
  } catch (error) {
    return [null, null, error];
  }
}

export class BlacklistDetector {
  private blacklist: string[];

  constructor(blacklist: string[]) {
    this.blacklist = blacklist;
  }

  public check(input: string): boolean {
    for (const word of this.blacklist) {
      if (input.toLowerCase().indexOf(word.toLowerCase()) !== -1) return true;
    }
    return false;
  }
}
