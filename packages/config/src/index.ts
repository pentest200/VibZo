import { z } from 'zod';

const integer = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const boolean = z.enum(['true', 'false']).transform(value => value === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  API_PORT: integer(3000, 65535), GATEWAY_PORT: integer(3001, 65535), WORKER_PORT: integer(3002, 65535),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//).default('mongodb://127.0.0.1:27017/chat?replicaSet=rs0&directConnection=true'),
  MONGODB_DATABASE: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,50}$/).default('chat'),
  MONGODB_POOL_SIZE: integer(20, 100), DEPENDENCY_TIMEOUT_MS: integer(3000, 10000),
  REDIS_URL: z.url().regex(/^rediss?:\/\//).default('redis://:local-only-redis-password@127.0.0.1:6379'),
  RABBITMQ_URL: z.url().regex(/^amqps?:\/\//).default('amqp://chat:local-only-rabbit-password@127.0.0.1:5672/chat'),
  S3_ENDPOINT: z.url().default('http://127.0.0.1:3900'), S3_REGION: z.string().default('garage'),
  S3_ACCESS_KEY: z.string().min(10).default('GK00000000000000000000000000000001'),
  S3_SECRET_KEY: z.string().min(32).default('local-only-s3-secret-change-before-production'),
  S3_QUARANTINE_BUCKET: z.string().default('chat-quarantine'), S3_APPROVED_BUCKET: z.string().default('chat-approved'),
  CLAMAV_HOST: z.string().default('127.0.0.1'), CLAMAV_PORT: integer(3310, 65535),
  SCANNER_TIMEOUT_MS: integer(30000, 60000), IMAGE_PROCESSOR_URL: z.url().default('http://127.0.0.1:3003'),
  IMAGE_PROCESSOR_KEY: z.string().min(32).default('local-only-image-processor-key-change-before-production'),
  MAX_PENDING_ATTACHMENT_JOBS: integer(10000, 100000),
  SMTP_HOST: z.string().default('127.0.0.1'), SMTP_PORT: integer(1025, 65535),
  SMTP_SECURE: boolean.default(false), SMTP_USER: z.string().optional(), SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.email().default('accounts@commonroom.example.test'),
  AUTH_EMAIL_KEY: z.string().min(32).default('local-only-email-encryption-change-before-production'),
  SESSION_DURATION_HOURS: integer(168, 720), AUTH_TOKEN_MINUTES: integer(30, 60),
  AUTH_RATE_LIMIT: integer(60, 100), AUTH_RATE_WINDOW_SECONDS: integer(60, 3600),
  ARGON_MEMORY_KIB: integer(65536, 262144), ARGON_TIME_COST: integer(3, 10), ARGON_PARALLELISM: integer(1, 4),
  AUTH_HASH_CONCURRENCY: integer(2, 4),
  LIVEKIT_URL: z.url().default('ws://127.0.0.1:7880'), LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().min(32).default('local-only-livekit-secret-change-before-production'),
  SESSION_SECRET: z.string().min(32).default('local-only-session-secret-change-before-production'),
  COOKIE_SECURE: boolean.default(false), SCANNER_BYPASS: boolean.default(false),
  MAX_MESSAGE_CODEPOINTS: integer(4000, 4000), MAX_GROUP_MEMBERS: integer(50, 50),
  MAX_CONVERSATIONS_PER_USER: integer(500, 1000), MAX_BLOCKS_PER_USER: integer(500, 1000), GROUP_INVITATION_HOURS: integer(72, 168),
  MAX_ATTACHMENTS: integer(8, 8), MAX_ATTACHMENT_BYTES: integer(26214400, 26214400),
  ALLOWED_ATTACHMENT_TYPES: z.string().default('jpeg,png,webp,pdf,text').transform(value => value.split(','))
    .refine(types => types.length > 0 && new Set(types).size === types.length && types.every(type => ['jpeg', 'png', 'webp', 'pdf', 'text'].includes(type)), 'Unsupported attachment allowlist'),
  MAX_ACCOUNT_ATTACHMENT_BYTES: integer(1073741824, 1073741824), MAX_SESSIONS: integer(10, 10),
  MAX_CONNECTIONS_PER_SESSION: integer(4, 4), MAX_CALL_PARTICIPANTS: integer(12, 12),
  MAX_CALL_DURATION_MINUTES: integer(120, 120), MAX_HISTORY_PAGE: integer(100, 100),
  MAX_SOCKET_BYTES: integer(65536, 65536), MAX_LIVE_BUFFER_EVENTS: integer(256, 256),
  SESSION_RECHECK_SECONDS: integer(30, 30), CALL_TOKEN_SECONDS: integer(120, 120),
  DOWNLOAD_URL_SECONDS: integer(60, 60), UPLOAD_URL_SECONDS: integer(900, 900),
  EVENT_RETENTION_DAYS: integer(90, 3650), EFFECT_RETENTION_DAYS: integer(180, 3650),
  COMPLETED_OUTBOX_RETENTION_DAYS: integer(180, 3650), CONTENT_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  MAX_PENDING_OUTBOX: integer(100000, 1000000), BROKER_PREFETCH: integer(16, 100),
  BROKER_NAMESPACE: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).default('commonroom'),
  BROKER_QUEUE_LIMIT: integer(100000, 1000000), BROKER_RETRY_ATTEMPTS: integer(5, 5),
  BROKER_RETRY_BASE_MS: z.coerce.number().int().min(100).max(5000).default(1000),
  MAX_PENDING_PROJECTIONS: integer(100000, 1000000),
  JOB_CONCURRENCY: integer(4, 16), LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});
