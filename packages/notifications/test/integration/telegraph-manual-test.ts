/**
 * Manual test: creates a large markdown spec and uploads to telegra.ph.
 * Run: npx tsx test/integration/telegraph-manual-test.ts
 */
import { FetchHttpClient } from "@effect/platform"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { SpecFile } from "../../src/lib/SpecHtmlGenerator.js"
import { PlanOverviewUploader, TelegraphPlanOverviewUploaderLive } from "../../src/services/PlanOverviewUploader.js"

const bigMarkdown = `# Comprehensive System Architecture

## Overview

This document describes a **large-scale microservices** architecture for a real-time notification platform built with *Effect-TS*. The system handles **millions of events per day** across multiple channels including Telegram, Slack, Email, and webhook integrations.

## Core Services

### 1. EventIngestionService

The ingestion layer is responsible for receiving events from external sources and normalizing them into a unified internal format.

\`\`\`typescript
interface EventIngestionService {
  readonly ingest: (raw: RawEvent) => Effect<NormalizedEvent, IngestionError>
  readonly batchIngest: (events: ReadonlyArray<RawEvent>) => Effect<ReadonlyArray<NormalizedEvent>, IngestionError>
  readonly healthCheck: () => Effect<HealthStatus>
}
\`\`\`

Key responsibilities:
- Validate incoming payloads against JSON Schema
- Deduplicate events using a **sliding window** of 5 minutes
- Enrich events with metadata (timestamps, source info, correlation IDs)
- Route events to the appropriate processing pipeline

### 2. NotificationRouter

The router determines which notification channels should receive each event based on user preferences and routing rules.

| Priority | Channel | Latency Target | Retry Policy |
|----------|---------|----------------|--------------|
| Critical | Telegram + Email | < 1s | 3x exponential |
| High | Telegram | < 5s | 2x exponential |
| Medium | Slack | < 30s | 1x linear |
| Low | Email digest | Batch hourly | None |

### 3. DeliveryService

Handles the actual delivery of notifications with circuit breaker patterns:

- **Circuit Breaker**: Opens after 5 consecutive failures, half-open after 30s
- **Rate Limiting**: Per-channel rate limits (Telegram: 30 msg/s, Slack: 1 msg/s)
- **Dead Letter Queue**: Failed messages after all retries are stored for manual review

### 4. TemplateEngine

Renders notification content using a template system:

\`\`\`typescript
interface TemplateEngine {
  readonly render: (templateId: string, context: TemplateContext) => Effect<RenderedContent, TemplateError>
  readonly registerTemplate: (template: Template) => Effect<void, TemplateError>
  readonly listTemplates: () => Effect<ReadonlyArray<TemplateSummary>>
}
\`\`\`

Supported formats:
1. **Markdown** — for Telegram and Slack
2. **HTML** — for email and web previews
3. **Plain text** — fallback for all channels

## Data Flow

> Events flow through the system in a pipeline: Ingestion → Validation → Routing → Rendering → Delivery → Confirmation. Each stage is an Effect that can fail independently and is monitored via OpenTelemetry spans.

### Processing Pipeline

The pipeline uses Effect's Stream API for backpressure-aware processing:

- \`Stream.fromQueue(eventQueue)\` reads incoming events
- \`Stream.mapEffect(validate)\` applies schema validation
- \`Stream.filter(dedup)\` removes duplicates
- \`Stream.mapEffect(route)\` determines target channels
- \`Stream.flatMap(fanOut)\` creates per-channel delivery streams
- \`Stream.mapEffect(deliver)\` sends with retry logic

### Error Handling Strategy

Errors are categorized into three tiers:

1. **Transient errors** (network timeouts, rate limits) — automatic retry with exponential backoff
2. **Permanent errors** (invalid template, missing channel config) — fail fast, log, alert
3. **Partial failures** (some channels succeed, some fail) — report partial success, retry failed channels

## Configuration

### Environment Variables

\`\`\`bash
TELEGRAM_BOT_TOKEN=bot123456:ABC-DEF
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/xxx
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
REDIS_URL=redis://localhost:6379
MAX_RETRY_ATTEMPTS=3
CIRCUIT_BREAKER_THRESHOLD=5
RATE_LIMIT_WINDOW_MS=1000
\`\`\`

### Feature Flags

- \`ENABLE_BATCH_PROCESSING\` — enables hourly digest batching
- \`ENABLE_CIRCUIT_BREAKER\` — enables circuit breaker pattern
- \`ENABLE_TELEMETRY\` — enables OpenTelemetry tracing
- \`ENABLE_DLQ\` — enables dead letter queue for failed messages

## API Endpoints

### POST /api/v1/events

Accepts a single event for processing.

**Request body:**
\`\`\`json
{
  "type": "pr_merged",
  "source": "github",
  "payload": {
    "repo": "my-org/my-repo",
    "pr_number": 42,
    "author": "jane-doe",
    "title": "Add user authentication"
  },
  "metadata": {
    "correlation_id": "abc-123",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
\`\`\`

**Response:**
\`\`\`json
{
  "id": "evt_abc123",
  "status": "accepted",
  "channels": ["telegram", "email"]
}
\`\`\`

### GET /api/v1/events/:id/status

Returns delivery status for all channels.

### POST /api/v1/templates

Registers a new notification template.

### GET /api/v1/health

Returns system health including per-channel circuit breaker states.

## Monitoring & Observability

### Metrics

Key metrics tracked via Prometheus:

- \`notification_events_total\` — total events received (counter)
- \`notification_delivery_duration_seconds\` — delivery latency histogram
- \`notification_delivery_failures_total\` — failed deliveries by channel
- \`notification_circuit_breaker_state\` — current circuit breaker state
- \`notification_queue_depth\` — current event queue depth

### Alerting Rules

- **P1**: Delivery success rate < 95% over 5 minutes
- **P2**: Average latency > 10s over 5 minutes
- **P3**: Queue depth > 10,000 events
- **P4**: Any circuit breaker in open state

## Security Considerations

- All API endpoints require **JWT authentication**
- Webhook URLs are encrypted at rest using ~~AES-128~~ **AES-256-GCM**
- Bot tokens are stored in *HashiCorp Vault*
- Rate limiting per API key: 100 req/min
- Input sanitization prevents [XSS attacks](https://owasp.org/www-community/attacks/xss/)

---

## Deployment

The system is deployed on Kubernetes with the following resource allocation:

- **Event Ingestion**: 3 replicas, 512Mi RAM, 0.5 CPU
- **Notification Router**: 2 replicas, 256Mi RAM, 0.25 CPU
- **Delivery Workers**: 5 replicas, 1Gi RAM, 1 CPU (autoscales to 20)
- **Redis**: 1 primary + 2 read replicas

---

*Document generated automatically. Last updated: 2026-02-25.*
`

