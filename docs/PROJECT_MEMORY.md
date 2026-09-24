# Evidence-backed project memory

ENGRAM now contains two complementary memory layers:

- The root TypeScript package is the cognitive engine. It handles recall,
  reinforcement, decay, entity association, contradiction detection, and
  consolidation.
- `packages/project-memory` is the governed project record. It stores projects,
  conversations, files, reviewable claims, verbatim evidence, permissions, and
  an administrative audit trail in PostgreSQL.

The project-memory service is authoritative for shared claims. ENGRAM must not
silently copy those claims into its local SQLite database: doing so would lose
their review state and could bypass source visibility rules. Instead, use
`ProjectMemoryClient` to query or mutate them through the service API.

## Run both layers locally

Install all workspace dependencies from the repository root:

```bash
npm install
```

Prepare and run Project Memory:

```bash
createdb project_memory_proto
npm run project-memory:migrate
npm run project-memory:seed
npm run project-memory:ui
```

The Project Memory UI and API run at `http://localhost:4173`. ENGRAM's existing
cognitive API continues to run on port 3000 with `npm run server`.

## TypeScript client

```ts
import { ProjectMemoryClient } from 'engram';

const projects = new ProjectMemoryClient({
  baseUrl: 'http://localhost:4173',
  actorId: 'alice',
});

const context = await projects.ask(projectId, 'Why did we choose Postgres?');
```

The actor identity is forwarded to the service's current prototype permission
model. Replace that mechanism with authenticated request identity before any
network deployment.

## Revert AI integration boundary

Keep `revert-ai` independently versioned. A future adapter should submit its
code-operation and rollback events as a new evidence source. When a rollback
invalidates a project claim, Project Memory can mark it contradicted or
superseded; ENGRAM can then adjust recall without treating repository history
as an unrelated second source of truth.
