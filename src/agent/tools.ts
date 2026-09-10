// ============================================================================
// Engram Tool Registry & Sandboxed Execution Harness
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import type { MemoryStore } from '../storage/memory-store.js';
import type { VectorStore } from '../storage/vector-store.js';
import type { EmbeddingProvider } from '../providers/interface.js';

export interface ToolContext {
  userId?: string;
  memoryStore?: MemoryStore;
  vectorStore?: VectorStore;
  embedder?: EmbeddingProvider | null;
  workingDirectory?: string;
}

export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
  default?: any;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
  };
  timeoutMs?: number;
  execute: (args: Record<string, any>, context: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  public register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns a concise description of all tools for LLM prompting.
   */
  public getToolDocumentation(): string {
    return this.getAll().map(tool => {
      const paramDocs = Object.entries(tool.parameters.properties)
        .map(([key, val]) => `    - ${key} (${val.type}${tool.parameters.required?.includes(key) ? ', required' : ''}): ${val.description}`)
        .join('\n');
      return `### Tool: ${tool.name}\n${tool.description}\nParameters:\n${paramDocs || '    (None)'}`;
    }).join('\n\n');
  }

  /**
   * Safely executes a tool with a hard timeout guarantee.
   */
  public async executeTool(
    name: string,
    args: Record<string, any>,
    context: ToolContext = {}
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool "${name}". Available tools: ${Array.from(this.tools.keys()).join(', ')}`);
    }

    // Validate required arguments
    if (tool.parameters.required) {
      for (const req of tool.parameters.required) {
        if (args[req] === undefined || args[req] === null) {
          throw new Error(`Missing required parameter "${req}" for tool "${name}".`);
        }
      }
    }

    const timeout = tool.timeoutMs || 20000;

    const executionPromise = tool.execute(args, context);
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error(`Tool "${name}" execution timed out after ${timeout}ms`)), timeout);
    });

    return Promise.race([executionPromise, timeoutPromise]);
  }
}

// ----------------------------------------------------------------------------
// Standard Built-In Tools
// ----------------------------------------------------------------------------

/**
 * 1. Safe Calculator Tool (evaluates mathematical expressions safely)
 */
export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: 'Evaluates mathematical calculations, interest rates, percentages, statistics, or equations safely. Supports +, -, *, /, %, Math functions (Math.pow, Math.sqrt, Math.log, etc.).',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The mathematical expression to evaluate, e.g. "10000 * Math.pow(1 + 0.07, 5)" or "(45 + 55) / 2"'
      }
    },
    required: ['expression']
  },
  timeoutMs: 3000,
  execute: async ({ expression }) => {
    if (typeof expression !== 'string' || !expression.trim()) {
      throw new Error('Expression must be a non-empty string');
    }

    // Sanitize: allow only math characters, numbers, parentheses, and Math.* functions
    const sanitized = expression.trim();

    // Reject dangerous identifiers
    if (/\b(process|global|window|document|require|import|eval|Function|this)\b/i.test(sanitized)) {
      throw new Error(`Expression contains prohibited characters. Only numeric and Math operators allowed.`);
    }

    // Strip allowed Math identifiers to test remaining characters
    const stripped = sanitized.replace(/\bMath\.(pow|sqrt|log|exp|round|floor|ceil|min|max|abs|PI|E)\b/g, '');
    if (/[^0-9+\-*/%().,\s]/g.test(stripped)) {
      throw new Error(`Expression contains prohibited characters. Only numeric and Math operators allowed.`);
    }

    try {
      // Evaluate within a restricted context
      const fn = new Function('Math', `"use strict"; return (${sanitized});`);
      const result = fn(Math);
      if (typeof result !== 'number' || isNaN(result)) {
        throw new Error('Expression did not evaluate to a valid number');
      }
      return String(result);
    } catch (err) {
      throw new Error(`Calculation error: ${(err as Error).message}`);
    }
  }
};

/**
 * 2. File Read Tool
 */
export const fileReadTool: ToolDefinition = {
  name: 'file_read',
  description: 'Reads the text content of a file from the workspace filesystem.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative or absolute file path to read'
      },
      maxLines: {
        type: 'number',
        description: 'Optional maximum number of lines to return (default: 200)'
      }
    },
    required: ['path']
  },
  timeoutMs: 5000,
  execute: async ({ path: filePath, maxLines = 200 }, context) => {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(context.workingDirectory || process.cwd(), filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found at path: ${filePath}`);
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... [truncated ${lines.length - maxLines} lines]`;
    }
    return content;
  }
};

/**
 * 3. File Write Tool
 */
export const fileWriteTool: ToolDefinition = {
  name: 'file_write',
  description: 'Writes or updates text content in a file. Creates parent directories automatically if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative or absolute file path to write to'
      },
      content: {
        type: 'string',
        description: 'The text content to write'
      }
    },
    required: ['path', 'content']
  },
  timeoutMs: 5000,
  execute: async ({ path: filePath, content }, context) => {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(context.workingDirectory || process.cwd(), filePath);

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, String(content), 'utf-8');
    return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${filePath}`;
  }
};

