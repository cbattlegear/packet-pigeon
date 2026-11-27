import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageLinkParts } from './image-links.ts'

test('recognizes HTTPS images and GIFs without changing surrounding text or URL parameters', () => {
  const text = 'Look (https://images.example/a(b).GIF?token=123#frame), then https://images.example/photo.PNG!'
  const parts = imageLinkParts(text)
  assert.deepEqual(parts.filter((part) => part.kind === 'image').map((part) => part.url), [
    'https://images.example/a(b).GIF?token=123#frame', 'https://images.example/photo.PNG',
  ])
  assert.equal(parts.map((part) => part.kind === 'text' ? part.text : part.url).join(''), text)
  for (const extension of ['avif', 'bmp', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']) {
    assert.equal(imageLinkParts(`https://images.example/photo.${extension}`)[0].kind, 'image')
  }
})

test('marks ordinary HTTPS links for manual loading, without treating insecure or invalid URLs as links', () => {
  const text = [
    'Plain message', 'https://example.com/article', 'https://example.com/movie.mp4',
    'http://example.com/photo.png', 'https://example.com/photo.png/page',
    'https://example.com/article?image=photo.png', 'https://user:password@example.com/photo.png',
    'https://[invalid]/photo.png', 'https://example.com/download',
  ].join('\n')
  const parts = imageLinkParts(text)
  assert.deepEqual(parts.filter((part) => part.kind === 'link').map((part) => part.url), [
    'https://example.com/article', 'https://example.com/movie.mp4',
    'https://example.com/photo.png/page', 'https://example.com/article?image=photo.png',
    'https://example.com/download',
  ])
  assert.equal(parts.some((part) => part.kind === 'image'), false)
  assert.equal(parts.map((part) => part.kind === 'text' ? part.text : part.url).join(''), text)
})
