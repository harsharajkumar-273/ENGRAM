import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { 
  ToolRegistry, 
  calculatorTool, 
  fileReadTool, 
  fileWriteTool, 
  memorySearchTool, 
  memoryStoreTool, 
  shellExecTool,
  createDefaultToolRegistry 
} from '../src/agent/tools.js';
import { initDatabase } from '../src/storage/database.js';
import { MemoryStore } from '../src/storage/memory-store.js';

describe('Tool Registry & Built-in Tools', () => {
  const testDir = path.resolve('scratch_tool_test');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('registers tools and generates documentation', () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    expect(registry.has('calculator')).toBe(true);
    expect(registry.getAll().length).toBe(1);

    const docs = registry.getToolDocumentation();
    expect(docs).toContain('### Tool: calculator');
    expect(docs).toContain('expression (string, required)');

    expect(() => registry.register(calculatorTool)).toThrow('already registered');
  });

  it('calculator evaluates mathematical expressions safely', async () => {
    const res1 = await calculatorTool.execute({ expression: '2 + 3 * 4' }, {});
    expect(res1).toBe('14');

    const res2 = await calculatorTool.execute({ expression: 'Math.pow(2, 8)' }, {});
    expect(res2).toBe('256');

    const res3 = await calculatorTool.execute({ expression: '10000 * Math.pow(1 + 0.05, 3)' }, {});
    expect(parseFloat(res3)).toBeCloseTo(11576.25, 1);

    // Rejects unauthorized characters/code injection
    await expect(calculatorTool.execute({ expression: 'process.exit(1)' }, {})).rejects.toThrow('prohibited characters');
  });

  it('file_write and file_read write and read files safely', async () => {
    const filePath = path.join(testDir, 'test_output.txt');
    const writeRes = await fileWriteTool.execute(
      { path: filePath, content: 'Hello Autonomous Agent World!' },
      { workingDirectory: testDir }
    );
    expect(writeRes).toContain('Successfully wrote');
    expect(fs.existsSync(filePath)).toBe(true);

    const readRes = await fileReadTool.execute(
      { path: filePath },
      { workingDirectory: testDir }
    );
    expect(readRes).toBe('Hello Autonomous Agent World!');
  });

  it('file_read handles non-existent files gracefully', async () => {
    await expect(fileReadTool.execute({ path: 'non_existent.txt' }, { workingDirectory: testDir }))
      .rejects.toThrow('File not found');
  });

  it('memory_store and memory_search interact with Engram memory store', async () => {
    const db = initDatabase(':memory:');
    const memoryStore = new MemoryStore(db);
    const context = { memoryStore, userId: 'test_user' };

    const storeRes = await memoryStoreTool.execute({
      content: 'User prefers dark mode in all UI applications',
      type: 'semantic',
      importance: 0.9
    }, context);
    expect(storeRes).toContain('Successfully stored memory');

    const searchRes = await memorySearchTool.execute({
      query: 'dark mode'
    }, context);
    expect(searchRes).toContain('User prefers dark mode');
  });

  it('shell_exec captures command output and reports exit errors', async () => {
    const echoRes = await shellExecTool.execute({ command: 'echo "Engram Agent"' }, {});
    expect(echoRes).toContain('Engram Agent');

    const errRes = await shellExecTool.execute({ command: 'non_existent_command_12345' }, {});
    expect(errRes).toContain('Command failed with exit code');
  });

  it('enforces execution timeout', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow_tool',
      description: 'Sleeps longer than timeout',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 50,
      execute: async () => {
        await new Promise(r => setTimeout(r, 200));
        return 'done';
      }
    });

    await expect(registry.executeTool('slow_tool', {})).rejects.toThrow('timed out after 50ms');
  });
  it('keeps shell execution disabled in the default registry', () => {
    expect(createDefaultToolRegistry().has('shell_exec')).toBe(false);
    expect(createDefaultToolRegistry({ allowShell: true }).has('shell_exec')).toBe(true);
  });

  it('rejects relative and absolute paths outside the workspace', async () => {
    await expect(fileWriteTool.execute({ path: '../escape.txt', content: 'x' }, { workingDirectory: testDir })).rejects.toThrow('escapes');
    await expect(fileReadTool.execute({ path: path.resolve('package.json') }, { workingDirectory: testDir })).rejects.toThrow('escapes');
  });

  it('rejects symlink paths outside the workspace', async () => {
    fs.symlinkSync(path.dirname(testDir), path.join(testDir, 'outside'), 'dir');
    await expect(fileWriteTool.execute({ path: 'outside/escape.txt', content: 'x' }, { workingDirectory: testDir })).rejects.toThrow('Symlink escapes');
    await expect(fileReadTool.execute({ path: 'outside/package.json' }, { workingDirectory: testDir })).rejects.toThrow('Symlink escapes');
  });

});
