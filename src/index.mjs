#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, firefox, webkit } from "playwright";

const execFile = promisify(execFileCallback);
const PACKAGE_NAME = "video-recorder-mcp";
const PACKAGE_VERSION = "0.5.0";
const OUTPUT_ROOT_ENV = "VIDEO_RECORDER_OUTPUT_DIR";
const DEFAULT_OUTPUT_FOLDER = "Video Recorder";

const server = new Server(
  {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const screenSessions = new Map();
const browserSessions = new Map();

const BROWSER_MODE_PRESETS = {
  feature: {
    demoMode: true,
    showCursor: true,
    actionDelayMs: 220,
    typingDelayMs: 42,
    navigationSettlingMs: 420,
    clickHoldMs: 70,
    moveDurationMs: 140,
    annotationDurationMs: 900,
    captureConsole: false,
    capturePageErrors: false,
    captureNetwork: false,
    captureTrace: false,
    captureHar: false
  },
  bug: {
    demoMode: true,
    showCursor: true,
    actionDelayMs: 180,
    typingDelayMs: 20,
    navigationSettlingMs: 260,
    clickHoldMs: 50,
    moveDurationMs: 100,
    annotationDurationMs: 700,
    captureConsole: true,
    capturePageErrors: true,
    captureNetwork: true,
    captureTrace: true,
    captureHar: true
  },
  tutorial: {
    demoMode: true,
    showCursor: true,
    actionDelayMs: 520,
    typingDelayMs: 72,
    navigationSettlingMs: 920,
    clickHoldMs: 90,
    moveDurationMs: 320,
    annotationDurationMs: 1600,
    captureConsole: false,
    capturePageErrors: false,
    captureNetwork: false,
    captureTrace: false,
    captureHar: false
  },
  gif: {
    demoMode: true,
    showCursor: true,
    actionDelayMs: 120,
    typingDelayMs: 26,
    navigationSettlingMs: 180,
    clickHoldMs: 40,
    moveDurationMs: 90,
    annotationDurationMs: 600,
    captureConsole: false,
    capturePageErrors: false,
    captureNetwork: false,
    captureTrace: false,
    captureHar: false
  },
  manual: {
    demoMode: false,
    showCursor: false,
    actionDelayMs: 0,
    typingDelayMs: 0,
    navigationSettlingMs: 0,
    clickHoldMs: 0,
    moveDurationMs: 0,
    annotationDurationMs: 0,
    captureConsole: false,
    capturePageErrors: false,
    captureNetwork: false,
    captureTrace: false,
    captureHar: false
  }
};

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }

  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function appendJsonl(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

function writeJsonlFile(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  fs.writeFileSync(filePath, content ? `${content}\n` : "");
  return filePath;
}

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function isoStamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function sanitizeFileStem(filePath) {
  const raw = String(filePath || "artifact");
  return String(path.basename(raw, path.extname(raw)) || "artifact")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "artifact";
}

function defaultOutputRoot() {
  const configured = process.env[OUTPUT_ROOT_ENV];
  const root = path.resolve(expandHome(configured || path.join(os.homedir(), "Movies", DEFAULT_OUTPUT_FOLDER)));
  ensureDir(root);
  return root;
}

function defaultOutputPath(prefix, extension, options = {}) {
  const baseDir = options.dir
    ? path.resolve(expandHome(options.dir))
    : options.subdir
      ? path.join(defaultOutputRoot(), options.subdir)
      : defaultOutputRoot();
  ensureDir(baseDir);
  return path.join(baseDir, `${sanitizeFileStem(prefix)}-${isoStamp()}.${extension}`);
}

function buildJobLayout(jobDir) {
  const resolvedJobDir = path.resolve(expandHome(jobDir));
  return {
    jobDir: resolvedJobDir,
    rawDir: path.join(resolvedJobDir, "raw"),
    finalDir: path.join(resolvedJobDir, "final"),
    clipsDir: path.join(resolvedJobDir, "clips"),
    screensDir: path.join(resolvedJobDir, "screens"),
    diagnosticsDir: path.join(resolvedJobDir, "diagnostics"),
    analysisDir: path.join(resolvedJobDir, "analysis"),
    assetsDir: path.join(resolvedJobDir, "assets"),
    manifestPath: path.join(resolvedJobDir, "manifest.jsonl"),
    metadataPath: path.join(resolvedJobDir, "job.json")
  };
}

function ensureJobLayout(layout) {
  ensureDir(layout.jobDir);
  ensureDir(layout.rawDir);
  ensureDir(layout.finalDir);
  ensureDir(layout.clipsDir);
  ensureDir(layout.screensDir);
  ensureDir(layout.diagnosticsDir);
  ensureDir(layout.analysisDir);
  ensureDir(layout.assetsDir);
}

function createVideoJob(options = {}) {
  const defaultName = sanitizeFileStem(options.name || options.kind || options.mode || "video-job");
  const resolvedJobDir = options.jobDir
    ? path.resolve(expandHome(options.jobDir))
    : path.join(path.resolve(expandHome(options.rootDir || defaultOutputRoot())), `${isoStamp()}-${defaultName}`);
  const rootDir = path.resolve(expandHome(options.rootDir || path.dirname(resolvedJobDir)));
  ensureDir(rootDir);
  const layout = buildJobLayout(resolvedJobDir);
  ensureJobLayout(layout);

  const existed = fs.existsSync(layout.metadataPath);
  const existing = readJsonIfExists(layout.metadataPath, {});
  const metadata = {
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: options.name || existing.name || defaultName,
    kind: options.kind || existing.kind || null,
    mode: options.mode || existing.mode || null,
    notes: options.notes || existing.notes || null,
    outputRoot: rootDir,
    directories: {
      jobDir: layout.jobDir,
      raw: layout.rawDir,
      final: layout.finalDir,
      clips: layout.clipsDir,
      screens: layout.screensDir,
      diagnostics: layout.diagnosticsDir,
      analysis: layout.analysisDir,
      assets: layout.assetsDir
    },
    metadata: {
      ...(existing.metadata || {}),
      ...(options.metadata || {})
    }
  };

  writeJson(layout.metadataPath, metadata);
  if (!existed) {
    appendJsonl(layout.manifestPath, {
      type: "job_created",
      recordedAt: new Date().toISOString(),
      name: metadata.name,
      kind: metadata.kind,
      mode: metadata.mode
    });
  }

  return {
    ...layout,
    ...metadata
  };
}

function updateJobMetadata(layout, patch = {}) {
  if (!layout?.metadataPath) {
    return null;
  }

  const existing = readJsonIfExists(layout.metadataPath, {}) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
    metadata: {
      ...(existing.metadata || {}),
      ...(patch.metadata || {})
    }
  };
  writeJson(layout.metadataPath, next);
  return next;
}

function appendJobEvent(layout, type, payload = {}) {
  if (!layout?.manifestPath) {
    return;
  }

  appendJsonl(layout.manifestPath, {
    type,
    recordedAt: new Date().toISOString(),
    ...payload
  });
}

function resolveJobArtifactPath(layout, group, stem, extension, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(expandHome(explicitPath));
    ensureDir(path.dirname(resolved));
    return resolved;
  }

  const dir = layout?.[`${group}Dir`]
    || (group === "clips"
      ? path.join(defaultOutputRoot(), "clips")
      : group === "screens"
        ? path.join(defaultOutputRoot(), "screens")
        : group === "analysis"
          ? path.join(defaultOutputRoot(), "analysis")
          : group === "diagnostics"
            ? path.join(defaultOutputRoot(), "diagnostics")
            : group === "assets"
              ? path.join(defaultOutputRoot(), "assets")
              : group === "raw"
                ? path.join(defaultOutputRoot(), "raw")
                : path.join(defaultOutputRoot(), "final"));
  ensureDir(dir);
  return path.join(dir, `${sanitizeFileStem(stem)}-${isoStamp()}.${extension}`);
}

function browserEngine(name) {
  if (name === "firefox") {
    return firefox;
  }

  if (name === "webkit") {
    return webkit;
  }

  return chromium;
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }

  const text = error instanceof Error ? error.message : String(error);
  return text.trim();
}

function pickFirstLine(text) {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    || null;
}

function roundNumber(value, places = 3) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function jitterMs(baseMs, ratio = 0.18) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    return 0;
  }

  const variance = baseMs * ratio;
  return Math.max(0, Math.round(baseMs + ((Math.random() * 2) - 1) * variance));
}

function resolveSessionMs(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function parseFrameRate(rate) {
  if (!rate || typeof rate !== "string") {
    return null;
  }

  if (!rate.includes("/")) {
    const value = Number(rate);
    return Number.isFinite(value) ? value : null;
  }

  const [num, den] = rate.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return null;
  }

  return num / den;
}

function timestampForFilename(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join("-") + `-${String(ms).padStart(3, "0")}`;
}

function sampleTimestamps(durationSeconds, sampleCount) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0];
  }

  const count = Math.max(1, Math.min(24, Math.floor(sampleCount || 9)));
  const step = durationSeconds / (count + 1);
  const timestamps = [];

  for (let index = 1; index <= count; index += 1) {
    timestamps.push(roundNumber(step * index, 3));
  }

  return timestamps;
}

function sessionElapsedSeconds(session) {
  return roundNumber((Date.now() - session.startedAt) / 1000, 3) || 0;
}

function appendSessionEvent(session, type, payload = {}) {
  appendJobEvent(session.job, type, {
    sessionId: session.sessionId,
    mode: session.mode,
    elapsedSeconds: sessionElapsedSeconds(session),
    ...payload
  });
}

async function listAvfoundationDevices() {
  try {
    await execFile("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    return [];
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("[AVFoundation indev"));
  }
}

function resolveBrowserMode(args = {}) {
  if (typeof args.mode === "string" && args.mode.trim()) {
    return args.mode.trim().toLowerCase();
  }

  if (args.demoMode === false) {
    return "manual";
  }

  return "feature";
}

function createBrowserDemoProfile(args, width, height) {
  const mode = resolveBrowserMode(args);
  const preset = BROWSER_MODE_PRESETS[mode] || BROWSER_MODE_PRESETS.feature;
  const demoMode = args.demoMode === false ? false : preset.demoMode;
  const showCursor = typeof args.showCursor === "boolean" ? args.showCursor : preset.showCursor;

  return {
    mode,
    demoMode,
    showCursor,
    actionDelayMs: resolveSessionMs(args.actionDelayMs, preset.actionDelayMs),
    typingDelayMs: resolveSessionMs(args.typingDelayMs, preset.typingDelayMs),
    navigationSettlingMs: resolveSessionMs(args.navigationSettlingMs, preset.navigationSettlingMs),
    clickHoldMs: resolveSessionMs(args.clickHoldMs, preset.clickHoldMs),
    moveDurationMs: resolveSessionMs(args.moveDurationMs, preset.moveDurationMs),
    annotationDurationMs: resolveSessionMs(args.annotationDurationMs, preset.annotationDurationMs),
    captureConsole: typeof args.captureConsole === "boolean" ? args.captureConsole : preset.captureConsole,
    capturePageErrors: typeof args.capturePageErrors === "boolean" ? args.capturePageErrors : preset.capturePageErrors,
    captureNetwork: typeof args.captureNetwork === "boolean" ? args.captureNetwork : preset.captureNetwork,
    captureTrace: typeof args.captureTrace === "boolean" ? args.captureTrace : preset.captureTrace,
    captureHar: typeof args.captureHar === "boolean" ? args.captureHar : preset.captureHar,
    cursorPosition: {
      x: roundNumber(width * 0.16, 1),
      y: roundNumber(height * 0.18, 1)
    }
  };
}

