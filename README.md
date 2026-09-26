# Uploader Bot

Private Telegram downloader/uploader bot built from the supplied working engine.

## Supported
- DiskWala share links
- Terabox-family share links
- YouTube metadata + existing quality/download resolver
- Telegram video/audio/document delivery
- Download progress and speed
- Thumbnail attachment
- Direct-link fallback for files above the configured upload limit
- Temporary-file cleanup
- Owner/access control
- In-memory callback cache

## Deploy

Node.js 18.17+ is supported. The repository includes both a `Procfile` and `Dockerfile`, so it can be deployed as a worker on Heroku or as a Docker service on platforms such as Koyeb.

### Required environment

```env
BOT_TOKEN=your_bot_token
MAX_FILE_MB=48
```

For Terabox, set `TERABOX_COOKIES` when the built-in resolver needs an authenticated share session. For the existing YouTube download provider, set its resolver configuration (`YTDL_API_KEY` and optionally `YTDL_API_BASE`) if you want download quality buttons to complete.

Optional:

```env
ALLOWED_USERS=123456789
REQUEST_TIMEOUT_MS=25000
DOWNLOAD_DIR=./downloads
DISKWALA_RESOLVER_URL=https://diskwala-dl-six.vercel.app/api/scrap
```

If `ALLOWED_USERS` is empty, the first Telegram account that sends `/start` claims the bot.

## Security

Never commit `.env`, bot tokens, cookies, or API keys. The included `.gitignore` excludes local secrets and temporary downloads.

Use the bot only for files/content you are authorized to download.