/**
 * 4. Memory Query Tool (Agent self-reflection on Engram memory store)
 */
export const memorySearchTool: ToolDefinition = {
  name: 'memory_search',
  description: 'Searches the agent\'s persistent cognitive memory for previously recorded facts, preferences, past task solutions, or user constraints.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search terms or question to look up in persistent memory'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of memories to return (default: 5)'
      }
    },
    required: ['query']
  },
  timeoutMs: 5000,
  execute: async ({ query, limit = 5 }, context) => {
    if (!context.memoryStore) {
      return 'Memory store not attached to execution context.';
    }

    const userId = context.userId || 'default_user';
    const active = context.memoryStore.getActiveByUser(userId);
    if (active.length === 0) {
      return 'No active memories stored for this user.';
    }

    // Text substring + keyword match
    const lower = String(query).toLowerCase();
    const matches = active
      .filter(m => m.content.toLowerCase().includes(lower) || lower.split(' ').some(w => w.length > 3 && m.content.toLowerCase().includes(w)))
      .slice(0, limit);

    if (matches.length === 0) {
      return `No memories found matching query "${query}". Total active memories in store: ${active.length}.`;
    }

    return matches.map(m => `- [${m.type.toUpperCase()} | Importance: ${m.importance.toFixed(2)}] ${m.content}`).join('\n');
  }
};

/**
 * 5. Memory Store Tool (Explicitly records a fact or procedural rule)
 */
export const memoryStoreTool: ToolDefinition = {
  name: 'memory_store',
  description: 'Explicitly records a new fact, rule, or learned workflow into the cognitive memory engine.',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The fact or procedural lesson to remember'
      },
      type: {
        type: 'string',
        enum: ['semantic', 'episodic', 'procedural'],
        description: 'Memory type (default: semantic)'
      },
      importance: {
        type: 'number',
        description: 'Importance score from 0.0 to 1.0 (default: 0.8)'
      }
    },
    required: ['content']
  },
  timeoutMs: 5000,
  execute: async ({ content, type = 'semantic', importance = 0.8 }, context) => {
    if (!context.memoryStore) {
      return 'Memory store not attached to execution context.';
    }

    const userId = context.userId || 'default_user';
    const now = new Date().toISOString();
    const mem = {
      id: 'mem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      type: type as any,
      status: 'active' as const,
      content: String(content).trim(),
      source_turn_id: 'tool_memory_store',
      importance: Number(importance) || 0.8,
      emotional_weight: 0.1,
      recall_count: 0,
      base_half_life_hours: type === 'procedural' ? 2160 : type === 'semantic' ? 720 : 72,
      strengthening_factor: 0.5,
      created_at: now,
      last_recalled_at: now,
      entities: [],
      superseded_by: null,
      consolidated_from: [],
      user_id: userId,
      session_id: 'agent_session'
    };

    context.memoryStore.create(mem);

    if (context.vectorStore && context.embedder) {
      try {
        const emb = await context.embedder.embed(mem.content);
        context.vectorStore.store(mem.id, emb);
      } catch {}
    }

    return `Successfully stored memory [ID: ${mem.id}]: "${mem.content}"`;
  }
};

/**
 * 6. Shell Command Execution Tool
 */
export const shellExecTool: ToolDefinition = {
  name: 'shell_exec',
  description: 'Executes a command line instruction and captures stdout, stderr, and exit status. Use for file manipulation, git queries, inspecting environment, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute'
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional execution timeout in milliseconds (default: 15000)'
      }
    },
    required: ['command']
  },
  timeoutMs: 20000,
  execute: async ({ command, timeoutMs = 15000 }, context) => {
    const cwd = context.workingDirectory || process.cwd();
    return new Promise((resolve, reject) => {
      exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const out = stdout ? stdout.trim() : '';
        const err = stderr ? stderr.trim() : '';

        if (error) {
          resolve(`[Command failed with exit code ${error.code || 1}]\nSTDOUT:\n${out || '(empty)'}\nSTDERR:\n${err || error.message}`);
          return;
        }

        if (!out && !err) {
          resolve('(Command completed with no output)');
          return;
        }

        resolve([out && `STDOUT:\n${out}`, err && `STDERR:\n${err}`].filter(Boolean).join('\n'));
      });
    });
  }
};

/**
 * Creates a standard pre-configured ToolRegistry with all essential tools.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(memorySearchTool);
  registry.register(memoryStoreTool);
  registry.register(shellExecTool);
  return registry;
}
