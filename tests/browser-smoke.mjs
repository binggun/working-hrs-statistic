import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const credentials = process.env.BROWSER_CREDENTIALS_FILE
  ? JSON.parse(await readFile(process.env.BROWSER_CREDENTIALS_FILE, "utf8"))
  : {
      email: process.env.BROWSER_EMAIL,
      password: process.env.BROWSER_PASSWORD,
    };
assert.ok(
  credentials.email && credentials.password,
  "Set BROWSER_EMAIL / BROWSER_PASSWORD or BROWSER_CREDENTIALS_FILE",
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(process.env.WEB_TEST_URL || "http://localhost:5173");
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Monthly hours", exact: true })
    .waitFor();
  await page.locator("input[type=month]").fill("2026-10");
  await page
    .getByRole("button", { name: "Attendance records", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Attendance records", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Validation queue", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Validation queue", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page
    .getByRole("heading", { name: "People & accounts", exact: true })
    .waitFor();
  await page.getByRole("heading", { name: "Managers", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Monthly hours", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Monthly hours", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Download PDF", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.body.textContent.includes("Loading…"),
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().endsWith(".pdf"));
  await page.screenshot({
    path: process.env.SCREENSHOT_PATH || "/tmp/pawhub-manager.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.equal(await page.locator("[role=alert]").count(), 0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  console.log(
    "PASS desktop login, monthly filters, navigation, PDF download, logout; no browser errors",
  );
} finally {
  await browser.close();
}
