import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_UPLOAD_URL = "https://music.163.com/#/my/music/cloud/";
const UPLOAD_BUTTON_PATTERNS = [
  /\u4e0a\u4f20\u672c\u5730\u97f3\u4e50/u,
  /\u4e0a\u4f20\u97f3\u4e50/u,
  /\u4e0a\u4f20\u6b4c\u66f2/u,
  /\u4e0a\u4f20/u,
  /import/i,
  /upload/i
];
const SUCCESS_TEXT_PATTERNS = [
  /\u4e0a\u4f20\u6210\u529f/u,
  /\u5df2\u4e0a\u4f20/u,
  /\u4e0a\u4f20\u5b8c\u6210/u,
  /\u5bfc\u5165\u6210\u529f/u,
  /\u5b8c\u6210/u
];
const ERROR_TEXT_PATTERNS = [/\u4e0a\u4f20\u5931\u8d25/u, /\u5bfc\u5165\u5931\u8d25/u, /\u5931\u8d25/u, /error/i];

export async function maybeUploadToNetease({ config, neteaseSettings, downloadedTracks }) {
  if (!neteaseSettings?.enabled) {
    return {
      enabled: false,
      attempted: false,
      uploaded: false,
      skipped: true,
      reason: "disabled"
    };
  }

  const mode = String(neteaseSettings.mode || "playwright").trim().toLowerCase();
  if (mode !== "playwright") {
    throw new Error(`Unsupported netease.mode: ${neteaseSettings.mode}. Only "playwright" is implemented.`);
  }

  const playableTracks = downloadedTracks.filter((track) => track.audioPath);
  if (playableTracks.length === 0) {
    return {
      enabled: true,
      attempted: false,
      uploaded: false,
      skipped: true,
      reason: "no_audio_files"
    };
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error('NetEase upload requires the "playwright" package. Run "npm install" first.');
  }

  const headless = Boolean(config.neteaseHeadless);
  const hasSavedSession =
    Boolean(config.neteaseCookie) ||
    Boolean(config.neteaseCookiesPath) ||
    (config.neteaseStorageStatePath && fs.existsSync(path.resolve(config.neteaseStorageStatePath)));

  if (headless && !hasSavedSession) {
    throw new Error("NETEASE_HEADLESS=true requires NETEASE_COOKIE, NETEASE_COOKIES_PATH, or NETEASE_STORAGE_STATE_PATH.");
  }

  const browser = await playwright.chromium.launch({
    headless,
    channel: config.neteaseBrowserChannel || undefined
  });

  const uploadUrl = neteaseSettings.uploadUrl || DEFAULT_UPLOAD_URL;
  const context = await browser.newContext(await buildContextOptions(config.neteaseStorageStatePath));

  try {
    await applyNeteaseCookies(context, config, uploadUrl);
    const page = await context.newPage();
    await page.goto(uploadUrl, { waitUntil: "domcontentloaded" });

    const waitForManualLoginMs = Math.max(10, Number(neteaseSettings.waitForManualLoginSec ?? 180)) * 1000;
    console.log(`[NetEase] Waiting for upload page at ${uploadUrl} ...`);
    const ready = await waitForUploadInput(page, waitForManualLoginMs);
    if (!ready) {
      throw new Error(
        `Unable to find a NetEase upload file input within ${Math.round(waitForManualLoginMs / 1000)} seconds. ` +
          "If login is required, run with NETEASE_HEADLESS=false and complete the login in the opened browser window."
      );
    }

    const uploads = [];
    for (const track of playableTracks) {
      console.log(`[NetEase] Uploading ${path.basename(track.audioPath)} ...`);
      const upload = await uploadSingleTrack(page, track.audioPath, neteaseSettings);
      uploads.push({
        title: track.track?.title || "",
        audioPath: track.audioPath,
        ...upload
      });
    }

    if (config.neteaseStorageStatePath) {
      await ensureParentDir(path.resolve(config.neteaseStorageStatePath));
      await context.storageState({ path: path.resolve(config.neteaseStorageStatePath) });
    }

    return {
      enabled: true,
      attempted: true,
      uploaded: uploads.length > 0,
      skipped: false,
      reason: "",
      mode,
      accountName: config.neteaseAccountName || "",
      uploadUrl,
      uploads,
      confirmedCount: uploads.filter((upload) => upload.confirmed).length,
      unconfirmedCount: uploads.filter((upload) => !upload.confirmed).length
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function buildContextOptions(storageStatePath) {
  const resolvedPath = storageStatePath ? path.resolve(storageStatePath) : "";
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return {};
  }
  return { storageState: resolvedPath };
}

async function applyNeteaseCookies(context, config, uploadUrl) {
  const parsedUploadUrl = new URL(uploadUrl);
  const cookies = [];

  if (config.neteaseCookiesPath) {
    cookies.push(...(await readCookiesFile(path.resolve(config.neteaseCookiesPath), parsedUploadUrl)));
  }

  if (config.neteaseCookie) {
    cookies.push(...parseCookieHeader(config.neteaseCookie, parsedUploadUrl));
  }

  if (cookies.length > 0) {
    await context.addCookies(deduplicateCookies(cookies));
  }
}

async function readCookiesFile(filePath, parsedUploadUrl) {
  const raw = await fsp.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : [];

  return source.map((cookie) => normalizeCookie(cookie, parsedUploadUrl)).filter(Boolean);
}

function parseCookieHeader(cookieHeader, parsedUploadUrl) {
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        return null;
      }
      return normalizeCookie(
        {
          name: entry.slice(0, separatorIndex).trim(),
          value: entry.slice(separatorIndex + 1).trim()
        },
        parsedUploadUrl
      );
    })
    .filter(Boolean);
}

