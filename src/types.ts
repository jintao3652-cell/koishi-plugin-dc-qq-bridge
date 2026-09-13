export interface MessageBody {
  // 消息正文
  text: string,

  // 存放图片等文件的表单数据
  form: FormData,

  // 当前表单数据内的文件数量
  n: number,

  // 存放 Discord 的 Embed 消息
  embed: Array<object>,

  // Discord 原生回复的消息引用
  reply: object | null,

  // 当前消息体是否存在可发送的元素
  validElement: boolean,

  // 当前消息体是否存在文件
  hasFile: boolean

  // 是否 @everyone
  mentionEveryone: boolean,

  // Discord 原生语音消息。语音必须独占一条消息发送，不能与正文或其他附件混发。
  voices: DiscordVoice[]
}

export interface DiscordVoice {
  blob: Blob,
  filename: string,
  contentType: string,
  duration: number,
}