async function waitForBrowserDelay(session, baseMs, ratio = 0.18) {
  const delayMs = jitterMs(baseMs, ratio);
  if (delayMs > 0) {
    await session.page.waitForTimeout(delayMs);
  }
  return delayMs;
}

async function ensureBrowserDemoOverlay(session) {
  if (!session.demoMode && !session.showCursor) {
    return;
  }

  await session.page.evaluate(({ showCursor }) => {
    const rootId = "__video-recorder-demo-root";
    const styleId = "__video-recorder-demo-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        #${rootId} {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          pointer-events: none;
          overflow: hidden;
        }

        #${rootId} .vrdemo-cursor {
          position: absolute;
          top: 0;
          left: 0;
          width: 22px;
          height: 22px;
          margin-left: -11px;
          margin-top: -11px;
          border-radius: 999px;
          background: rgba(10, 10, 10, 0.88);
          border: 2px solid rgba(255, 255, 255, 0.96);
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transform: translate(-80px, -80px);
        }

        #${rootId} .vrdemo-cursor::after {
          content: "";
          width: 4px;
          height: 4px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.96);
        }

        #${rootId} .vrdemo-layer {
          position: absolute;
          inset: 0;
        }

        #${rootId} .vrdemo-ripple {
          position: absolute;
          top: 0;
          left: 0;
          width: 20px;
          height: 20px;
          margin-left: -10px;
          margin-top: -10px;
          border-radius: 999px;
          border: 2px solid rgba(255, 255, 255, 0.95);
          background: rgba(0, 0, 0, 0.14);
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.28);
        }

        #${rootId} .vrdemo-annotation {
          position: absolute;
          border-radius: 18px;
          border: 2px solid rgba(255, 255, 255, 0.98);
          box-shadow:
            0 0 0 1px rgba(0, 0, 0, 0.35) inset,
            0 18px 38px rgba(0, 0, 0, 0.18);
        }

        #${rootId} .vrdemo-annotation[data-style="outline"] {
          background: rgba(255, 255, 255, 0.02);
        }

        #${rootId} .vrdemo-annotation[data-style="spotlight"] {
          background: rgba(255, 255, 255, 0.03);
          box-shadow:
            0 0 0 9999px rgba(0, 0, 0, 0.45),
            0 0 0 2px rgba(255, 255, 255, 0.98),
            0 20px 56px rgba(0, 0, 0, 0.26);
        }

        #${rootId} .vrdemo-label {
          position: absolute;
          max-width: 360px;
          padding: 10px 14px;
          border-radius: 14px;
          background: rgba(10, 10, 10, 0.94);
          color: rgba(255, 255, 255, 0.98);
          font-family: "SF Pro Display", "Inter", "Helvetica Neue", sans-serif;
          font-size: 15px;
          line-height: 1.35;
          letter-spacing: -0.01em;
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.22);
        }
      `;
      document.head.append(style);
    }

    let root = document.getElementById(rootId);
    if (!root) {
      root = document.createElement("div");
      root.id = rootId;
      root.innerHTML = `
        <div class="vrdemo-layer" data-layer="annotations"></div>
        <div class="vrdemo-cursor" data-layer="cursor"></div>
      `;
      document.documentElement.append(root);
    }

    const cursor = root.querySelector('[data-layer="cursor"]');
    if (cursor) {
      cursor.style.display = showCursor ? "flex" : "none";
    }
  }, { showCursor: session.showCursor });
}

async function moveBrowserCursor(session, x, y, options = {}) {
  if (!session.demoMode || !session.showCursor) {
    return { x, y };
  }

  await ensureBrowserDemoOverlay(session);
  const durationMs = resolveSessionMs(options.durationMs, session.moveDurationMs);
  const dx = session.cursorPosition ? x - session.cursorPosition.x : 0;
  const dy = session.cursorPosition ? y - session.cursorPosition.y : 0;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(8, Math.ceil(distance / 30));

  await Promise.all([
    session.page.mouse.move(x, y, { steps }),
    session.page.evaluate(({ xPos, yPos, moveMs }) => new Promise((resolve) => {
      const cursor = document.querySelector("#__video-recorder-demo-root .vrdemo-cursor");
      if (!cursor) {
        resolve();
        return;
      }

      cursor.style.opacity = "1";
      cursor.style.transition = `transform ${moveMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms ease`;
      cursor.style.transform = `translate(${xPos}px, ${yPos}px)`;
      window.setTimeout(resolve, moveMs + 24);
    }), {
      xPos: x,
      yPos: y,
      moveMs: durationMs
    })
  ]);

  session.cursorPosition = { x, y };
  return session.cursorPosition;
}

async function playBrowserClickEffect(session, x, y) {
  if (!session.demoMode) {
    return;
  }

  await ensureBrowserDemoOverlay(session);
  await session.page.evaluate(({ xPos, yPos }) => new Promise((resolve) => {
    const layer = document.querySelector('#__video-recorder-demo-root [data-layer="annotations"]');
    if (!layer) {
      resolve();
      return;
    }

    const ripple = document.createElement("div");
    ripple.className = "vrdemo-ripple";
    ripple.style.transform = `translate(${xPos}px, ${yPos}px) scale(0.4)`;
    ripple.style.opacity = "0.92";
    ripple.style.transition = "transform 260ms ease, opacity 260ms ease";
    layer.append(ripple);

    requestAnimationFrame(() => {
      ripple.style.transform = `translate(${xPos}px, ${yPos}px) scale(1.8)`;
      ripple.style.opacity = "0";
    });

    window.setTimeout(() => {
      ripple.remove();
      resolve();
    }, 280);
  }), {
    xPos: x,
    yPos: y
  });
}

async function resolveBrowserTarget(session, selector) {
  const locator = session.page.locator(selector).first();
  await locator.waitFor({ state: "visible" });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Could not resolve a visible box for selector: ${selector}`);
  }

  return {
    locator,
    box,
    x: roundNumber(box.x + (box.width / 2), 2),
    y: roundNumber(box.y + (box.height / 2), 2)
  };
}

async function annotateBrowserRegion(session, rect, options = {}) {
  if (!session.demoMode) {
    return { shown: false };
  }

  await ensureBrowserDemoOverlay(session);
  const padding = resolveSessionMs(options.padding, 12);
  const durationMs = resolveSessionMs(options.durationMs, session.annotationDurationMs);
  const left = Math.max(0, rect.x - padding);
  const top = Math.max(0, rect.y - padding);
  const width = rect.width + (padding * 2);
  const height = rect.height + (padding * 2);

  await session.page.evaluate((annotation) => new Promise((resolve) => {
    const layer = document.querySelector('#__video-recorder-demo-root [data-layer="annotations"]');
    if (!layer) {
      resolve();
      return;
    }

    const wrapper = document.createElement("div");
    const box = document.createElement("div");
    box.className = "vrdemo-annotation";
    box.dataset.style = annotation.style;
    box.style.left = `${annotation.left}px`;
    box.style.top = `${annotation.top}px`;
    box.style.width = `${annotation.width}px`;
    box.style.height = `${annotation.height}px`;
    wrapper.append(box);

    if (annotation.text) {
      const label = document.createElement("div");
      label.className = "vrdemo-label";
      label.textContent = annotation.text;
      label.style.left = `${annotation.left}px`;
      label.style.top = `${Math.max(16, annotation.top - 56)}px`;
      wrapper.append(label);
    }

    layer.append(wrapper);
    if (annotation.durationMs <= 0) {
      resolve();
      return;
    }

    window.setTimeout(() => {
      wrapper.remove();
      resolve();
    }, annotation.durationMs);
  }), {
    left,
    top,
    width,
    height,
    text: options.text || "",
    style: options.style || "outline",
    durationMs
  });

  return {
    shown: true,
    left,
    top,
    width,
    height,
    durationMs
  };
}

async function clearBrowserAnnotations(session) {
  if (!session.demoMode) {
    return;
  }

  await session.page.evaluate(() => {
    const layer = document.querySelector('#__video-recorder-demo-root [data-layer="annotations"]');
    if (layer) {
      layer.replaceChildren();
    }
  });
}

function captureConsoleEntry(message) {
  const location = message.location();
  return {
    recordedAt: new Date().toISOString(),
    type: message.type(),
    text: message.text(),
    location: location?.url
      ? {
        url: location.url,
        lineNumber: location.lineNumber ?? null,
        columnNumber: location.columnNumber ?? null
      }
      : null
  };
}

function capturePageErrorEntry(error) {
  return {
    recordedAt: new Date().toISOString(),
    message: formatError(error),
    stack: error?.stack || null
  };
}

function attachBrowserDiagnostics(session) {
  if (session.captureConsole) {
    session.page.on("console", (message) => {
      session.consoleMessages.push(captureConsoleEntry(message));
    });
  }

  if (session.capturePageErrors) {
    session.page.on("pageerror", (error) => {
      session.pageErrors.push(capturePageErrorEntry(error));
    });
  }

  if (session.captureNetwork) {
    session.page.on("request", (request) => {
      session.networkEvents.push({
        recordedAt: new Date().toISOString(),
        kind: "request",
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        isNavigationRequest: request.isNavigationRequest()
      });
    });

    session.page.on("response", (response) => {
      const request = response.request();
      session.networkEvents.push({
        recordedAt: new Date().toISOString(),
        kind: "response",
        method: request.method(),
        url: response.url(),
        status: response.status(),
        ok: response.ok(),
        resourceType: request.resourceType(),
        contentType: response.headers()["content-type"] || null
      });
    });

    session.page.on("requestfailed", (request) => {
      session.networkEvents.push({
        recordedAt: new Date().toISOString(),
        kind: "requestfailed",
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText || null
      });
    });
  }
}

function flushBrowserDiagnostics(session) {
  const output = {
    consoleLogPath: null,
    pageErrorsPath: null,
    networkLogPath: null,
    tracePath: session.captureTrace && session.tracePath && fs.existsSync(session.tracePath) ? session.tracePath : null,
    harPath: session.captureHar && session.harPath && fs.existsSync(session.harPath) ? session.harPath : null
  };

  if (session.captureConsole && session.consoleMessages.length > 0) {
    output.consoleLogPath = writeJsonlFile(
      path.join(session.job.diagnosticsDir, `${session.outputStem}-console.jsonl`),
      session.consoleMessages
    );
  }

  if (session.capturePageErrors && session.pageErrors.length > 0) {
    output.pageErrorsPath = writeJsonlFile(
      path.join(session.job.diagnosticsDir, `${session.outputStem}-page-errors.jsonl`),
      session.pageErrors
    );
  }

  if (session.captureNetwork && session.networkEvents.length > 0) {
    output.networkLogPath = writeJsonlFile(
      path.join(session.job.diagnosticsDir, `${session.outputStem}-network.jsonl`),
      session.networkEvents
    );
  }

  writeJson(
    path.join(session.job.diagnosticsDir, `${session.outputStem}-diagnostics-summary.json`),
    {
      generatedAt: new Date().toISOString(),
      sessionId: session.sessionId,
      browser: session.browserName,
      mode: session.mode,
      consoleMessages: session.consoleMessages.length,
      pageErrors: session.pageErrors.length,
      networkEvents: session.networkEvents.length,
      ...output
    }
  );

  return output;
}

