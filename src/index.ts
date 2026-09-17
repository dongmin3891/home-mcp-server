import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const mcpApiKey = process.env.MCP_API_KEY ?? '';
const pexelsApiKey = process.env.PEXELS_API_KEY ?? '';
const iwtcAutomationToken = process.env.IWTC_AUTOMATION_TOKEN ?? '';
const iwtcApiBaseUrl =
  process.env.IWTC_API_BASE_URL ?? 'http://iwtc-backend.iwtc.svc.cluster.local';

const PEXELS_API_BASE_URL = 'https://api.pexels.com';
const PEXELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PEXELS_ATTRIBUTION_URL = 'https://www.pexels.com';
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;

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

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  photographer_id: number;
  avg_color: string | null;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
  alt: string;
}

interface PexelsSearchResponse {
  total_results: number;
  page: number;
  per_page: number;
  photos: PexelsPhoto[];
}

interface PexelsRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAtUnix: number | null;
}

interface PexelsSearchResult {
  query: string;
  totalResults: number;
  attribution: {
    provider: 'Pexels';
    providerUrl: string;
    displayText: 'Photos provided by Pexels';
  };
  rateLimit: PexelsRateLimit;
  photos: Array<{
    id: number;
    width: number;
    height: number;
    imageUrl: string;
    previewUrl: string;
    pexelsUrl: string;
    photographer: string;
    photographerUrl: string;
    photographerId: number;
    alt: string;
    avgColor: string | null;
    attributionText: string;
  }>;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface PreparedDraftImage {
  name: string;
  pexelsPhotoId: number;
  imageUrl: string;
  pexelsUrl: string;
  photographer: string;
  photographerUrl: string;
  attributionText: string;
  bytes: Uint8Array;
  contentType: 'image/jpeg' | 'image/png' | 'image/gif';
  fileName: string;
}

const pexelsSearchCache = new Map<string, CacheEntry<PexelsSearchResult>>();

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

async function fetchIwtcAutomation<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  if (!iwtcAutomationToken) {
    throw new Error('IWTC_AUTOMATION_TOKEN is not configured');
  }

  const url = new URL(path, iwtcApiBaseUrl);
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('x-iwtc-automation-token', iwtcAutomationToken);

  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `IWTC automation API request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  return (await response.json()) as T;
}

function normalizePexelsQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseRateLimitHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function searchPexelsPhotos(input: {
  query: string;
  count: number;
  orientation?: 'landscape' | 'portrait' | 'square';
  locale: string;
}): Promise<PexelsSearchResult> {
  if (!pexelsApiKey) {
    throw new Error('PEXELS_API_KEY is not configured');
  }

  const normalizedQuery = normalizePexelsQuery(input.query);
  const cacheKey = JSON.stringify({
    query: normalizedQuery,
    count: input.count,
    orientation: input.orientation ?? null,
    locale: input.locale,
  });
  const cached = pexelsSearchCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (cached) {
    pexelsSearchCache.delete(cacheKey);
  }

  const url = new URL('/v1/search', PEXELS_API_BASE_URL);
  url.searchParams.set('query', normalizedQuery);
  url.searchParams.set('per_page', String(input.count));
  url.searchParams.set('page', '1');
  url.searchParams.set('locale', input.locale);

  if (input.orientation) {
    url.searchParams.set('orientation', input.orientation);
  }

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: pexelsApiKey,
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 429) {
      throw new Error('Pexels API rate limit exceeded');
    }
    throw new Error(
      `Pexels API request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  const data = (await response.json()) as PexelsSearchResponse;
  const rateLimit: PexelsRateLimit = {
    limit: parseRateLimitHeader(response.headers.get('x-ratelimit-limit')),
    remaining: parseRateLimitHeader(response.headers.get('x-ratelimit-remaining')),
    resetAtUnix: parseRateLimitHeader(response.headers.get('x-ratelimit-reset')),
  };

  const result: PexelsSearchResult = {
    query: normalizedQuery,
    totalResults: data.total_results,
    attribution: {
      provider: 'Pexels',
      providerUrl: PEXELS_ATTRIBUTION_URL,
      displayText: 'Photos provided by Pexels',
    },
    rateLimit,
    photos: data.photos.map((photo) => ({
      id: photo.id,
      width: photo.width,
      height: photo.height,
      imageUrl: photo.src.large2x,
      previewUrl: photo.src.medium,
      pexelsUrl: photo.url,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      photographerId: photo.photographer_id,
      alt: photo.alt,
      avgColor: photo.avg_color,
      attributionText: `Photo by ${photo.photographer} on Pexels`,
    })),
  };

  pexelsSearchCache.set(cacheKey, {
    expiresAt: Date.now() + PEXELS_CACHE_TTL_MS,
    value: result,
  });

  return result;
}

function validatePexelsUrl(value: string, expectedHost: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== expectedHost) {
    throw new Error(`Unsupported Pexels URL host: ${url.hostname}`);
  }
  return url;
}

