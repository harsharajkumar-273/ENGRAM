import type Database from 'better-sqlite3';
import type { VectorSearchResult } from '../core/types.js';

/**
 * Storage and similarity search for memory embeddings.
 * Uses pure TypeScript for cosine similarity since we avoid sqlite-vec.
 */
export class VectorStore {
  private db: Database.Database;
  private hotCache = new Map<string, number[]>();
  private searchComparisons = 0;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Serializes a number array into a Float32 Buffer.
   */
  public serializeEmbedding(embedding: number[]): Buffer {
    return serializeEmbedding(embedding);
  }

  /**
   * Deserializes a Float32 Buffer into a number array.
   */
  public deserializeEmbedding(buffer: Buffer): number[] {
    return deserializeEmbedding(buffer);
  }

  /**
   * Computes cosine similarity between two vectors.
   */
  public cosineSimilarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  /**
   * Stores a vector embedding for a memory.
   */
  public store(memoryId: string, embedding: number[]): void {
    const buffer = this.serializeEmbedding(embedding);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding)
      VALUES (?, ?)
    `);
    stmt.run(memoryId, buffer);
    // A newly written full-precision vector supersedes an archived encoding.
    this.db.prepare('DELETE FROM cold_memory_embeddings WHERE memory_id = ?').run(memoryId);
    if (this.hotCache.has(memoryId)) this.hotCache.set(memoryId, [...embedding]);
  }

  /** Moves only the retrieval representation; canonical memory content stays authoritative. */
  public setTier(memoryId: string, tier: 'hot' | 'warm' | 'cold'): void {
    if (tier === 'cold') {
      const embedding = this.getEmbedding(memoryId);
      if (embedding) {
        const { bytes, scale } = quantizeEmbedding(embedding);
        this.db.prepare(`
          INSERT OR REPLACE INTO cold_memory_embeddings
            (memory_id, embedding, scale, dimensions)
          VALUES (?, ?, ?, ?)
        `).run(memoryId, bytes, scale, embedding.length);
        this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
      }
      this.hotCache.delete(memoryId);
      return;
    }

    const cold = this.getColdEmbedding(memoryId);
    if (cold) {
      const buffer = this.serializeEmbedding(cold);
      this.db.prepare(`
        INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)
      `).run(memoryId, buffer);
      this.db.prepare('DELETE FROM cold_memory_embeddings WHERE memory_id = ?').run(memoryId);
    }

    const full = this.getEmbedding(memoryId);
    if (tier === 'hot' && full) this.hotCache.set(memoryId, full);
    else this.hotCache.delete(memoryId);
  }

  /**
   * Searches for similar memories using pure TypeScript cosine similarity.
   */
  public search(
    queryEmbedding: number[],
    topK: number,
    threshold: number,
    allowedMemoryIds?: ReadonlySet<string>
  ): VectorSearchResult[] {
    if (allowedMemoryIds && allowedMemoryIds.size === 0) return [];

    let rows: { memory_id: string; embedding: Buffer }[];
    const cachedResults: VectorSearchResult[] = [];
    const cachedIds = new Set<string>();
    for (const [memoryId, embedding] of this.hotCache) {
      if (allowedMemoryIds && !allowedMemoryIds.has(memoryId)) continue;
      cachedIds.add(memoryId);
      if (embedding.length !== queryEmbedding.length) continue;
      this.searchComparisons++;
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) cachedResults.push({ memory_id: memoryId, similarity });
    }
    if (allowedMemoryIds) {
      const ids = Array.from(allowedMemoryIds).filter(id => !cachedIds.has(id));
      if (ids.length === 0) rows = [];
      else {
      const placeholders = ids.map(() => '?').join(',');
      rows = this.db.prepare(
        `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${placeholders})`
      ).all(...ids) as { memory_id: string; embedding: Buffer }[];
      }
    } else {
      rows = this.db.prepare('SELECT memory_id, embedding FROM memory_embeddings')
        .all() as { memory_id: string; embedding: Buffer }[];
    }

    const results: VectorSearchResult[] = [...cachedResults];

    for (const row of rows) {
      if (cachedIds.has(row.memory_id)) continue;
      const embedding = this.deserializeEmbedding(row.embedding);
      
      // Ensure lengths match before calculating similarity
      if (embedding.length === queryEmbedding.length) {
        this.searchComparisons++;
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);
        
        if (similarity >= threshold) {
          results.push({
            memory_id: row.memory_id,
            similarity
          });
        }
      }
    }

    // Cold vectors use symmetric int8 quantization (roughly 4x smaller than Float32).
    const coldRows = allowedMemoryIds
      ? this.getColdRows(allowedMemoryIds)
      : this.db.prepare('SELECT * FROM cold_memory_embeddings').all() as ColdEmbeddingRow[];
    for (const row of coldRows) {
      const embedding = dequantizeEmbedding(row.embedding, row.scale, row.dimensions);
      if (embedding.length !== queryEmbedding.length) continue;
      this.searchComparisons++;
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      if (similarity >= threshold) results.push({ memory_id: row.memory_id, similarity });
    }

    // Sort descending by similarity
    results.sort((a, b) => b.similarity - a.similarity);

    // Return top K
    return results.slice(0, topK);
  }

  /**
   * Deletes a memory's embedding.
   */
  public delete(memoryId: string): void {
    const stmt = this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?');
    stmt.run(memoryId);
    this.db.prepare('DELETE FROM cold_memory_embeddings WHERE memory_id = ?').run(memoryId);
    this.hotCache.delete(memoryId);
  }

  /**
   * Retrieves an embedding for a memory.
   */
  public getEmbedding(memoryId: string): number[] | null {
    const stmt = this.db.prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?');
    const row = stmt.get(memoryId) as { embedding: Buffer } | undefined;
    
    if (!row) return null;
    return this.deserializeEmbedding(row.embedding);
  }

  /**
   * Counts the total number of stored embeddings.
   */
  public count(): number {
    const full = this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings').get() as { count: number };
    const cold = this.db.prepare('SELECT COUNT(*) as count FROM cold_memory_embeddings').get() as { count: number };
    return full.count + cold.count;
  }

  public getStorageStats(): {
    hotEntries: number;
    fullPrecisionEntries: number;
    coldEntries: number;
    fullPrecisionBytes: number;
    coldBytes: number;
  } {
    const full = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(embedding)), 0) AS bytes
      FROM memory_embeddings
    `).get() as { count: number; bytes: number };
    const cold = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(embedding)), 0) AS bytes
      FROM cold_memory_embeddings
    `).get() as { count: number; bytes: number };
    return {
      hotEntries: this.hotCache.size,
      fullPrecisionEntries: full.count,
      coldEntries: cold.count,
      fullPrecisionBytes: full.bytes,
      coldBytes: cold.bytes,
    };
  }

  /** Deterministic work counter used by benchmarks instead of noisy wall-clock timing. */
  public resetSearchComparisons(): void {
    this.searchComparisons = 0;
  }

  public getSearchComparisons(): number {
    return this.searchComparisons;
  }

  private getColdEmbedding(memoryId: string): number[] | null {
    const row = this.db.prepare('SELECT * FROM cold_memory_embeddings WHERE memory_id = ?')
      .get(memoryId) as ColdEmbeddingRow | undefined;
    return row ? dequantizeEmbedding(row.embedding, row.scale, row.dimensions) : null;
  }

  private getColdRows(ids: ReadonlySet<string>): ColdEmbeddingRow[] {
    if (ids.size === 0) return [];
    const values = Array.from(ids);
    const placeholders = values.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM cold_memory_embeddings WHERE memory_id IN (${placeholders})`
    ).all(...values) as ColdEmbeddingRow[];
  }
}

