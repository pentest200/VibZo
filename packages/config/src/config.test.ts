import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';
describe('server config safety', () => {
  it('loads bounded local-only limits', () => {
    expect(loadConfig({}).MAX_GROUP_MEMBERS).toBe(50);
    expect(loadConfig({}).SCANNER_BYPASS).toBe(false);
    expect(loadConfig({}).ALLOWED_ATTACHMENT_TYPES).toEqual(['jpeg', 'png', 'webp', 'pdf', 'text', 'gif', 'mp4', 'webm', 'mp3', 'wav', 'ogg']);
  });
  it.each([{ MAX_GROUP_MEMBERS: '500' }, { MAX_SESSIONS: 'NaN' }, { COOKIE_SECURE: 'yes' }, { API_PORT: '0' }, { MAX_ATTACHMENT_BYTES: '-1' }, { ALLOWED_ATTACHMENT_TYPES: 'jpeg,html' }, { ALLOWED_ATTACHMENT_TYPES: '' }])('rejects invalid limits/booleans %j', env => {
    expect(() => loadConfig(env)).toThrow('Invalid configuration');
  });
  it('rejects production default credentials and insecure settings', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('explicit');
  });
  it('never exposes invalid secret input in validation errors', () => {
    expect(() => loadConfig({ SESSION_SECRET: 'private-password' })).toThrow('SESSION_SECRET');
    try { loadConfig({ SESSION_SECRET: 'private-password' }); } catch (error) { expect(String(error)).not.toContain('private-password'); }
  });
  it('cannot expire effect dedup records before publication retention', () => {
    expect(() => loadConfig({ EFFECT_RETENTION_DAYS: '1' })).toThrow('retention');
  });
  // Synthetic fixture values; these are not deployable secrets or real endpoints.
  const production = {
    IMAGE_PROCESSOR_KEY: 'synthetic-image-processor-validation-key', IMAGE_PROCESSOR_URL: 'https://processor.example.test',
    NODE_ENV: 'production', WEB_ORIGIN: 'https://chat.example.test',
    MONGODB_URI: 'mongodb://user:synthetic@db.example.test/chat?tls=true&replicaSet=rs0',
    REDIS_URL: 'rediss://user:synthetic@redis.example.test:6379',
    RABBITMQ_URL: 'amqps://user:synthetic@broker.example.test/chat',
    S3_ENDPOINT: 'https://s3.example.test', S3_ACCESS_KEY: 'synthetic-access-key',
    S3_SECRET_KEY: 'synthetic-s3-secret-for-validation-tests',
    SESSION_SECRET: 'synthetic-session-secret-for-validation-tests',
    LIVEKIT_URL: 'wss://media.example.test', LIVEKIT_API_KEY: 'synthetic-media-key',
    LIVEKIT_API_SECRET: 'synthetic-media-secret-for-validation-tests', COOKIE_SECURE: 'true',
    AUTH_EMAIL_KEY: 'synthetic-email-encryption-key-for-validation', SMTP_SECURE: 'true',
    SMTP_USER: 'synthetic', SMTP_PASSWORD: 'synthetic', EMAIL_FROM: 'test@example.test'
  };
  it('accepts explicit safe production configuration', () => {
    expect(loadConfig(production).NODE_ENV).toBe('production');
  });
  it('keeps telemetry opt-in and validates private collector and drain settings', () => {
    expect(loadConfig({}).OTEL_TRACE_ENABLED).toBe(false);
    expect(loadConfig({}).MEDIA_DRAINING).toBe(false);
    for (const override of [
      { OTEL_TRACE_SAMPLE_RATIO: '2' }, { OTEL_TRACE_SAMPLE_RATIO: 'NaN' }, { DRAIN_DELAY_MS: '-1' }, { DRAIN_TIMEOUT_MS: '60001' },
      { OPERATIONS_INTERVAL_MS: '10001' }, { OPERATIONS_PROBE_TIMEOUT_MS: '3001' }, { RABBITMQ_MANAGEMENT_URL: 'http://user:private@127.0.0.1' },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'file:///tmp/spans' }, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://user:private@collector.example.test/v1/traces' },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.test/v1/traces?token=private' }
    ]) expect(() => loadConfig(override)).toThrow('Invalid configuration fields');
    expect(() => loadConfig({ ...production, OTEL_TRACE_ENABLED: 'true' })).toThrow('TLS collector');
    expect(() => loadConfig({ ...production, OTEL_TRACE_ENABLED: 'true', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.example.test/v1/traces' })).toThrow('TLS collector');
    expect(loadConfig({ ...production, OTEL_TRACE_ENABLED: 'true', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example.test/v1/traces' }).OTEL_TRACE_ENABLED).toBe(true);
  });
  it.each([
    { SCANNER_BYPASS: 'true' }, { COOKIE_SECURE: 'false' },
    { WEB_ORIGIN: 'http://chat.example.test' }, { WEB_ORIGIN: 'https://chat.example.test/path' },
    { REDIS_URL: 'redis://redis.example.test' }, { LIVEKIT_URL: 'ws://media.example.test' },
    { SESSION_SECRET: 'local-only-session-secret-change-before-production' },
    { MONGODB_URI: 'mongodb://db.example.test/chat?tls=true&directConnection=true' }
  ])('rejects unsafe production override %j', override => {
    expect(() => loadConfig({ ...production, ...override })).toThrow();
  });
});
