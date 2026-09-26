# Uploader Bot

Telegram downloader/uploader bot for **DiskWala, Terabox and YouTube**.

This repository keeps the supplied working provider/download engine instead of replacing it.

## Features

- DiskWala public share-link resolver
- Terabox share-link resolver
- YouTube quality buttons/download resolver
- Download progress and speed
- Telegram video/audio/document delivery
- Streaming flag for playable Telegram videos
- File-size guard and direct-link fallback
- Thumbnail support
- Temporary-file cleanup
- Private owner mode / `ALLOWED_USERS`
- Heroku, Koyeb and Docker-ready

## Required configuration

```env
BOT_TOKEN=your_telegram_bot_token
```

For Terabox, configure `TERABOX_COOKIES` if the current share flow needs an account cookie.

DiskWala uses the existing resolver from the base project and **does not require your DiskWala API key**. You can override its endpoint with `DISKWALA_RESOLVER_URL`.

The existing YouTube provider uses `YTDL_API_BASE` + `YTDL_API_KEY` when a quality is selected.

Optional:

```env
ALLOWED_USERS=123456789
MAX_FILE_MB=48
REQUEST_TIMEOUT_MS=25000
DOWNLOAD_DIR=./downloads
TELEGRAM_API_ROOT=https://api.telegram.org
```

## Start

```bash
node bot.js
```

Node.js 18.17+ is required.

## Deploy

**Heroku:** worker command is defined in `Procfile`.

**Koyeb:** use `node bot.js` as the run command and add environment variables in the service settings.

**Docker:** build with the included `Dockerfile`.

> Use the bot only for files/content you are authorized to access and download.