function getBrowserSession(sessionId) {
  const session = browserSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown browser session: ${sessionId}`);
  }

  return session;
}

async function startScreenRecording(args = {}) {
  const sessionId = randomUUID();
  const name = sanitizeFileStem(args.name || "screen-recording");
  const job = createVideoJob({
    jobDir: args.jobDir,
    rootDir: args.rootDir,
    name,
    kind: "screen-recording",
    mode: args.mode || "screen"
  });
  const outputPath = path.resolve(expandHome(args.outputPath || path.join(job.rawDir, `${name}.mp4`)));
  const videoDeviceIndex = Number.isFinite(args.videoDeviceIndex) ? String(args.videoDeviceIndex) : "0";
  const framerate = Number.isFinite(args.framerate) ? String(args.framerate) : "30";
  const captureCursor = args.captureCursor === false ? "0" : "1";
  ensureDir(path.dirname(outputPath));

  const ffmpegArgs = [
    "-y",
    "-f",
    "avfoundation",
    "-capture_cursor",
    captureCursor,
    "-framerate",
    framerate,
    "-i",
    `${videoDeviceIndex}:none`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    outputPath
  ];

  const process = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stderr = "";
  process.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1500);
    process.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg exited early with code ${code}: ${stderr}`));
    });
  });

  const session = {
    sessionId,
    name,
    job,
    outputPath,
    process,
    ffmpegArgs,
    startedAt: Date.now(),
    stopped: false
  };

  screenSessions.set(sessionId, session);
  appendJobEvent(job, "screen_recording_started", {
    sessionId,
    outputPath,
    framerate: Number(framerate),
    videoDeviceIndex: Number(videoDeviceIndex),
    captureCursor: captureCursor === "1"
  });
  updateJobMetadata(job, {
    metadata: {
      lastScreenRecordingPath: outputPath
    }
  });

  return {
    sessionId,
    outputPath,
    jobDir: job.jobDir,
    manifestPath: job.manifestPath,
    ffmpegArgs
  };
}

async function stopScreenSession(sessionId) {
  const session = screenSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown screen recording session: ${sessionId}`);
  }

  if (session.stopped) {
    return {
      sessionId,
      outputPath: session.outputPath,
      jobDir: session.job.jobDir,
      manifestPath: session.job.manifestPath,
      stopped: true
    };
  }

  session.stopped = true;
  session.process.stdin.write("q\n");

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.process.kill("SIGINT");
    }, 1500);

    session.process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  appendJobEvent(session.job, "screen_recording_stopped", {
    sessionId,
    outputPath: session.outputPath,
    elapsedSeconds: roundNumber((Date.now() - session.startedAt) / 1000, 3)
  });
  screenSessions.delete(sessionId);
  return {
    sessionId,
    outputPath: session.outputPath,
    jobDir: session.job.jobDir,
    manifestPath: session.job.manifestPath,
    stopped: true
  };
}

async function startBrowserSession(args = {}) {
  const sessionId = randomUUID();
  const browserName = args.browser || "chromium";
  const engine = browserEngine(browserName);
  const width = Number.isFinite(args.width) ? args.width : 1440;
  const height = Number.isFinite(args.height) ? args.height : 900;
  const profile = createBrowserDemoProfile(args, width, height);
  const name = sanitizeFileStem(args.name || args.jobName || `${profile.mode}-browser-session`);
  const job = createVideoJob({
    jobDir: args.jobDir,
    rootDir: args.rootDir,
    name,
    kind: "browser-session",
    mode: profile.mode,
    notes: args.notes
  });
  const recordDir = path.resolve(expandHome(args.recordDir || job.rawDir));
  const tracePath = profile.captureTrace ? path.join(job.diagnosticsDir, `${name}-trace.zip`) : null;
  const harPath = profile.captureHar ? path.join(job.diagnosticsDir, `${name}.har`) : null;
  ensureDir(recordDir);

  const contextOptions = {
    viewport: { width, height },
    recordVideo: {
      dir: recordDir,
      size: { width, height }
    }
  };

  if (harPath) {
    contextOptions.recordHar = {
      path: harPath,
      mode: "full",
      content: "attach"
    };
  }

  const browser = await engine.launch({
    headless: args.headless === true
  });
  const context = await browser.newContext(contextOptions);
  if (tracePath) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false
    });
  }
  const page = await context.newPage();

  const session = {
    sessionId,
    browserName,
    browser,
    context,
    page,
    job,
    recordDir,
    tracePath,
    harPath,
    outputStem: name,
    startedAt: Date.now(),
    consoleMessages: [],
    pageErrors: [],
    networkEvents: [],
    ...profile
  };
  browserSessions.set(sessionId, session);
  attachBrowserDiagnostics(session);

  updateJobMetadata(job, {
    metadata: {
      browser: browserName,
      viewport: { width, height },
      mode: profile.mode,
      recordDir,
      tracePath,
      harPath
    }
  });
  appendSessionEvent(session, "browser_session_started", {
    browser: browserName,
    recordDir,
    demoMode: session.demoMode,
    showCursor: session.showCursor,
    captureConsole: session.captureConsole,
    capturePageErrors: session.capturePageErrors,
    captureNetwork: session.captureNetwork,
    captureTrace: session.captureTrace,
    captureHar: session.captureHar
  });

  if (args.url) {
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
  }
  await ensureBrowserDemoOverlay(session);
  if (session.showCursor) {
    await moveBrowserCursor(session, session.cursorPosition.x, session.cursorPosition.y, { durationMs: 0 });
  }
  if (args.url) {
    appendSessionEvent(session, "browser_navigate", {
      url: page.url(),
      automatic: true
    });
    if (session.demoMode) {
      await waitForBrowserDelay(session, session.navigationSettlingMs, 0.1);
    }
  }

  return {
    sessionId,
    browser: browserName,
    url: args.url || null,
    recordDir,
    jobDir: job.jobDir,
    manifestPath: job.manifestPath,
    mode: session.mode,
    demoMode: session.demoMode,
    showCursor: session.showCursor,
    diagnostics: {
      captureConsole: session.captureConsole,
      capturePageErrors: session.capturePageErrors,
      captureNetwork: session.captureNetwork,
      captureTrace: session.captureTrace,
      captureHar: session.captureHar
    }
  };
}

async function performBrowserNavigate(session, args = {}) {
  await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
  await ensureBrowserDemoOverlay(session);
  if (session.showCursor && session.cursorPosition) {
    await moveBrowserCursor(session, session.cursorPosition.x, session.cursorPosition.y, { durationMs: 0 });
  }

  const settleMs = resolveSessionMs(args.settleMs, session.navigationSettlingMs);
  if (session.demoMode) {
    await waitForBrowserDelay(session, settleMs, 0.1);
  }

  const result = {
    sessionId: session.sessionId,
    url: session.page.url(),
    settleMs
  };
  appendSessionEvent(session, "browser_navigate", {
    url: result.url,
    settleMs
  });
  return result;
}

async function performBrowserClick(session, args = {}) {
  const target = await resolveBrowserTarget(session, args.selector);
  if (session.demoMode) {
    await moveBrowserCursor(session, target.x, target.y, { durationMs: args.moveDurationMs });
    if (args.annotationText) {
      await annotateBrowserRegion(session, target.box, {
        text: args.annotationText,
        style: args.annotationStyle || "outline",
        durationMs: Math.min(session.annotationDurationMs, 1000)
      });
    }
    await waitForBrowserDelay(session, session.clickHoldMs, 0.14);
    await Promise.all([
      playBrowserClickEffect(session, target.x, target.y),
      target.locator.click({ delay: session.clickHoldMs })
    ]);
    await waitForBrowserDelay(session, resolveSessionMs(args.settleMs, session.actionDelayMs), 0.16);
  } else {
    await target.locator.click();
  }

  const result = {
    sessionId: session.sessionId,
    selector: args.selector,
    clicked: true,
    x: target.x,
    y: target.y
  };
  appendSessionEvent(session, "browser_click", {
    selector: args.selector,
    x: target.x,
    y: target.y
  });
  return result;
}

async function performBrowserFill(session, args = {}) {
  const target = await resolveBrowserTarget(session, args.selector);
  const clearFirst = args.clearFirst !== false;
  if (session.demoMode) {
    await moveBrowserCursor(session, target.x, target.y);
    await waitForBrowserDelay(session, session.clickHoldMs, 0.12);
    await Promise.all([
      playBrowserClickEffect(session, target.x, target.y),
      target.locator.click({ delay: session.clickHoldMs })
    ]);
    if (clearFirst) {
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await session.page.keyboard.press(`${modifier}+A`);
      await session.page.waitForTimeout(70);
      await session.page.keyboard.press("Backspace");
    }

    await session.page.keyboard.type(args.value, {
      delay: resolveSessionMs(args.typingDelayMs, session.typingDelayMs)
    });
    await waitForBrowserDelay(session, resolveSessionMs(args.settleMs, Math.max(260, session.actionDelayMs - 140)), 0.14);
  } else {
    await target.locator.fill(args.value);
  }

  const result = {
    sessionId: session.sessionId,
    selector: args.selector,
    filled: true,
    length: String(args.value || "").length
  };
  appendSessionEvent(session, "browser_fill", {
    selector: args.selector,
    valueLength: String(args.value || "").length,
    clearFirst
  });
  return result;
}

async function performBrowserPress(session, args = {}) {
  if (args.selector) {
    const target = await resolveBrowserTarget(session, args.selector);
    if (session.demoMode) {
      await moveBrowserCursor(session, target.x, target.y);
      await waitForBrowserDelay(session, session.clickHoldMs, 0.12);
      await Promise.all([
        playBrowserClickEffect(session, target.x, target.y),
        target.locator.click({ delay: session.clickHoldMs })
      ]);
      await target.locator.press(args.key);
      await waitForBrowserDelay(session, resolveSessionMs(args.settleMs, Math.max(220, session.actionDelayMs - 180)), 0.12);
    } else {
      await target.locator.press(args.key);
    }
  } else {
    await session.page.keyboard.press(args.key);
    if (session.demoMode) {
      await waitForBrowserDelay(session, resolveSessionMs(args.settleMs, Math.max(180, session.actionDelayMs - 220)), 0.12);
    }
  }

  const result = {
    sessionId: session.sessionId,
    key: args.key,
    selector: args.selector || null
  };
  appendSessionEvent(session, "browser_press", {
    key: args.key,
    selector: args.selector || null
  });
  return result;
}

async function performBrowserAnnotate(session, args = {}) {
  let rect = null;

  if (args.selector) {
    const target = await resolveBrowserTarget(session, args.selector);
    rect = target.box;
    if (session.demoMode && session.showCursor) {
      await moveBrowserCursor(session, target.x, target.y, { durationMs: 260 });
    }
  } else if ([args.x, args.y, args.width, args.height].every((value) => Number.isFinite(value))) {
    rect = {
      x: args.x,
      y: args.y,
      width: args.width,
      height: args.height
    };
  } else {
    throw new Error("browser_annotate requires either selector or x/y/width/height.");
  }

  const annotation = await annotateBrowserRegion(session, rect, {
    text: args.text,
    style: args.style || "outline",
    durationMs: args.durationMs,
    padding: args.padding
  });

  appendSessionEvent(session, "browser_annotate", {
    selector: args.selector || null,
    text: args.text || null,
    style: args.style || "outline",
    durationMs: annotation.durationMs
  });

  return {
    sessionId: session.sessionId,
    ...annotation
  };
}

async function performBrowserClearAnnotations(session) {
  await clearBrowserAnnotations(session);
  appendSessionEvent(session, "browser_clear_annotations");
  return {
    sessionId: session.sessionId,
    cleared: true
  };
}

async function performBrowserWait(session, args = {}) {
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 1000;
  if (args.selector) {
    await session.page.waitForSelector(args.selector, { timeout: timeoutMs });
    if (session.demoMode) {
      await waitForBrowserDelay(session, Math.min(timeoutMs, 260), 0.08);
    }
  } else {
    await session.page.waitForTimeout(timeoutMs);
  }

  appendSessionEvent(session, "browser_wait", {
    selector: args.selector || null,
    timeoutMs
  });
  return {
    sessionId: session.sessionId,
    selector: args.selector || null,
    timeoutMs
  };
}

async function performBrowserScreenshot(session, args = {}) {
  const outputPath = resolveJobArtifactPath(
    session.job,
    "screens",
    `${session.outputStem}-shot`,
    "png",
    args.outputPath
  );
  await session.page.screenshot({
    path: outputPath,
    fullPage: args.fullPage === true
  });
  appendSessionEvent(session, "browser_screenshot", {
    outputPath,
    fullPage: args.fullPage === true
  });
  return {
    sessionId: session.sessionId,
    outputPath
  };
}

async function performBrowserMark(session, args = {}) {
  if (!args.label) {
    throw new Error("browser_mark requires a label.");
  }

  let screenshotPath = null;
  if (args.screenshot === true) {
    const screenshot = await performBrowserScreenshot(session, {
      outputPath: args.outputPath,
      fullPage: args.fullPage
    });
    screenshotPath = screenshot.outputPath;
  }

  appendSessionEvent(session, "browser_mark", {
    label: args.label,
    note: args.note || null,
    screenshotPath
  });
  return {
    sessionId: session.sessionId,
    label: args.label,
    note: args.note || null,
    screenshotPath
  };
}

async function performBrowserExpect(session, args = {}) {
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 1200;
  if (!args.selector && !args.text) {
    throw new Error("browser_expect requires either selector or text.");
  }

  try {
    if (args.selector) {
      await session.page.waitForSelector(args.selector, {
        timeout: timeoutMs,
        state: args.state || "visible"
      });
    } else {
      const locator = args.exact === true
        ? session.page.getByText(args.text, { exact: true }).first()
        : session.page.getByText(args.text).first();
      await locator.waitFor({
        timeout: timeoutMs,
        state: args.state || "visible"
      });
    }

    appendSessionEvent(session, "browser_expect_passed", {
      selector: args.selector || null,
      text: args.text || null,
      timeoutMs
    });
    return {
      sessionId: session.sessionId,
      ok: true,
      selector: args.selector || null,
      text: args.text || null,
      timeoutMs
    };
  } catch (error) {
    let screenshotPath = null;
    if (args.screenshotOnFail !== false) {
      const screenshot = await performBrowserScreenshot(session, {
        outputPath: args.failureShotPath
      });
      screenshotPath = screenshot.outputPath;
    }

    const message = formatError(error);
    appendSessionEvent(session, "browser_expect_failed", {
      selector: args.selector || null,
      text: args.text || null,
      timeoutMs,
      error: message,
      screenshotPath
    });
    return {
      sessionId: session.sessionId,
      ok: false,
      selector: args.selector || null,
      text: args.text || null,
      timeoutMs,
      error: message,
      screenshotPath
    };
  }
}

async function exportRecordedBrowserVideo(recordedPath, targetPath) {
  const resolvedTargetPath = path.resolve(expandHome(targetPath));
  ensureDir(path.dirname(resolvedTargetPath));

  if (resolvedTargetPath.toLowerCase().endsWith(".mp4")) {
    await execFile("ffmpeg", [
      "-y",
      "-i",
      recordedPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      resolvedTargetPath
    ]);
    return resolvedTargetPath;
  }

  fs.copyFileSync(recordedPath, resolvedTargetPath);
  return resolvedTargetPath;
}

async function closeBrowserSession(sessionId, saveAs) {
  const session = browserSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown browser session: ${sessionId}`);
  }

  const page = session.page;
  const finalUrl = page.url();
  const video = page.video();
  let traceStopError = null;

  appendSessionEvent(session, "browser_session_closing", {
    url: finalUrl
  });

  if (session.captureTrace && session.tracePath) {
    try {
      await session.context.tracing.stop({ path: session.tracePath });
    } catch (error) {
      traceStopError = formatError(error);
    }
  }

  await session.context.close();
  await session.browser.close();

  let recordedPath = null;
  if (video) {
    recordedPath = await video.path();
  }

  let finalVideoPath = null;
  let exportWarning = traceStopError;
  if (recordedPath) {
    const requestedTargetPath = path.resolve(expandHome(saveAs || path.join(session.job.finalDir, `${session.outputStem}.mp4`)));
    try {
      finalVideoPath = await exportRecordedBrowserVideo(recordedPath, requestedTargetPath);
    } catch (error) {
      const fallbackPath = path.join(session.job.finalDir, `${session.outputStem}.webm`);
      fs.copyFileSync(recordedPath, fallbackPath);
      finalVideoPath = fallbackPath;
      const fallbackMessage = `Video export fallback to raw WebM: ${formatError(error)}`;
      exportWarning = exportWarning ? `${exportWarning}; ${fallbackMessage}` : fallbackMessage;
    }
  }

  const diagnostics = flushBrowserDiagnostics(session);
  updateJobMetadata(session.job, {
    metadata: {
      lastRawVideoPath: recordedPath,
      lastFinalVideoPath: finalVideoPath,
      lastDiagnostics: diagnostics
    }
  });
  appendSessionEvent(session, "browser_session_closed", {
    url: finalUrl,
    rawVideoPath: recordedPath,
    finalVideoPath,
    exportWarning,
    diagnostics
  });
  browserSessions.delete(sessionId);

  return {
    sessionId,
    jobDir: session.job.jobDir,
    manifestPath: session.job.manifestPath,
    url: finalUrl,
    mode: session.mode,
    rawVideoPath: recordedPath,
    finalVideoPath,
    diagnostics,
    exportWarning
  };
}

