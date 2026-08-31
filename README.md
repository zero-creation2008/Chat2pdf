# Chat2PDF

Convert an exported WhatsApp chat (`.zip`) into a beautifully formatted, WhatsApp-styled PDF — entirely in your browser. Nothing is ever uploaded to a server.

## Features

- Parses WhatsApp `_chat.txt` exports (multi-line messages, system messages, group chats, 12/24-hour time, various date formats)
- Matches media files (images, videos, audio, documents, stickers) to the exact message they belong to, in chronological order
- Live WhatsApp-style preview with infinite scroll and lazy-loaded images
- Generates a print-ready A4/Letter PDF with:
  - Green/light message bubbles, sender colors, date separators, timestamps
  - Image previews, video/audio/document attachment cards
  - Page numbers and a title page
- Configurable: page size, orientation, font size, spacing, image quality, light/dark theme, and which content types to include
- 100% client-side — uses JSZip for extraction and jsPDF for PDF generation

## Getting a WhatsApp export

On your phone: open the chat → **⋮ (menu)** → **More** → **Export chat** → **Include media** → save the resulting `.zip`.

## Running locally

No build step, no dependencies to install. Just serve the folder statically:

```bash
cd chat2pdf
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

(Opening `index.html` directly via `file://` may work in some browsers, but a local server is recommended since the app loads JSZip/jsPDF from a CDN and some browsers restrict local file access for zip parsing.)

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under **Source**, select the branch (e.g. `main`) and root folder (`/`).
4. Save — GitHub will publish it at `https://<username>.github.io/<repo-name>/`.

No further configuration is needed since the app has no backend and no build step.

## Project structure

```
chat2pdf/
├── index.html      # App shell: home, processing, editor/preview, generating, done screens
├── style.css        # WhatsApp-inspired styling, light/dark themes
├── script.js         # Chat parsing, media matching, preview rendering, PDF generation
├── README.md
└── assets/
    └── icons/
```

## Privacy

Everything — ZIP extraction, chat parsing, media matching, preview rendering, and PDF generation — happens locally in your browser using the File API, JSZip, and jsPDF. No chat data or media is ever sent to a server.

## Browser support

Tested to work on Android Chrome, desktop Chrome, Firefox, Edge, and Safari.
