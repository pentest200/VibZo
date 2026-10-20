import { argumentsFor, budget } from './policy.js';
const roots = new Set(['formatVersion', 'mode', 'profile', 'profileLimits', 'warmupMs', 'measuredMs', 'host', 'topology', 'admission', 'unavailable', 'inventory', 'windows', 'chatInvariants', 'mediaInvariants', 'durableMessageCount', 'passed', 'runtime', 'chat', 'media', 'runner', 'mediaSetupFailure', 'failedStage']);
const privateKey = /password|cookie|csrf|token|secret|email|username|userId|conversationId|deviceId|address|url|sessionId|eventId|messageId|roomName|hostName|^(?:body|text|content|headers|authorization|sdp)$/i;
export function disclosure(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid measurement report');
  const report = raw as Record<string, unknown>;
  if (Object.keys(report).some(key => !roots.has(key)) || typeof report['mode'] !== 'string' || typeof report['profile'] !== 'string' || typeof report['passed'] !== 'boolean') throw new Error('Unexpected measurement fields');
  argumentsFor([report['mode'], report['profile']]);
  const json = JSON.stringify({ ...report, formatVersion: 1 }, null, 2);
  if (Buffer.byteLength(json) > budget.reportBytes) throw new Error('Disclosure byte bound');
  function visit(value: unknown, depth: number) {
    if (depth > 12) throw new Error('Disclosure depth bound');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite disclosure');
    if (typeof value === 'string' && (value.length > 2048 || /(?:https?|wss?|mongodb|redis|amqp):\/\/|\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b127\.0\.0\.\d+\b/i.test(value))) throw new Error('Private address/identifier in disclosure');
    if (Array.isArray(value)) { if (value.length > 512) throw new Error('Disclosure array bound'); for (const child of value) visit(child, depth + 1); }
    else if (value && typeof value === 'object') {
      const entries = Object.entries(value); if (entries.length > 128) throw new Error('Disclosure field bound');
      for (const [key, child] of entries) { if (privateKey.test(key)) throw new Error('Private field in disclosure'); visit(child, depth + 1); }
    }
  }
  visit(report, 0);
  return json + '\n';
}
