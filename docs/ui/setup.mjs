export async function ready(page, template) {
  await page.getByTestId('load-sample').click();
  await page.getByTestId('header-continue-to-sign').waitFor();
  await page.getByTestId('field-box-party_a').waitFor();
  if (template.id === 'sign') {
    await page.getByTestId('header-continue-to-sign').click();
    await page.getByTestId('app-bar-prepare').waitFor();
    await page.getByTestId('pdf-page-1').locator('canvas').waitFor();
    await page.getByTestId('field-box-party_a').waitFor();
  }
}