async function downloadPexelsImage(input: {
  name: string;
  pexelsPhotoId: number;
  imageUrl: string;
  pexelsUrl: string;
  photographer: string;
  photographerUrl: string;
}): Promise<PreparedDraftImage> {
  const imageUrl = validatePexelsUrl(input.imageUrl, 'images.pexels.com');
  validatePexelsUrl(input.pexelsUrl, 'www.pexels.com');
  validatePexelsUrl(input.photographerUrl, 'www.pexels.com');

  const response = await fetch(imageUrl, {
    headers: { accept: 'image/jpeg,image/png,image/gif' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download Pexels image ${input.pexelsPhotoId}: ${response.status} ${response.statusText}`,
    );
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`Pexels image ${input.pexelsPhotoId} exceeds 10MB`);
  }

  const rawContentType = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (!['image/jpeg', 'image/png', 'image/gif'].includes(rawContentType ?? '')) {
    throw new Error(
      `Unsupported image content type for Pexels image ${input.pexelsPhotoId}: ${rawContentType ?? 'unknown'}`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`Invalid image size for Pexels image ${input.pexelsPhotoId}`);
  }

  const contentType = rawContentType as 'image/jpeg' | 'image/png' | 'image/gif';
  const extension =
    contentType === 'image/png' ? 'png' : contentType === 'image/gif' ? 'gif' : 'jpg';

  return {
    ...input,
    attributionText: `Photo by ${input.photographer} on Pexels`,
    bytes,
    contentType,
    fileName: `pexels-${input.pexelsPhotoId}.${extension}`,
  };
}

async function createIwtcDraft(input: {
  title: string;
  description: string;
  candidates: Array<{
    name: string;
    pexelsPhotoId: number;
    imageUrl: string;
    pexelsUrl: string;
    photographer: string;
    photographerUrl: string;
  }>;
}) {
  const preparedImages = await Promise.all(input.candidates.map(downloadPexelsImage));

  const worldCupResponse = await fetchIwtcAutomation<IwtcApiResponse<number>>(
    '/api/internal/automation/world-cups',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
      }),
    },
  );

  const worldCupId = worldCupResponse.data;
  const createdCandidates: Array<{
    candidateId: number;
    name: string;
    pexelsPhotoId: number;
  }> = [];

  for (const image of preparedImages) {
    const form = new FormData();
    form.set('contentsName', image.name);
    form.set('visibleType', 'PRIVATE');
    form.set('sourceProvider', 'PEXELS');
    form.set('sourceExternalId', String(image.pexelsPhotoId));
    form.set('sourceUrl', image.pexelsUrl);
    form.set('sourceAuthor', image.photographer);
    form.set('sourceAuthorUrl', image.photographerUrl);
    const imageBuffer = image.bytes.buffer.slice(
      image.bytes.byteOffset,
      image.bytes.byteOffset + image.bytes.byteLength,
    ) as ArrayBuffer;
    form.set(
      'file',
      new Blob([imageBuffer], { type: image.contentType }),
      image.fileName,
    );

    try {
      const candidateResponse = await fetchIwtcAutomation<IwtcApiResponse<number>>(
        `/api/internal/automation/world-cups/${worldCupId}/contents/static`,
        {
          method: 'POST',
          body: form,
        },
      );
      createdCandidates.push({
        candidateId: candidateResponse.data,
        name: image.name,
        pexelsPhotoId: image.pexelsPhotoId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Draft ${worldCupId} was created but candidate upload failed after ${createdCandidates.length}/${preparedImages.length}: ${message}`,
      );
    }
  }

  return {
    worldCupId,
    status: 'PRIVATE_DRAFT',
    title: input.title,
    candidateCount: createdCandidates.length,
    candidates: createdCandidates,
    attribution: {
      provider: 'Pexels',
      providerUrl: PEXELS_ATTRIBUTION_URL,
      displayText: 'Photos provided by Pexels',
      photos: preparedImages.map((image) => ({
        candidateName: image.name,
        pexelsPhotoId: image.pexelsPhotoId,
        pexelsUrl: image.pexelsUrl,
        photographer: image.photographer,
        photographerUrl: image.photographerUrl,
        attributionText: image.attributionText,
      })),
    },
    publishBlockedReason:
      'Pexels attribution metadata is persisted in IWTC, but the frontend does not display it yet. Keep this draft PRIVATE until attribution UI display is implemented.',
  };
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
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { status: 'ok', service: 'ddongmy-home-mcp' },
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
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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

  server.registerTool(
    'iwtc_search_images',
    {
      description:
        'Search Pexels for candidate photos for an IWTC world cup. Preserve the returned Pexels and photographer attribution metadata when displaying or saving selected images.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100),
        count: z.number().int().min(1).max(40).default(16),
        orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
        locale: z.string().trim().min(2).max(10).default('en-US'),
      }),
    },
    async ({ query, count, orientation, locale }) => {
      try {
        const result = await searchPexelsPhotos({
          query,
          count,
          orientation,
          locale,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to search Pexels images: ${message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'iwtc_create_worldcup_draft',
    {
      description:
        'Create a PRIVATE IWTC world cup draft from selected Pexels images through the internal automation API. Downloads only images.pexels.com URLs, uploads them to IWTC storage, persists source attribution metadata, and returns an attribution manifest. Do not publish until attribution UI display is implemented.',
      inputSchema: z.object({
        title: z.string().trim().min(1).max(100),
        description: z.string().trim().max(100).default(''),
        candidates: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(100),
              pexelsPhotoId: z.number().int().positive(),
              imageUrl: z.string().url().max(2048),
              pexelsUrl: z.string().url().max(2048),
              photographer: z.string().trim().min(1).max(200),
              photographerUrl: z.string().url().max(2048),
            }),
          )
          .min(2)
          .max(32),
      }),
    },
    async ({ title, description, candidates }) => {
      try {
        const result = await createIwtcDraft({
          title,
          description,
          candidates,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to create IWTC draft: ${message}`,
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
  console.log(
    `[home-mcp-server] IWTC automation auth: ${iwtcAutomationToken ? 'configured' : 'not configured'}`,
  );
  console.log(
    `[home-mcp-server] Pexels integration: ${pexelsApiKey ? 'configured' : 'not configured'}`,
  );
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
