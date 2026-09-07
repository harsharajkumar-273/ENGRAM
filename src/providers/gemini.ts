import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Message, ChatOptions } from '../core/types.js';
import type { LLMProvider, EmbeddingProvider } from './interface.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetries<T>(
  operation: () => Promise<T>,
  retries = 3,
  delays = [1000, 2000, 4000]
): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const msg = error.message?.toLowerCase() || '';
      const isRetryable =
        msg.includes('429') ||
        msg.includes('500') ||
        msg.includes('503') ||
        msg.includes('too many requests') ||
        msg.includes('internal server error');

      if (i < retries && isRetryable) {
        await delay(delays[i] || 4000);
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

export class GeminiLLMProvider implements LLMProvider {
  public readonly name = 'Google Gemini';
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(apiKey: string, modelName = 'gemini-2.0-flash') {
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('Gemini API key is required but was empty or missing.');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  private prepareMessages(messages: Message[]) {
    let systemInstruction: any = undefined;
    const contents: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = {
          role: 'system',
          parts: [{ text: msg.content }]
        };
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }
    return { systemInstruction, contents };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });
    const { systemInstruction, contents } = this.prepareMessages(messages);

    const config: any = {};
    if (options?.temperature !== undefined) config.temperature = options.temperature;
    if (options?.max_tokens !== undefined) config.maxOutputTokens = options.max_tokens;

    const request: any = { contents };
    if (systemInstruction) request.systemInstruction = systemInstruction;
    if (Object.keys(config).length > 0) request.generationConfig = config;

    return withRetries(async () => {
      const result = await model.generateContent(request);
      return result.response.text();
    });
  }

  async chatJSON<T>(messages: Message[], schema: Record<string, unknown>, options?: ChatOptions): Promise<T> {
    const currentMessages = [...messages];
    const schemaStr = JSON.stringify(schema, null, 2);

    currentMessages.push({
      role: 'user',
      content: `Please return your response as valid JSON matching this schema: ${schemaStr}`
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const model = this.genAI.getGenerativeModel({ model: this.modelName });
        const { systemInstruction, contents } = this.prepareMessages(currentMessages);

        const config: any = { responseMimeType: 'application/json' };
        if (options?.temperature !== undefined) config.temperature = options.temperature;
        if (options?.max_tokens !== undefined) config.maxOutputTokens = options.max_tokens;

        const request: any = { contents };
        if (systemInstruction) request.systemInstruction = systemInstruction;
        if (Object.keys(config).length > 0) request.generationConfig = config;

        const text = await withRetries(async () => {
          const result = await model.generateContent(request);
          return result.response.text();
        });

        return JSON.parse(text) as T;
      } catch (err: any) {
        if (attempt === 3) {
          throw new Error(`Failed to get valid JSON from Gemini after 3 attempts. Last error: ${err.message}`);
        }
        currentMessages.push({
          role: 'user',
          content: `The previous response was not valid JSON or failed to parse. Error: ${err.message}. Please fix the JSON and try again.`
        });
      }
    }
    throw new Error('Unreachable');
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  public readonly name = 'Google Gemini Embeddings';
  public readonly dimensions = 768;
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(apiKey: string, modelName = 'text-embedding-004') {
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('Gemini API key is required but was empty or missing.');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  async embed(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });
    return withRetries(async () => {
      const result = await model.embedContent(text);
      return result.embedding.values;
    });
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Loop through individually to support arbitrary batch sizes safely
    return Promise.all(texts.map(text => this.embed(text)));
  }
}
