import { describe, expect, it, vi } from 'vitest';
import { ProjectMemoryApiError, ProjectMemoryClient } from '../src/integrations/project-memory.js';

describe('ProjectMemoryClient', () => {
  it('passes actor identity and filters when listing reviewed memories', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new ProjectMemoryClient({
      baseUrl: 'http://localhost:4173/',
      actorId: 'alice@example.com',
      fetch: fetchMock,
    });

    await client.listMemories('project/id', { status: 'active' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'http://localhost:4173/api/projects/project%2Fid/memories?actor=alice%40example.com&status=active'
    );
  });

  it('posts questions without moving evidence-backed claims into local memory', async () => {
    const result = {
      denied: false,
      activeMemories: [],
      matchedMemories: [],
      sources: [],
      formatted: 'Active project memory:\n  (none)',
      answer: null,
      answerNote: 'No provider configured',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new ProjectMemoryClient({
      baseUrl: 'http://localhost:4173',
      actorId: 'alice',
      fetch: fetchMock,
    });

    await expect(client.ask('project-1', 'Why did we choose Postgres?')).resolves.toEqual(result);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      actor: 'alice',
      question: 'Why did we choose Postgres?',
    });
  });

  it('surfaces service authorization failures as typed errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Access denied' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new ProjectMemoryClient({
      baseUrl: 'http://localhost:4173',
      actorId: 'mallory',
      fetch: fetchMock,
    });

    const error = await client.listProjects().catch(value => value);
    expect(error).toBeInstanceOf(ProjectMemoryApiError);
    expect(error).toMatchObject({ status: 403, message: 'Access denied' });
  });
});
