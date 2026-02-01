# Mythweaver TTRPG App

A custom TTRPG-style ChatGPT App built with the OpenAI Apps SDK + Tailwind 4.

## Structure

- `server/` MCP server (Node + MCP SDK)
- `web/` Widget UI (Tailwind 4)

## Build the widget UI

```bash
cd web
npm install
npm run build
```

This generates `web/dist/widget.html` which is embedded by the MCP server.

## Run the MCP server

```bash
cd server
npm install
node server.js
```

Server runs at `http://localhost:8787/mcp` by default.

## Connect to ChatGPT (developer mode)

1. Enable developer mode in ChatGPT.
2. Add a connector pointing to your public MCP server URL (e.g. via ngrok).
3. Start a new chat with the connector and ask it to start a game.

## Local development tips

- Rebuild the widget after any UI changes: `npm run build` in `web/`.
- Restart the server after modifying `server/server.js`.
