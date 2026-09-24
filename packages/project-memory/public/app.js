// Vanilla JS, no build step, no framework — thin fetch-based glue over the
// /api/* routes in src/server.js, which themselves are thin wrappers over
// the same library functions the CLI calls. This file's job is rendering;
// every permission decision happens server-side, in the real code paths.

const state = {
  actor: localStorage.getItem('pm.actor') || '',
  projectId: localStorage.getItem('pm.projectId') || '',
  conversationId: null,
  projects: [],
  memories: [],
};

// Ask is a client-side-only chat thread — buildContext()/hybridSearch() are
// stateless per call (no server-side "ask conversation" concept), so the
// running back-and-forth feel lives here, not in the database. Switching
// projects clears it, same as switching a real chat thread would.
const askThread = [];

const el = (id) => document.getElementById(id);

function showError(message) {
  const banner = el('errorBanner');
  banner.textContent = message;
  banner.classList.remove('hidden');
  clearTimeout(showError._t);
  showError._t = setTimeout(() => banner.classList.add('hidden'), 6000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || `${method} ${path} failed (${res.status})`;
    showError(message);
    throw new Error(message);
  }
  return data;
}

function withActor(query = {}) {
  const params = new URLSearchParams({ ...query, actor: state.actor });
  return params.toString();
}

// --- tabs ------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tabpanel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    el(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// --- actor / project selection ----------------------------------------------

function updateAvatar() {
  el('actorAvatar').textContent = state.actor ? state.actor[0].toUpperCase() : '?';
}

el('actorInput').value = state.actor;
updateAvatar();
el('actorInput').addEventListener('change', async (e) => {
  state.actor = e.target.value.trim();
  localStorage.setItem('pm.actor', state.actor);
  updateAvatar();
  await refreshAll();
});

el('newProjectBtn').addEventListener('click', async () => {
  if (!state.actor) return showError('Set "Acting as" first — that user becomes the new project\'s owner.');
  const name = prompt('Project name?');
  if (!name) return;
  const project = await api('POST', '/api/projects', { name, owner: state.actor });
  await loadProjects();
  el('projectSelect').value = project.id;
  onProjectChange();
});

el('projectSelect').addEventListener('change', onProjectChange);

async function loadProjects() {
  if (!state.actor) return;
  state.projects = await api('GET', `/api/projects?${withActor()}`);
  const select = el('projectSelect');
  select.innerHTML = '<option value="">— none —</option>';
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.my_role})`;
    select.appendChild(opt);
  }
  if (state.projects.some((p) => p.id === state.projectId)) {
    select.value = state.projectId;
  } else {
    state.projectId = '';
  }
}

function onProjectChange() {
  const previousProjectId = state.projectId;
  state.projectId = el('projectSelect').value;
  localStorage.setItem('pm.projectId', state.projectId);
  const project = state.projects.find((p) => p.id === state.projectId);
  el('myRole').textContent = project ? `role: ${project.my_role}` : '';
  el('main').classList.toggle('hidden', !state.projectId);
  if (state.projectId !== previousProjectId) {
    askThread.length = 0;
    renderAskThread();
  }
  if (state.projectId) {
    loadConversations();
    loadMemories();
  }
}

async function refreshAll() {
  await loadProjects();
  onProjectChange();
}

// --- conversations -----------------------------------------------------------

async function loadConversations() {
  const conversations = await api('GET', `/api/projects/${state.projectId}/conversations?${withActor()}`);
  const list = el('conversationList');
  list.innerHTML = '';
  for (const c of conversations) {
    const li = document.createElement('li');
    li.className = 'selectable' + (c.id === state.conversationId ? ' selected' : '');
    li.textContent = `${c.title || '(untitled)'} [${c.visibility}]`;
    li.addEventListener('click', () => selectConversation(c.id, c.title));
    list.appendChild(li);
  }
}

function selectConversation(id, title) {
  state.conversationId = id;
  el('convoHeading').textContent = title || '(untitled)';
  loadConversations();
  loadMessages();
}

async function loadMessages() {
  if (!state.conversationId) return;
  const messages = await api('GET', `/api/conversations/${state.conversationId}/messages?${withActor()}`);
  const container = el('messageList');
  container.innerHTML = '';
  for (const m of messages) {
    const mine = m.author_id === state.actor;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (mine ? 'msg-user' : 'msg-other');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.content;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `#${m.sequence_number} · ${m.author_id} · ${m.role}`;
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    container.appendChild(wrap);
  }
  container.scrollTop = container.scrollHeight;
}

