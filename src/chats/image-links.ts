export type ImageLinkPart = { kind: 'text'; text: string } | { kind: 'image'; url: string }

export function imageLinkParts(text: string): ImageLinkPart[] {
  const parts: ImageLinkPart[] = []
  let end = 0
  for (const match of text.matchAll(/\bhttps:\/\/[^\s<>"']+/gu)) {
    let url = match[0].replace(/[.,!;:]+$/u, '')
    // Leave surrounding prose punctuation outside the link, but keep balanced URL parentheses.
    while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1)
    url = url.replace(/[\]}]+$/u, '')
    try {
      const parsed = new URL(url)
      if (!parsed.hostname || parsed.username || parsed.password
        || !/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu.test(parsed.pathname)) continue
    } catch {
      continue
    }
    if (match.index > end) parts.push({ kind: 'text', text: text.slice(end, match.index) })
    parts.push({ kind: 'image', url })
    end = match.index + url.length
  }
  if (end < text.length) parts.push({ kind: 'text', text: text.slice(end) })
  return parts
}
