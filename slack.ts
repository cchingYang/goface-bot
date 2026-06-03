import { WebClient } from '@slack/web-api'

const slack = new WebClient(process.env.SLACK_BOT_TOKEN)

export async function replyToSlack(
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  await slack.chat.postMessage({
    channel,
    thread_ts: threadTs, // 回覆在同一個 thread
    text,
    mrkdwn: true,
  })
}
