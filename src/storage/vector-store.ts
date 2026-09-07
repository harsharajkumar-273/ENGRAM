import type Database from 'better-sqlite3';
import type { VectorSearchResult } from '../core/types.js';

/**
 * Storage and similarity search for memory embeddings.
 * Uses pure TypeScript for cosine similarity since we avoid sqlite-vec.
 */
export class VectorStore {
  private db: Database.Database;

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
  }

  /**
   * Searches for similar memories using pure TypeScript cosine similarity.
   */
  public search(queryEmbedding: number[], topK: number, threshold: number): VectorSearchResult[] {
    const stmt = this.db.prepare('SELECT memory_id, embedding FROM memory_embeddings');
    const rows = stmt.all() as { memory_id: string; embedding: Buffer }[];

    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      const embedding = this.deserializeEmbedding(row.embedding);
      
      // Ensure lengths match before calculating similarity
      if (embedding.length === queryEmbedding.length) {
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);
        
        if (similarity >= threshold) {
          results.push({
            memory_id: row.memory_id,
            similarity
          });
        }
      }
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
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings');
    const row = stmt.get() as { count: number };
    return row.count;
  }
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
