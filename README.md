# Video Recorder MCP

Record product demos without rebuilding the same automation stack in every repo.

`@alaarab/video-recorder-mcp` is a Model Context Protocol server for two kinds of capture:

- browser demo recording with Playwright
- desktop screen capture on macOS with `ffmpeg`

It is designed for Codex-style workflows where an agent can drive a browser, interact with an app, and leave behind a real video artifact instead of a pile of screenshots.

## Why This Exists

Most agent tooling is good at:

- browsing pages
- clicking buttons
- taking screenshots
- reading logs

Most agent tooling is bad at:

- producing a usable feature demo
- capturing a local desktop app
- leaving behind a normal video file that opens in QuickTime

This server closes that gap.

## Good Fits

- record a browser login flow and save it as `.mp4`
- capture a local feature walkthrough for QA or design review
- pair screen recording with Ableton automation through `LiveMCP`
- generate repeatable demo videos across multiple projects from one Codex install

## Core Features

- starts Playwright browser sessions with recording enabled
- exposes simple browser actions: navigate, click, fill, press, wait, screenshot
- closes browser sessions and exports a final video
- transcodes browser recordings to `.mp4` when the output path ends in `.mp4`
- starts and stops macOS screen recording through `ffmpeg`
- defaults output to `~/Movies/Codex Recordings`

## Requirements

- Node.js 20+
- `ffmpeg` on `PATH`
- macOS for screen recording

Playwright browser recording also needs browser binaries:

```bash
npx playwright install chromium
```

## Install

Install from npm:

```bash
npm install -g @alaarab/video-recorder-mcp
npx playwright install chromium
```

Install directly from GitHub:

```bash
npm install -g github:alaarab/video-recorder-mcp
npx playwright install chromium
```

Local development:

```bash
npm install
npx playwright install chromium
```

## Codex Setup

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.videoRecorder]
command = "node"
args = ["/absolute/path/to/video-recorder-mcp/src/index.mjs"]
```

If you installed it globally through npm, point `args` to the installed entrypoint on your machine instead.

## Tools

- `list_screen_capture_devices`
- `start_screen_recording`
- `stop_screen_recording`
- `start_browser_session`
- `browser_navigate`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_screenshot`
- `close_browser_session`

## Typical Workflows

### Browser Demo

1. Start a browser session with recording enabled.
2. Navigate to your app.
3. Fill login fields, click through the flow, create/update something.
4. Close the session with:

```text
saveAs: "~/Movies/Codex Recordings/demo.mp4"
```

If `saveAs` ends in `.mp4`, the server will transcode the Playwright WebM output to H.264 MP4 through `ffmpeg`.

### Desktop App Demo

1. Call `start_screen_recording`
2. Drive the app with your existing tooling
3. Call `stop_screen_recording`

This is especially useful when paired with tools like `LiveMCP` for Ableton Live demos.

## Example Use Cases

- “Open the staging site, log in, create a project, and save a 20-second demo MP4.”
- “Start screen capture, tweak the plugin in Ableton, and save the recording to Movies.”
- “Take a screenshot halfway through the flow, then continue and export the final browser video.”

## Output

By default, recordings land in:

```text
~/Movies/Codex Recordings
```

You can override output paths per tool call.

## Current Limits

- macOS screen capture is full-display capture right now, not single-window crop
- browser automation is intentionally low-level and generic
- screen recording depends on `ffmpeg` and OS-level capture permissions

## Development Notes

The server is intentionally small:

- MCP transport: `@modelcontextprotocol/sdk`
- browser automation: `playwright`
- desktop capture: `ffmpeg`

That keeps it easy to patch for project-specific workflows without dragging in a large framework.

## License

MIT
