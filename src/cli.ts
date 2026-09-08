import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase } from './storage/database.js';
import { MemoryStore } from './storage/memory-store.js';
import { VectorStore } from './storage/vector-store.js';
import { GeminiLLMProvider, GeminiEmbeddingProvider } from './providers/gemini.js';
import { EngramAgent } from './agent.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from './core/types.js';
import type { Memory } from './core/types.js';
import { computeSalience, getAdaptiveHalfLife, hoursUntilDormant } from './core/salience.js';
import { retrieveMemories } from './recall/retrieval.js';
import { runDecaySweep } from './processes/decay-sweep.js';

dotenv.config();

const dbPath = process.env.DB_PATH || './engram.db';
const db = initDatabase(dbPath);
const memoryStore = new MemoryStore(db);
const vectorStore = new VectorStore(db);

const timeProvider = new SimulatedTimeProvider();

const apiKey = process.env.GEMINI_API_KEY || '';

let llmProvider: GeminiLLMProvider | null = null;
let embeddingProvider: GeminiEmbeddingProvider | null = null;
let agent: EngramAgent | null = null;

if (apiKey.trim()) {
  try {
    llmProvider = new GeminiLLMProvider(apiKey);
    embeddingProvider = new GeminiEmbeddingProvider(apiKey);
    agent = new EngramAgent(db, llmProvider, embeddingProvider, DEFAULT_CONFIG, timeProvider);
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
  Phase 3: Ebbinghaus Decay & Spaced Repetition Engine\x1b[0m
  ${apiKey ? '\x1b[32m● Connected to Gemini (Chat + Memory Extraction active)\x1b[0m' : '\x1b[33m○ No GEMINI_API_KEY set — running in manual mode\x1b[0m'}
  Clock: \x1b[33m${timeProvider.now().toISOString()}\x1b[0m
  Type \x1b[36m/help\x1b[0m for commands, or chat naturally!
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
    
    const nowIso = timeProvider.now().toISOString();
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
      created_at: nowIso,
      last_recalled_at: nowIso,
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
      console.log(`\x1b[32m✔ Memory stored (ID: ${memory.id})\x1b[0m`);
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
      const now = timeProvider.now();
      const results = await retrieveMemories(
        query,
        memoryStore,
        vectorStore,
        embeddingProvider,
        now,
        { userId: 'default_user', limit: 5 }
      );

      if (results.length === 0) {
        console.log('\x1b[90mNo active, non-dormant memories found matching query.\x1b[0m');
      } else {
        console.log(`\x1b[36mRetrieved ${results.length} memories (ranked by similarity + salience):\x1b[0m`);
        for (const res of results) {
          const m = res.memory;
          console.log(`  \x1b[32m[Final: ${res.final_score.toFixed(2)} | Sim: ${(res.similarity_score * 100).toFixed(0)}% | Salience: ${res.salience_score.toFixed(2)}]\x1b[0m \x1b[37m${m.content}\x1b[0m`);
          console.log(`    \x1b[90mID: ${m.id} | Type: ${m.type} | Recalls: ${m.recall_count} | Half-Life: ${getAdaptiveHalfLife(m).toFixed(0)}h\x1b[0m`);
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
      const now = timeProvider.now();
      console.log(`\x1b[36mActive Memories (${memories.length}) as of ${now.toISOString()}:\x1b[0m`);
      for (const m of memories) {
        const salience = computeSalience(m, now);
        const halfLife = getAdaptiveHalfLife(m);
        const hoursLeft = hoursUntilDormant(m, now);

        const salienceColor = salience > 0.5 ? '\x1b[32m' : salience > 0.1 ? '\x1b[33m' : '\x1b[31m';

        console.log(`  \x1b[33m•\x1b[0m \x1b[37m${m.content}\x1b[0m`);
        console.log(`    \x1b[90mType: ${m.type} | Importance: ${m.importance.toFixed(2)} | Salience: ${salienceColor}${salience.toFixed(3)}\x1b[90m | Half-Life: ${halfLife.toFixed(0)}h | Recalls: ${m.recall_count} | Dormant in: ${hoursLeft.toFixed(1)}h\x1b[0m`);
      }
    }
  } else if (input === '/stats') {
    const stats = memoryStore.countByUser('default_user');
    console.log(`\x1b[36mMemory Distribution:\x1b[0m`);
    console.log(`  Active: ${stats.active} | Dormant: ${stats.dormant} | Superseded: ${stats.superseded} | Consolidated: ${stats.consolidated} | Total: ${stats.total}`);
  } else if (input === '/decay') {
    const report = runDecaySweep(memoryStore, vectorStore, timeProvider.now(), DEFAULT_CONFIG);
    console.log(`\x1b[36m🧹 Decay Sweep Report (${report.timestamp}):\x1b[0m`);
    console.log(`  Active Checked:     ${report.checkedCount}`);
    console.log(`  Marked as Dormant:  ${report.markedDormantCount}`);
    console.log(`  Permanently Purged: ${report.purgedCount}`);
    console.log(`  Active Remaining:   ${report.activeRemainingCount}`);
    console.log(`  Dormant Remaining:  ${report.dormantRemainingCount}`);
  } else if (input.startsWith('/time')) {
    const parts = input.split(/\s+/);
    if (parts.length === 1) {
      console.log(`\x1b[33mCurrent reference clock:\x1b[0m ${timeProvider.now().toISOString()}`);
    } else if (parts[1] === 'advance' && parts[2]) {
      const hours = parseFloat(parts[2]);
      if (isNaN(hours) || hours <= 0) {
        console.log('\x1b[31mUsage: /time advance <positive_hours>\x1b[0m');
      } else {
        timeProvider.advance(hours);
        const report = runDecaySweep(memoryStore, vectorStore, timeProvider.now(), DEFAULT_CONFIG);
        console.log(`\x1b[32m✔ Fast-forwarded time by ${hours} hours.\x1b[0m`);
        console.log(`\x1b[33mNew timestamp:\x1b[0m ${timeProvider.now().toISOString()}`);
        if (report.markedDormantCount > 0 || report.purgedCount > 0) {
          console.log(`\x1b[90m(Sweep: ${report.markedDormantCount} memories became dormant, ${report.purgedCount} purged)\x1b[0m`);
        }
      }
    } else {
      console.log('\x1b[33mUsage: /time or /time advance <hours>\x1b[0m');
    }
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
  <message>           - Natural conversation with Engram (auto-extracts memories)
  /recall <query>     - Multi-signal recall (vector similarity + Ebbinghaus salience)
  /memories           - View active memories with real-time salience, half-lives & decay
  /decay              - Manually run background decay sweep & pruning
  /time               - View current reference timestamp
  /time advance <hrs> - Fast-forward time (watch memories naturally fade)
  /stats              - View memory distribution counts (Active, Dormant, Purged)
  /debug              - Toggle verbose extraction & recall diagnostics
  /remember <text>    - Manually force-store a memory
  /delete <id>        - Delete a specific memory by ID prefix
  /clear              - Wipe all memories from database
  /help               - Display this manual
  /quit, /exit        - Terminate session
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
      console.log('\x1b[90m(You can still use /remember, /recall, /time advance in manual mode)\x1b[0m');
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
            result.recalledMemories.forEach(m => console.log(`  - (${m.type} | Salience: ${computeSalience(m, timeProvider.now()).toFixed(3)}) ${m.content}`));
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