interface ColdEmbeddingRow {
  memory_id: string;
  embedding: Buffer;
  scale: number;
  dimensions: number;
}

export function quantizeEmbedding(embedding: number[]): { bytes: Buffer; scale: number } {
  const maxAbs = Math.max(...embedding.map(value => Math.abs(value)), 0);
  const scale = maxAbs === 0 ? 1 : maxAbs / 127;
  const values = Int8Array.from(embedding.map(value =>
    Math.max(-127, Math.min(127, Math.round(value / scale)))
  ));
  return { bytes: Buffer.from(values.buffer), scale };
}

export function dequantizeEmbedding(bytes: Buffer, scale: number, dimensions: number): number[] {
  const values = new Int8Array(bytes.buffer, bytes.byteOffset, Math.min(dimensions, bytes.byteLength));
  return Array.from(values, value => value * scale);
}

/**
 * Serializes a number array into a Float32 Buffer.
 */
export function serializeEmbedding(embedding: number[]): Buffer {
  const floatArray = new Float32Array(embedding);
  return Buffer.from(floatArray.buffer);
}

/**
 * Deserializes a Float32 Buffer into a number array.
 */
export function deserializeEmbedding(buffer: Buffer): number[] {
  const floatArray = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(floatArray);
}

/**
 * Computes cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length for cosine similarity');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
