import type { CompanionSession } from '../radio/companion-session.ts'
import { makeChannelSecret, secretHex } from '../radio/channel-commands.ts'
import type { ChannelShare } from './meshcoreLinks.ts'

export async function importSharedChannel(session: CompanionSession, radioKey: string, channel: ChannelShare) {
  const kind = channel.name.startsWith('#') ? 'hashtag' : 'join'
  if (kind === 'hashtag' && secretHex(await makeChannelSecret(kind, channel.name, '')) !== channel.secret) {
    throw new Error('The hashtag channel key does not match its name.')
  }
  await session.createChannel(radioKey, { kind, name: channel.name, secret: channel.secret })
}
