// ============================================================================
// Engram REST API Microservice Server
// ============================================================================

import http from 'http';
import { URL } from 'url';
import dotenv from 'dotenv';
import { EngramAgent } from './agent.js';
import { initDatabase } from './storage/database.js';
import { GeminiLLMProvider, GeminiEmbeddingProvider } from './providers/gemini.js';
import type { LLMProvider, EmbeddingProvider } from './providers/interface.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from './core/types.js';
import type { MemoryType, Message } from './core/types.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.ENGRAM_DB_PATH || process.env.DB_PATH || 'engram.db';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Fallback providers for offline, CI, or demo usage when API key is not supplied
class FallbackLLMProvider implements LLMProvider {
  readonly name = 'fallback-local';
  async chat(messages: Message[]): Promise<string> {
    const userMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
    return `[Engram Local Engine] Processed: "${userMsg}". In local offline mode without GEMINI_API_KEY.`;
  }
  async chatJSON<T>(): Promise<T> {
    return [] as unknown as T;
  }
}

class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fallback-local-emb';
  readonly dimensions = 16;
  async embed(text: string): Promise<number[]> {
    const vec = new Array(16).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 16] = (vec[i % 16] + text.charCodeAt(i)) % 100 / 100;
    }
    return vec;
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

const db = initDatabase(DB_PATH);
const timeProvider = new SimulatedTimeProvider();

const llm: LLMProvider = GEMINI_API_KEY.trim()
  ? new GeminiLLMProvider(GEMINI_API_KEY)
  : new FallbackLLMProvider();

const embedder: EmbeddingProvider = GEMINI_API_KEY.trim()
  ? new GeminiEmbeddingProvider(GEMINI_API_KEY)
  : new FallbackEmbeddingProvider();

export const agent = new EngramAgent(
  db,
  llm,
  embedder,
  DEFAULT_CONFIG,
  timeProvider
);

/**
 * Helper to read JSON request body
 */
