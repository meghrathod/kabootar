import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Receivers in tests can't click through native save pickers. */
async function receiverContext(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
}

async function startShare(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
  text?: string,
) {
  await page.goto("/");
  await page.locator('input[type="file"][multiple]').setInputFiles(files);
  if (text) {
    await page.getByRole("button", { name: "Text" }).click();
    await page.getByPlaceholder("Text or link").fill(text);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Live: keep this page open")).toBeVisible();
  const code = (await page.getByLabel(/^Code /).textContent())!.replace(
    /\D/g,
    "",
  );
  return { link: page.url(), code };
}

test("sends files and text peer-to-peer and verifies integrity", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const receiver = await browser.newContext({ acceptDownloads: true });
  await receiverContext(receiver);

  const big = {
    name: "big.bin",
    mimeType: "application/octet-stream",
    buffer: randomBytes(12 * 1024 * 1024 + 7),
  };
  const small = {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello from kabootar\n"),
  };

  const sp = await sender.newPage();
  const { link } = await startShare(
    sp,
    [big, small],
    "Wi-Fi password: hunter2 https://example.com",
  );

  const rp = await receiver.newPage();
  await rp.goto(link);
  await expect(rp.getByText("Wi-Fi password: hunter2")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    rp.getByRole("link", { name: "https://example.com" }),
  ).toHaveAttribute("rel", /noopener/);
  await expect(rp.getByText("big.bin")).toBeVisible();

  const downloads: Promise<import("@playwright/test").Download>[] = [];
  rp.on("download", (d) => downloads.push(Promise.resolve(d)));
  await rp.getByRole("button", { name: /Download all 2/ }).click();

  await expect(rp.getByText("Verified")).toHaveCount(2, { timeout: 60_000 });
  await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(2);

  const got = new Map<string, string>();
  for (const p of downloads) {
    const d = await p;
    got.set(d.suggestedFilename(), sha(await readFile((await d.path())!)));
  }
  expect(got.get("big.bin")).toBe(sha(big.buffer));
  expect(got.get("notes.txt")).toBe(sha(small.buffer));

  // The sender sees the deliveries.
  await expect(sp.getByText("2 files delivered")).toBeVisible();

  // Ending the share tells the receiver.
  await sp.getByRole("button", { name: "Stop" }).click();
  await sp.getByRole("button", { name: "Stop sharing" }).click();
  await expect(
    rp.getByText(/All files received|Sender stopped sharing/),
  ).toBeVisible();

  await sender.close();
  await receiver.close();
});

test("joins with the 6-digit code", async ({ browser }) => {
  const sender = await browser.newContext();
  const receiver = await browser.newContext();
  await receiverContext(receiver);

  const sp = await sender.newPage();
  const { code } = await startShare(sp, [
    { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") },
  ]);

  const rp = await receiver.newPage();
  await rp.goto("/receive");
  await rp.getByLabel("6-digit code").first().fill(code);
  await expect(rp.getByText("a.txt")).toBeVisible({ timeout: 30_000 });
  await expect(rp.getByText("Receiving from")).toBeVisible();

  await sender.close();
  await receiver.close();
});

test("wrong code shows an error", async ({ page }) => {
  await page.goto("/receive");
  await page.getByLabel("6-digit code").first().fill("999999");
  await expect(page.getByText("No share found with that code.")).toBeVisible();
});

test("app shell, manifest and security headers", async ({ request }) => {
  const res = await request.get("/some/deep/link");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-security-policy"]).toContain(
    "default-src 'self'",
  );
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.share_target.action).toBe("/share-target");
  expect(
    manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable"),
  ).toBe(true);
});

