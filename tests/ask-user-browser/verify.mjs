// Start the sibling fixture with Vite, then run: node verify.mjs.
// Uses Playwright from the workspace, or PLAYWRIGHT_MODULE for an isolated checkout.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const evidenceDir =
  process.env.ASK_USER_EVIDENCE_DIR ||
  join(tmpdir(), "forgeax-question-preview");
await mkdir(evidenceDir, { recursive: true });
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1050 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(
    process.env.ASK_USER_PREVIEW_URL || "http://127.0.0.1:19351/",
  );
  const card = page.getByTestId("ask-user-card");
  const requests = page.getByTestId("requests");
  const checked = () => card.locator('[aria-checked="true"]').count();
  await card.waitFor();
  assert.equal(await page.getByTestId('conversation-flow').getByTestId('ask-user-card').count(), 1);
  const flowText = await page.getByTestId('conversation-flow').innerText();
  assert.ok(flowText.indexOf('main.ts') < flowText.indexOf('你希望采用哪种核心玩法'));

  assert.equal(await card.locator(".ask-user-question").count(), 1);
  assert.equal(
    await checked(),
    0,
    "recommendations must not answer a question",
  );
  await page.getByRole("radio", { name: "泡泡射击消除", exact: false }).click();
  await card
    .locator(".ask-user-progress")
    .filter({ hasText: "2 / 3" })
    .waitFor();
  assert.equal(await requests.textContent(), "0");
  await page.getByRole("radio", { name: "2D 正面视角", exact: false }).click();
  await page.getByRole("checkbox", { name: "可玩单关", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "计分与重新开始", exact: true })
    .click();
  assert.equal(
    await checked(),
    2,
    "multi-select must stay on the current step",
  );
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  assert.equal(await checked(), 1, "back preserves the previous answer");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  assert.equal(await checked(), 2);
  await page.getByRole("button", { name: "切换会话 preview-a" }).click();
  assert.equal(await checked(), 0, "another session must not inherit answers");
  assert.match(await card.innerText(), /1 \/ 3/);
  await page.getByRole("button", { name: "切换会话 preview-b" }).click();
  assert.equal(
    await checked(),
    2,
    "return restores the original step and choices",
  );
  await page.getByLabel("模拟提交失败").check();
  await page.getByTestId("ask-user-submit").click();
  await page.getByRole("alert").waitFor();
  assert.equal(await checked(), 2);
  assert.equal(await requests.textContent(), "1");
  await page.getByLabel("模拟提交失败").uncheck();
  await page.getByTestId("ask-user-submit").click();
  await card.locator(".ask-user-resolved-row").first().waitFor();
  assert.equal(await card.locator(".ask-user-resolved-row").count(), 3);
  assert.equal(await requests.textContent(), "2");
  const payload = JSON.parse(await page.locator("pre").textContent());
  assert.equal(payload.answers.length, 3);
  assert.deepEqual(payload.answers[2].values, ["可玩单关", "计分与重新开始"]);
  await page.getByRole("button", { name: "重新体验" }).click();
  await page.getByTestId("ask-user-custom-input").fill("自定义玩法");
  assert.match(await card.innerText(), /1 \/ 3/, "typing must not advance");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("radio", { name: "2D 正面视角", exact: false }).focus();
  await page.keyboard.press("ArrowDown");
  assert.match(await page.locator(":focus").innerText(), /3D/);
  await page.keyboard.press("Enter");
  assert.match(await card.innerText(), /3 \/ 3/);
  assert.equal(
    await card
      .locator(".ask-user-question-head")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("题型").selectOption("single");
  assert.equal(await card.locator(".ask-user-steps").count(), 0);
  await page.getByRole("radio", { name: "泡泡射击消除", exact: false }).click();
  assert.equal(
    await requests.textContent(),
    "2",
    "last selection must not submit",
  );
  await page.getByLabel("题型").selectOption("text");
  await page.getByTestId("ask-user-custom-input").fill("像素风格");
  assert.equal(await page.getByTestId("ask-user-submit").isEnabled(), true);
  await page.getByTestId("ask-user-custom-input").fill("  ");
  assert.equal(await page.getByTestId("ask-user-submit").isEnabled(), false);
  await page.getByLabel("题型").selectOption("expired");
  assert.equal(await card.locator("button:not(:disabled)").count(), 0);
  await page.getByLabel("题型").selectOption("group");
  await page.getByRole("button", { name: "重新体验" }).click();
  await page.screenshot({
    path: join(evidenceDir, "after.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "narrow viewport must not overflow",
  );
  await page.screenshot({
    path: join(evidenceDir, "after-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: single/multi/text, auto advance, keyboard focus, back, session isolation, retry, grouped submit, terminal state, narrow layout",
  );
} finally {
  await browser.close();
}
