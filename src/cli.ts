import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase } from './storage/database.js';
import { MemoryStore } from './storage/memory-store.js';
import { VectorStore } from './storage/vector-store.js';
import { GeminiLLMProvider, GeminiEmbeddingProvider } from './providers/gemini.js';
import { EngramAgent } from './agent.js';
import type { Memory } from './core/types.js';

dotenv.config();

const dbPath = process.env.DB_PATH || './engram.db';
const db = initDatabase(dbPath);
const memoryStore = new MemoryStore(db);
const vectorStore = new VectorStore(db);

const apiKey = process.env.GEMINI_API_KEY || '';

let llmProvider: GeminiLLMProvider | null = null;
let embeddingProvider: GeminiEmbeddingProvider | null = null;
let agent: EngramAgent | null = null;

if (apiKey.trim()) {
  try {
    llmProvider = new GeminiLLMProvider(apiKey);
    embeddingProvider = new GeminiEmbeddingProvider(apiKey);
    agent = new EngramAgent(db, llmProvider, embeddingProvider);
  } catch (err: any) {
    console.warn('\x1b[33mWarning: Failed to initialize Gemini provider:\x1b[0m', err.message);
  }
}

let debugMode = false;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '\x1b[35mengram>\x1b[0m '
});

console.log(`\x1b[36m
  ╔══════════════════════════════════════════╗
  ║         🧠 Engram Memory System          ║
  ║    Memories that think like a brain      ║
  ╚══════════════════════════════════════════╝
  Phase 2: Autonomous Memory Chat Mode\x1b[0m
  ${apiKey ? '\x1b[32m● Connected to Gemini (Chat + Memory Extraction active)\x1b[0m' : '\x1b[33m○ No GEMINI_API_KEY set — running in manual command mode (add key to .env for AI chat)\x1b[0m'}
  Type \x1b[36m/help\x1b[0m for available commands, or simply type a message to chat!
`);