async function runBrowserFlowStep(session, step = {}) {
  const action = String(step.action || "").trim().toLowerCase();

  if (action === "navigate" || action === "goto") {
    return performBrowserNavigate(session, step);
  }
  if (action === "click") {
    return performBrowserClick(session, step);
  }
  if (action === "fill") {
    return performBrowserFill(session, step);
  }
  if (action === "press") {
    return performBrowserPress(session, step);
  }
  if (action === "annotate") {
    return performBrowserAnnotate(session, step);
  }
  if (action === "clear_annotations" || action === "clearannotations" || action === "clear") {
    return performBrowserClearAnnotations(session);
  }
  if (action === "wait") {
    return performBrowserWait(session, step);
  }
  if (action === "screenshot") {
    return performBrowserScreenshot(session, step);
  }
  if (action === "mark") {
    return performBrowserMark(session, step);
  }
  if (action === "expect") {
    return performBrowserExpect(session, step);
  }

  throw new Error(`Unsupported browser flow action: ${step.action}`);
}

async function recordBrowserFlow(args = {}) {
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    throw new Error("record_browser_flow requires a non-empty steps array.");
  }

  const started = await startBrowserSession(args);
  const results = [];
  let failure = null;

  try {
    const session = getBrowserSession(started.sessionId);
    appendSessionEvent(session, "browser_flow_started", {
      stepCount: args.steps.length
    });

    for (let index = 0; index < args.steps.length; index += 1) {
      const step = args.steps[index];
      try {
        const result = await runBrowserFlowStep(session, step);
        results.push({
          index,
          action: step.action,
          ok: result?.ok !== false,
          result
        });

        if (String(step.action || "").trim().toLowerCase() === "expect" && result?.ok === false && step.stopOnFailure !== false) {
          failure = {
            index,
            action: step.action,
            error: result.error || "Expectation failed",
            result
          };
          break;
        }
      } catch (error) {
        const message = formatError(error);
        results.push({
          index,
          action: step.action,
          ok: false,
          error: message
        });
        appendSessionEvent(session, "browser_flow_step_failed", {
          stepIndex: index,
          action: step.action,
          error: message
        });
        if (args.stopOnError !== false && step.stopOnFailure !== false) {
          failure = {
            index,
            action: step.action,
            error: message
          };
          break;
        }
      }
    }
  } finally {
    // Always finalize the video bundle even on a failed step.
  }

  const closeResult = await closeBrowserSession(started.sessionId, args.outputPath || args.saveAs);
  appendJobEvent(buildJobLayout(closeResult.jobDir), "browser_flow_finished", {
    ok: !failure,
    failedStepIndex: failure?.index ?? null,
    failedAction: failure?.action ?? null,
    stepCount: args.steps.length
  });

  return {
    ok: !failure,
    started,
    closeResult,
    stepResults: results,
    failure
  };
}

async function probeVideo(inputPath) {
  const { stdout } = await execFile("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath
  ]);

  const probe = JSON.parse(stdout);
  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === "video") || null;
  const audioStream = (probe.streams || []).find((stream) => stream.codec_type === "audio") || null;
  const durationSeconds = Number(probe.format?.duration || videoStream?.duration || 0);

  return {
    raw: probe,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    formatName: probe.format?.format_name || null,
    sizeBytes: Number(probe.format?.size || 0) || 0,
    bitRate: Number(probe.format?.bit_rate || 0) || 0,
    videoStream,
    audioStream,
    width: videoStream?.width || null,
    height: videoStream?.height || null,
    frameRate: parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate),
    videoCodec: videoStream?.codec_name || null,
    audioCodec: audioStream?.codec_name || null
  };
}

async function extractFrameAtTimestamp(inputPath, timestampSeconds, outputPath) {
  await execFile("ffmpeg", [
    "-y",
    "-ss",
    String(timestampSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    outputPath
  ]);
}

async function buildContactSheet(framesDir, outputPath, frameCount) {
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(frameCount))));
  const rows = Math.max(1, Math.ceil(frameCount / cols));

  await execFile("ffmpeg", [
    "-y",
    "-framerate",
    "1",
    "-i",
    path.join(framesDir, "frame-%03d.png"),
    "-frames:v",
    "1",
    "-vf",
    `scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black,tile=${cols}x${rows}:padding=8:margin=8`,
    outputPath
  ]);
}

async function detectScenes(inputPath, outputDir, threshold, maxSceneFrames) {
  const sceneDir = path.join(outputDir, "scene-cuts");
  ensureDir(sceneDir);
  const safeThreshold = Number.isFinite(threshold) ? threshold : 0.35;
  const safeMaxSceneFrames = Math.max(1, Math.min(24, Math.floor(maxSceneFrames || 8)));

  try {
    const { stderr } = await execFile("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `select='gt(scene,${safeThreshold})',showinfo`,
      "-fps_mode",
      "vfr",
      "-frames:v",
      String(safeMaxSceneFrames),
      path.join(sceneDir, "scene-%03d.png")
    ]);

    const timestamps = Array.from(stderr.matchAll(/pts_time:([0-9.]+)/g)).map((match) => Number(match[1]));
    return timestamps
      .slice(0, safeMaxSceneFrames)
      .map((timestamp, index) => ({
        timestampSeconds: roundNumber(timestamp, 3),
        path: path.join(sceneDir, `scene-${String(index + 1).padStart(3, "0")}.png`)
      }))
      .filter((scene) => fs.existsSync(scene.path));
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    if (output.includes("Output file is empty")) {
      return [];
    }
    throw error;
  }
}