function normalizeCookie(cookie, parsedUploadUrl) {
  if (!cookie?.name) {
    return null;
  }

  const normalized = {
    name: cookie.name,
    value: cookie.value ?? "",
    domain: cookie.domain || parsedUploadUrl.hostname,
    path: cookie.path || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure ?? parsedUploadUrl.protocol === "https:",
    sameSite: normalizeSameSite(cookie.sameSite)
  };

  if (typeof cookie.expires === "number" && Number.isFinite(cookie.expires)) {
    normalized.expires = cookie.expires;
  }

  return normalized;
}

function normalizeSameSite(value) {
  if (value === "Strict" || value === "Lax" || value === "None") {
    return value;
  }
  return "Lax";
}

function deduplicateCookies(cookies) {
  const map = new Map();
  for (const cookie of cookies) {
    map.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  }
  return [...map.values()];
}

async function waitForUploadInput(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const fileInput = await findFileInput(page);
    if (fileInput) {
      return true;
    }

    await clickUploadButtons(page);
    await page.waitForTimeout(1000);
  }

  return false;
}

async function uploadSingleTrack(page, audioPath, neteaseSettings) {
  const fileInput = await findFileInput(page);
  if (!fileInput) {
    throw new Error("NetEase upload input disappeared before file submission.");
  }

  await fileInput.setInputFiles(audioPath);
  const timeoutMs = Math.max(15, Number(neteaseSettings.perTrackTimeoutSec ?? 180)) * 1000;
  return await waitForUploadResult(page, path.basename(audioPath), timeoutMs);
}

async function waitForUploadResult(page, fileName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawFileName = false;

  while (Date.now() < deadline) {
    const pageText = await collectText(page);
    if (pageText.includes(fileName)) {
      sawFileName = true;
    }

    if (matchesAnyPattern(pageText, ERROR_TEXT_PATTERNS)) {
      return {
        status: "failed",
        confirmed: false,
        detail: trimTextSnapshot(pageText)
      };
    }

    if (matchesAnyPattern(pageText, SUCCESS_TEXT_PATTERNS)) {
      return {
        status: "completed",
        confirmed: true,
        detail: trimTextSnapshot(pageText)
      };
    }

    if (sawFileName) {
      return {
        status: "submitted",
        confirmed: true,
        detail: `Observed ${fileName} in the NetEase page after upload submission.`
      };
    }

    await page.waitForTimeout(1500);
  }

  return {
    status: "submitted_unconfirmed",
    confirmed: false,
    detail: `Timed out after ${Math.round(timeoutMs / 1000)} seconds while waiting for a visible confirmation for ${fileName}.`
  };
}

async function findFileInput(page) {
  for (const frame of page.frames()) {
    const locator = frame.locator('input[type="file"]');
    if ((await locator.count()) > 0) {
      return locator.first();
    }
  }
  return null;
}

async function clickUploadButtons(page) {
  for (const frame of page.frames()) {
    for (const pattern of UPLOAD_BUTTON_PATTERNS) {
      const locator = frame.getByText(pattern).first();
      if ((await locator.count()) === 0) {
        continue;
      }

      try {
        await locator.click({ timeout: 500 });
        return;
      } catch {
        continue;
      }
    }
  }
}

async function collectText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 500 });
      if (text) {
        parts.push(text);
      }
    } catch {
      continue;
    }
  }
  return parts.join("\n");
}

function matchesAnyPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function trimTextSnapshot(text) {
  return String(text).replace(/\s+/gu, " ").trim().slice(0, 400);
}

async function ensureParentDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}
