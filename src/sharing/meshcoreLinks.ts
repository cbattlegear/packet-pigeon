export type ContactType = 1 | 2 | 3 | 4

export type ContactShare = {
  kind: 'contact'
  name: string
  publicKey: string
  type: ContactType
}

export type ChannelShare = {
  kind: 'channel'
  name: string
  secret: string
  regionScope?: string
}

export type MeshCoreShare = ContactShare | ChannelShare

function readName(name: string): string {
  if (!name.trim() || name.includes('\0')) throw new Error('The share link needs a valid name.')
  return name
}

function readPublicKey(publicKey: string): string {
  if (publicKey.length !== 64 || !/^[a-f0-9]{64}$/i.test(publicKey)) {
    throw new Error('The contact public key must contain 64 hex characters.')
  }
  return publicKey.toLowerCase()
}

function readChannelSecret(secret: string): string {
  if (secret.length !== 32 || !/^[a-f0-9]{32}$/i.test(secret)) {
    throw new Error('The channel secret must contain 32 hex characters.')
  }
  return secret.toLowerCase()
}

function readContactType(type: string): ContactType {
  switch (type) {
    case '1': return 1
    case '2': return 2
    case '3': return 3
    case '4': return 4
    default: throw new Error('The contact type is unsupported.')
  }
}

function readParameter(parameters: URLSearchParams, key: string): string | undefined {
  const values = parameters.getAll(key)
  if (values.length > 1) throw new Error('The share link repeats a field.')
  return values[0]
}

export function formatMeshCoreShare(share: MeshCoreShare): string {
  const parameters = new URLSearchParams({ name: readName(share.name) })
  if (share.kind === 'contact') {
    parameters.set('public_key', readPublicKey(share.publicKey))
    parameters.set('type', String(readContactType(String(share.type))))
  } else {
    parameters.set('secret', readChannelSecret(share.secret))
    if (share.regionScope) parameters.set('region_scope', share.regionScope)
  }
  return `meshcore://${share.kind}/add?${parameters}`
}

export function contactShareLink(name: string, publicKey: string, type: number | undefined) {
  if (type !== 1 && type !== 2 && type !== 3 && type !== 4) return null
  if (publicKey.length !== 64 || !/^[\da-f]+$/i.test(publicKey)) return null
  return formatMeshCoreShare({ kind: 'contact', name: name.trim() || 'Unnamed contact', publicKey, type })
}

export function parseMeshCoreShare(input: string): MeshCoreShare {
  const invalidLink = 'Enter a MeshCore contact or channel share link.'
  const text = input.trim()
  if (text.length > 4096 || /[\r\n\t]/.test(text)) throw new Error(invalidLink)

  const url = URL.parse(text)
  if (
    !url || url.protocol !== 'meshcore:' || url.pathname !== '/add' ||
    url.username || url.password || url.port || url.hash ||
    (url.hostname !== 'contact' && url.hostname !== 'channel')
  ) {
    throw new Error(invalidLink)
  }

  // URLSearchParams tolerates broken percent escapes and substitutes invalid UTF-8.
  try {
    decodeURIComponent(url.search)
  } catch {
    throw new Error('The share link contains invalid URL encoding.')
  }

  const name = readName(readParameter(url.searchParams, 'name') ?? '')
  if (url.hostname === 'contact') {
    return {
      kind: 'contact',
      name,
      publicKey: readPublicKey(readParameter(url.searchParams, 'public_key') ?? ''),
      type: readContactType(readParameter(url.searchParams, 'type') ?? ''),
    }
  }

  const secret = readChannelSecret(readParameter(url.searchParams, 'secret') ?? '')
  const regionScope = readParameter(url.searchParams, 'region_scope')
  return regionScope ? { kind: 'channel', name, secret, regionScope } : { kind: 'channel', name, secret }
}
