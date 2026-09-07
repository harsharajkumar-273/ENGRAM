import type { Message, ChatOptions } from '../core/types.js';

/**
 * Interface for LLM chat providers.
 * All providers must implement this to be usable with Engram.
 */
export interface LLMProvider {
  /** The name of this provider (for logging). */
  readonly name: string;

  /** Send a chat completion request and get a text response. */
  chat(messages: Message[], options?: ChatOptions): Promise<string>;

  /**
   * Send a chat completion request and parse the response as JSON.
   * The provider should instruct the model to return valid JSON matching the schema.
   * Includes retry logic for malformed responses.
   */
  chatJSON<T>(messages: Message[], schema: Record<string, unknown>, options?: ChatOptions): Promise<T>;
}

/**
 * Interface for embedding providers.
 */
export interface EmbeddingProvider {
  /** The name of this provider (for logging). */
  readonly name: string;

  /** The dimensionality of embeddings produced by this provider. */
  readonly dimensions: number;

  /** Generate an embedding vector for a single text. */
  embed(text: string): Promise<number[]>;

  /** Generate embedding vectors for multiple texts (batch). */
  embedBatch(texts: string[]): Promise<number[][]>;
}
