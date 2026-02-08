# TTRPG ChatGPT App

A custom TTRPG-style ChatGPT App built with the OpenAI Apps SDK, React, and Tailwind 4.

## Structure

- `server/` MCP server (Node + MCP SDK)
- `web/` Widget UI (React + Apps SDK UI + Tailwind 4)

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

## Supabase persistence (optional)

To sync game state to Supabase, configure these environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side key)
- `SUPABASE_SCHEMA` (optional, defaults to `public`)
- `SUPABASE_GAMES_TABLE` (optional, defaults to `rpg_games`)

Create a table similar to:

```sql
create table if not exists public.rpg_games (
  game_id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
```

When configured, the MCP server loads game state from Supabase on demand and
upserts updates on every state change.

## Connect to ChatGPT (developer mode)

1. Enable developer mode in ChatGPT.
2. Add a connector pointing to your public MCP server URL (e.g. via ngrok).
3. Start a new chat with the connector and ask it to start a game.

## Deploy to Vercel

1. Push this repo to GitHub and import it into Vercel.
2. Deploy with the default settings (the repo includes `vercel.json`).
3. Use the deployed MCP endpoint: `https://<project>.vercel.app/mcp`.
4. The MCP handler is implemented as a Next.js route at `app/api/[transport]/route.js`.
5. Ensure `web/dist/widget.html` is built (via `npm run build`) since the MCP widget is loaded from that file.

## Local development tips

- Rebuild the widget after any UI changes: `npm run build` in `web/`.
- Restart the server after modifying `server/server.js`.
