// Start this folder's Vite fixture; optional ASK_USER_PREVIEW_URL and PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const origin = process.env.ASK_USER_PREVIEW_URL || 'http://127.0.0.1:19351';
const open = mode => page.goto(`${origin}/batch-lifecycle.html?mode=${mode}`);
const choose = id => page.getByRole('radio', { name: `Yes ${id}`, exact: true }).click();
const submit = () => page.getByTestId('ask-user-submit').click();
const sent = () => page.getByTestId('sent').textContent().then(JSON.parse);
try {
  await open('expired');
  assert.equal(await page.getByTestId('ask-user-submit').isDisabled(), true);
  await choose('b'); await submit();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-user-submit"]'));
  assert.deepEqual(await sent(), ['b']);

  await open('late');
  await choose('a'); await choose('b'); await submit();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-user-submit"]'));
  await page.getByRole('button', { name: 'Append question' }).click();
  await choose('c'); await submit();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-user-submit"]'));
  assert.deepEqual(await sent(), ['a', 'b', 'c']);

  await open('draft');
  await choose('a');
  await page.getByRole('button', { name: 'Append question' }).click();
  assert.equal(await page.getByRole('radio', { name: 'Yes a', exact: true }).getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await choose('b'); await choose('c'); await submit();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-user-submit"]'));
  assert.deepEqual(await sent(), ['a', 'b', 'c']);

  await open('race');
  await choose('a'); await choose('b'); await submit();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-user-submit"]'));
  assert.deepEqual(await sent(), ['a', 'b']);
  assert.equal(await page.locator('[data-state="expired-unanswered"]').count(), 1);
  assert.equal(await page.locator('[data-state="resolved-collapsed"]').count(), 1);
  await open('network');
  await choose('a'); await choose('b'); await submit();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').count(), 1);
  assert.equal(await page.getByTestId('ask-user-submit').isEnabled(), true);
  await submit();
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-user-submit"]'));
  assert.deepEqual(await sent(), ['a', 'b', 'b']);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: expired member, late question, preserved draft, expiry during submission, and single-error retry; no browser errors');
} finally { await browser.close(); }
