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
    version: "0.3.0"
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
        background:
          radial-gradient(circle at 15% 20%, rgba(84, 221, 190, 0.28), transparent 28%),
          radial-gradient(circle at 82% 18%, rgba(72, 131, 255, 0.24), transparent 24%),
          radial-gradient(circle at 74% 80%, rgba(245, 111, 166, 0.20), transparent 28%),
          linear-gradient(140deg, #07111f 0%, #101a2d 48%, #050a14 100%);
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
        border-radius: 36px;
        background: linear-gradient(160deg, rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.03));
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
        backdrop-filter: blur(20px);
      }

      .eyebrow {
        display: inline-block;
        margin-bottom: 24px;
        padding: 10px 16px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        color: #8fe6d5;
        font-size: 18px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        max-width: 900px;
        color: #f5f7fb;
        font-size: 76px;
        line-height: 0.94;
        letter-spacing: -0.04em;
        font-weight: 740;
      }

      p {
        margin: 24px 0 0;
        max-width: 820px;
        color: #b6c3d8;
        font-size: 28px;
        line-height: 1.3;
        letter-spacing: -0.02em;
      }
    </style>
  </head>
  <body>
    <section class="frame">
      <div class="eyebrow">Demo Edit</div>
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
  const startTime = Number.isFinite(options.startTime) ? options.startTime : null;
  const endTime = Number.isFinite(options.endTime) ? options.endTime : null;
  const trimDuration = startTime !== null && endTime !== null && endTime > startTime
    ? endTime - startTime
    : null;

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
    `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`,
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
  const cardDuration = Number.isFinite(options.cardDuration) ? options.cardDuration : 1.8;
  const labelCardDuration = Number.isFinite(options.labelCardDuration) ? options.labelCardDuration : 1.2;
  const transition = options.transition || "fade";
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

    if (clip.label) {
      const labelPath = path.join(workDir, `segment-${String(segments.length).padStart(3, "0")}-label.mp4`);
      await createTitleCardClip(labelPath, {
        width,
        height,
        fps,
        duration: labelCardDuration,
        keepAudio,
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
      endTime: clip.endTime
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
          recordDir: { type: "string" }
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
          url: { type: "string" }
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
          selector: { type: "string" }
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
          value: { type: "string" }
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
          selector: { type: "string" }
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
          outroTitle: { type: "string" },
          outroSubtitle: { type: "string" },
          cardDuration: { type: "number", default: 1.8 },
          labelCardDuration: { type: "number", default: 1.2 },
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
    if (args.url) {
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
    }

    browserSessions.set(sessionId, {
      browser,
      context,
      page,
      recordDir
    });

    return textResult({
      sessionId,
      browser: browserName,
      url: args.url || null,
      recordDir
    });
  }

  if (name === "browser_navigate") {
    const session = browserSessions.get(args.sessionId);
    if (!session) {
      throw new Error(`Unknown browser session: ${args.sessionId}`);
    }
    await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
    return textResult({ sessionId: args.sessionId, url: session.page.url() });
  }

  if (name === "browser_click") {
    const session = browserSessions.get(args.sessionId);
    if (!session) {
      throw new Error(`Unknown browser session: ${args.sessionId}`);
    }
    await session.page.click(args.selector);
    return textResult({ sessionId: args.sessionId, selector: args.selector, clicked: true });
  }

  if (name === "browser_fill") {
    const session = browserSessions.get(args.sessionId);
    if (!session) {
      throw new Error(`Unknown browser session: ${args.sessionId}`);
    }
    await session.page.fill(args.selector, args.value);
    return textResult({ sessionId: args.sessionId, selector: args.selector, filled: true });
  }

  if (name === "browser_press") {
    const session = browserSessions.get(args.sessionId);
    if (!session) {
      throw new Error(`Unknown browser session: ${args.sessionId}`);
    }
    if (args.selector) {
      await session.page.press(args.selector, args.key);
    } else {
      await session.page.keyboard.press(args.key);
    }
    return textResult({ sessionId: args.sessionId, key: args.key, selector: args.selector || null });
  }

  if (name === "browser_wait_for") {
    const session = browserSessions.get(args.sessionId);
    if (!session) {
      throw new Error(`Unknown browser session: ${args.sessionId}`);
    }
    const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 1000;
    if (args.selector) {
      await session.page.waitForSelector(args.selector, { timeout: timeoutMs });
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