async function createWaveformImage(inputPath, outputPath) {
  await execFile("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-filter_complex",
    "aformat=channel_layouts=mono,showwavespic=s=1600x240:colors=white",
    "-frames:v",
    "1",
    outputPath
  ]);
}

async function analyzeVideo(inputPath, options = {}) {
  const resolvedInputPath = path.resolve(expandHome(inputPath));
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Video file not found: ${resolvedInputPath}`);
  }

  const job = (options.jobDir || options.rootDir)
    ? createVideoJob({
      jobDir: options.jobDir,
      rootDir: options.rootDir,
      name: options.name || sanitizeFileStem(resolvedInputPath),
      kind: "video-analysis",
      mode: options.mode || null
    })
    : null;
  const defaultDir = job
    ? job.analysisDir
    : path.join(defaultOutputRoot(), "analysis", `${sanitizeFileStem(resolvedInputPath)}-${isoStamp()}`);
  const outputDir = path.resolve(expandHome(options.outputDir || defaultDir));
  const framesDir = path.join(outputDir, "frames");
  ensureDir(framesDir);

  const probe = await probeVideo(resolvedInputPath);
  const timestamps = sampleTimestamps(probe.durationSeconds, options.sampleCount);
  const sampleFrames = [];

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestampSeconds = timestamps[index];
    const framePath = path.join(framesDir, `frame-${String(index + 1).padStart(3, "0")}.png`);
    await extractFrameAtTimestamp(resolvedInputPath, timestampSeconds, framePath);
    sampleFrames.push({
      index: index + 1,
      timestampSeconds,
      timestampLabel: timestampForFilename(timestampSeconds),
      path: framePath
    });
  }

  let contactSheetPath = null;
  if (sampleFrames.length > 0 && options.createContactSheet !== false) {
    contactSheetPath = path.join(outputDir, "contact-sheet.png");
    await buildContactSheet(framesDir, contactSheetPath, sampleFrames.length);
  }

  let waveformPath = null;
  if (probe.audioStream && options.extractWaveform !== false) {
    waveformPath = path.join(outputDir, "waveform.png");
    await createWaveformImage(resolvedInputPath, waveformPath);
  }

  const scenes = options.detectScenes === false
    ? []
    : await detectScenes(
      resolvedInputPath,
      outputDir,
      options.sceneThreshold,
      options.maxSceneFrames
    );

  const manifest = {
    inputPath: resolvedInputPath,
    outputDir,
    generatedAt: new Date().toISOString(),
    metadata: {
      formatName: probe.formatName,
      sizeBytes: probe.sizeBytes,
      bitRate: probe.bitRate,
      durationSeconds: roundNumber(probe.durationSeconds, 3),
      width: probe.width,
      height: probe.height,
      frameRate: roundNumber(probe.frameRate, 3),
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      hasAudio: Boolean(probe.audioStream)
    },
    sampleFrames,
    scenes,
    contactSheetPath,
    waveformPath
  };

  writeJson(path.join(outputDir, "analysis.json"), manifest);
  if (job) {
    appendJobEvent(job, "video_analyzed", {
      inputPath: resolvedInputPath,
      outputDir,
      sceneCount: scenes.length,
      sampleFrameCount: sampleFrames.length
    });
    updateJobMetadata(job, {
      metadata: {
        lastAnalysisPath: path.join(outputDir, "analysis.json")
      }
    });
  }
  return manifest;
}

function buildTransformFilters(options = {}) {
  const filters = [];
  if ([options.cropWidth, options.cropHeight, options.cropX, options.cropY].every((value) => Number.isFinite(value))) {
    filters.push(`crop=${Math.round(options.cropWidth)}:${Math.round(options.cropHeight)}:${Math.round(options.cropX)}:${Math.round(options.cropY)}`);
  }

  if (Number.isFinite(options.width) && Number.isFinite(options.height)) {
    filters.push(`scale=${Math.round(options.width)}:${Math.round(options.height)}:force_original_aspect_ratio=decrease,pad=${Math.round(options.width)}:${Math.round(options.height)}:(ow-iw)/2:(oh-ih)/2:color=black`);
  } else if (Number.isFinite(options.width)) {
    filters.push(`scale=${Math.round(options.width)}:-2:flags=lanczos`);
  } else if (Number.isFinite(options.height)) {
    filters.push(`scale=-2:${Math.round(options.height)}:flags=lanczos`);
  }

  return filters;
}

async function exportVideoClip(inputPath, options = {}) {
  const resolvedInputPath = path.resolve(expandHome(inputPath));
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Clip input not found: ${resolvedInputPath}`);
  }

  const extensionFromOutput = options.outputPath ? path.extname(options.outputPath).slice(1).toLowerCase() : "";
  const format = (options.format || extensionFromOutput || "mp4").toLowerCase();
  if (!["mp4", "webm", "gif"].includes(format)) {
    throw new Error(`Unsupported clip format: ${format}`);
  }

  const job = (options.jobDir || options.rootDir)
    ? createVideoJob({
      jobDir: options.jobDir,
      rootDir: options.rootDir,
      name: options.name || sanitizeFileStem(resolvedInputPath),
      kind: "clip-export"
    })
    : null;

  const outputPath = path.resolve(expandHome(
    options.outputPath
    || (job
      ? path.join(job.clipsDir, `${sanitizeFileStem(options.name || resolvedInputPath)}.${format}`)
      : defaultOutputPath(`${sanitizeFileStem(resolvedInputPath)}-clip`, format, { subdir: "clips" }))
  ));
  ensureDir(path.dirname(outputPath));

  const probe = await probeVideo(resolvedInputPath);
  const startTime = Number.isFinite(options.startTime) ? Math.max(0, options.startTime) : 0;
  const endTime = Number.isFinite(options.endTime)
    ? Math.max(startTime + 0.05, options.endTime)
    : Number.isFinite(options.duration)
      ? startTime + Math.max(0.05, options.duration)
      : probe.durationSeconds;
  const trimDuration = Math.max(0.05, endTime - startTime);
  const fps = Number.isFinite(options.fps) ? Math.max(1, options.fps) : (format === "gif" ? 12 : 30);
  const transformFilters = buildTransformFilters(options);
  const keepAudio = format !== "gif" && options.mute !== true && Boolean(probe.audioStream);
  const posterFramePath = options.posterFrame === true
    ? path.join(path.dirname(outputPath), `${sanitizeFileStem(outputPath)}-poster.png`)
    : null;

  const ffmpegArgs = ["-y"];
  if (startTime > 0) {
    ffmpegArgs.push("-ss", String(startTime));
  }
  ffmpegArgs.push("-i", resolvedInputPath);
  ffmpegArgs.push("-t", String(trimDuration));

  if (format === "gif") {
    const baseFilters = [...transformFilters, `fps=${fps}`];
    const filterGraph = `${baseFilters.join(",")},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`;
    ffmpegArgs.push(
      "-filter_complex",
      filterGraph,
      "-loop",
      String(Number.isFinite(options.loopCount) ? options.loopCount : 0),
      outputPath
    );
  } else {
    const videoFilters = [...transformFilters, `fps=${fps}`, "format=yuv420p"].join(",");
    ffmpegArgs.push(
      "-vf",
      videoFilters,
      "-map",
      "0:v:0"
    );
    if (keepAudio) {
      ffmpegArgs.push("-map", "0:a:0");
    } else {
      ffmpegArgs.push("-an");
    }

    if (format === "mp4") {
      ffmpegArgs.push(
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart"
      );
      if (keepAudio) {
        ffmpegArgs.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
      }
    } else {
      ffmpegArgs.push(
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "32"
      );
      if (keepAudio) {
        ffmpegArgs.push("-c:a", "libopus");
      }
    }

    ffmpegArgs.push(outputPath);
  }

  await execFile("ffmpeg", ffmpegArgs);

  let posterPath = null;
  if (posterFramePath) {
    const clipProbe = await probeVideo(outputPath);
    await extractFrameAtTimestamp(outputPath, Math.max(0, (clipProbe.durationSeconds || trimDuration) / 2), posterFramePath);
    posterPath = posterFramePath;
  }

  if (job) {
    appendJobEvent(job, "video_clip_exported", {
      inputPath: resolvedInputPath,
      outputPath,
      format,
      startTime,
      endTime,
      posterPath
    });
    updateJobMetadata(job, {
      metadata: {
        lastClipPath: outputPath
      }
    });
  }

  return {
    inputPath: resolvedInputPath,
    outputPath,
    format,
    startTime,
    endTime: roundNumber(endTime, 3),
    durationSeconds: roundNumber(trimDuration, 3),
    posterPath
  };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildTitleCardHtml(options = {}) {
  const title = escapeHtml(options.title || "Demo");
  const subtitle = options.subtitle ? escapeHtml(options.subtitle) : "";
  const eyebrow = escapeHtml(options.eyebrow || "Demo");
  const cardStyle = options.cardStyle || "minimal";

  const theme = cardStyle === "glass"
    ? {
      pageBackground: `
        radial-gradient(circle at 15% 20%, rgba(84, 221, 190, 0.28), transparent 28%),
        radial-gradient(circle at 82% 18%, rgba(72, 131, 255, 0.24), transparent 24%),
        radial-gradient(circle at 74% 80%, rgba(245, 111, 166, 0.20), transparent 28%),
        linear-gradient(140deg, #07111f 0%, #101a2d 48%, #050a14 100%)
      `,
      frameCss: `
        border-radius: 36px;
        background: linear-gradient(160deg, rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.03));
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
        backdrop-filter: blur(20px);
      `,
      eyebrowCss: `
        background: rgba(255, 255, 255, 0.08);
        color: #8fe6d5;
      `,
      titleColor: "#f5f7fb",
      subtitleColor: "#b6c3d8"
    }
    : cardStyle === "light"
      ? {
        pageBackground: "#f3f2ee",
        frameCss: `
          border-radius: 32px;
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid rgba(17, 17, 17, 0.08);
          box-shadow: 0 24px 60px rgba(17, 17, 17, 0.08);
        `,
        eyebrowCss: `
          background: rgba(17, 17, 17, 0.06);
          color: #171717;
        `,
        titleColor: "#0f0f0f",
        subtitleColor: "#444444"
      }
      : {
        pageBackground: "#050505",
        frameCss: `
          border-radius: 0;
          background: transparent;
          border-top: 1px solid rgba(255, 255, 255, 0.18);
          border-bottom: 1px solid rgba(255, 255, 255, 0.18);
        `,
        eyebrowCss: `
          background: transparent;
          color: rgba(255, 255, 255, 0.78);
          border: 1px solid rgba(255, 255, 255, 0.16);
        `,
        titleColor: "#fafafa",
        subtitleColor: "rgba(255, 255, 255, 0.72)"
      };

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root {
        color-scheme: dark;
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: ${theme.pageBackground};
        font-family: "SF Pro Display", "Inter", "Helvetica Neue", sans-serif;
      }

      body {
        position: relative;
        display: grid;
        place-items: center;
      }

      .frame {
        position: relative;
        width: calc(100% - 120px);
        min-height: 46%;
        padding: 56px 64px;
        ${theme.frameCss}
      }

      .eyebrow {
        display: inline-block;
        margin-bottom: 24px;
        padding: 10px 16px;
        border-radius: 999px;
        font-size: 18px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        ${theme.eyebrowCss}
      }

      h1 {
        margin: 0;
        max-width: 900px;
        color: ${theme.titleColor};
        font-size: 76px;
        line-height: 0.94;
        letter-spacing: -0.04em;
        font-weight: 740;
      }

      p {
        margin: 24px 0 0;
        max-width: 820px;
        color: ${theme.subtitleColor};
        font-size: 28px;
        line-height: 1.3;
        letter-spacing: -0.02em;
      }
    </style>
  </head>
  <body>
    <section class="frame">
      <div class="eyebrow">${eyebrow}</div>
      <h1>${title}</h1>
      ${subtitle ? `<p>${subtitle}</p>` : ""}
    </section>
  </body>
</html>`;
}

async function createTitleCardClip(outputPath, options = {}) {
  const width = Number.isFinite(options.width) ? options.width : 1440;
  const height = Number.isFinite(options.height) ? options.height : 900;
  const fps = Number.isFinite(options.fps) ? options.fps : 30;
  const duration = Number.isFinite(options.duration) ? options.duration : 1.8;
  const keepAudio = options.keepAudio !== false;
  const pngPath = `${outputPath}.png`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1
  });

  await page.setContent(buildTitleCardHtml(options), {
    waitUntil: "load"
  });
  await page.screenshot({
    path: pngPath,
    type: "png"
  });
  await page.close();
  await browser.close();

  const ffmpegArgs = [
    "-y",
    "-loop",
    "1",
    "-i",
    pngPath,
    "-t",
    String(duration)
  ];

  if (keepAudio) {
    ffmpegArgs.push(
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo"
    );
  }

  ffmpegArgs.push(
    "-vf",
    `fps=${fps},format=yuv420p`,
    "-map",
    "0:v:0"
  );

  if (keepAudio) {
    ffmpegArgs.push("-map", "1:a:0");
  } else {
    ffmpegArgs.push("-an");
  }

  ffmpegArgs.push(
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps)
  );

  if (keepAudio) {
    ffmpegArgs.push(
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2"
    );
  }

  ffmpegArgs.push(outputPath);
  await execFile("ffmpeg", ffmpegArgs);
}

async function normalizeClip(inputPath, outputPath, options = {}) {
  const resolvedInputPath = path.resolve(expandHome(inputPath));
  const probe = await probeVideo(resolvedInputPath);
  const width = Number.isFinite(options.width) ? options.width : 1440;
  const height = Number.isFinite(options.height) ? options.height : 900;
  const fps = Number.isFinite(options.fps) ? options.fps : 30;
  const keepAudio = options.keepAudio !== false;
  const preRoll = Number.isFinite(options.preRoll) ? Math.max(0, options.preRoll) : 0.25;
  const postRoll = Number.isFinite(options.postRoll) ? Math.max(0, options.postRoll) : 0.45;
  const requestedStart = Number.isFinite(options.startTime) ? Math.max(0, options.startTime) : null;
  const requestedEnd = Number.isFinite(options.endTime) ? Math.max(0, options.endTime) : null;
  const startTime = requestedStart !== null
    ? Math.max(0, requestedStart - preRoll)
    : null;
  const endTime = requestedEnd !== null
    ? Math.min(probe.durationSeconds || requestedEnd + postRoll, requestedEnd + postRoll)
    : null;
  const trimDuration = endTime !== null
    ? Math.max(0.05, endTime - (startTime ?? 0))
    : null;
  const zoomScale = Number.isFinite(options.zoomScale) ? clamp(options.zoomScale, 1, 4) : 1;
  const focusX = Number.isFinite(options.focusX) ? clamp(options.focusX, 0, 1) : 0.5;
  const focusY = Number.isFinite(options.focusY) ? clamp(options.focusY, 0, 1) : 0.5;
  let videoFilter = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;

  if (zoomScale > 1.001) {
    const zoomedWidth = Math.round(width * zoomScale);
    const zoomedHeight = Math.round(height * zoomScale);
    const cropX = Math.round((zoomedWidth - width) * focusX);
    const cropY = Math.round((zoomedHeight - height) * focusY);
    videoFilter += `,scale=${zoomedWidth}:${zoomedHeight},crop=${width}:${height}:${cropX}:${cropY}`;
  }

  videoFilter += ",format=yuv420p";

  const ffmpegArgs = ["-y"];
  if (startTime !== null) {
    ffmpegArgs.push("-ss", String(startTime));
  }
  ffmpegArgs.push("-i", resolvedInputPath);
  if (trimDuration !== null) {
    ffmpegArgs.push("-t", String(trimDuration));
  }

  if (keepAudio && !probe.audioStream) {
    ffmpegArgs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  }

  ffmpegArgs.push(
    "-vf",
    videoFilter,
    "-map",
    "0:v:0"
  );

  if (keepAudio) {
    ffmpegArgs.push("-map", probe.audioStream ? "0:a:0" : "1:a:0");
  } else {
    ffmpegArgs.push("-an");
  }

  ffmpegArgs.push(
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps)
  );

  if (keepAudio) {
    ffmpegArgs.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
  }

  ffmpegArgs.push(outputPath);
  await execFile("ffmpeg", ffmpegArgs);

  const normalizedProbe = await probeVideo(outputPath);
  return {
    path: outputPath,
    durationSeconds: roundNumber(normalizedProbe.durationSeconds, 3) || 0,
    hasAudio: Boolean(normalizedProbe.audioStream)
  };
}

function computeSafeTransitionDuration(segmentDurations, requestedDuration) {
  const finiteDurations = segmentDurations.filter((duration) => Number.isFinite(duration) && duration > 0);
  if (finiteDurations.length < 2) {
    return 0;
  }

  const requested = Number.isFinite(requestedDuration) ? requestedDuration : 0.4;
  const maxAllowed = Math.min(...finiteDurations.map((duration) => duration / 3));
  return roundNumber(Math.max(0, Math.min(requested, maxAllowed)), 3);
}

async function composeDemoVideo(clips, options = {}) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("compose_demo_video requires at least one clip.");
  }

  const job = (options.jobDir || options.rootDir)
    ? createVideoJob({
      jobDir: options.jobDir,
      rootDir: options.rootDir,
      name: options.name || options.introTitle || "demo-composition",
      kind: "demo-composition"
    })
    : null;
  const width = Number.isFinite(options.width) ? options.width : 1440;
  const height = Number.isFinite(options.height) ? options.height : 900;
  const fps = Number.isFinite(options.fps) ? options.fps : 30;
  const keepAudio = options.keepAudio !== false;
  const keepAssets = options.keepAssets === true;
  const cardDuration = Number.isFinite(options.cardDuration) ? options.cardDuration : 2.2;
  const labelCardDuration = Number.isFinite(options.labelCardDuration) ? options.labelCardDuration : 1.6;
  const transition = options.transition || "fade";
  const cardStyle = options.cardStyle || "minimal";
  const defaultOutputPathValue = job
    ? path.join(job.finalDir, `${sanitizeFileStem(options.outputName || options.introTitle || "demo")}.mp4`)
    : defaultOutputPath("demo", "mp4", { subdir: "final" });
  const outputPath = path.resolve(expandHome(options.outputPath || defaultOutputPathValue));
  const workDir = job
    ? path.join(job.assetsDir, sanitizeFileStem(path.basename(outputPath, path.extname(outputPath))))
    : path.join(path.dirname(outputPath), `${sanitizeFileStem(outputPath)}-assets`);
  ensureDir(workDir);

  const segments = [];

  if (options.introTitle) {
    const introPath = path.join(workDir, "segment-000-intro.mp4");
    await createTitleCardClip(introPath, {
      width,
      height,
      fps,
      duration: cardDuration,
      keepAudio,
      cardStyle,
      eyebrow: options.eyebrow || "Intro",
      title: options.introTitle,
      subtitle: options.introSubtitle
    });
    const probe = await probeVideo(introPath);
    segments.push({
      kind: "intro",
      path: introPath,
      durationSeconds: probe.durationSeconds,
      hasAudio: Boolean(probe.audioStream)
    });
  }

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    if (!clip?.inputPath) {
      throw new Error(`Clip ${index + 1} is missing inputPath.`);
    }
    if (Number.isFinite(clip.startTime) && Number.isFinite(clip.endTime) && clip.endTime <= clip.startTime) {
      throw new Error(`Clip ${index + 1} has endTime <= startTime.`);
    }

    if (clip.label) {
      const labelPath = path.join(workDir, `segment-${String(segments.length).padStart(3, "0")}-label.mp4`);
      await createTitleCardClip(labelPath, {
        width,
        height,
        fps,
        duration: labelCardDuration,
        keepAudio,
        cardStyle,
        eyebrow: "Section",
        title: clip.label,
        subtitle: clip.subtitle
      });
      const probe = await probeVideo(labelPath);
      segments.push({
        kind: "label",
        path: labelPath,
        durationSeconds: probe.durationSeconds,
        hasAudio: Boolean(probe.audioStream)
      });
    }

    const normalizedPath = path.join(workDir, `segment-${String(segments.length).padStart(3, "0")}-clip.mp4`);
    const normalized = await normalizeClip(clip.inputPath, normalizedPath, {
      width,
      height,
      fps,
      keepAudio,
      startTime: clip.startTime,
      endTime: clip.endTime,
      preRoll: clip.preRoll,
      postRoll: clip.postRoll,
      zoomScale: clip.zoomScale,
      focusX: clip.focusX,
      focusY: clip.focusY
    });
    segments.push({
      kind: "clip",
      path: normalized.path,
      durationSeconds: normalized.durationSeconds,
      hasAudio: normalized.hasAudio
    });
  }

  if (options.outroTitle) {
    const outroPath = path.join(workDir, `segment-${String(segments.length).padStart(3, "0")}-outro.mp4`);
    await createTitleCardClip(outroPath, {
      width,
      height,
      fps,
      duration: cardDuration,
      keepAudio,
      cardStyle,
      eyebrow: options.outroEyebrow || "Outro",
      title: options.outroTitle,
      subtitle: options.outroSubtitle
    });
    const probe = await probeVideo(outroPath);
    segments.push({
      kind: "outro",
      path: outroPath,
      durationSeconds: probe.durationSeconds,
      hasAudio: Boolean(probe.audioStream)
    });
  }

  if (segments.length === 0) {
    throw new Error("No segments were created for compose_demo_video.");
  }

  if (segments.length === 1) {
    fs.copyFileSync(segments[0].path, outputPath);
    const finalProbe = await probeVideo(outputPath);
    if (!keepAssets) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    if (job) {
      appendJobEvent(job, "demo_composed", {
        outputPath,
        transition: "none",
        segmentCount: 1
      });
      updateJobMetadata(job, {
        metadata: {
          lastComposedVideoPath: outputPath
        }
      });
    }
    return {
      outputPath,
      transition: "none",
      segmentCount: 1,
      durationSeconds: roundNumber(finalProbe.durationSeconds, 3),
      keptAssets: keepAssets,
      assetDir: keepAssets ? workDir : null
    };
  }

  const includeAudio = keepAudio && segments.every((segment) => segment.hasAudio);
  const safeTransitionDuration = transition === "none"
    ? 0
    : computeSafeTransitionDuration(
      segments.map((segment) => segment.durationSeconds),
      options.transitionDuration
    );

  const ffmpegArgs = ["-y"];
  for (const segment of segments) {
    ffmpegArgs.push("-i", segment.path);
  }

  const filterParts = [];
  if (safeTransitionDuration <= 0) {
    if (includeAudio) {
      const concatInputs = segments.map((_, index) => `[${index}:v][${index}:a]`).join("");
      filterParts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[vout][aout]`);
    } else {
      const concatInputs = segments.map((_, index) => `[${index}:v]`).join("");
      filterParts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=0[vout]`);
    }
  } else {
    let currentVideoLabel = "0:v";
    let currentAudioLabel = includeAudio ? "0:a" : null;
    let currentTimelineDuration = segments[0].durationSeconds;

    for (let index = 1; index < segments.length; index += 1) {
      const videoOut = `vxf${index}`;
      const audioOut = `axf${index}`;
      const offset = roundNumber(Math.max(0, currentTimelineDuration - safeTransitionDuration), 3);
      filterParts.push(
        `[${currentVideoLabel}][${index}:v]xfade=transition=${transition}:duration=${safeTransitionDuration}:offset=${offset}[${videoOut}]`
      );

      if (includeAudio) {
        filterParts.push(
          `[${currentAudioLabel}][${index}:a]acrossfade=d=${safeTransitionDuration}:c1=tri:c2=tri[${audioOut}]`
        );
      }

      currentVideoLabel = videoOut;
      currentAudioLabel = includeAudio ? audioOut : null;
      currentTimelineDuration += segments[index].durationSeconds - safeTransitionDuration;
    }

    filterParts.push(`[${currentVideoLabel}]copy[vout]`);
    if (includeAudio) {
      filterParts.push(`[${currentAudioLabel}]acopy[aout]`);
    }
  }

  ffmpegArgs.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[vout]"
  );

  if (includeAudio) {
    ffmpegArgs.push("-map", "[aout]");
  }

  ffmpegArgs.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-preset",
    "veryfast"
  );

  if (includeAudio) {
    ffmpegArgs.push(
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2"
    );
  } else {
    ffmpegArgs.push("-an");
  }

  ffmpegArgs.push(outputPath);
  await execFile("ffmpeg", ffmpegArgs);
  const finalProbe = await probeVideo(outputPath);
  if (!keepAssets) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const result = {
    outputPath,
    assetDir: keepAssets ? workDir : null,
    keptAssets: keepAssets,
    transition,
    transitionDuration: safeTransitionDuration,
    segmentCount: segments.length,
    durationSeconds: roundNumber(finalProbe.durationSeconds, 3),
    segments: segments.map((segment, index) => ({
      index,
      kind: segment.kind,
      path: keepAssets ? segment.path : null,
      durationSeconds: roundNumber(segment.durationSeconds, 3)
    }))
  };

  if (job) {
    appendJobEvent(job, "demo_composed", {
      outputPath,
      transition,
      transitionDuration: safeTransitionDuration,
      segmentCount: segments.length
    });
    updateJobMetadata(job, {
      metadata: {
        lastComposedVideoPath: outputPath
      }
    });
  }
  return result;
}

function buildHighlightCandidates(analysis, options = {}) {
  const durationSeconds = Number(analysis?.metadata?.durationSeconds || 0);
  const clipDuration = Number.isFinite(options.clipDuration) ? clamp(options.clipDuration, 1.5, 20) : 5;
  const maxClips = Math.max(1, Math.min(12, Math.floor(options.maxClips || 4)));
  const minSpacingSeconds = Number.isFinite(options.minSpacingSeconds) ? Math.max(0.5, options.minSpacingSeconds) : Math.max(clipDuration * 0.55, 2);

  let anchors = (analysis.scenes || []).map((scene) => ({
    timestampSeconds: scene.timestampSeconds,
    reason: "scene change"
  }));
  if (anchors.length === 0) {
    anchors = (analysis.sampleFrames || []).map((frame) => ({
      timestampSeconds: frame.timestampSeconds,
      reason: "sample frame"
    }));
  }
  if (anchors.length === 0 && durationSeconds > 0) {
    anchors = sampleTimestamps(durationSeconds, maxClips).map((timestampSeconds) => ({
      timestampSeconds,
      reason: "even sample"
    }));
  }

  const clips = [];
  let lastStart = -Infinity;
  for (const anchor of anchors) {
    if (clips.length >= maxClips) {
      break;
    }
    let startTime = Math.max(0, anchor.timestampSeconds - (clipDuration * 0.35));
    let endTime = Math.min(durationSeconds || anchor.timestampSeconds + clipDuration, startTime + clipDuration);
    startTime = Math.max(0, endTime - clipDuration);
    if ((startTime - lastStart) < minSpacingSeconds) {
      continue;
    }
    lastStart = startTime;
    clips.push({
      label: `Highlight ${clips.length + 1}`,
      reason: anchor.reason,
      startTime: roundNumber(startTime, 3),
      endTime: roundNumber(endTime, 3)
    });
  }

  return clips.slice(0, maxClips);
}

async function suggestHighlightClips(inputPath, options = {}) {
  const sharedJob = (options.jobDir || options.rootDir)
    ? createVideoJob({
      jobDir: options.jobDir,
      rootDir: options.rootDir,
      name: options.name || sanitizeFileStem(inputPath),
      kind: "highlight-suggestion"
    })
    : null;
  const analysisPath = options.analysisPath
    ? path.resolve(expandHome(options.analysisPath))
    : null;
  const analysis = analysisPath
    ? readJsonIfExists(analysisPath)
    : await analyzeVideo(inputPath, {
      ...options,
      jobDir: sharedJob?.jobDir || options.jobDir
    });
  if (!analysis) {
    throw new Error("Could not load analysis data for highlight suggestion.");
  }

  const job = sharedJob;
  const clips = buildHighlightCandidates(analysis, options);
  const outputPath = path.resolve(expandHome(
    options.outputPath
    || path.join((job?.analysisDir || analysis.outputDir), "highlights.json")
  ));
  ensureDir(path.dirname(outputPath));

  const payload = {
    generatedAt: new Date().toISOString(),
    inputPath: analysis.inputPath || path.resolve(expandHome(inputPath)),
    analysisOutputDir: analysis.outputDir || path.dirname(outputPath),
    clipDuration: Number.isFinite(options.clipDuration) ? options.clipDuration : 5,
    maxClips: clips.length,
    clips
  };
  writeJson(outputPath, payload);
  if (job) {
    appendJobEvent(job, "highlight_clips_suggested", {
      outputPath,
      clipCount: clips.length
    });
  }
  return payload;
}

async function composeHighlightVideo(inputPath, options = {}) {
  const sharedJob = (options.jobDir || options.rootDir)
    ? createVideoJob({
      jobDir: options.jobDir,
      rootDir: options.rootDir,
      name: options.name || sanitizeFileStem(inputPath),
      kind: "highlight-composition"
    })
    : null;
  const sharedOptions = sharedJob
    ? {
      ...options,
      jobDir: sharedJob.jobDir
    }
    : options;
  const suggestion = await suggestHighlightClips(inputPath, sharedOptions);
  const clips = suggestion.clips.map((clip) => ({
    inputPath: suggestion.inputPath,
    startTime: clip.startTime,
    endTime: clip.endTime,
    label: options.includeLabels === true ? clip.label : undefined,
    subtitle: options.includeLabels === true ? clip.reason : undefined,
    preRoll: options.preRoll,
    postRoll: options.postRoll
  }));

  const composition = await composeDemoVideo(clips, {
    ...sharedOptions,
    outputPath: options.outputPath,
    introTitle: options.introTitle,
    introSubtitle: options.introSubtitle,
    outroTitle: options.outroTitle,
    outroSubtitle: options.outroSubtitle
  });

  return {
    ...composition,
    suggestion
  };
}

async function getCommandVersion(command) {
  try {
    const { stdout, stderr } = await execFile(command, ["-version"]);
    return {
      available: true,
      version: pickFirstLine(stdout) || pickFirstLine(stderr)
    };
  } catch (error) {
    return {
      available: false,
      error: formatError(error)
    };
  }
}

async function checkPlaywrightBrowserAvailability(browserName) {
  try {
    const engine = browserEngine(browserName);
    const browser = await engine.launch({ headless: true });
    await browser.close();
    return {
      available: true
    };
  } catch (error) {
    return {
      available: false,
      error: formatError(error)
    };
  }
}

async function runDoctor() {
  const ffmpeg = await getCommandVersion("ffmpeg");
  const ffprobe = await getCommandVersion("ffprobe");
  const chromiumCheck = await checkPlaywrightBrowserAvailability("chromium");
  const advice = [];
  if (!ffmpeg.available) {
    advice.push("Install ffmpeg for MP4 export, GIF export, screen capture, and composition.");
  }
  if (!ffprobe.available) {
    advice.push("Install ffprobe for video analysis and metadata inspection.");
  }
  if (!chromiumCheck.available) {
    advice.push("Install Playwright Chromium with `npx playwright install chromium`.");
  }
  if (process.platform !== "darwin") {
    advice.push("Screen recording is still macOS-only. Browser recording works cross-platform.");
  }

  let screenCaptureDevices = [];
  if (process.platform === "darwin" && ffmpeg.available) {
    screenCaptureDevices = await listAvfoundationDevices();
  }

  return {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    outputRoot: defaultOutputRoot(),
    outputRootEnvVar: process.env[OUTPUT_ROOT_ENV] || null,
    ffmpeg,
    ffprobe,
    playwright: {
      chromium: chromiumCheck
    },
    screenCapture: {
      supported: process.platform === "darwin",
      deviceCount: screenCaptureDevices.length,
      devices: screenCaptureDevices
    },
    advice
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "create_video_job",
    description: "Create a dedicated artifact folder with raw, final, clip, screenshot, diagnostics, analysis, and assets directories.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        kind: { type: "string" },
        mode: { type: "string" },
        notes: { type: "string" }
      }
    }
  },
  {
    name: "doctor",
    description: "Check ffmpeg, ffprobe, Playwright Chromium, output root configuration, and screen capture readiness.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "list_screen_capture_devices",
    description: "List macOS AVFoundation capture devices available to ffmpeg for screen recording.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "start_screen_recording",
    description: "Start recording the macOS screen with ffmpeg and place artifacts into a reusable job folder.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        outputPath: { type: "string" },
        videoDeviceIndex: { type: "number", default: 0 },
        framerate: { type: "number", default: 30 },
        captureCursor: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "stop_screen_recording",
    description: "Stop a screen recording session and return the raw recording artifact path.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      }
    }
  },
  {
    name: "start_browser_session",
    description: "Launch a Playwright browser session with recording, pacing presets, manifest logging, and optional diagnostics capture.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        browser: { type: "string", enum: ["chromium", "firefox", "webkit"], default: "chromium" },
        url: { type: "string" },
        headless: { type: "boolean", default: false },
        width: { type: "number", default: 1440 },
        height: { type: "number", default: 900 },
        recordDir: { type: "string" },
        mode: { type: "string", enum: ["feature", "bug", "tutorial", "gif", "manual"], default: "feature" },
        demoMode: { type: "boolean" },
        showCursor: { type: "boolean" },
        actionDelayMs: { type: "number" },
        typingDelayMs: { type: "number" },
        navigationSettlingMs: { type: "number" },
        clickHoldMs: { type: "number" },
        moveDurationMs: { type: "number" },
        annotationDurationMs: { type: "number" },
        captureConsole: { type: "boolean" },
        capturePageErrors: { type: "boolean" },
        captureNetwork: { type: "boolean" },
        captureTrace: { type: "boolean" },
        captureHar: { type: "boolean" }
      }
    }
  },
  {
    name: "browser_navigate",
    description: "Navigate the active page in a browser session to a URL.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "url"],
      properties: {
        sessionId: { type: "string" },
        url: { type: "string" },
        settleMs: { type: "number" }
      }
    }
  },
  {
    name: "browser_click",
    description: "Click an element in a browser session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "selector"],
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        settleMs: { type: "number" },
        moveDurationMs: { type: "number" },
        annotationText: { type: "string" },
        annotationStyle: { type: "string", enum: ["outline", "spotlight"] }
      }
    }
  },
  {
    name: "browser_fill",
    description: "Fill an input or textarea in a browser session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "selector", "value"],
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        value: { type: "string" },
        typingDelayMs: { type: "number" },
        clearFirst: { type: "boolean", default: true },
        settleMs: { type: "number" }
      }
    }
  },
  {
    name: "browser_press",
    description: "Send a keyboard key press to an element or the page.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "key"],
      properties: {
        sessionId: { type: "string" },
        key: { type: "string" },
        selector: { type: "string" },
        settleMs: { type: "number" }
      }
    }
  },
  {
    name: "browser_annotate",
    description: "Draw an outline or spotlight around a selector or explicit rectangle inside the page recording.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        text: { type: "string" },
        style: { type: "string", enum: ["outline", "spotlight"], default: "outline" },
        durationMs: { type: "number" },
        padding: { type: "number" }
      }
    }
  },
  {
    name: "browser_clear_annotations",
    description: "Remove any active browser demo annotations from the recorded page.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      }
    }
  },
  {
    name: "browser_wait_for",
    description: "Wait either for a selector to appear or for a timeout in milliseconds.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        timeoutMs: { type: "number", default: 1000 }
      }
    }
  },
  {
    name: "browser_screenshot",
    description: "Capture a screenshot from an active browser session and store it in the job folder.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        outputPath: { type: "string" },
        fullPage: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "browser_mark",
    description: "Add a named marker to the manifest, optionally with a screenshot.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "label"],
      properties: {
        sessionId: { type: "string" },
        label: { type: "string" },
        note: { type: "string" },
        screenshot: { type: "boolean", default: false },
        fullPage: { type: "boolean", default: false },
        outputPath: { type: "string" }
      }
    }
  },
  {
    name: "browser_expect",
    description: "Check that a selector or text appears, capturing a screenshot on failure when requested.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        exact: { type: "boolean", default: false },
        state: { type: "string", enum: ["visible", "attached", "hidden"], default: "visible" },
        timeoutMs: { type: "number", default: 1200 },
        screenshotOnFail: { type: "boolean", default: true },
        failureShotPath: { type: "string" }
      }
    }
  },
  {
    name: "close_browser_session",
    description: "Close the browser session, export the recorded video, and return raw/final artifact paths plus diagnostics.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        saveAs: { type: "string" }
      }
    }
  },
  {
    name: "record_browser_flow",
    description: "Record a complete browser demo or bug repro from a declarative list of steps and always finalize artifacts at the end.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        name: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        browser: { type: "string", enum: ["chromium", "firefox", "webkit"], default: "chromium" },
        url: { type: "string" },
        headless: { type: "boolean", default: false },
        width: { type: "number", default: 1440 },
        height: { type: "number", default: 900 },
        mode: { type: "string", enum: ["feature", "bug", "tutorial", "gif", "manual"], default: "feature" },
        outputPath: { type: "string" },
        stopOnError: { type: "boolean", default: true },
        captureConsole: { type: "boolean" },
        capturePageErrors: { type: "boolean" },
        captureNetwork: { type: "boolean" },
        captureTrace: { type: "boolean" },
        captureHar: { type: "boolean" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              selector: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              value: { type: "string" },
              key: { type: "string" },
              url: { type: "string" },
              text: { type: "string" },
              label: { type: "string" },
              note: { type: "string" },
              settleMs: { type: "number" },
              timeoutMs: { type: "number" },
              typingDelayMs: { type: "number" },
              moveDurationMs: { type: "number" },
              clearFirst: { type: "boolean" },
              annotationText: { type: "string" },
              annotationStyle: { type: "string" },
              style: { type: "string" },
              durationMs: { type: "number" },
              padding: { type: "number" },
              exact: { type: "boolean" },
              state: { type: "string" },
              screenshot: { type: "boolean" },
              fullPage: { type: "boolean" },
              outputPath: { type: "string" },
              failureShotPath: { type: "string" },
              stopOnFailure: { type: "boolean" }
            }
          }
        }
      }
    }
  },
  {
    name: "export_video_clip",
    description: "Export a short clip or GIF from any local video file with optional crop, resize, and poster-frame generation.",
    inputSchema: {
      type: "object",
      required: ["inputPath"],
      properties: {
        inputPath: { type: "string" },
        outputPath: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        name: { type: "string" },
        format: { type: "string", enum: ["mp4", "webm", "gif"], default: "mp4" },
        startTime: { type: "number", default: 0 },
        endTime: { type: "number" },
        duration: { type: "number" },
        fps: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        cropX: { type: "number" },
        cropY: { type: "number" },
        cropWidth: { type: "number" },
        cropHeight: { type: "number" },
        loopCount: { type: "number", default: 0 },
        mute: { type: "boolean", default: false },
        posterFrame: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "analyze_video",
    description: "Analyze a local video file with ffprobe, extract evenly sampled frames, detect scene cuts, and generate a contact sheet plus waveform.",
    inputSchema: {
      type: "object",
      required: ["inputPath"],
      properties: {
        inputPath: { type: "string" },
        outputDir: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        sampleCount: { type: "number", default: 9 },
        createContactSheet: { type: "boolean", default: true },
        detectScenes: { type: "boolean", default: true },
        sceneThreshold: { type: "number", default: 0.35 },
        maxSceneFrames: { type: "number", default: 8 },
        extractWaveform: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "suggest_highlight_clips",
    description: "Suggest short highlight ranges from an analyzed video and write a reusable highlights manifest.",
    inputSchema: {
      type: "object",
      required: ["inputPath"],
      properties: {
        inputPath: { type: "string" },
        analysisPath: { type: "string" },
        outputPath: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        name: { type: "string" },
        clipDuration: { type: "number", default: 5 },
        maxClips: { type: "number", default: 4 },
        minSpacingSeconds: { type: "number" },
        sampleCount: { type: "number", default: 9 },
        detectScenes: { type: "boolean", default: true },
        sceneThreshold: { type: "number", default: 0.35 },
        maxSceneFrames: { type: "number", default: 8 },
        extractWaveform: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "compose_highlight_video",
    description: "Analyze a video, pick likely highlight ranges, and compose them into a tighter demo video.",
    inputSchema: {
      type: "object",
      required: ["inputPath"],
      properties: {
        inputPath: { type: "string" },
        analysisPath: { type: "string" },
        outputPath: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        name: { type: "string" },
        clipDuration: { type: "number", default: 5 },
        maxClips: { type: "number", default: 4 },
        minSpacingSeconds: { type: "number" },
        includeLabels: { type: "boolean", default: false },
        preRoll: { type: "number" },
        postRoll: { type: "number" },
        introTitle: { type: "string" },
        introSubtitle: { type: "string" },
        outroTitle: { type: "string" },
        outroSubtitle: { type: "string" },
        cardStyle: { type: "string", enum: ["minimal", "glass", "light"], default: "minimal" },
        transition: {
          type: "string",
          enum: ["none", "fade", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "circleclose"],
          default: "fade"
        },
        transitionDuration: { type: "number", default: 0.4 },
        keepAssets: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "compose_demo_video",
    description: "Compose a polished demo MP4 from local clips with title cards and transitions.",
    inputSchema: {
      type: "object",
      required: ["clips"],
      properties: {
        clips: {
          type: "array",
          items: {
            type: "object",
            required: ["inputPath"],
            properties: {
              inputPath: { type: "string" },
              startTime: { type: "number" },
              endTime: { type: "number" },
              preRoll: { type: "number" },
              postRoll: { type: "number" },
              zoomScale: { type: "number" },
              focusX: { type: "number" },
              focusY: { type: "number" },
              label: { type: "string" },
              subtitle: { type: "string" }
            }
          }
        },
        name: { type: "string" },
        rootDir: { type: "string" },
        jobDir: { type: "string" },
        outputName: { type: "string" },
        outputPath: { type: "string" },
        width: { type: "number", default: 1440 },
        height: { type: "number", default: 900 },
        fps: { type: "number", default: 30 },
        keepAudio: { type: "boolean", default: true },
        transition: {
          type: "string",
          enum: ["none", "fade", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "circleclose"],
          default: "fade"
        },
        transitionDuration: { type: "number", default: 0.4 },
        introTitle: { type: "string" },
        introSubtitle: { type: "string" },
        eyebrow: { type: "string" },
        outroTitle: { type: "string" },
        outroSubtitle: { type: "string" },
        outroEyebrow: { type: "string" },
        cardStyle: { type: "string", enum: ["minimal", "glass", "light"], default: "minimal" },
        cardDuration: { type: "number", default: 2.2 },
        labelCardDuration: { type: "number", default: 1.6 },
        keepAssets: { type: "boolean", default: false }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "create_video_job") {
    return textResult(createVideoJob(args));
  }

  if (name === "doctor") {
    return textResult(await runDoctor());
  }

  if (name === "list_screen_capture_devices") {
    return textResult({
      devices: await listAvfoundationDevices()
    });
  }

  if (name === "start_screen_recording") {
    return textResult(await startScreenRecording(args));
  }

  if (name === "stop_screen_recording") {
    return textResult(await stopScreenSession(args.sessionId));
  }

  if (name === "start_browser_session") {
    return textResult(await startBrowserSession(args));
  }

  if (name === "browser_navigate") {
    return textResult(await performBrowserNavigate(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_click") {
    return textResult(await performBrowserClick(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_fill") {
    return textResult(await performBrowserFill(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_press") {
    return textResult(await performBrowserPress(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_annotate") {
    return textResult(await performBrowserAnnotate(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_clear_annotations") {
    return textResult(await performBrowserClearAnnotations(getBrowserSession(args.sessionId)));
  }

  if (name === "browser_wait_for") {
    return textResult(await performBrowserWait(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_screenshot") {
    return textResult(await performBrowserScreenshot(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_mark") {
    return textResult(await performBrowserMark(getBrowserSession(args.sessionId), args));
  }

  if (name === "browser_expect") {
    return textResult(await performBrowserExpect(getBrowserSession(args.sessionId), args));
  }

  if (name === "close_browser_session") {
    return textResult(await closeBrowserSession(args.sessionId, args.saveAs));
  }

  if (name === "record_browser_flow") {
    return textResult(await recordBrowserFlow(args));
  }

  if (name === "export_video_clip") {
    return textResult(await exportVideoClip(args.inputPath, args));
  }

  if (name === "analyze_video") {
    return textResult(await analyzeVideo(args.inputPath, args));
  }

  if (name === "suggest_highlight_clips") {
    return textResult(await suggestHighlightClips(args.inputPath, args));
  }

  if (name === "compose_highlight_video") {
    return textResult(await composeHighlightVideo(args.inputPath, args));
  }

  if (name === "compose_demo_video") {
    return textResult(await composeDemoVideo(args.clips, args));
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function shutdown() {
  for (const sessionId of Array.from(screenSessions.keys())) {
    try {
      await stopScreenSession(sessionId);
    } catch (_error) {
      // Ignore cleanup failures during shutdown.
    }
  }

  for (const sessionId of Array.from(browserSessions.keys())) {
    try {
      await closeBrowserSession(sessionId);
    } catch (_error) {
      // Ignore cleanup failures during shutdown.
    }
  }
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
