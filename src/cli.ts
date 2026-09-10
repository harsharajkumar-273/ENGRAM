import * as readline from 'readline';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase } from './storage/database.js';
import { MemoryStore } from './storage/memory-store.js';
import { VectorStore } from './storage/vector-store.js';
import { GraphStore } from './storage/graph-store.js';
import { GeminiLLMProvider, GeminiEmbeddingProvider } from './providers/gemini.js';
import { EngramAgent } from './agent.js';
import { SimulatedTimeProvider, DEFAULT_CONFIG } from './core/types.js';
import type { Memory } from './core/types.js';
import { computeSalience, getAdaptiveHalfLife, hoursUntilDormant } from './core/salience.js';
import { retrieveMemories } from './recall/retrieval.js';
import { runDecaySweep } from './processes/decay-sweep.js';
import { formatTerminalStep } from './agent/telemetry.js';

dotenv.config();

const dbPath = process.env.DB_PATH || './engram.db';
const db = initDatabase(dbPath);
const memoryStore = new MemoryStore(db);
const vectorStore = new VectorStore(db);
const graphStore = new GraphStore(db);

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
        { userId: 'default_user', limit: 5, graphStore }
      );

      if (results.length === 0) {
        console.log('\x1b[90mNo active, non-dormant memories found matching query.\x1b[0m');
      } else {
        console.log(`\x1b[36mRetrieved ${results.length} memories (ranked by similarity + salience + graph):\x1b[0m`);
        for (const res of results) {
          const m = res.memory;
          const assocTag = res.association_boost > 0 ? ` | \x1b[35mGraph: +${res.association_boost.toFixed(2)}\x1b[32m` : '';
          console.log(`  \x1b[32m[Score: ${res.final_score.toFixed(2)} | Sim: ${(res.similarity_score * 100).toFixed(0)}% | Sal: ${res.salience_score.toFixed(2)}${assocTag}]\x1b[0m \x1b[37m${m.content}\x1b[0m`);
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
  } else if (input === '/contradictions') {
    const logs = memoryStore.getContradictions();
    if (logs.length === 0) {
      console.log('\x1b[90mNo contradictions recorded yet.\x1b[0m');
    } else {
      console.log(`\x1b[36m⚡ Contradiction Audit Trail (${logs.length} detected changes):\x1b[0m`);
      for (const log of logs) {
        console.log(`  \x1b[31m[SUPERSEDED]\x1b[0m "${log.old_content}"`);
        console.log(`  \x1b[32m[CURRENT]   \x1b[0m "${log.new_content}"`);
        console.log(`  \x1b[90mConfidence: ${(log.confidence * 100).toFixed(0)}% | Time: ${log.detected_at}\x1b[0m`);
        console.log(`  \x1b[90mReasoning:  ${log.reasoning}\x1b[0m\n`);
      }
    }
  } else if (input === '/entities') {
    const entities = graphStore.getAllEntities();
    if (entities.length === 0) {
      console.log('\x1b[90mNo entities in knowledge graph yet.\x1b[0m');
    } else {
      console.log(`\x1b[36m🕸️ Entity Knowledge Graph (${entities.length} entities):\x1b[0m`);
      for (const ent of entities) {
        const catStr = ent.categories.length > 0 ? `\x1b[35m[${ent.categories.join(', ')}]\x1b[0m ` : '';
        console.log(`  \x1b[33m•\x1b[0m \x1b[37m${ent.name}\x1b[0m \x1b[90m(${ent.type})\x1b[0m ${catStr}\x1b[32m(${ent.memoryCount} memory links)\x1b[0m`);
      }
    }
  } else if (input.startsWith('/graph ')) {
    const name = input.substring('/graph '.length).trim();
    if (!name) {
      console.log('\x1b[33mUsage: /graph <entity_name>\x1b[0m');
    } else {
      const entity = graphStore.getEntityByName(name);
      if (!entity) {
        console.log(`\x1b[33mEntity "${name}" not found in graph.\x1b[0m`);
      } else {
        const memIds = graphStore.getMemoriesForEntity(entity.id);
        const related = graphStore.getRelatedEntities(entity.id);
        console.log(`\x1b[36m🕸️ Entity: \x1b[37m${entity.name}\x1b[36m (${entity.type})\x1b[0m`);
        console.log(`  Categories: ${entity.categories.join(', ') || 'none'}`);
        console.log(`  Linked Memories (${memIds.length}):`);
        for (const mid of memIds) {
          const m = memoryStore.getById(mid);
          if (m) console.log(`    - "${m.content}"`);
        }
        console.log(`  Connected 1-Hop Concepts (${related.length}):`);
        for (const rel of related) {
          console.log(`    -> \x1b[32m${rel.entity.name}\x1b[0m (${rel.entity.type}) via [${rel.sharedCategory}]`);
        }
      }
    }
  } else if (input === '/consolidate') {
    if (!agent) {
      console.log('\x1b[33mConsolidation requires GEMINI_API_KEY in .env for LLM abstractive summarization.\x1b[0m');
    } else {
      process.stdout.write('\x1b[90mRunning consolidation sleep pass (clustering episodic fragments)...\x1b[0m\r');
      const consolidated = await agent.consolidate();
      process.stdout.write(' '.repeat(65) + '\r');
      if (consolidated.length === 0) {
        console.log('\x1b[90mNo qualifying episodic memory clusters (>= 3 related events) found to consolidate.\x1b[0m');
      } else {
        console.log(`\x1b[32m✔ Consolidation pass completed! Created ${consolidated.length} synthesized semantic narrative(s):\x1b[0m`);
        for (const c of consolidated) {
          console.log(`  \x1b[36m• [Semantic Narrative]\x1b[0m "${c.content}"`);
          console.log(`    \x1b[90mConsolidated from ${c.consolidated_from.length} episodic memories | Importance: ${c.importance.toFixed(2)}\x1b[0m`);
        }
      }
    }
  } else if (input === '/procedural') {
    if (!agent) {
      console.log('\x1b[33mProcedural detection requires GEMINI_API_KEY in .env.\x1b[0m');
    } else {
      process.stdout.write('\x1b[90mAnalyzing conversational interactions for procedural habits...\x1b[0m\r');
      const detected = await agent.detectProcedural();
      process.stdout.write(' '.repeat(65) + '\r');
      if (detected.length === 0) {
        console.log('\x1b[90mNo new recurring procedural patterns detected in recent turns.\x1b[0m');
      } else {
        console.log(`\x1b[32m✔ Extracted ${detected.length} procedural interaction guideline(s):\x1b[0m`);
        for (const p of detected) {
          console.log(`  \x1b[35m⚙ [Procedural Rule]\x1b[0m "${p.content}"`);
          console.log(`    \x1b[90mHalf-Life: ${p.base_half_life_hours}h (90 days) | Importance: ${p.importance.toFixed(2)}\x1b[0m`);
        }
      }
    }
  } else if (input.startsWith('/goal ') || input.startsWith('/run ')) {
    const goalText = input.replace(/^\/(goal|run)\s+/, '').trim();
    if (!goalText) {
      console.log('\x1b[33mUsage: /goal <task description>\x1b[0m');
    } else if (!agent) {
      console.log('\x1b[33mAutonomous goal execution requires GEMINI_API_KEY in .env\x1b[0m');
    } else {
      console.log(`\n\x1b[35m🚀 Launching Autonomous ReAct Agent for goal:\x1b[0m "${goalText}"\n`);
      const res = await agent.executeGoal(goalText, {
        onStep: (step) => {
          console.log(formatTerminalStep(step));
        }
      });

      if (res.status === 'completed') {
        console.log(`\x1b[32m🎯 Final Answer:\x1b[0m\n${res.finalAnswer}\n`);
        console.log(`\x1b[90mTrace ID: ${res.trace.traceId} | Steps: ${res.trace.steps.length} | Latency: ${res.trace.totalLatencyMs}ms\x1b[0m\n`);
      } else {
        console.log(`\x1b[31m⚠️ Goal Execution Stopped (${res.status.toUpperCase()}): ${res.trace.circuitBreakerReason || 'Incomplete'}\x1b[0m\n`);
      }
    }
  } else if (input === '/help') {
    console.log(`
\x1b[36mCommands:\x1b[0m
  <message>           - Natural conversation with Engram (auto-extracts memories)
  /goal <objective>   - Launch autonomous agent with tools, ReAct loop & self-healing
  /recall <query>     - Multi-signal recall (vector similarity + Ebbinghaus salience + graph)
  /memories           - View active memories with real-time salience, half-lives & decay
  /consolidate        - Run sleep pass (cluster episodic events into rich semantic narratives)
  /procedural         - Detect recurring behavioral & interaction guidelines
  /entities           - View all entities and categories in the knowledge graph
  /graph <entity>     - Inspect 1-hop associations and linked memories for an entity
  /contradictions     - View audit log of detected fact changes & superseded memories
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
