export async function openWorkspaceMenu(page, name) {
  const summary = page.getByLabel(name, { exact: true })
  if (!await summary.evaluate((element) => element.parentElement.open)) await summary.click()
}
