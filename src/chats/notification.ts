import { conversations, possibleRepeats } from './model.ts'
import { channelTextParts } from './mentions.ts'
import type { RadioData, StoredMessage } from '../storage/index.ts'

export function messageAlert(data: RadioData, message: StoredMessage, ownName: string) {
  if (!message.receipt || message.receipt.kind === 'channel-data'
    || data.readMessages?.includes(message.id) || possibleRepeats(data.messages).has(message.id)) return null
  const conversation = conversations(data).find((item) => item.messages.some((entry) => entry.id === message.id))
  if (!conversation) return null
  if (conversation.id.startsWith('direct:') && data.mutedDirectConversations?.includes(conversation.id.slice(0, 19))) return null
  if (message.receipt.kind === 'channel-text') {
    const index = message.receipt.channelIndex
    const channel = data.channels.find((entry) => entry.index === index)
    if (!channel) return null
    const setting = data.channelNotifications?.find((entry) => entry.index === channel.index)
    if (setting && (setting.paused || setting.channelName !== channel.name || setting.mode === 'muted')) return null
    if (setting?.mode === 'mentions' && (!ownName || !channelTextParts(message.text)
      .some((part) => part.kind === 'mention' && part.name === ownName))) return null
  }
  return { conversationId: conversation.id, title: conversation.title }
}
