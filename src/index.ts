import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'ddongmy-home-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'health_check',
    {
      description: 'Check whether the ddongmy home MCP server is running.',
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: 'ok',
        },
      ],
      structuredContent: {
        status: 'ok',
        service: 'ddongmy-home-mcp',
      },
    }),
  );

  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeHandler = toNodeHandler(mcpHandler);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (url.pathname === '/mcp') {
    void nodeHandler(req, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, host, () => {
  console.log(`[home-mcp-server] listening on http://${host}:${port}`);
  console.log(`[home-mcp-server] MCP endpoint: /mcp`);
});

async function shutdown(signal: string) {
  console.log(`[home-mcp-server] received ${signal}; shutting down`);
  await mcpHandler.close();
  server.close((error) => {
    if (error) {
      console.error('[home-mcp-server] shutdown error', error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
