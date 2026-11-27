export const primarySections = ['Chats', 'Contacts', 'Channels', 'Map'] as const
export const secondarySections = ['Discovery', 'Tools', 'Diagnostics', 'Settings'] as const
export const sections = [...primarySections, ...secondarySections] as const
export type Section = typeof sections[number]