test("returning visitor downloads through the service worker", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const receiver = await browser.newContext({ acceptDownloads: true });
  await receiverContext(receiver);

  const rp = await receiver.newPage();
  await rp.goto("/");
  await expect
    .poll(() => rp.evaluate(() => !!navigator.serviceWorker.controller), {
      timeout: 15_000,
    })
    .toBe(true);

  const file = {
    name: "streamed.bin",
    mimeType: "application/octet-stream",
    buffer: randomBytes(40 * 1024 * 1024),
  };
  const sp = await sender.newPage();
  const { link } = await startShare(sp, [file]);

  await rp.goto(link);
  await expect(rp.getByText("streamed.bin")).toBeVisible({ timeout: 30_000 });
  const download = rp.waitForEvent("download");
  await rp.getByRole("button", { name: /^Download ·/ }).click();
  const d = await download;
  await expect(rp.getByText("Verified")).toBeVisible({ timeout: 30_000 });
  expect(sha(await readFile((await d.path())!))).toBe(sha(file.buffer));

  await sender.close();
  await receiver.close();
});

test("receiver reload resumes the download and keeps its identity", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  // Without a service worker Chromium saves to device storage (OPFS): the
  // same path iOS uses, and the one that can resume after a reload.
  const receiver = await browser.newContext({
    acceptDownloads: true,
    serviceWorkers: "block",
  });
  await receiverContext(receiver);

  const file = {
    name: "resume.bin",
    mimeType: "application/octet-stream",
    buffer: randomBytes(45 * 1024 * 1024),
  };
  const sp = await sender.newPage();
  const { link } = await startShare(sp, [file]);

  const rp = await receiver.newPage();
  const logs: string[] = [];
  rp.on("console", (m) => logs.push(m.text()));
  await rp.goto(link);
  await expect(rp.getByText("resume.bin")).toBeVisible({ timeout: 30_000 });
  await rp.getByRole("button", { name: /^Download ·/ }).click();
  await expect.poll(() => logs.some((l) => l.includes("via opfs"))).toBe(true);
  await expect(rp.getByText(/[1-9][\d.]* MB of/)).toBeVisible({
    timeout: 30_000,
  });

  const download = rp.waitForEvent("download", { timeout: 60_000 });
  await rp.reload();
  await expect
    .poll(() => logs.some((l) => l.includes('resuming "resume.bin"')))
    .toBe(true);
  await expect(rp.getByText("Verified")).toBeVisible({ timeout: 60_000 });
  expect(sha(await readFile((await (await download).path())!))).toBe(
    sha(file.buffer),
  );

  // Still one receiver on the sender's side.
  await expect(sp.getByText(/^Receiver \d/)).toHaveCount(1);

  await sender.close();
  await receiver.close();
});

test("sender reload resumes the same share after re-adding files", async ({
  browser,
}) => {
  const sender = await browser.newContext();
  const receiver = await browser.newContext({ acceptDownloads: true });
  await receiverContext(receiver);

  const file = {
    name: "again.bin",
    mimeType: "application/octet-stream",
    buffer: randomBytes(3 * 1024 * 1024),
  };
  const sp = await sender.newPage();
  const { link, code } = await startShare(sp, [file]);

  const rp = await receiver.newPage();
  await rp.goto(link);
  await expect(rp.getByText("again.bin")).toBeVisible({ timeout: 30_000 });

  // Sender reloads: the share is remembered, the files have to be re-added.
  sp.on("dialog", (d) => d.accept());
  await sp.reload();
  await expect(sp.getByText("Continue sharing")).toBeVisible();
  await sp.locator('input[type="file"][multiple]').setInputFiles([file]);
  await expect(sp.getByText("Live: keep this page open")).toBeVisible({
    timeout: 15_000,
  });
  expect(
    (await sp.getByLabel(/^Code /).textContent())!.replace(/\D/g, ""),
  ).toBe(code);

  // The receiver reconnects on its own and can download.
  const download = rp.waitForEvent("download", { timeout: 60_000 });
  await expect(rp.getByRole("button", { name: /^Download ·/ })).toBeEnabled({
    timeout: 30_000,
  });
  await rp.getByRole("button", { name: /^Download ·/ }).click();
  await expect(rp.getByText("Verified")).toBeVisible({ timeout: 30_000 });
  expect(sha(await readFile((await (await download).path())!))).toBe(
    sha(file.buffer),
  );

  await sender.close();
  await receiver.close();
});