el('newConversationForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = el('convoTitle').value;
  const visibility = el('convoVisibility').value;
  const convo = await api('POST', `/api/projects/${state.projectId}/conversations`, {
    owner: state.actor,
    title,
    visibility,
  });
  el('convoTitle').value = '';
  await loadConversations();
  selectConversation(convo.id, convo.title);
});

el('newMessageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.conversationId) return showError('Select a conversation first.');
  await api('POST', `/api/conversations/${state.conversationId}/messages`, {
    author: state.actor,
    role: el('messageRole').value,
    content: el('messageContent').value,
  });
  el('messageContent').value = '';
  await loadMessages();
});

el('extractBtn').addEventListener('click', async () => {
  if (!state.conversationId) return showError('Select a conversation first.');
  const created = await api('POST', `/api/conversations/${state.conversationId}/extract`, { actor: state.actor });
  el('extractResult').innerHTML = created.length
    ? `<pre>Extracted ${created.length} candidate(s):\n` +
      created.map((m) => `[${m.memory_type}] ${m.content}`).join('\n') +
      `</pre>`
    : '<pre>No new candidates (already extracted, or nothing matched).</pre>';
  await loadMemories();
});

// --- memories ----------------------------------------------------------------

el('statusFilter').addEventListener('change', loadMemories);
el('refreshMemoriesBtn').addEventListener('click', loadMemories);

async function loadMemories() {
  if (!state.projectId) return;
  const status = el('statusFilter').value;
  state.memories = await api('GET', `/api/projects/${state.projectId}/memories?${withActor({ status })}`);
  renderMemories();
  renderSupersedeOptions();
}

function renderMemories() {
  const list = el('memoryList');
  list.innerHTML = '';
  for (const m of state.memories) {
    const li = document.createElement('li');
    const evidenceHtml = (m.evidence || [])
      .map(
        (e) =>
          `<div class="evidence">${e.evidence_role}: conversation ${e.conversation_id || '-'}${
            e.message_id ? `, message ${e.message_id}` : ''
          } — "${escapeHtml(e.quote)}"</div>`
      )
      .join('');
    li.innerHTML = `
      <span class="memory-type">${m.memory_type}</span>
      <span class="status-badge status-${m.status}">${m.status}</span>
      ${escapeHtml(m.content)}
      ${evidenceHtml}
      <div class="memory-actions" data-id="${m.id}">
        ${m.status === 'proposed' ? '<button data-action="confirm">Confirm</button>' : ''}
        ${m.status !== 'rejected' ? '<button data-action="reject" class="secondary">Reject</button>' : ''}
        <button data-action="edit" class="secondary">Edit</button>
        <button data-action="delete" class="danger">Delete</button>
      </div>
    `;
    list.appendChild(li);
  }
  list.querySelectorAll('.memory-actions button').forEach((btn) => {
    btn.addEventListener('click', () => onMemoryAction(btn.closest('.memory-actions').dataset.id, btn.dataset.action));
  });
}

function renderSupersedeOptions() {
  for (const selectId of ['supersedeOld', 'supersedeNew']) {
    const select = el(selectId);
    select.innerHTML = '';
    for (const m of state.memories) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `[${m.status}] ${m.content.slice(0, 50)}`;
      select.appendChild(opt);
    }
  }
}

async function onMemoryAction(id, action) {
  if (action === 'confirm') await api('POST', `/api/memories/${id}/confirm`, { actor: state.actor });
  else if (action === 'reject') await api('POST', `/api/memories/${id}/reject`, { actor: state.actor });
  else if (action === 'delete') await api('POST', `/api/memories/${id}/delete`, { actor: state.actor });
  else if (action === 'edit') {
    const content = prompt('New content?');
    if (!content) return;
    await api('POST', `/api/memories/${id}/edit`, { actor: state.actor, content });
  }
  await loadMemories();
}

el('supersedeBtn').addEventListener('click', async () => {
  const oldId = el('supersedeOld').value;
  const newId = el('supersedeNew').value;
  if (!oldId || !newId || oldId === newId) return showError('Pick two different memories.');
  await api('POST', `/api/memories/${oldId}/supersede`, { actor: state.actor, newMemoryId: newId });
  await loadMemories();
});

// --- ask (chat-style) --------------------------------------------------------

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
}

