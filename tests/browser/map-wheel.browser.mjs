import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const key = (digit) => digit.repeat(64)
const centerOf = ({ x, y, width, height }) => ({ x: x + width / 2, y: y + height / 2 })
const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y)

test('map wheel zoom stays bounded, pointer-anchored and separate from page scrolling', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.setDefaultTimeout(8000)
  await page.goto(`${server.resolvedUrls.local[0]}#map`)

  const map = page.getByRole('region', { name: 'Node and terrain map' })
  const zoomIn = map.getByTitle('Zoom in', { exact: true })
  const zoomOut = map.getByTitle('Zoom out', { exact: true })
  await page.getByText('Node data and public map', { exact: true }).click()
  await page.getByLabel('Import local or discovered nodes', { exact: true }).setInputFiles({
    name: 'nodes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify([
      { publicKey: key('a'), name: 'Anchor node', role: 2, position: { lat: 40, lon: -105 } },
      { publicKey: key('b'), name: 'Distance node', role: 2, position: { lat: 40.06, lon: -104.9 } },
    ])),
  })
  await page.getByText('2 nodes loaded.', { exact: true }).waitFor()
  await page.locator('.map-node-list').getByRole('button', { name: /^Anchor node/ }).click()
  await map.getByTitle('Anchor node', { exact: true }).waitFor()
  await map.getByTitle('Distance node', { exact: true }).waitFor()

  const markers = async () => ({
    anchor: centerOf(await map.getByTitle('Anchor node', { exact: true }).boundingBox()),
    distance: centerOf(await map.getByTitle('Distance node', { exact: true }).boundingBox()),
  })
  const before = await markers()
  await page.mouse.move(before.anchor.x, before.anchor.y)
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(80)
  const zoomed = await markers()
  assert.ok(Math.abs(zoomed.anchor.x - before.anchor.x) < 2, 'Zoomed-in anchor x stays under the pointer')
  assert.ok(Math.abs(zoomed.anchor.y - before.anchor.y) < 2, 'Zoomed-in anchor y stays under the pointer')
  assert.ok(distance(zoomed.anchor, zoomed.distance) > distance(before.anchor, before.distance) * 1.8,
    'Upward wheel motion zooms in')
  await page.locator('.map-node-detail').getByRole('heading', { name: 'Anchor node', exact: true }).waitFor()

  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(80)
  const zoomedOut = await markers()
  assert.ok(distance(zoomedOut.anchor, zoomedOut.distance) < distance(zoomed.anchor, zoomed.distance) * 0.6,
    'Downward wheel motion zooms out')

  await map.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
  })
  const mapScroll = await page.evaluate(() => window.scrollY)
  await map.evaluate((element) => {
    for (let index = 0; index < 24; index += 1) {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    }
  })
  assert.equal(await zoomIn.evaluate((element) => element.closest('a').getAttribute('aria-disabled')), 'true')
  await map.evaluate((element) => {
    for (let index = 0; index < 24; index += 1) {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    }
  })
  assert.equal(await zoomOut.evaluate((element) => element.closest('a').getAttribute('aria-disabled')), 'true')
  assert.equal(await page.evaluate(() => window.scrollY), mapScroll)

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
    await page.setViewportSize(viewport)
    await page.getByRole('button', { name: 'Fit points', exact: true }).click()
    await map.getByTitle('Distance node', { exact: true }).waitFor()
    await map.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
    const frame = await map.boundingBox()
    const pageScroll = await page.evaluate(() => window.scrollY)
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.scrollY), pageScroll, `${viewport.width}px map wheel does not scroll page`)

    const outside = await page.evaluateHandle(() => {
      const target = document.createElement('button')
      target.type = 'button'
      target.textContent = 'Outside wheel target'
      target.style.cssText = 'position:fixed;inset:auto 8px 8px auto;z-index:10000'
      document.body.append(target)
      return target
    })
    const outsideBox = await outside.asElement().boundingBox()
    const outsideWheel = page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('wheel', (event) => resolve({
        overMap: event.target instanceof Element && Boolean(event.target.closest('.node-map')),
        prevented: event.defaultPrevented,
        target: event.target instanceof Element ? `${event.target.tagName}:${event.target.textContent}` : '',
      }), { once: true })
    }))
    await page.mouse.move(outsideBox.x + 10, outsideBox.y + 10)
    await page.mouse.wheel(0, -140)
    await page.waitForTimeout(80)
    assert.deepEqual(await outsideWheel, { overMap: false, prevented: false, target: 'BUTTON:Outside wheel target' },
      `${viewport.width}px outside wheel remains available for page scrolling`)
    await outside.asElement().evaluate((element) => element.remove())
  }

  const dialog = await map.evaluateHandle((element) => {
    const modal = document.createElement('dialog')
    modal.open = true
    modal.setAttribute('data-test-wheel-dialog', '')
    modal.style.cssText = 'position:absolute;inset:20px auto auto 20px;width:180px;height:80px;overflow:auto;z-index:1000'
    const content = document.createElement('div')
    content.style.height = '400px'
    content.textContent = 'Scrollable dialog content'
    modal.append(content)
    element.append(modal)
    return modal
  })
  const markerDistance = distance(...Object.values(await markers()))
  await dialog.asElement().scrollIntoViewIfNeeded()
  const dialogBox = await dialog.asElement().boundingBox()
  await page.mouse.move(dialogBox.x + 40, dialogBox.y + 40)
  await page.mouse.wheel(0, 100)
  await page.waitForTimeout(80)
  assert.ok(await dialog.asElement().evaluate((element) => element.scrollTop > 0))
  assert.ok(Math.abs(distance(...Object.values(await markers())) - markerDistance) < 8)
  await dialog.asElement().evaluate((element) => element.remove())
})
