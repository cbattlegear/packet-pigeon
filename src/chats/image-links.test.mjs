import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageLinkParts } from './image-links.ts'

test('recognizes HTTPS images and GIFs without changing surrounding text or URL parameters', () => {
  const text = 'Look (https://images.example/a(b).GIF?token=123#frame), then https://images.example/photo.PNG!'
  const parts = imageLinkParts(text)
  assert.deepEqual(parts.filter((part) => part.kind === 'image').map((part) => part.url), [
    'https://images.example/a(b).GIF?token=123#frame', 'https://images.example/photo.PNG',
  ])
  assert.equal(parts.map((part) => part.kind === 'image' ? part.url : part.text).join(''), text)
  for (const extension of ['avif', 'bmp', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']) {
    assert.equal(imageLinkParts(`https://images.example/photo.${extension}`)[0].kind, 'image')
  }
})

test('does not probe ordinary links, insecure URLs, credentials, or image-like non-image paths', () => {
  const text = [
    'Plain message', 'https://example.com/article', 'https://example.com/movie.mp4',
    'http://example.com/photo.png', 'https://example.com/photo.png/page',
    'https://example.com/article?image=photo.png', 'https://user:password@example.com/photo.png',
    'https://[invalid]/photo.png', 'https://example.com/download',
  ].join('\n')
  assert.deepEqual(imageLinkParts(text), [{ kind: 'text', text }])
})
