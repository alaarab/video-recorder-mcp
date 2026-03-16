# Video Recorder MCP

`@alaarab/video-recorder-mcp` is an MCP server for recording bug repros, feature demos, desktop captures, short clips, and GIFs.

It is built around job folders: every run can leave behind the raw recording, final exports, screenshots, diagnostics, analysis outputs, and a manifest of what happened. That makes it useful both for polished feature demos and for debugging sessions where the artifacts matter as much as the video.

## Good Fits

- Bug repros with trace, HAR, console, network, and failure screenshots
- Feature demos and tutorials with cursor treatment, pacing presets, and annotations
- macOS desktop recording for local apps
- Turning longer recordings into MP4, WebM, or GIF clips
- Analyzing footage and composing highlight reels

## What It Includes

- `create_video_job` to create or reuse a structured artifact folder
- `doctor` to verify `ffmpeg`, `ffprobe`, Playwright Chromium, output configuration, and screen-capture readiness
- `start_screen_recording` and `stop_screen_recording` for macOS screen capture inside job folders
- `start_browser_session` with mode presets: `feature`, `bug`, `tutorial`, `gif`, `manual`
- Optional browser diagnostics capture: `captureConsole`, `capturePageErrors`, `captureNetwork`, `captureTrace`, `captureHar`
- Manifest logging for sessions, marks, expectations, exports, and composition runs
- `browser_mark` for named checkpoints and optional screenshots
- `browser_expect` for assertions with optional failure screenshots
- `close_browser_session` returning raw video, final export, and diagnostics paths
- `record_browser_flow` for one-shot declarative browser recordings
- `export_video_clip` for `mp4`, `webm`, and `gif`
- `analyze_video`, `suggest_highlight_clips`, `compose_highlight_video`, and `compose_demo_video`

## Requirements

- Node.js 20+
- `ffmpeg` for screen capture, transcoding, GIF export, and composition
- `ffprobe` for analysis and metadata inspection
- Playwright browser binaries
- macOS for desktop screen recording

Install Chromium at minimum:

```bash
npx playwright install chromium
```

Browser recording works anywhere Playwright works. Desktop screen capture is currently macOS-only.

## Install

```bash
npm install -g @alaarab/video-recorder-mcp
npx playwright install chromium
```

From GitHub:

```bash
npm install -g github:alaarab/video-recorder-mcp
npx playwright install chromium
```

Local development:

```bash
npm install
npx playwright install chromium
```

## MCP Setup

Global install:

```toml
[mcp_servers.videoRecorder]
command = "video-recorder-mcp"
```

Run from source:

```toml
[mcp_servers.videoRecorder]
command = "node"
args = ["/absolute/path/to/video-recorder-mcp/src/index.mjs"]
```

## Output Root And Job Folders

By default, artifacts go under:

```text
~/Movies/Video Recorder
```

Override the root for all default outputs with:

```bash
export VIDEO_RECORDER_OUTPUT_DIR="/absolute/path/for/video-artifacts"
```

Use `create_video_job` when you want a stable folder for one repro or demo. You can also pass `jobDir` or `rootDir` directly to most tools:

- `jobDir`: reuse one exact folder
- `rootDir`: create a timestamped job folder under that root
- neither: write to the default output root

Typical job layout:

```text
~/Movies/Video Recorder/<job>/
  job.json
  manifest.jsonl
  raw/
  final/
  clips/
  screens/
  diagnostics/
  analysis/
  assets/
```

What each folder is for:

- `raw/`: original screen recordings and browser video files
- `final/`: final exported browser videos and composed demo videos
- `clips/`: trimmed MP4, WebM, and GIF outputs
- `screens/`: screenshots from browser sessions, marks, and failed expectations
- `diagnostics/`: console logs, page errors, network logs, traces, HAR files, summaries
- `analysis/`: `analysis.json`, sampled frames, scene cuts, contact sheets, waveform images
- `assets/`: temporary and optional kept composition assets
- `manifest.jsonl`: append-only event log for the job
- `job.json`: current metadata snapshot for the job

