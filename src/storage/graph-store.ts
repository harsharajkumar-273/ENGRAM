// ============================================
// Engram Entity Graph Storage & Traversal
// ============================================

import type Database from 'better-sqlite3';
import type { Entity, EntityLink, EntityType } from '../core/types.js';

export interface RelatedEntityResult {
  entity: Entity;
  hop: number;
  sharedCategory: string;
}

export class GraphStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Upserts an entity record and associates any categories.
   */
  public upsertEntity(entity: Entity): void {
    const upsertStmt = this.db.prepare(`
      INSERT INTO entities (id, name, type, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        last_seen = excluded.last_seen
    `);

    const insertCategoryStmt = this.db.prepare(`
      INSERT OR IGNORE INTO entity_categories (entity_id, category)
      VALUES (?, ?)
    `);

    const transaction = this.db.transaction(() => {
      upsertStmt.run(
        entity.id,
        entity.name.trim(),
        entity.type,
        entity.first_seen_at,
        entity.last_seen_at
      );

      for (const cat of entity.categories) {
        if (cat && cat.trim()) {
          insertCategoryStmt.run(entity.id, cat.trim().toLowerCase());
        }
      }
    });

    transaction();
  }

  /**
   * Retrieves an entity by its ID, hydrating its categories.
   */
  public getEntityById(id: string): Entity | null {
    const stmt = this.db.prepare('SELECT * FROM entities WHERE id = ?');
    const row = stmt.get(id) as { id: string; name: string; type: string; first_seen: string; last_seen: string } | undefined;
    if (!row) return null;

    const catStmt = this.db.prepare('SELECT category FROM entity_categories WHERE entity_id = ?');
    const catRows = catStmt.all(id) as { category: string }[];

    return {
      id: row.id,
      name: row.name,
      type: row.type as EntityType,
      categories: catRows.map(c => c.category),
      first_seen_at: row.first_seen,
      last_seen_at: row.last_seen
    };
  }

  /**
   * Searches for an entity by exact or case-insensitive name and optional type.
   */
  public getEntityByName(name: string, type?: EntityType): Entity | null {
    let stmt;
    let row;
    if (type) {
      stmt = this.db.prepare('SELECT * FROM entities WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1');
      row = stmt.get(name, type) as any;
    } else {
      stmt = this.db.prepare('SELECT * FROM entities WHERE LOWER(name) = LOWER(?) LIMIT 1');
      row = stmt.get(name) as any;
    }

    if (!row) return null;
    return this.getEntityById(row.id);
  }

  /**
   * Links a memory to an entity with a specific relation.
   */
  public linkMemoryToEntity(memoryId: string, entityId: string, relation: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relation)
      VALUES (?, ?, ?)
    `);
    stmt.run(memoryId, entityId, relation);
  }

  /**
   * Returns all memory IDs connected to a given entity.
   */
  public getMemoriesForEntity(entityId: string): string[] {
    const stmt = this.db.prepare('SELECT memory_id FROM memory_entities WHERE entity_id = ?');
    const rows = stmt.all(entityId) as { memory_id: string }[];
    return rows.map(r => r.memory_id);
  }

  /**
   * Returns all entities linked directly to a specific memory.
   */
  public getEntitiesForMemory(memoryId: string): EntityLink[] {
    const stmt = this.db.prepare(`
      SELECT me.entity_id, me.relation, e.name as entity_name, e.type as entity_type
      FROM memory_entities me
      JOIN entities e ON me.entity_id = e.id
      WHERE me.memory_id = ?
    `);
    const rows = stmt.all(memoryId) as any[];
    return rows.map(r => ({
      entity_id: r.entity_id,
      entity_name: r.entity_name,
      entity_type: r.entity_type,
      relation: r.relation
    }));
  }

  /**
   * Traverses the entity graph (1-hop) across shared categories.
   * E.g., Entity "Peanuts" (category: dietary_restrictions) connects to
   * Entity "Vegetarian" (category: dietary_restrictions).
   */
  public getRelatedEntities(entityId: string): RelatedEntityResult[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT e.id, e.name, e.type, e.first_seen, e.last_seen, ec1.category as shared_category
      FROM entity_categories ec1
      JOIN entity_categories ec2 ON ec1.category = ec2.category
      JOIN entities e ON ec2.entity_id = e.id
      WHERE ec1.entity_id = ? AND ec2.entity_id != ?
    `);

    const rows = stmt.all(entityId, entityId) as any[];

    return rows.map(r => ({
      entity: {
        id: r.id,
        name: r.name,
        type: r.type,
        categories: [r.shared_category],
        first_seen_at: r.first_seen,
        last_seen_at: r.last_seen
      },
      hop: 1,
      sharedCategory: r.shared_category
    }));
  }

  /**
   * Lists all entities with their category labels and count of linked memories.
   */
  public getAllEntities(): (Entity & { memoryCount: number })[] {
    const stmt = this.db.prepare(`
      SELECT e.*, COUNT(me.memory_id) as memory_count
      FROM entities e
      LEFT JOIN memory_entities me ON e.id = me.entity_id
      GROUP BY e.id
      ORDER BY memory_count DESC, e.last_seen DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map(r => {
      const catStmt = this.db.prepare('SELECT category FROM entity_categories WHERE entity_id = ?');
      const catRows = catStmt.all(r.id) as { category: string }[];

      return {
        id: r.id,
        name: r.name,
        type: r.type,
        categories: catRows.map(c => c.category),
        first_seen_at: r.first_seen,
        last_seen_at: r.last_seen,
        memoryCount: r.memory_count
      };
    });
  }
}