export type Config = z.infer<typeof schema>;

// Only server packages import this module. Errors name fields but never print their values.
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration fields: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  const config = result.data;
  if (new URL(config.WEB_ORIGIN).origin !== config.WEB_ORIGIN) throw new Error('WEB_ORIGIN must be an exact origin');
  if (config.EFFECT_RETENTION_DAYS < config.COMPLETED_OUTBOX_RETENTION_DAYS) throw new Error('Effect retention must cover completed outbox retention');
  if (config.NODE_ENV === 'production') {
    if (!env['IMAGE_PROCESSOR_KEY'] || config.IMAGE_PROCESSOR_KEY.startsWith('local-only') || !config.IMAGE_PROCESSOR_URL.startsWith('https://')) throw new Error('Production requires explicit authenticated TLS image processing');
    if (!env['AUTH_EMAIL_KEY'] || config.AUTH_EMAIL_KEY.startsWith('local-only')) throw new Error('Production requires an explicit email encryption key');
    if (!config.SMTP_SECURE || !config.SMTP_USER || !config.SMTP_PASSWORD || !env['EMAIL_FROM']) throw new Error('Production requires explicit authenticated TLS email configuration');
    if (config.ARGON_MEMORY_KIB < 19456 || config.ARGON_TIME_COST < 2) throw new Error('Production password hashing is below security minimum');
    const required = ['WEB_ORIGIN', 'MONGODB_URI', 'REDIS_URL', 'RABBITMQ_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'SESSION_SECRET', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'COOKIE_SECURE'];
    if (required.some(key => !env[key])) throw new Error('Production requires explicit connection and secret configuration');
    if (!config.COOKIE_SECURE || config.SCANNER_BYPASS || !config.WEB_ORIGIN.startsWith('https://')) throw new Error('Production requires secure cookies, HTTPS origin and enabled scanning');
    if (!config.LIVEKIT_URL.startsWith('wss://') || !config.S3_ENDPOINT.startsWith('https://')) throw new Error('Production requires encrypted media signaling and object transport');
    if (!config.REDIS_URL.startsWith('rediss://') || !config.RABBITMQ_URL.startsWith('amqps://')) throw new Error('Production requires encrypted Redis and broker transport');
    if (!config.MONGODB_URI.includes('tls=true') && !config.MONGODB_URI.startsWith('mongodb+srv://')) throw new Error('Production requires encrypted database transport');
    if (config.MONGODB_URI.includes('directConnection=true')) throw new Error('Production requires replica topology discovery');
    const secrets = [config.S3_ACCESS_KEY, config.S3_SECRET_KEY, config.SESSION_SECRET, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, config.REDIS_URL, config.RABBITMQ_URL];
    if (secrets.some(value => /local-only|devkey|change-me|GK0{10}/i.test(value))) throw new Error('Production rejects local development credentials');
  }
  return Object.freeze(config);
}
