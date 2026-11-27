import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { openWorkspaceMenu } from './workspace-menu.mjs'

test('Inbox navigation, radio menu and dark appearance work across workspaces', async (t) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ channel: 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' })
  page.setDefaultTimeout(10_000)
  await page.goto(server.resolvedUrls.local[0])

  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  assert.equal(await navigation.getByRole('link', { name: 'Chats', exact: true }).getAttribute('aria-current'), 'page')
  const brand = page.getByRole('link', { name: 'Packet Pigeon', exact: true })
  const lightMark = await brand.evaluate((element) => {
    const mark = getComputedStyle(element, '::before')
    return { mask: mark.maskImage, color: mark.backgroundColor }
  })
  assert.notEqual(lightMark.mask, 'none')
  const favicon = await page.locator('link[rel="icon"]').getAttribute('href')
  assert.equal(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'), favicon)
  const icon = await page.request.get(new URL(favicon, page.url()).href)
  assert.equal(icon.status(), 200)
  assert.match(icon.headers()['content-type'], /^image\/png/)
  const radio = page.getByLabel('Radio connection', { exact: true })
  await radio.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Connect USB' }).waitFor()
  await page.keyboard.press('Escape')
  assert.ok(await radio.evaluate((element) => document.activeElement === element && !element.parentElement.open))

  await openWorkspaceMenu(page, 'More')
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click()
  const appearance = page.getByLabel('Appearance', { exact: true })
  const colors = () => page.locator('html').evaluate((element) => {
    const style = getComputedStyle(element)
    return { scheme: style.colorScheme, background: style.backgroundColor, color: style.color }
  })
  const light = await colors()
  await appearance.selectOption('dark')
  const dark = await colors()
  assert.equal(dark.scheme, 'dark')
  assert.notEqual(dark.background, light.background)
  assert.notEqual(dark.color, light.color)
  assert.notEqual(await brand.evaluate((element) => getComputedStyle(element, '::before').backgroundColor), lightMark.color)
  await page.reload()
  await appearance.waitFor()
  assert.equal(await appearance.inputValue(), 'dark')
  assert.deepEqual(await colors(), dark)

  await navigation.getByRole('link', { name: 'Map', exact: true }).click()
  const map = page.getByRole('region', { name: 'Node and terrain map' })
  await map.waitFor()
  const mapBackground = await map.evaluate((element) => getComputedStyle(element).backgroundColor)
  await openWorkspaceMenu(page, 'More')
  await navigation.getByRole('link', { name: 'Settings', exact: true }).click()
  await appearance.selectOption('system')
  await navigation.getByRole('link', { name: 'Map', exact: true }).click()
  await map.waitFor()
  assert.notEqual(await map.evaluate((element) => getComputedStyle(element).backgroundColor), mapBackground)
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await map.evaluate((element) => getComputedStyle(element).backgroundColor), mapBackground)
  await page.setViewportSize({ width: 320, height: 800 })
  await radio.locator('.radio-summary').evaluate((element) => {
    element.textContent = 'Field test companion radio with a long name · Bluetooth'
  })
  const brandBounds = await brand.boundingBox()
  const radioBounds = await radio.boundingBox()
  assert.ok(brandBounds.x + brandBounds.width <= radioBounds.x)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await brand.click()
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
  assert.equal(await navigation.getByRole('link', { name: 'Chats', exact: true }).getAttribute('aria-current'), 'page')
})
