import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type http from 'http';
import { handleRequest } from '../src/server.js';

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function simulateRequest(
  method: string,
  url: string,
  bodyData?: Record<string, unknown>
): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    const req = new Readable() as any;
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost:3000' };

    const bodyStr = bodyData ? JSON.stringify(bodyData) : '';
    req._read = () => {
      if (bodyStr) {
        req.push(Buffer.from(bodyStr));
      }
      req.push(null);
    };

    let statusCode = 200;
    const headers: Record<string, string> = {};
    let body = '';

    const res: any = new EventEmitter();
    res.writeHead = (status: number, hdrs?: Record<string, string>) => {
      statusCode = status;
      if (hdrs) {
        Object.assign(headers, hdrs);
      }
      return res;
    };
    res.end = (chunk?: any) => {
      if (chunk) {
        body += chunk.toString();
      }
      resolve({ statusCode, headers, body });
    };

    handleRequest(req as http.IncomingMessage, res as http.ServerResponse).catch(reject);
  });
}

describe('Engram REST API Microservice', () => {
  it('GET /api/health returns system status', async () => {
    const res = await simulateRequest('GET', '/api/health');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('ok');
    expect(data.system).toContain('Engram');
    expect(data.virtualTime).toBeDefined();
  });

  it('POST /api/remember creates a memory', async () => {
    const res = await simulateRequest('POST', '/api/remember', {
      content: 'User prefers Rust over Python for performance critical jobs',
      type: 'semantic',
      importance: 0.85,
      userId: 'test_rest_user',
    });
    expect(res.statusCode).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.memory).toBeDefined();
    expect(data.memory.content).toBe('User prefers Rust over Python for performance critical jobs');
    expect(data.memory.user_id).toBe('test_rest_user');
  });

  it('GET /api/recall finds memories', async () => {
    const res = await simulateRequest('GET', '/api/recall?q=Rust&userId=test_rest_user');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.memories[0].content).toContain('Rust');
  });

  it('GET /api/memories lists active memories', async () => {
    const res = await simulateRequest('GET', '/api/memories?userId=test_rest_user');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.count).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/stats returns system statistics', async () => {
    const res = await simulateRequest('GET', '/api/stats?userId=test_rest_user');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.stats).toBeDefined();
    expect(data.stats.total).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/time/advance shifts virtual time', async () => {
    const res = await simulateRequest('POST', '/api/time/advance', { hours: 48 });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.hoursAdvanced).toBe(48);
  });

  it('POST /api/decay triggers decay sweep', async () => {
    const res = await simulateRequest('POST', '/api/decay', {});
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result).toBeDefined();
    expect(typeof data.result.checkedCount).toBe('number');
  });

  it('POST /api/agent/run executes autonomous goal and returns trace', async () => {
    const res = await simulateRequest('POST', '/api/agent/run', {
      goal: 'Calculate 25 * 4',
      maxSteps: 5,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBeDefined();
    expect(data.trace).toBeDefined();
    expect(Array.isArray(data.trace.steps)).toBe(true);
  });

  it('OPTIONS returns 204 for CORS preflight', async () => {
    const res = await simulateRequest('OPTIONS', '/api/chat');
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown endpoints', async () => {
    const res = await simulateRequest('GET', '/api/nonexistent');
    expect(res.statusCode).toBe(404);
  });
});