rl.prompt();

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  // --- Slash Commands ---
  if (input.startsWith('/remember ')) {
    const text = input.substring('/remember '.length).trim();
    if (!text) {
      console.log('\x1b[33mUsage: /remember <text>\x1b[0m');
      rl.prompt();
      return;
    }
    
    const memory: Memory = {
      id: uuidv4(),
      type: 'semantic',
      status: 'active',
      content: text,
      source_turn_id: 'cli_manual',
      importance: 0.7,
      emotional_weight: 0.1,
      recall_count: 0,
      base_half_life_hours: 720,
      strengthening_factor: 0.5,
      created_at: new Date().toISOString(),
      last_recalled_at: new Date().toISOString(),
      entities: [],
      superseded_by: null,
      consolidated_from: [],
      user_id: 'default_user',
      session_id: 'cli_session'
    };

    try {
      memoryStore.create(memory);
      if (embeddingProvider) {
        const embedding = await embeddingProvider.embed(text);
        vectorStore.store(memory.id, embedding);
      }
      console.log(`\x1b[32m✔ Memory manually stored with ID: ${memory.id}\x1b[0m`);
    } catch (e: any) {
      console.log(`\x1b[31mError creating memory: ${e.message}\x1b[0m`);
    }
  } else if (input.startsWith('/recall ')) {
    const query = input.substring('/recall '.length).trim();
    if (!query) {
      console.log('\x1b[33mUsage: /recall <query>\x1b[0m');
      rl.prompt();
      return;
    }

    try {
      if (embeddingProvider) {
        const embedding = await embeddingProvider.embed(query);
        const results = vectorStore.search(embedding, 5, 0.2);
        if (results.length === 0) {
          console.log('\x1b[90mNo relevant memories found.\x1b[0m');
        } else {
          console.log(`\x1b[36mFound ${results.length} matching memories:\x1b[0m`);
          for (const res of results) {
            const mem = memoryStore.getById(res.memory_id);
            if (mem) {
              console.log(`  \x1b[32m[Sim: ${(res.similarity * 100).toFixed(1)}% | Imp: ${mem.importance.toFixed(2)}]\x1b[0m \x1b[37m${mem.content}\x1b[0m`);
              console.log(`  \x1b[90m└─ ID: ${mem.id} | Type: ${mem.type} | Recalls: ${mem.recall_count}\x1b[0m`);
            }
          }
        }
      } else {
        const active = memoryStore.getActiveByUser('default_user');
        const matches = active.filter(m => m.content.toLowerCase().includes(query.toLowerCase()));
        if (matches.length === 0) {
          console.log('\x1b[90mNo relevant memories found.\x1b[0m');
        } else {
          for (const mem of matches) {
            console.log(`  \x1b[36m${mem.content}\x1b[0m \x1b[90m(ID: ${mem.id})\x1b[0m`);
          }
        }
      }
    } catch (e: any) {
      console.log(`\x1b[31mError recalling memory: ${e.message}\x1b[0m`);
    }
  } else if (input === '/memories') {
    const memories = memoryStore.getActiveByUser('default_user');
    if (memories.length === 0) {
      console.log('\x1b[90mNo active memories in store.\x1b[0m');
    } else {
      console.log(`\x1b[36mActive Memories (${memories.length}):\x1b[0m`);
      for (const m of memories) {
        console.log(`  \x1b[33m•\x1b[0m \x1b[37m${m.content}\x1b[0m`);
        console.log(`    \x1b[90mType: ${m.type} | Importance: ${m.importance.toFixed(2)} | Emotional: ${m.emotional_weight.toFixed(2)} | Recalls: ${m.recall_count}\x1b[0m`);
      }
    }
  } else if (input === '/stats') {
    const stats = memoryStore.countByUser('default_user');
    console.log(`\x1b[36mMemory Statistics:\x1b[0m`);
    console.log(`  Active: ${stats.active} | Dormant: ${stats.dormant} | Superseded: ${stats.superseded} | Consolidated: ${stats.consolidated} | Total: ${stats.total}`);
  } else if (input === '/debug') {
    debugMode = !debugMode;
    if (agent) agent.debugMode = debugMode;
    console.log(`\x1b[33mDebug mode ${debugMode ? 'ENABLED' : 'DISABLED'}\x1b[0m`);
  } else if (input.startsWith('/delete ')) {
    const id = input.substring('/delete '.length).trim();
    if (!id) {
      console.log('\x1b[33mUsage: /delete <id>\x1b[0m');
    } else {
      const all = memoryStore.getActiveByUser('default_user');
      const match = all.find(m => m.id.startsWith(id));
      if (match) {
        memoryStore.deleteMemory(match.id);
        vectorStore.delete(match.id);
        console.log(`\x1b[32m✔ Deleted memory ${match.id}\x1b[0m`);
      } else {
        console.log(`\x1b[33mMemory ID not found.\x1b[0m`);
      }
    }
  } else if (input === '/clear') {
    rl.question('\x1b[33mAre you sure you want to delete ALL memories? (y/n) \x1b[0m', (ans) => {
      if (ans.toLowerCase() === 'y') {
        const all = memoryStore.getActiveByUser('default_user');
        for (const m of all) {
          memoryStore.deleteMemory(m.id);
          vectorStore.delete(m.id);
        }
        if (agent) agent.clearWorkingMemory();
        console.log(`\x1b[32m✔ All memories wiped clean.\x1b[0m`);
      }
      rl.prompt();
    });
    return;
  } else if (input === '/help') {
    console.log(`
\x1b[36mCommands:\x1b[0m
  <message>        - Natural conversation with Engram (auto-remembers facts)
  /recall <query>  - Search stored memories by semantic similarity
  /memories        - View all stored active memories
  /stats           - View memory distribution counts
  /debug           - Toggle verbose extraction & recall diagnostics
  /remember <text> - Manually force-store a memory
  /delete <id>     - Delete a specific memory by ID prefix
  /clear           - Wipe all memories from the database
  /help            - Display this manual
  /quit, /exit     - Terminate session
    `);
  } else if (input === '/quit' || input === '/exit') {
    rl.close();
    return;
  } else if (input.startsWith('/')) {
    console.log('\x1b[33mUnknown command. Type /help for assistance.\x1b[0m');
  } else {
    // --- Conversational Interaction (Natural Chat) ---
    if (!agent) {
      console.log('\x1b[33mTo chat with Engram and enable autonomous memory extraction, set GEMINI_API_KEY in .env\x1b[0m');
      console.log('\x1b[90m(You can still use /remember and /recall in manual mode)\x1b[0m');
    } else {
      try {
        process.stdout.write('\x1b[90mEngram is thinking & recalling...\x1b[0m\r');
        const result = await agent.chat(input);

        // Clear loading indicator
        process.stdout.write(' '.repeat(45) + '\r');

        // Print assistant response
        console.log(`\x1b[32m${result.response}\x1b[0m\n`);

        // Print memory stats banner
        const stats = agent.getStats();
        console.log(`\x1b[90m[💾 Extracted: ${result.extractedMemories.length} | 🧠 Recalled: ${result.recalledMemories.length} | 📊 Total Active: ${stats.active}]\x1b[0m`);

        if (debugMode) {
          if (result.recalledMemories.length > 0) {
            console.log('\x1b[34m[Debug] Recalled memories injected into context:\x1b[0m');
            result.recalledMemories.forEach(m => console.log(`  - (${m.type}) ${m.content}`));
          }
          if (result.extractedMemories.length > 0) {
            console.log('\x1b[35m[Debug] Newly extracted & stored memories:\x1b[0m');
            result.extractedMemories.forEach(m => console.log(`  + (${m.type} | Imp: ${m.importance} | Emo: ${m.emotional_weight}) ${m.content}`));
          }
        }
      } catch (err: any) {
        console.log(`\x1b[31mError during chat: ${err.message}\x1b[0m`);
      }
    }
  }

  rl.prompt();
}).on('close', () => {
  console.log('\x1b[36mExiting Engram...\x1b[0m');
  process.exit(0);
});
