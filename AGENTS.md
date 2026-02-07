# AGENTS.md

Project guidance for engineers and coding agents working in this repo.

## 1) Environment Setup

Use Node via `nvm` first. The default shell Node can be very old and will break tooling.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --lts
node -v
npm -v
```

Install dependencies from repo root:

```bash
npm install
```

## 2) Repo Structure

- `server/`: MCP game server (`server/mcp.js`, `server/server.js`)
- `web/`: Widget UI source and build pipeline
- `web/dist/widget.html`: Built widget file used by MCP server
- `app/mcp/route.js`: Next route for `/mcp`
- `app/api/[transport]/route.js`: API route variant with `basePath: "/api"`

## 3) Core Commands

Run Next app locally:

```bash
npm run dev
```

Production build (includes widget build):

```bash
npm run build
```

Start Next production server:

```bash
npm start
```

Run standalone MCP server:

```bash
cd server
node server.js
```

## 4) Widget Workflow

Any change under `web/src/**` that affects the embedded widget should be followed by:

```bash
cd web
npm run build
```

This regenerates `web/dist/widget.html`, which the MCP server loads at runtime.

## 5) Combat System Notes

Combat rules are enforced server-side in `server/mcp.js`.

- Use `combat_action` for turn actions.
- `update_state` is blocked from mutating active combat turn state/HP/MP.
- Skills are state-driven (`skills` arrays + `unlockLevel`), not hard-coded by archetype.
- Attacks require an equipped weapon and valid range.
- One action per turn is enforced for attack/defend/dodge/use_skill.

## 6) Validation Checklist

Before finishing major server edits:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --lts
npm --workspace server exec -- node --check mcp.js
```

For UI changes, rebuild widget and confirm no runtime errors in browser/dev logs.

## 7) Common Pitfalls

- If commands fail with old JS syntax errors, Node version is wrong; run `nvm use --lts`.
- If UI changes do not appear in ChatGPT, `web/dist/widget.html` is likely stale; rebuild `web`.
- Keep combat logic centralized in `server/mcp.js` to avoid model-only rule enforcement.
