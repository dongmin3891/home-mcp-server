import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const mcpApiKey = process.env.MCP_API_KEY ?? '';
const iwtcApiBaseUrl =
  process.env.IWTC_API_BASE_URL ?? 'http://iwtc-backend.iwtc.svc.cluster.local';

if (!mcpApiKey) {
  throw new Error('MCP_API_KEY environment variable is required');
}

interface IwtcApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface IwtcWorldCupListItem {
  worldCupId: number;
  title: string;
  description: string;
  contentsName1: string | null;
  mediaFileId1: number | null;
  contentsName2: string | null;
  mediaFileId2: number | null;
}

interface IwtcWorldCupPage {
  totalElements: number;
  content: IwtcWorldCupListItem[];
  pageable: {
    pageNumber: number;
    pageSize: number;
  };
  totalPages: number;
}

function isAuthorized(authorization: string | undefined): boolean {
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }

  const token = authorization.slice('Bearer '.length);
  const provided = Buffer.from(token);
  const expected = Buffer.from(mcpApiKey);

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function fetchIwtcJson<T>(path: string): Promise<T> {
  const url = new URL(path, iwtcApiBaseUrl);
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `IWTC API request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  return (await response.json()) as T;
}

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

  server.registerTool(
    'iwtc_list_recent_worldcups',
    {
      description:
        'List recently created public IWTC world cups, newest first. Use this to inspect existing topics before creating a new world cup.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(10),
      }),
    },
    async ({ limit }) => {
      try {
        const params = new URLSearchParams({
          page: '0',
          size: String(limit),
          sort: 'id,DESC',
          dateRange: 'ALL',
        });
        const response = await fetchIwtcJson<IwtcApiResponse<IwtcWorldCupPage>>(
          `/api/world-cups?${params.toString()}`,
        );

        const result = {
          totalElements: response.data.totalElements,
          worldCups: response.data.content,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to list recent IWTC world cups: ${message}`,
            },
          ],
        };
      }
    },
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
    if (!isAuthorized(req.headers.authorization)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    void nodeHandler(req, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, host, () => {
  console.log(`[home-mcp-server] listening on http://${host}:${port}`);
  console.log('[home-mcp-server] MCP endpoint: /mcp (Bearer auth required)');
  console.log(`[home-mcp-server] IWTC API: ${iwtcApiBaseUrl}`);
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
