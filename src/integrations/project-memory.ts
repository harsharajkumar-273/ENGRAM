// ============================================================================
// ENGRAM Project Memory integration
// ============================================================================

export interface ProjectMemoryClientOptions {
  baseUrl: string;
  actorId: string;
  fetch?: typeof globalThis.fetch;
}

export interface ProjectMemoryProject {
  id: string;
  name: string;
  owner_id: string;
  my_role: 'owner' | 'editor' | 'viewer';
  created_at: string;
}

export interface ProjectMemoryEvidence {
  id: string;
  memory_id: string;
  source_type: 'message' | 'file_chunk';
  conversation_id: string | null;
  message_id: string | null;
  file_id: string | null;
  file_chunk_id: string | null;
  quote: string;
  evidence_role: 'supports' | 'contradicts' | 'supersedes';
}

export interface ProjectMemoryRecord {
  id: string;
  project_id: string;
  memory_type: 'decision' | 'requirement' | 'preference' | 'deadline' | 'fact' | 'open_question';
  content: string;
  status: 'proposed' | 'active' | 'superseded' | 'rejected' | 'expired';
  certainty: 'confirmed' | 'probable' | 'uncertain' | 'disputed';
  evidence: ProjectMemoryEvidence[];
  created_at: string;
  updated_at: string;
}

export interface ProjectMemoryAskResult {
  denied: boolean;
  activeMemories: ProjectMemoryRecord[];
  matchedMemories: ProjectMemoryRecord[];
  sources: Array<Record<string, unknown>>;
  formatted: string;
  answer: string | null;
  answerNote: string | null;
}

export interface ProjectMemoryAuditEntry {
  id: string;
  project_id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export class ProjectMemoryApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown
  ) {
    super(message);
    this.name = 'ProjectMemoryApiError';
  }
}

/**
 * Typed boundary between ENGRAM's cognitive memory and the evidence-backed
 * project-memory service. The service remains authoritative for citations,
 * project membership, and review state; this client never copies a claim into
 * ENGRAM's local SQLite store implicitly.
 */
export class ProjectMemoryClient {
  private readonly baseUrl: string;
  private readonly actorId: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ProjectMemoryClientOptions) {
    if (!options.baseUrl?.trim()) throw new Error('ProjectMemoryClient requires baseUrl');
    if (!options.actorId?.trim()) throw new Error('ProjectMemoryClient requires actorId');
    if (!options.fetch && typeof globalThis.fetch !== 'function') {
      throw new Error('ProjectMemoryClient requires a fetch implementation');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.actorId = options.actorId;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async listProjects(): Promise<ProjectMemoryProject[]> {
    return this.request(`/api/projects?${this.actorQuery()}`);
  }

  async listMemories(
    projectId: string,
    options: { status?: ProjectMemoryRecord['status'] } = {}
  ): Promise<ProjectMemoryRecord[]> {
    const query = new URLSearchParams({ actor: this.actorId });
    if (options.status) query.set('status', options.status);
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/memories?${query}`);
  }

  async ask(projectId: string, question: string): Promise<ProjectMemoryAskResult> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/ask`, {
      method: 'POST',
      body: JSON.stringify({ actor: this.actorId, question }),
    });
  }

  async createConversation(
    projectId: string,
    options: { title: string; visibility?: 'project' | 'private' }
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
      method: 'POST',
      body: JSON.stringify({
        owner: this.actorId,
        title: options.title,
        visibility: options.visibility ?? 'project',
      }),
    });
  }

  async postMessage(
    conversationId: string,
    content: string,
    role: 'user' | 'assistant' = 'user'
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ author: this.actorId, role, content }),
    });
  }

  async extractCandidates(conversationId: string): Promise<ProjectMemoryRecord[]> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/extract`, {
      method: 'POST',
      body: JSON.stringify({ actor: this.actorId }),
    });
  }

  async confirmMemory(memoryId: string): Promise<ProjectMemoryRecord> {
    return this.request(`/api/memories/${encodeURIComponent(memoryId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ actor: this.actorId }),
    });
  }

  async listAuditLog(
    projectId: string,
    options: { limit?: number; entityType?: string; actorId?: string } = {}
  ): Promise<ProjectMemoryAuditEntry[]> {
    const query = new URLSearchParams({ actor: this.actorId });
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.entityType) query.set('entityType', options.entityType);
    if (options.actorId) query.set('actorId', options.actorId);
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/audit?${query}`);
  }

  private actorQuery(): string {
    return new URLSearchParams({ actor: this.actorId }).toString();
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Project Memory request failed (${response.status})`;
      throw new ProjectMemoryApiError(message, response.status, body);
    }
    return body as T;
  }
}
