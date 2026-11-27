import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('Fit points shows antimeridian and worldwide node sets on the offline map', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } })
  page.setDefaultTimeout(8000)
  await page.goto(`${server.resolvedUrls.local[0]}#map`)
  const map = page.getByRole('region', { name: 'Node and terrain map' })
  const fit = page.getByRole('button', { name: 'Fit points' })
  const dateLine = [
    ['Date line east', 10, 170], ['Date line west', 10, -170],
  ]

  async function importNodes(label, nodes, publicSnapshot = false) {
    const records = nodes.map(([name, lat, lon], index) => {
      const publicKey = String(index + 1).repeat(64)
      return publicSnapshot ? { public_key: publicKey, adv_name: name, type: 2, adv_lat: lat, adv_lon: lon }
        : { publicKey, name, role: 2, position: { lat, lon } }
    })
    await page.getByLabel(label, { exact: true }).setInputFiles({
      name: 'nodes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(records)),
    })
    await page.getByText(`${nodes.length} nodes loaded.`, { exact: true }).waitFor()
  }

  async function assertPointsFit(nodes) {
    await fit.click()
    await page.waitForFunction((names) => {
      const map = document.querySelector('[aria-label="Node and terrain map"]')
      if (!map) return false
      const frame = map.getBoundingClientRect()
      return names.every((name) => {
        const pin = Array.from(map.querySelectorAll('[title]')).find((element) => element.getAttribute('title') === name)
        if (!pin) return false
        const bounds = pin.getBoundingClientRect()
        return bounds.width > 0 && bounds.height > 0
          && bounds.left >= frame.left && bounds.right <= frame.right
          && bounds.top >= frame.top && bounds.bottom <= frame.bottom
      })
    }, nodes.map(([name]) => name))
  }

  await page.getByText('Node data and public map', { exact: true }).click()
  await importNodes('Import local or discovered nodes', dateLine)
  await page.getByRole('button', { name: /Date line east/ }).click()
  assert.equal(await map.getByTitle('Date line west', { exact: true }).count(), 0)
  await assertPointsFit(dateLine)

  const worldwide = [
    ['Far north', 84, -160], ['Far south', -83, 164], ['Atlantic', 18, -48], ['Pacific', -4, 139],
  ]
  await importNodes('Import public snapshot', worldwide, true)
  await assertPointsFit(worldwide)
  await page.setViewportSize({ width: 1280, height: 800 })
  await assertPointsFit(worldwide)
})
