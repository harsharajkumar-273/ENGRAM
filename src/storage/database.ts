import Database from 'better-sqlite3';

/**
 * Initializes the SQLite database and creates the necessary tables.
 * Enables WAL mode for improved performance.
 *
 * @param dbPath - The path to the SQLite database file.
 * @returns A better-sqlite3 Database instance.
 */
export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable Write-Ahead Logging for better concurrency and performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
        status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'dormant', 'superseded', 'consolidated')),
        content         TEXT NOT NULL,
        source_turn_id  TEXT NOT NULL DEFAULT '',
        importance      REAL NOT NULL DEFAULT 0.5,
        emotional_weight REAL NOT NULL DEFAULT 0.0,
        recall_count    INTEGER NOT NULL DEFAULT 0,
        base_half_life  REAL NOT NULL,
        strength_factor REAL NOT NULL DEFAULT 0.5,
        created_at      TEXT NOT NULL,
        last_recalled_at TEXT NOT NULL,
        superseded_by   TEXT,
        consolidated_from TEXT,
        user_id         TEXT NOT NULL,
        session_id      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cold_memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        scale REAL NOT NULL,
        dimensions INTEGER NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entities (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_categories (
        entity_id   TEXT NOT NULL,
        category    TEXT NOT NULL,
        PRIMARY KEY (entity_id, category)
    );

    CREATE TABLE IF NOT EXISTS memory_entities (
        memory_id   TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        relation    TEXT NOT NULL,
        PRIMARY KEY (memory_id, entity_id, relation)
    );

    CREATE TABLE IF NOT EXISTS contradictions (
        id              TEXT PRIMARY KEY,
        old_memory_id   TEXT NOT NULL,
        new_memory_id   TEXT NOT NULL,
        old_content     TEXT NOT NULL,
        new_content     TEXT NOT NULL,
        confidence      REAL NOT NULL,
        reasoning       TEXT NOT NULL,
        detected_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consolidations (
        id              TEXT PRIMARY KEY,
        source_ids      TEXT NOT NULL,
        result_id       TEXT NOT NULL,
        created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_tiers (
        memory_id          TEXT PRIMARY KEY,
        tier               TEXT NOT NULL CHECK(tier IN ('hot', 'warm', 'cold')),
        cue                TEXT NOT NULL,
        access_count       INTEGER NOT NULL DEFAULT 0,
        successful_use_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at   TEXT,
        utility_score      REAL NOT NULL DEFAULT 0,
        pinned             INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS idx_memory_entities_entity_id ON memory_entities(entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_tiers_tier ON memory_tiers(tier);
  `);

  return db;
}