const mermaidDiagram = `classDiagram
    class EventIngestionService {
        +ingest(raw: RawEvent) NormalizedEvent
        +batchIngest(events: RawEvent[]) NormalizedEvent[]
        +healthCheck() HealthStatus
    }

    class NotificationRouter {
        +route(event: NormalizedEvent) RoutingDecision
        +updateRules(rules: RoutingRule[]) void
    }

    class DeliveryService {
        +deliver(notification: Notification) DeliveryResult
        +retry(failedId: string) DeliveryResult
    }

    class TemplateEngine {
        +render(templateId: string, ctx: TemplateContext) RenderedContent
        +registerTemplate(template: Template) void
    }

    class TelegramChannel {
        +send(message: TelegramMessage) void
    }

    class SlackChannel {
        +send(message: SlackMessage) void
    }

    class EmailChannel {
        +send(message: EmailMessage) void
    }

    class CircuitBreaker {
        +execute(action: Effect) Result
        +getState() CircuitState
    }

    EventIngestionService --> NotificationRouter : routes events
    NotificationRouter --> DeliveryService : dispatches
    DeliveryService --> TemplateEngine : renders content
    DeliveryService --> TelegramChannel : delivers
    DeliveryService --> SlackChannel : delivers
    DeliveryService --> EmailChannel : delivers
    DeliveryService --> CircuitBreaker : wraps delivery
`

const changelogMd = `# Changelog

## v2.5.0

### Added
- **Batch processing** for low-priority email notifications
- Circuit breaker pattern for all delivery channels
- OpenTelemetry tracing integration
- Dead letter queue for permanently failed messages

### Changed
- Upgraded Effect-TS to v3.12
- Improved rate limiting algorithm from fixed window to ~~token bucket~~ **sliding window**
- Template rendering now supports \`conditional blocks\`

### Fixed
- Race condition in deduplication logic when processing concurrent events
- Memory leak in WebSocket connection pool
- Incorrect retry count in delivery status API

### Deprecated
- \`POST /api/v1/notify\` — use \`POST /api/v1/events\` instead

## v2.4.1

### Fixed
- Telegram message truncation for messages > 4096 chars
- Slack webhook timeout increased from 5s to 10s

## v2.4.0

### Added
- Multi-tenant support with per-tenant routing rules
- Custom webhook channel type
- Event replay API for debugging

### Security
- Updated all dependencies to patch [CVE-2024-1234](https://cve.example.com)
- Added request signing for webhook deliveries
`

const files: ReadonlyArray<SpecFile> = [
  { name: "architecture.md", content: bigMarkdown, mermaid: false },
  { name: "services.mmd", content: mermaidDiagram, mermaid: true },
  { name: "changelog.md", content: changelogMd, mermaid: false }
]

const TestUploader = TelegraphPlanOverviewUploaderLive.pipe(Layer.provide(FetchHttpClient.layer))

const program = Effect.gen(function*() {
  const uploader = yield* PlanOverviewUploader
  const result = yield* uploader.upload({ files, description: "Manual test — big markdown" })
  yield* Effect.log(`Uploaded! URL: ${result.url}`)
}).pipe(Effect.provide(TestUploader))

NodeRuntime.runMain(program)
