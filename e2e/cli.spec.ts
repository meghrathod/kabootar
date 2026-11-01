import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BrowserContext, expect, test } from "@playwright/test";

/**
 * The command-line client talking to the same worker as the browsers: it
 * must interoperate with the web app in both directions.
 */

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bin = path.resolve(
  "test-results",
  process.platform === "win32" ? "kabootar.exe" : "kabootar",
);

test.beforeAll(() => {
  execFileSync("go", ["build", "-o", bin, "./cmd/kabootar"], {
    cwd: path.resolve("cli"),
    stdio: "inherit",
  });
});

interface Run {
  proc: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number>;
}

function kabootar(args: string[], baseURL: string): Run {
  const proc = spawn(bin, [...args, "--server", baseURL], {
    env: { ...process.env, NO_COLOR: "1" },
  });
  let out = "";
  let err = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (err += d));
  const exit = new Promise<number>((resolve) =>
    proc.on("exit", (code) => resolve(code ?? -1)),
  );
  return { proc, stdout: () => out, stderr: () => err, exit };
}

async function receiverContext(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "kabootar-e2e-"));
}

test("CLI sends to a browser", async ({ browser, baseURL }) => {
  const dir = await tempDir();
  const big = randomBytes(9 * 1024 * 1024 + 3);
  const small = Buffer.from("from the terminal\n");
  await writeFile(path.join(dir, "big.bin"), big);
  await writeFile(path.join(dir, "small.txt"), small);

  const send = kabootar(
    [
      "send",
      "--no-nearby",
      "--once",
      path.join(dir, "big.bin"),
      path.join(dir, "small.txt"),
      "--text",
      "hello from the cli",
    ],
    baseURL!,
  );
  await expect.poll(send.stderr, { timeout: 15_000 }).toMatch(/Link\s+http/);
  const link = send.stderr().match(/Link\s+(\S+)/)![1];

  const receiver = await browser.newContext({ acceptDownloads: true });
  await receiverContext(receiver);
  const rp = await receiver.newPage();
  await rp.goto(link);
  await expect(rp.getByText("hello from the cli")).toBeVisible({
    timeout: 30_000,
  });

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
  expect(got.get("big.bin")).toBe(sha(big));
  expect(got.get("small.txt")).toBe(sha(small));

  // --once: the CLI exits by itself once the receiver has everything.
  expect(await send.exit).toBe(0);
  expect(send.stderr()).toContain("Receiver 1 has everything.");
  await receiver.close();
});

test("browser sends to the CLI with the 6-digit code", async ({
  browser,
  baseURL,
}) => {
  const files = [
    {
      name: "photo.bin",
      mimeType: "application/octet-stream",
      buffer: randomBytes(5 * 1024 * 1024 + 11),
    },
    { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hi\n") },
  ];
  const sender = await browser.newContext();
  const sp = await sender.newPage();
  await sp.goto("/");
  await sp.locator('input[type="file"][multiple]').setInputFiles(files);
  await sp.getByRole("button", { name: "Text" }).click();
  await sp.getByPlaceholder("Text or link").fill("text for the terminal");
  await sp.getByRole("button", { name: "Add", exact: true }).click();
  await sp.getByRole("button", { name: "Send", exact: true }).click();
  await expect(sp.getByText("Live: keep this page open")).toBeVisible();
  const code = (await sp.getByLabel(/^Code /).textContent())!.replace(
    /\D/g,
    "",
  );

  const out = await tempDir();
  const recv = kabootar(["receive", "-o", out, code], baseURL!);
  expect(await recv.exit, recv.stderr()).toBe(0);
  expect(recv.stdout()).toContain("text for the terminal");
  expect(recv.stderr()).toMatch(/Done: 2 files/);
  for (const f of files) {
    expect(sha(await readFile(path.join(out, f.name)))).toBe(sha(f.buffer));
  }
  await expect(sp.getByText("2 files delivered")).toBeVisible();
  await sender.close();
});

test("CLI sends a folder to another CLI with the link", async ({
  baseURL,
}) => {
  const src = await tempDir();
  const nested = path.join(src, "album", "2024");
  await mkdir(nested, { recursive: true });
  const a = randomBytes(2 * 1024 * 1024);
  const b = Buffer.from("b");
  await writeFile(path.join(nested, "a.bin"), a);
  await writeFile(path.join(src, "album", "b.txt"), b);

  const send = kabootar(
    ["send", "--no-nearby", "--once", path.join(src, "album")],
    baseURL!,
  );
  await expect.poll(send.stderr, { timeout: 15_000 }).toMatch(/Link\s+http/);
  const link = send.stderr().match(/Link\s+(\S+)/)![1];

  const out = await tempDir();
  const recv = kabootar(["receive", link, "--output", out], baseURL!);
  expect(await recv.exit, recv.stderr()).toBe(0);
  expect(sha(await readFile(path.join(out, "album", "2024", "a.bin")))).toBe(
    sha(a),
  );
  expect(sha(await readFile(path.join(out, "album", "b.txt")))).toBe(sha(b));
  expect(await send.exit).toBe(0);
});

test("CLI reports a wrong code", async ({ baseURL }) => {
  const recv = kabootar(["receive", "999999"], baseURL!);
  expect(await recv.exit).toBe(1);
  expect(recv.stderr()).toContain("No share found with that code.");
});
