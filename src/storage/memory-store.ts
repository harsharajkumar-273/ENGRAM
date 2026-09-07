import type Database from 'better-sqlite3';
import type { Memory, MemoryStatus, EntityLink, MemoryRow, MemoryEntityRow } from '../core/types.js';

/**
 * Handles CRUD operations for memories in the SQLite database.
 */
export class MemoryStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Converts a database row and a list of entities into a Memory object.
   */
  private rowToMemory(row: MemoryRow, entities: EntityLink[]): Memory {
    return {
      id: row.id,
      type: row.type as any,
      status: row.status as any,
      content: row.content,
      source_turn_id: row.source_turn_id,
      importance: row.importance,
      emotional_weight: row.emotional_weight,
      recall_count: row.recall_count,
      base_half_life_hours: row.base_half_life,
      strengthening_factor: row.strength_factor,
      created_at: row.created_at,
      last_recalled_at: row.last_recalled_at,
      superseded_by: row.superseded_by,
      consolidated_from: row.consolidated_from ? JSON.parse(row.consolidated_from) : [],
      user_id: row.user_id,
      session_id: row.session_id,
      entities: entities,
    };
  }

  /**
   * Helper to fetch entities for a memory.
   * Note: The memory_entities table lacks entity_name and entity_type in the original schema,
   * but the row types expect them. This query joins with entities table to fetch them.
   */
  private getEntitiesForMemory(memoryId: string): EntityLink[] {
    const stmt = this.db.prepare(`
      SELECT me.entity_id, me.relation, e.name as entity_name, e.type as entity_type
      FROM memory_entities me
      LEFT JOIN entities e ON me.entity_id = e.id
      WHERE me.memory_id = ?
    `);
    const rows = stmt.all(memoryId) as MemoryEntityRow[];
    return rows.map((row) => ({
      entity_id: row.entity_id,
      entity_name: row.entity_name || '',
      entity_type: row.entity_type as any,
      relation: row.relation,
    }));
  }

  /**
   * Helper to fetch entities for multiple memories at once for performance.
   */
  private getEntitiesForMemories(memoryIds: string[]): Record<string, EntityLink[]> {
    if (memoryIds.length === 0) return {};
    
    const placeholders = memoryIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT me.memory_id, me.entity_id, me.relation, e.name as entity_name, e.type as entity_type
      FROM memory_entities me
      LEFT JOIN entities e ON me.entity_id = e.id
      WHERE me.memory_id IN (${placeholders})
    `);
    const rows = stmt.all(...memoryIds) as (MemoryEntityRow & { memory_id: string })[];
    
    const result: Record<string, EntityLink[]> = {};
    for (const id of memoryIds) result[id] = [];
    
    for (const row of rows) {
      result[row.memory_id].push({
        entity_id: row.entity_id,
        entity_name: row.entity_name || '',
        entity_type: row.entity_type as any,
        relation: row.relation,
      });
    }
    return result;
  }

  /**
   * Inserts a new memory and its associated entities.
   */
  public create(memory: Memory): void {
    const insertMemoryStmt = this.db.prepare(`
      INSERT INTO memories (
        id, type, status, content, source_turn_id, importance, emotional_weight,
        recall_count, base_half_life, strength_factor, created_at, last_recalled_at,
        superseded_by, consolidated_from, user_id, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertEntityStmt = this.db.prepare(`
      INSERT INTO entities (id, name, type, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen = ?
    `);

    const insertEntityLinkStmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relation)
      VALUES (?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      insertMemoryStmt.run(
        memory.id,
        memory.type,
        memory.status,
        memory.content,
        memory.source_turn_id,
        memory.importance,
        memory.emotional_weight,
        memory.recall_count,
        memory.base_half_life_hours,
        memory.strengthening_factor,
        memory.created_at,
        memory.last_recalled_at,
        memory.superseded_by,
        memory.consolidated_from.length > 0 ? JSON.stringify(memory.consolidated_from) : null,
        memory.user_id,
        memory.session_id
      );

      for (const entity of memory.entities) {
        if (entity.entity_name) {
          upsertEntityStmt.run(
            entity.entity_id,
            entity.entity_name,
            entity.entity_type,
            memory.created_at,
            memory.created_at,
            memory.created_at
          );
        }
        insertEntityLinkStmt.run(memory.id, entity.entity_id, entity.relation);
      }
    });

    transaction();
  }

  /**
   * Fetches a memory by ID.
   */
  public getById(id: string): Memory | null {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    const row = stmt.get(id) as MemoryRow | undefined;
    
    if (!row) return null;
    
    const entities = this.getEntitiesForMemory(id);
    return this.rowToMemory(row, entities);
  }

  /**
   * Fetches all active memories for a given user.
   */
  public getActiveByUser(userId: string): Memory[] {
    const stmt = this.db.prepare("SELECT * FROM memories WHERE user_id = ? AND status = 'active'");
    const rows = stmt.all(userId) as MemoryRow[];
    
    if (rows.length === 0) return [];
    
    const entitiesMap = this.getEntitiesForMemories(rows.map(r => r.id));
    return rows.map(row => this.rowToMemory(row, entitiesMap[row.id]));
  }

  /**
   * Fetches memories by status.
   */
  public getByStatus(status: MemoryStatus): Memory[] {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE status = ?');
    const rows = stmt.all(status) as MemoryRow[];
    
    if (rows.length === 0) return [];
    
    const entitiesMap = this.getEntitiesForMemories(rows.map(r => r.id));
    return rows.map(row => this.rowToMemory(row, entitiesMap[row.id]));
  }

  /**
   * Updates recall statistics for a memory.
   */
  public updateRecallStats(id: string, now: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories
      SET recall_count = recall_count + 1, last_recalled_at = ?
      WHERE id = ?
    `);
    stmt.run(now, id);
  }

  /**
   * Updates the status of a memory.
   */
  public updateStatus(id: string, status: MemoryStatus, supersededBy?: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories
      SET status = ?, superseded_by = ?
      WHERE id = ?
    `);
    stmt.run(status, supersededBy || null, id);
  }

  /**
   * Hard deletes a memory and cascades to embeddings and entities.
   */
  public deleteMemory(id: string): void {
    const deleteMemoryStmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const deleteEmbeddingsStmt = this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?');
    const deleteEntitiesStmt = this.db.prepare('DELETE FROM memory_entities WHERE memory_id = ?');

    const transaction = this.db.transaction(() => {
      deleteMemoryStmt.run(id);
      deleteEmbeddingsStmt.run(id);
      deleteEntitiesStmt.run(id);
    });

    transaction();
  }

  /**
   * Counts memories by status for a given user.
   */
  public countByUser(userId: string): { total: number; active: number; dormant: number; superseded: number; consolidated: number } {
    const stmt = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM memories
      WHERE user_id = ?
      GROUP BY status
    `);
    const rows = stmt.all(userId) as { status: string; count: number }[];
    
    const result = { total: 0, active: 0, dormant: 0, superseded: 0, consolidated: 0 };
    for (const row of rows) {
      result.total += row.count;
      if (row.status === 'active') result.active = row.count;
      else if (row.status === 'dormant') result.dormant = row.count;
      else if (row.status === 'superseded') result.superseded = row.count;
      else if (row.status === 'consolidated') result.consolidated = row.count;
    }
    
    return result;
  }
}