// Minimal, dependency-free markdown → HTML: escapes first (never trusts model
// output as raw HTML), then handles the handful of constructs an assembled-
// context answer actually uses (bold/italic/code, "- " lists, paragraphs).
// Not a full CommonMark implementation — deliberately small enough to audit.
function renderMarkdown(text) {
  const escaped = escapeHtml(text || '');
  const withInline = escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = withInline.split('\n');
  let html = '';
  let inList = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${trimmed.replace(/^[-*]\s+/, '')}</li>`;
      continue;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    if (trimmed === '') continue;
    html += `<p>${trimmed}</p>`;
  }
  if (inList) html += '</ul>';
  return html || '<p></p>';
}

function fallbackAnswerMarkdown(result) {
  if (!result.activeMemories || result.activeMemories.length === 0) {
    return '_No active memory found for this project yet — extract and confirm some from a conversation first._';
  }
  return result.activeMemories.map((m) => `- **[${m.memory_type}]** ${m.content}`).join('\n');
}

function summarizeSources(result) {
  const memorySources = (result.matchedMemories || []).map((m) => `[${m.memory_type}] ${m.content}`);
  const otherSources = (result.sources || []).map((s) =>
    s.kind === 'message'
      ? `message in "${s.conversation_title || s.conversation_id}": "${String(s.content).slice(0, 100)}"`
      : `file "${s.filename}": "${String(s.text).slice(0, 100)}"`
  );
  return [...memorySources, ...otherSources];
}

function renderAskThread() {
  const container = el('askThread');
  const emptyState = el('askEmptyState');
  if (askThread.length === 0) {
    container.innerHTML = '';
    if (emptyState) container.appendChild(emptyState);
    return;
  }
  container.innerHTML = '';
  for (const turn of askThread) {
    const wrap = document.createElement('div');
    if (turn.role === 'user') {
      wrap.className = 'msg msg-user';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = turn.text;
      wrap.appendChild(bubble);
    } else {
      wrap.className = 'msg msg-assistant';
      const content = document.createElement('div');
      content.className = 'assistant-content';
      if (turn.thinking) {
        content.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';
      } else {
        content.innerHTML = renderMarkdown(turn.text);
        if (turn.note) {
          const note = document.createElement('div');
          note.className = 'assistant-note';
          note.textContent = turn.note;
          content.appendChild(note);
        }
        if (turn.sources && turn.sources.length > 0) {
          const details = document.createElement('details');
          details.className = 'sources-box';
          const summary = document.createElement('summary');
          summary.textContent = `${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}`;
          details.appendChild(summary);
          const list = document.createElement('div');
          list.className = 'sources-list';
          list.innerHTML = turn.sources.map((s) => `<div class="source-chip">${escapeHtml(s)}</div>`).join('');
          details.appendChild(list);
          content.appendChild(details);
        }
      }
      wrap.appendChild(content);
    }
    container.appendChild(wrap);
  }
  container.scrollTop = container.scrollHeight;
}

el('askQuestion').addEventListener('input', (e) => autoResizeTextarea(e.target));
el('askQuestion').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el('askForm').requestSubmit();
  }
});

el('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const textarea = el('askQuestion');
  const question = textarea.value.trim();
  if (!question) return;
  if (!state.projectId) return showError('Select a project first.');

  textarea.value = '';
  autoResizeTextarea(textarea);

  askThread.push({ role: 'user', text: question });
  const pending = { role: 'assistant', thinking: true };
  askThread.push(pending);
  renderAskThread();

  try {
    const result = await api('POST', `/api/projects/${state.projectId}/ask`, { actor: state.actor, question });
    pending.thinking = false;
    if (result.denied) {
      pending.text = "You're not a member of this project, so I can't answer from its memory.";
    } else {
      pending.text = result.answer || fallbackAnswerMarkdown(result);
      pending.note = result.answerNote || null;
      pending.sources = summarizeSources(result);
    }
  } catch (err) {
    pending.thinking = false;
    pending.text = `Something went wrong: ${err.message}`;
  }
  renderAskThread();
});

// --- files ------------------------------------------------------------------

el('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = await api('POST', `/api/projects/${state.projectId}/files`, {
    actor: state.actor,
    filePath: el('filePath').value,
    visibility: el('fileVisibility').value,
  });
  el('uploadResult').innerHTML = `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
});

// --- members ------------------------------------------------------------------

el('addMemberForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = await api('POST', `/api/projects/${state.projectId}/members`, {
    actor: state.actor,
    targetUserId: el('memberUserId').value,
    role: el('memberRole').value,
  });
  el('memberResult').innerHTML = `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  el('memberUserId').value = '';
});

// --- utils ------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- boot ------------------------------------------------------------------

if (state.actor) refreshAll();
