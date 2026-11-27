import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildReaction, dartStringHash, isReactionEmoji, messageReactionHash, openReactionHash, parseReaction, reactionChannelContent } from './reactions.ts'

test('MeshCore hashes and wire envelopes agree with independent protocol vectors', async () => {
  for (const [text, timestamp, hash] of [
    ['Hello', 1704067200, 'b45pc4ek'],
    ["What's the situation at Main St today?", 1704067200, '3pe3nahw'],
    ['ok', 1704067200, 'zgya0xt2'], ['', 0, 'vwzp3604'],
    ['caf\u00e9', 1, 'zrgd9q90'], ['cafe\u0301', 1, 'vat3s086'],
    ['🎉abc', 2147483649, '5ttb578g'], ['漢字', 4294967295, 'tbz38qvw'],
  ]) assert.equal(await messageReactionHash(text, timestamp), hash)
  assert.equal(await buildReaction('👍', "What's the situation at Main St today?", 1704067200, 'AlphaNode'),
    '@[AlphaNode]👍\n3pe3nahw')
  assert.equal(await buildReaction('❤️', 'ok', 1704067200, null), '❤️\nzgya0xt2')
  await assert.rejects(buildReaction('👍', 'ok', 1, 'Bad]name'), /sender name/)
  assert.throws(() => messageReactionHash('ok', 4294967296), /timestamp/)
})

test('native parser handles both channel orders, Crockford aliases, and grapheme delimiters', () => {
  for (const wire of ['@[Node]👍\nOOIILL00', '👍@[Node]\nOOIILL00']) {
    assert.deepEqual(parseReaction(wire, true),
      { format: 'meshcore', emoji: '👍', hash: '00111100', targetSender: 'Node' })
    assert.equal(parseReaction(wire, false), null)
  }
  for (const emoji of ['👍', '❤️', '👍🏽', '🇺🇸', '👨‍👩‍👧', '1️⃣', '#\u0301', '😀‍', '🏽']) {
    assert.equal(isReactionEmoji(emoji), true, emoji)
    assert.equal(parseReaction(`${emoji}\nABCDEFGH`, false)?.emoji, emoji)
  }
  for (const emoji of ['', '1', '#', '©', 'hello', '👍👍', '🎉 on my way', '👍‍‍👍']) {
    assert.equal(isReactionEmoji(emoji), false, emoji)
    assert.equal(parseReaction(`${emoji}\nabcdefgh`, false), null)
  }
  for (const wire of ['👍\r\nabcdefgh', '@[]👍\nabcdefgh', '@\u0301[Node]👍\nabcdefgh',
    '@[Node]\u0301👍\nabcdefgh', '@[Node]👍\nuuuuuuuu', '@[Node]👍\nabcde']) {
    assert.equal(parseReaction(wire, true), null, wire)
  }
  assert.deepEqual(reactionChannelContent(' Alice :  hello \nworld\u200b'),
    { sender: 'Alice', text: 'hello \nworld' })
  assert.deepEqual(reactionChannelContent('A:B: hello'), { sender: 'A', text: 'B: hello' })
})

test('Open v1/v3 receive formats and Dart UTF-16 hashing match protocol vectors', () => {
  assert.equal(dartStringHash('hello'), 150804507)
  assert.equal(dartStringHash('a'), 170824770)
  assert.equal(dartStringHash('TestNode'), 305741885)
  assert.equal(dartStringHash('Hello from mesh'), 657738659)
  assert.equal(dartStringHash('AVN1'), 690979482)
  assert.equal(dartStringHash('Test message content'), 539648391)
  assert.deepEqual(parseReaction('r:1772600903000_690979482_539648391:👍', true), {
    format: 'open-v1', timestamp: 1772600903, senderHash: 690979482, textHash: 539648391, emoji: '👍',
  })
  for (const [index, emoji] of [['00', '👍'], ['05', '🔥'], ['06', '😀'], ['45', '😶'], ['46', '👍'],
    ['66', '💪'], ['67', '❤️'], ['87', '🎉'], ['b7', '🚀']]) {
    assert.deepEqual(parseReaction(`r:a1b2:${index}`, false), { format: 'open-v3', hash: 'a1b2', emoji })
  }
  for (const wire of ['r:A1B2:00', 'r:a1b2:0A', 'r:aaaa:b8', 'r:1700000000000_1_2:', 'r:4294967296000_1_2:👍',
    'r:0_4294967296_0:👍', 'r:0_1_2:👍:oops', 'r\u0301:aaaa:00']) assert.equal(parseReaction(wire, true), null)
  assert.equal(openReactionHash('🎉abcdef', 1700000000, null), openReactionHash('🎉abc', 1700000000, null))
  assert.equal(openReactionHash('abcd🎉', 1700000000, null),
    (dartStringHash('1700000000abcd\ud83c') & 0xffff).toString(16).padStart(4, '0'))
})
