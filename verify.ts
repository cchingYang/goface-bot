import { createHmac } from 'crypto'

export async function verifySlackSignature(
  rawBody: string,
  signature: string,
  timestamp: string
): Promise<boolean> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET || ''

  // 防止 replay attack（5分鐘內有效）
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false
  }

  const baseString = `v0:${timestamp}:${rawBody}`
  const hmac = createHmac('sha256', signingSecret)
  hmac.update(baseString)
  const computedSignature = `v0=${hmac.digest('hex')}`

  return computedSignature === signature
}
