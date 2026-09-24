#!/usr/bin/env node
// A minimal local HTTP server for manually testing the prototype in a
// browser. Deliberately built with Node's built-in `http` module and manual
// routing — no Express, no framework — matching the zero-extra-dependency
// pattern used everywhere else in this project. Every route is a thin
// wrapper around the SAME library functions the CLI calls (src/projects.js,
// conversations.js, files.js, memory/extract.js, memory/lifecycle.js,
// memory/context.js): the UI exercises the real authorization model, not a
// separate copy of it. The "acting as" user in the UI is passed exactly like
// the CLI's --actor flag — there is no session/auth layer, matching this
// prototype's existing "no users table, free-text id" design (see README).
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { createProject, addMember, listProjectsForUser } from './projects.js';
import { createConversation, listConversationsForUser, postMessage, listMessages } from './conversations.js';
import { uploadFile } from './files.js';
import { extractCandidates } from './memory/extract.js';
import {
  listMemories,
  getMemoryWithEvidence,
  confirmMemory,
  rejectMemory,
  editMemory,
  deleteMemory,
  supersedeMemory,
  findPotentialConflicts,
} from './memory/lifecycle.js';
import { buildContext, formatContext } from './memory/context.js';
import { llmAvailable, complete } from './llm.js';
import { listAuditLogForUser } from './audit.js';
import { closePool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 4173;

// --- helpers -----------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function statusForError(err) {
  if (/Access denied/.test(err.message)) return 403;
  if (/not found/i.test(err.message)) return 404;
  return 400;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(publicDir, rel);
  // Prevent path traversal outside public/ — this server has no auth on
  // static files, so it must not be possible to request ../src/db.js etc.
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 400, { error: 'Invalid path' });
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// --- route table ---------------------------------------------------------
// Each entry: [method, regex (capture groups become `params`), async handler(params, query, body)]
const routes = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true })],

  ['POST', /^\/api\/projects$/, async (_p, _q, body) => createProject(body.name, body.owner)],
  ['GET', /^\/api\/projects$/, async (_p, q) => listProjectsForUser(q.get('actor'))],
  [
    'POST',
    /^\/api\/projects\/([^/]+)\/members$/,
    async ([projectId], _q, body) => addMember(projectId, body.actor, body.targetUserId, body.role || 'editor'),
  ],

  [
    'POST',
    /^\/api\/projects\/([^/]+)\/conversations$/,
    async ([projectId], _q, body) =>
      createConversation(projectId, body.owner, { title: body.title, visibility: body.visibility || 'project' }),
  ],
  [
    'GET',
    /^\/api\/projects\/([^/]+)\/conversations$/,
    async ([projectId], q) => listConversationsForUser(projectId, q.get('actor')),
  ],

  [
    'GET',
    /^\/api\/conversations\/([^/]+)\/messages$/,
    async ([conversationId], q) => listMessages(conversationId, q.get('actor')),
  ],
  [
    'POST',
    /^\/api\/conversations\/([^/]+)\/messages$/,
    async ([conversationId], _q, body) =>
      postMessage(conversationId, body.author, { role: body.role || 'user', content: body.content }),
  ],
  [
    'POST',
    /^\/api\/conversations\/([^/]+)\/extract$/,
    async ([conversationId], _q, body) => extractCandidates(conversationId, body.actor),
  ],

  [
    'GET',
    /^\/api\/projects\/([^/]+)\/memories$/,
    async ([projectId], q) => listMemories(projectId, q.get('actor'), { status: q.get('status') || undefined }),
  ],
  ['GET', /^\/api\/memories\/([^/]+)$/, async ([memoryId], q) => getMemoryWithEvidence(memoryId, q.get('actor'))],
  [
    'GET',
    /^\/api\/memories\/([^/]+)\/conflicts$/,
    async ([memoryId], q) => {
      const memory = await getMemoryWithEvidence(memoryId, q.get('actor'));
      if (!memory) return [];
      return findPotentialConflicts(memory.project_id, memoryId, q.get('actor'));
    },
  ],
  [
    'POST',
    /^\/api\/memories\/([^/]+)\/confirm$/,
    async ([memoryId], _q, body) => confirmMemory(memoryId, body.actor),
  ],
  ['POST', /^\/api\/memories\/([^/]+)\/reject$/, async ([memoryId], _q, body) => rejectMemory(memoryId, body.actor)],
  [
    'POST',
    /^\/api\/memories\/([^/]+)\/edit$/,
    async ([memoryId], _q, body) => editMemory(memoryId, body.actor, body.content),
  ],
  [
    'POST',
    /^\/api\/memories\/([^/]+)\/delete$/,
    async ([memoryId], _q, body) => deleteMemory(memoryId, body.actor),
  ],
  [
    'POST',
    /^\/api\/memories\/([^/]+)\/supersede$/,
    async ([oldMemoryId], _q, body) => supersedeMemory(oldMemoryId, body.newMemoryId, body.actor),
  ],

  [
    'POST',
    /^\/api\/projects\/([^/]+)\/files$/,
    async ([projectId], _q, body) =>
      uploadFile(projectId, body.actor, body.filePath, { visibility: body.visibility || 'project' }),
  ],

  [
    'POST',
    /^\/api\/projects\/([^/]+)\/ask$/,
    async ([projectId], _q, body) => {
      const ctx = await buildContext(projectId, body.actor, body.question);
      const result = { ...ctx, formatted: formatContext(ctx), answer: null, answerNote: null };
      if (ctx.denied) return result;
      if (!llmAvailable()) {
        result.answerNote = 'ANTHROPIC_API_KEY not configured — showing assembled context only.';
        return result;
      }
      try {
        result.answer = await complete({
          system:
            'Answer the question using ONLY the provided context. Cite the conversation or message for every claim you make. If the context does not contain the answer, say so explicitly.',
          messages: [
            { role: 'user', content: `Context:\n${formatContext(ctx)}\n\nQuestion: ${body.question}` },
          ],
        });
      } catch (err) {
        result.answerNote = `LLM answer generation failed (${err.message}) — showing assembled context only.`;
      }
      return result;
    },
  ],

  // Read-only, authorization-checked the same way every other project read
  // is (listAuditLogForUser calls assertProjectRead internally) — any
  // project member can view the project's audit history, not just owners,
  // since this is visible provenance rather than a privileged control.
  [
    'GET',
    /^\/api\/projects\/([^/]+)\/audit$/,
    async ([projectId], q) =>
      listAuditLogForUser(projectId, q.get('actor'), {
        limit: q.get('limit') || undefined,
        entityType: q.get('entityType') || undefined,
        actorId: q.get('actorId') || undefined,
      }),
  ],
];

async function handleApi(req, res, pathname) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = routes.find(([method, regex]) => method === req.method && regex.test(pathname));
  if (!match) {
    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
    return;
  }
  const [, regex, handler] = match;
  const params = pathname.match(regex).slice(1);
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handler(params, url.searchParams, body);
    sendJson(res, 200, result ?? null);
  } catch (err) {
    sendJson(res, statusForError(err), { error: err.message });
  }
}

const server = createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => sendJson(res, 500, { error: err.message }));
  } else if (req.method === 'GET') {
    serveStatic(req, res, pathname);
  } else {
    sendJson(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, () => {
  console.log(`project-memory UI running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  server.close();
  await closePool();
  process.exit(0);
});
