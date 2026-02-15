# Effect Monorepo Template

A full-stack TypeScript monorepo template built with [Effect](https://effect.website/), featuring type-safe RPC, PostgreSQL with Prisma, and a React frontend.

## Prerequisites

- **Node.js** 24.5+
- **pnpm** 10.14+
- **Docker** (for PostgreSQL)

## Quick Start

```bash
# Start the database
docker compose up -d

# Install dependencies
pnpm install

# Generate Prisma client
pnpm db:generate

# Run database migrations
pnpm db:migrate

# Start the development server (backend + frontend)
pnpm dev
```

## Project Structure

```
packages/
├── domain/          # Shared types, schemas, DTOs, RPC definitions (Effect Schema)
├── database/        # Prisma schema, migrations, database service (Effect SQL)
├── server/          # HTTP server, RPC handlers, auth (Effect Platform + better-auth)
├── frontend/        # React SPA, RPC client, UI components (Vite + Effect Atom)
└── eslint-plugin/   # Custom ESLint rules for Effect patterns
```

## Development Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start the backend server |
| `pnpm dev:front` | Start the frontend dev server |
| `pnpm dev:server` | Start the backend server |
| `pnpm check` | Run TypeScript type checking across all packages |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Run ESLint with auto-fix |
| `pnpm test` | Run tests with Vitest |
| `pnpm build` | Build all packages |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:migrate` | Run database migrations |
| `pnpm db:reset` | Reset the database |

## Running Code

This template uses [tsx](https://tsx.is) to execute TypeScript files directly:

```bash
pnpm tsx ./path/to/the/file.ts
```
