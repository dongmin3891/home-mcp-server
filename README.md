# home-mcp-server

Home server MCP gateway for ddongmy services.

## Current scope

The first milestone only exposes a minimal MCP server so the remote connection path can be verified safely before adding service write tools.

- `GET /healthz` — Kubernetes/container health endpoint
- `/mcp` — Streamable HTTP MCP endpoint
- `health_check` — MCP tool that returns `ok`

## Local development

```bash
npm install
npm run dev
```

The server listens on `0.0.0.0:3000` by default.

```text
http://localhost:3000/healthz
http://localhost:3000/mcp
```

## Build

```bash
npm run typecheck
npm run build
npm start
```

## Docker

```bash
docker build -t home-mcp-server .
docker run --rm -p 3000:3000 home-mcp-server
```

## Planned modules

```text
home-mcp-server
├─ iwtc
│  ├─ list recent worldcups
│  ├─ search images
│  ├─ create worldcup draft
│  └─ publish worldcup
├─ ddongmy
└─ homelab
```

Write-capable tools will be added only after remote MCP connectivity and authentication are in place.
