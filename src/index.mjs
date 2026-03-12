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
const server = new Server(
  {
    name: "video-recorder-mcp",
    version: "0.4.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const screenSessions = new Map();
const browserSessions = new Map();

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

function defaultOutputPath(prefix, extension) {
  const dir = path.join(os.homedir(), "Movies", "Codex Recordings");
  ensureDir(dir);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return path.join(dir, `${prefix}-${stamp}.${extension}`);
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

function browserEngine(name) {
  if (name === "firefox") {
    return firefox;
  }

  if (name === "webkit") {
    return webkit;
  }

  return chromium;
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

async function stopScreenSession(sessionId) {
  const session = screenSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown screen recording session: ${sessionId}`);
  }

  if (session.stopped) {
    return {
      sessionId,
      outputPath: session.outputPath,
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

  screenSessions.delete(sessionId);
  return {
    sessionId,
    outputPath: session.outputPath,
    stopped: true
  };
}

async function closeBrowserSession(sessionId, saveAs) {
  const session = browserSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown browser session: ${sessionId}`);
  }

  const page = session.page;
  const video = page.video();
  await session.context.close();
  await session.browser.close();

  let recordedPath = null;
  if (video) {
    recordedPath = await video.path();
  }

  let finalPath = recordedPath;
  if (recordedPath && saveAs) {
    const targetPath = path.resolve(expandHome(saveAs));
    ensureDir(path.dirname(targetPath));
    if (targetPath.toLowerCase().endsWith(".mp4")) {
      await execFile("ffmpeg", [
        "-y",
        "-i",
        recordedPath,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        targetPath
      ]);
    } else {
      fs.copyFileSync(recordedPath, targetPath);
    }
    finalPath = targetPath;
  }

  browserSessions.delete(sessionId);
  return {
    sessionId,
    videoPath: finalPath,
    url: page.url()
  };
}

function getBrowserSession(sessionId) {
  const session = browserSessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown browser session: ${sessionId}`);
  }

  return session;
}

function createBrowserDemoProfile(args, width, height) {
  return {
    demoMode: args.demoMode !== false,
    showCursor: args.showCursor !== false,
    actionDelayMs: resolveSessionMs(args.actionDelayMs, 650),
    typingDelayMs: resolveSessionMs(args.typingDelayMs, 82),
    navigationSettlingMs: resolveSessionMs(args.navigationSettlingMs, 1150),
    clickHoldMs: resolveSessionMs(args.clickHoldMs, 110),
    moveDurationMs: resolveSessionMs(args.moveDurationMs, 420),
    annotationDurationMs: resolveSessionMs(args.annotationDurationMs, 1800),
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
  if (!session.demoMode) {
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

function sanitizeFileStem(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9._-]+/g, "-");
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
    return timestamps.slice(0, safeMaxSceneFrames).map((timestamp, index) => ({
      timestampSeconds: roundNumber(timestamp, 3),
      path: path.join(sceneDir, `scene-${String(index + 1).padStart(3, "0")}.png`)
    })).filter((scene) => fs.existsSync(scene.path));
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

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const defaultDir = path.join(
    os.homedir(),
    "Movies",
    "Codex Recordings",
    "video-analysis",
    `${sanitizeFileStem(resolvedInputPath)}-${stamp}`
  );
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

  fs.writeFileSync(path.join(outputDir, "analysis.json"), JSON.stringify(manifest, null, 2));
  return manifest;
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

  const width = Number.isFinite(options.width) ? options.width : 1440;
  const height = Number.isFinite(options.height) ? options.height : 900;
  const fps = Number.isFinite(options.fps) ? options.fps : 30;
  const keepAudio = options.keepAudio !== false;
  const keepAssets = options.keepAssets === true;
  const cardDuration = Number.isFinite(options.cardDuration) ? options.cardDuration : 2.2;
  const labelCardDuration = Number.isFinite(options.labelCardDuration) ? options.labelCardDuration : 1.6;
  const transition = options.transition || "fade";
  const cardStyle = options.cardStyle || "minimal";
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const defaultOutputPath = path.join(os.homedir(), "Movies", "Codex Recordings", `demo-${stamp}.mp4`);
  const outputPath = path.resolve(expandHome(options.outputPath || defaultOutputPath));
  const workDir = path.join(path.dirname(outputPath), `${sanitizeFileStem(outputPath)}-assets`);
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

  ffmpegArgs.push(
    outputPath
  );

  await execFile("ffmpeg", ffmpegArgs);
  const finalProbe = await probeVideo(outputPath);
  if (!keepAssets) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return {
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
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
      description: "Start recording the macOS screen with ffmpeg. Returns a sessionId you must pass to stop_screen_recording.",
      inputSchema: {
        type: "object",
        properties: {
          outputPath: { type: "string" },
          videoDeviceIndex: { type: "number", default: 0 },
          framerate: { type: "number", default: 30 },
          captureCursor: { type: "boolean", default: true }
        }
      }
    },
    {
      name: "stop_screen_recording",
      description: "Stop a screen recording session and finalize the video file.",
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
      description: "Launch a Playwright browser session with video recording enabled.",
      inputSchema: {
        type: "object",
        properties: {
          browser: { type: "string", enum: ["chromium", "firefox", "webkit"], default: "chromium" },
          url: { type: "string" },
          headless: { type: "boolean", default: false },
          width: { type: "number", default: 1440 },
          height: { type: "number", default: 900 },
          recordDir: { type: "string" },
          demoMode: { type: "boolean", default: true },
          showCursor: { type: "boolean", default: true },
          actionDelayMs: { type: "number", default: 650 },
          typingDelayMs: { type: "number", default: 82 },
          navigationSettlingMs: { type: "number", default: 1150 },
          clickHoldMs: { type: "number", default: 110 },
          moveDurationMs: { type: "number", default: 420 },
          annotationDurationMs: { type: "number", default: 1800 }
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
          durationMs: { type: "number", default: 1800 },
          padding: { type: "number", default: 12 }
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
      description: "Capture a screenshot from an active browser session.",
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
      name: "close_browser_session",
      description: "Close the browser session and return the final video path.",
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
      name: "analyze_video",
      description: "Analyze a local video file with ffprobe, extract evenly sampled frames, detect scene cuts, and generate a contact sheet plus waveform.",
      inputSchema: {
        type: "object",
        required: ["inputPath"],
        properties: {
          inputPath: { type: "string" },
          outputDir: { type: "string" },
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
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "list_screen_capture_devices") {
    return textResult({
      devices: await listAvfoundationDevices()
    });
  }

  if (name === "start_screen_recording") {
    const sessionId = randomUUID();
    const outputPath = path.resolve(expandHome(args.outputPath || defaultOutputPath("screen", "mp4")));
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

    screenSessions.set(sessionId, {
      outputPath,
      process,
      startedAt: Date.now(),
      stopped: false
    });

    return textResult({
      sessionId,
      outputPath,
      ffmpegArgs
    });
  }

  if (name === "stop_screen_recording") {
    return textResult(await stopScreenSession(args.sessionId));
  }

  if (name === "start_browser_session") {
    const sessionId = randomUUID();
    const browserName = args.browser || "chromium";
    const engine = browserEngine(browserName);
    const width = Number.isFinite(args.width) ? args.width : 1440;
    const height = Number.isFinite(args.height) ? args.height : 900;
    const recordDir = path.resolve(expandHome(args.recordDir || path.join(os.homedir(), "Movies", "Codex Recordings", "browser-temp")));
    ensureDir(recordDir);
    const demoProfile = createBrowserDemoProfile(args, width, height);

    const browser = await engine.launch({
      headless: args.headless === true
    });
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: {
        dir: recordDir,
        size: { width, height }
      }
    });
    const page = await context.newPage();
    const session = {
      browser,
      context,
      page,
      recordDir,
      ...demoProfile
    };
    browserSessions.set(sessionId, session);

    if (args.url) {
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
    }
    await ensureBrowserDemoOverlay(session);
    if (session.showCursor) {
      await moveBrowserCursor(session, session.cursorPosition.x, session.cursorPosition.y, { durationMs: 0 });
    }
    if (args.url && session.demoMode) {
      await waitForBrowserDelay(session, session.navigationSettlingMs, 0.1);
    }

    return textResult({
      sessionId,
      browser: browserName,
      url: args.url || null,
      recordDir,
      demoMode: session.demoMode,
      showCursor: session.showCursor
    });
  }

  if (name === "browser_navigate") {
    const session = getBrowserSession(args.sessionId);
    await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
    await ensureBrowserDemoOverlay(session);
    if (session.showCursor && session.cursorPosition) {
      await moveBrowserCursor(session, session.cursorPosition.x, session.cursorPosition.y, { durationMs: 0 });
    }
    const settleMs = resolveSessionMs(args.settleMs, session.navigationSettlingMs);
    if (session.demoMode) {
      await waitForBrowserDelay(session, settleMs, 0.1);
    }
    return textResult({ sessionId: args.sessionId, url: session.page.url() });
  }

  if (name === "browser_click") {
    const session = getBrowserSession(args.sessionId);
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
    return textResult({ sessionId: args.sessionId, selector: args.selector, clicked: true });
  }

  if (name === "browser_fill") {
    const session = getBrowserSession(args.sessionId);
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
    return textResult({ sessionId: args.sessionId, selector: args.selector, filled: true });
  }

  if (name === "browser_press") {
    const session = getBrowserSession(args.sessionId);
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
    return textResult({ sessionId: args.sessionId, key: args.key, selector: args.selector || null });
  }

  if (name === "browser_annotate") {
    const session = getBrowserSession(args.sessionId);
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

    return textResult({
      sessionId: args.sessionId,
      ...annotation
    });
  }

  if (name === "browser_clear_annotations") {
    const session = getBrowserSession(args.sessionId);
    await clearBrowserAnnotations(session);
    return textResult({ sessionId: args.sessionId, cleared: true });
  }

  if (name === "browser_wait_for") {
    const session = getBrowserSession(args.sessionId);
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 1000;
    if (args.selector) {
      await session.page.waitForSelector(args.selector, { timeout: timeoutMs });
      if (session.demoMode) {
        await waitForBrowserDelay(session, Math.min(timeoutMs, 260), 0.08);
      }
    } else {
      await session.page.waitForTimeout(timeoutMs);
    }
    return textResult({ sessionId: args.sessionId, selector: args.selector || null, timeoutMs });
  }

  if (name === "browser_screenshot") {
    const session = browserSessions.get(args.sessionId);
    if (!session) {
      throw new Error(`Unknown browser session: ${args.sessionId}`);
    }
    const outputPath = path.resolve(expandHome(args.outputPath || defaultOutputPath("browser-shot", "png")));
    ensureDir(path.dirname(outputPath));
    await session.page.screenshot({
      path: outputPath,
      fullPage: args.fullPage === true
    });
    return textResult({ sessionId: args.sessionId, outputPath });
  }

  if (name === "close_browser_session") {
    return textResult(await closeBrowserSession(args.sessionId, args.saveAs));
  }

  if (name === "analyze_video") {
    return textResult(await analyzeVideo(args.inputPath, args));
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