## Browser Modes

`start_browser_session` and `record_browser_flow` support these presets:

- `feature`: balanced pacing for product demos
- `bug`: faster interactions plus diagnostics capture for debugging
- `tutorial`: slower pacing and longer emphasis windows
- `gif`: tighter, shorter pacing for small looping clips
- `manual`: disables demo pacing and visual treatment defaults

The `bug` preset enables console, page error, network, trace, and HAR capture by default. Any preset value can still be overridden per call.

## Tool Surface

Setup and jobs:

- `create_video_job`
- `doctor`
- `list_screen_capture_devices`

Browser capture:

- `start_browser_session`
- `browser_navigate`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_annotate`
- `browser_clear_annotations`
- `browser_wait_for`
- `browser_screenshot`
- `browser_mark`
- `browser_expect`
- `close_browser_session`
- `record_browser_flow`

Screen capture:

- `start_screen_recording`
- `stop_screen_recording`

Post-processing:

- `export_video_clip`
- `analyze_video`
- `suggest_highlight_clips`
- `compose_highlight_video`
- `compose_demo_video`

## First Check

Use `doctor` first:

```text
doctor
{}
```

On macOS, list available screen devices with:

```text
list_screen_capture_devices
{}
```

## Workflow Examples

Replace `SESSION_ID` with the value returned by the previous browser or screen-start call.

### 1. Create A Dedicated Job Folder

```text
create_video_job
{
  "jobDir": "~/Movies/Video Recorder/checkout-bug",
  "name": "checkout-bug",
  "kind": "bug-repro",
  "mode": "bug",
  "notes": "Guest checkout throws a 500 after submit"
}
```

### 2. Browser Bug Repro With Diagnostics

Start a recorded browser session in `bug` mode:

```text
start_browser_session
{
  "jobDir": "~/Movies/Video Recorder/checkout-bug",
  "name": "checkout-bug",
  "browser": "chromium",
  "url": "http://localhost:3000/checkout",
  "mode": "bug"
}
```

Mark important moments and assert visible outcomes:

```text
browser_mark
{
  "sessionId": "SESSION_ID",
  "label": "checkout-opened",
  "note": "Page loaded before form input",
  "screenshot": true
}
```

```text
browser_fill
{
  "sessionId": "SESSION_ID",
  "selector": "[name='email']",
  "value": "qa@example.com"
}
```

```text
browser_click
{
  "sessionId": "SESSION_ID",
  "selector": "button[type='submit']",
  "annotationText": "Submit checkout"
}
```

```text
browser_expect
{
  "sessionId": "SESSION_ID",
  "text": "Something went wrong",
  "timeoutMs": 3000
}
```

Finish the session and export the final recording:

```text
close_browser_session
{
  "sessionId": "SESSION_ID",
  "saveAs": "~/Movies/Video Recorder/checkout-bug/final/checkout-bug.mp4"
}
```

`close_browser_session` returns:

- `rawVideoPath`
- `finalVideoPath`
- `diagnostics`
- `jobDir`
- `manifestPath`

That makes it easy to hand off both the video and the debug artifacts from one run.

### 3. One-Shot Browser Demo With `record_browser_flow`

Use this when you want a single call that always finalizes the recording bundle:

```text
record_browser_flow
{
  "jobDir": "~/Movies/Video Recorder/signup-demo",
  "name": "signup-demo",
  "mode": "feature",
  "url": "http://localhost:3000",
  "outputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
  "steps": [
    { "action": "click", "selector": "a[href='/signup']" },
    { "action": "fill", "selector": "[name='email']", "value": "new-user@example.com" },
    { "action": "fill", "selector": "[name='password']", "value": "correct horse battery staple" },
    { "action": "click", "selector": "button[type='submit']" },
    { "action": "expect", "text": "Welcome aboard", "timeoutMs": 4000 },
    { "action": "mark", "label": "signup-success", "screenshot": true }
  ]
}
```

The result includes `stepResults`, `failure` when applicable, and the same finalized artifacts returned by `close_browser_session`.

### 4. Record A Desktop App On macOS

Start:

```text
start_screen_recording
{
  "jobDir": "~/Movies/Video Recorder/ableton-repro",
  "name": "ableton-repro",
  "videoDeviceIndex": 0,
  "framerate": 30,
  "captureCursor": true
}
```

Stop:

```text
stop_screen_recording
{
  "sessionId": "SESSION_ID"
}
```

The raw recording lands in `raw/` for that job folder.

### 5. Export A Short MP4, WebM, Or GIF Clip

Create a GIF:

```text
export_video_clip
{
  "inputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
  "outputPath": "~/Movies/Video Recorder/signup-demo/clips/signup-success.gif",
  "format": "gif",
  "startTime": 4.2,
  "duration": 3.5,
  "width": 960,
  "fps": 12,
  "posterFrame": true
}
```

Create a WebM clip:

```text
export_video_clip
{
  "inputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
  "outputPath": "~/Movies/Video Recorder/signup-demo/clips/signup-success.webm",
  "format": "webm",
  "startTime": 4.2,
  "endTime": 7.7,
  "mute": true
}
```

`export_video_clip` also supports crop and resize options for tighter social clips and GIFs.

### 6. Analyze A Recording And Suggest Highlights

Analyze the source video:

```text
analyze_video
{
  "inputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
  "jobDir": "~/Movies/Video Recorder/signup-demo",
  "sampleCount": 9,
  "createContactSheet": true,
  "detectScenes": true,
  "extractWaveform": true
}
```

This writes a bundle under `analysis/` including:

- `analysis.json`
- `frames/`
- `scene-cuts/`
- `contact-sheet.png`
- `waveform.png` when audio is present

Then generate reusable highlight suggestions:

```text
suggest_highlight_clips
{
  "inputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
  "jobDir": "~/Movies/Video Recorder/signup-demo",
  "clipDuration": 4,
  "maxClips": 3
}
```

This writes `highlights.json` with suggested ranges.

### 7. Compose A Highlight Video Automatically

```text
compose_highlight_video
{
  "inputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
  "jobDir": "~/Movies/Video Recorder/signup-demo",
  "clipDuration": 4,
  "maxClips": 3,
  "includeLabels": true,
  "introTitle": "Signup Flow",
  "introSubtitle": "Three key moments",
  "outroTitle": "Done",
  "transition": "fade",
  "outputPath": "~/Movies/Video Recorder/signup-demo/final/signup-highlights.mp4"
}
```

This runs analysis or reuses it, suggests clips, and composes a tighter final video.

### 8. Compose A Demo Video Manually

Use `compose_demo_video` when you already know the exact ranges you want:

```text
compose_demo_video
{
  "jobDir": "~/Movies/Video Recorder/release-demo",
  "outputPath": "~/Movies/Video Recorder/release-demo/final/release-demo.mp4",
  "introTitle": "Checkout Refresh",
  "introSubtitle": "March release demo",
  "transition": "fade",
  "cardStyle": "minimal",
  "clips": [
    {
      "inputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
      "startTime": 1.2,
      "endTime": 5.4,
      "label": "Start checkout"
    },
    {
      "inputPath": "~/Movies/Video Recorder/signup-demo/final/signup-demo.mp4",
      "startTime": 5.4,
      "endTime": 9.0,
      "label": "Success state"
    }
  ]
}
```

## Notes

- Browser screenshots from `browser_screenshot`, `browser_mark`, and failed `browser_expect` calls land in `screens/`
- `manifest.jsonl` is useful when you want a timeline of what the agent did during a repro or demo
- `record_browser_flow` always finalizes the recording bundle, even if a step fails
- Browser exports default to MP4 in `final/`; if MP4 transcoding fails, the raw browser video is still preserved
- Original input recordings are never deleted by the server

## License

MIT