async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) { // 10MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error(`Invalid JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Helper to send JSON responses with CORS headers
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Request Handler
 */
export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method?.toUpperCase() || 'GET';

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  try {
    // ------------------------------------------------------------------------
    // Health Check
    // ------------------------------------------------------------------------
    if (pathname === '/health' || pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        system: 'Engram Cognitive AI Memory Engine',
        version: '0.1.0',
        uptime: process.uptime(),
        virtualTime: agent.getCurrentTime().toISOString(),
        llmProvider: llm.name,
        embeddingProvider: embedder.name,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // POST /api/chat — End-to-end cognitive chat with recall and extraction
    // ------------------------------------------------------------------------
    if (pathname === '/api/chat' && method === 'POST') {
      const body = await parseJsonBody<{
        message?: string;
      }>(req);

      if (!body.message || typeof body.message !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: "message"' });
        return;
      }

      const result = await agent.chat(body.message);
      sendJson(res, 200, result);
      return;
    }

    // ------------------------------------------------------------------------
    // POST /api/agent/run — Execute an autonomous goal with tools & circuit breakers
    // ------------------------------------------------------------------------
    if (pathname === '/api/agent/run' && method === 'POST') {
      const body = await parseJsonBody<{
        goal?: string;
        maxSteps?: number;
      }>(req);

      if (!body.goal || typeof body.goal !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: "goal"' });
        return;
      }

      const result = await agent.executeGoal(body.goal, {
        maxSteps: body.maxSteps ?? 10,
      });

      sendJson(res, 200, result);
      return;
    }

    // ------------------------------------------------------------------------
    // POST /api/remember — Explicitly record a memory
    // ------------------------------------------------------------------------
    if (pathname === '/api/remember' && method === 'POST') {
      const body = await parseJsonBody<{
        content?: string;
        type?: MemoryType;
        importance?: number;
        emotionalWeight?: number;
        userId?: string;
      }>(req);

      if (!body.content || typeof body.content !== 'string') {
        sendJson(res, 400, { error: 'Missing required field: "content"' });
        return;
      }

      const memory = await agent.addMemory(body.content, {
        type: body.type,
        importance: body.importance,
        emotionalWeight: body.emotionalWeight,
        userId: body.userId,
      });

      sendJson(res, 201, { memory });
      return;
    }

    // ------------------------------------------------------------------------
    // GET /api/recall — Query active memories with multi-signal scoring
    // ------------------------------------------------------------------------
    if (pathname === '/api/recall' && method === 'GET') {
      const q = parsedUrl.searchParams.get('q');
      const userId = parsedUrl.searchParams.get('userId') || undefined;
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '5', 10);

      if (!q) {
        sendJson(res, 400, { error: 'Missing query parameter "q"' });
        return;
      }

      const memories = await agent.recall(q, limit, userId);
      sendJson(res, 200, {
        query: q,
        userId: userId || 'default_user',
        count: memories.length,
        memories,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // GET /api/memories — List active memories
    // ------------------------------------------------------------------------
    if (pathname === '/api/memories' && method === 'GET') {
      const userId = parsedUrl.searchParams.get('userId') || undefined;
      const memories = agent.getActiveMemories(userId);

      sendJson(res, 200, {
        userId: userId || 'default_user',
        count: memories.length,
        memories,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // GET /api/stats — System-wide telemetry and memory counts
    // ------------------------------------------------------------------------
    if (pathname === '/api/stats' && method === 'GET') {
      const userId = parsedUrl.searchParams.get('userId') || undefined;
      const stats = agent.getStats(userId);
      sendJson(res, 200, { stats });
      return;
    }

    // ------------------------------------------------------------------------
    // GET /api/entities — Knowledge graph entities
    // ------------------------------------------------------------------------
    if (pathname === '/api/entities' && method === 'GET') {
      const entities = agent.getEntities();
      sendJson(res, 200, {
        count: entities.length,
        entities,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // GET /api/contradictions — Contradiction audit log
    // ------------------------------------------------------------------------
    if (pathname === '/api/contradictions' && method === 'GET') {
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
      const contradictions = agent.getContradictions(limit);
      sendJson(res, 200, {
        count: contradictions.length,
        contradictions,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // POST /api/decay — Run decay sweep (dormancy & purge)
    // ------------------------------------------------------------------------
    if (pathname === '/api/decay' && method === 'POST') {
      const body = await parseJsonBody<{ gracePeriodHours?: number }>(req);
      const result = agent.runDecaySweep(body.gracePeriodHours);
      sendJson(res, 200, { result });
      return;
    }

    // ------------------------------------------------------------------------
    // POST /api/consolidate — Trigger episodic memory consolidation
    // ------------------------------------------------------------------------
    if (pathname === '/api/consolidate' && method === 'POST') {
      const consolidated = await agent.consolidate();
      sendJson(res, 200, {
        consolidatedCount: consolidated.length,
        consolidated,
      });
      return;
    }

    // ------------------------------------------------------------------------
    // POST /api/time/advance — Advance virtual time for spaced repetition tests
    // ------------------------------------------------------------------------
    if (pathname === '/api/time/advance' && method === 'POST') {
      const body = await parseJsonBody<{ hours?: number }>(req);
      if (typeof body.hours !== 'number' || body.hours <= 0) {
        sendJson(res, 400, { error: 'Missing or invalid "hours" parameter (must be positive number)' });
        return;
      }

      const newTime = agent.advanceTime(body.hours);
      sendJson(res, 200, {
        currentVirtualTime: newTime.toISOString(),
        hoursAdvanced: body.hours,
      });
      return;
    }

    // 404 Not Found
    sendJson(res, 404, { error: `Endpoint not found: ${method} ${pathname}` });
  } catch (error) {
    sendJson(res, 500, {
      error: 'Internal server error',
      message: (error as Error).message,
    });
  }
}

// Start server if directly executed
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`\x1b[32m✔ Engram REST API Microservice running on http://${HOST}:${PORT}\x1b[0m`);
    console.log(`\x1b[90m• Health check: GET http://${HOST}:${PORT}/api/health\x1b[0m`);
    console.log(`\x1b[90m• Chat:         POST http://${HOST}:${PORT}/api/chat\x1b[0m`);
    console.log(`\x1b[90m• Remember:     POST http://${HOST}:${PORT}/api/remember\x1b[0m`);
    console.log(`\x1b[90m• Recall:       GET http://${HOST}:${PORT}/api/recall?q=...\x1b[0m`);
  });

  const shutdown = () => {
    console.log('\nShutting down Engram server...');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
