# Suno + DeepSeek Music Generator

This project:

1. Uses DeepSeek to generate a better structured Suno prompt from your theme.
2. Calls the Suno API to generate music.
3. Downloads audio as `wav`, `mp3`, or `both`.
4. Optionally uploads the finished files to a NetEase Cloud Music account through the web UI.

## Setup

```powershell
Copy-Item .env.example .env
Copy-Item music-settings.example.json music-settings.json
npm install
```

Then edit `.env` and `music-settings.json`.

## Output Naming

Every run creates a folder under `output/` with this format:

```text
YYYY-MM-DD-theme-sequence
```

Example:

```text
2026-04-02-summer-night-drive-001
```

## Audio Output

Configure audio output in `music-settings.json`:

```json
{
  "audioOutput": {
    "format": "wav",
    "wavPollIntervalSec": 10,
    "wavTimeoutSec": 300
  }
}
```

Supported values:

- `wav`: request Suno WAV conversion and save `.wav`
- `mp3`: download source MP3 only
- `both`: save both MP3 and WAV, and treat WAV as the primary output file

CLI override:

```powershell
node index.js --theme "night drive" --audio-format wav
```

## Prompt Engineering

The project now supports a trend preset plus anti-AI prompt rules:

```json
{
  "promptEngineering": {
    "trendPreset": "introspective_pop",
    "avoidAiSound": true,
    "humanizationDirectives": [
      "Avoid overly perfect quantization and repetitive loop feel.",
      "Use dynamic contrast, arrangement evolution, and realistic transitions.",
      "Prefer memorable motifs over generic ambient filler.",
      "Keep vocals expressive and human, not robotic or overly synthetic."
    ]
  }
}
```

Available presets:

- `introspective_pop`
- `afro_fusion`
- `country_pop`
- `kpop_polished`
- `speed_garage`
- `triphop_revival`

CLI override:

```powershell
node index.js --theme "late summer rooftop" --trend-preset afro_fusion
```

## Quality Gate

The script still validates downloaded audio metadata after download. The default bitrate gate is:

```json
{
  "constraints": {
    "audioBitrateKbps": { "min": 320 }
  }
}
```

Notes:

- For MP3 mode, the script prefers `sourceAudioUrl` and `sourceStreamAudioUrl` over low-quality proxy links.
- For WAV mode, the script uses the Suno WAV conversion endpoints.
- If the quality gate fails, the run is marked failed and NetEase upload does not continue.

## NetEase Upload

Enable it in `music-settings.json`:

```json
{
  "netease": {
    "enabled": true,
    "mode": "playwright",
    "uploadUrl": "https://music.163.com/#/my/music/cloud/",
    "waitForManualLoginSec": 180,
    "perTrackTimeoutSec": 180
  }
}
```

Relevant env vars:

- `NETEASE_ACCOUNT_NAME`
- `NETEASE_COOKIE`
- `NETEASE_COOKIES_PATH`
- `NETEASE_STORAGE_STATE_PATH`
- `NETEASE_BROWSER_CHANNEL`
- `NETEASE_HEADLESS`

Recommended first run:

- Set `NETEASE_HEADLESS=false`
- Let the browser open
- Log into the target NetEase account manually
- Save session state to `NETEASE_STORAGE_STATE_PATH`

## Run

Instrumental WAV:

```powershell
node index.js --theme "midnight coding music" --instrumental --audio-format wav
```

Vocal with trend preset:

```powershell
node index.js --theme "rainy city romance" --lyrics-language Chinese --trend-preset introspective_pop
```

## Metadata

Each run writes `metadata.json` with:

- prompt plan
- Suno task data
- MP3 or WAV download details
- validation results
- quality-gate result
- NetEase upload result
