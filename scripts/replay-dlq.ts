import { loadConfig } from '@chat/config';
import { AuthService, BrokerTransport, ConversationService, createMongoClient, replayDeadLetters } from '@chat/domain';
const config = loadConfig(), client = createMongoClient(config), auth = new AuthService(config, client, client.db(config.MONGODB_DATABASE));
const subscription = process.argv[2], limit = Number(process.argv[3] ?? '1');
if (subscription !== 'fanout' && subscription !== 'notification') throw new Error('Usage: replay-dlq.ts fanout|notification [limit 1-20]');
let broker: BrokerTransport | undefined;
try {
  await client.connect(); broker = await BrokerTransport.open(config);
  const count = await replayDeadLetters(new ConversationService(auth), broker, process.env['REPLAY_SESSION_TOKEN'], subscription, limit);
  console.log(`Confirmed ${count} audited replay handoffs.`);
} catch { console.error('Replay failed: verify moderator session, event horizon, queue and dependency health. No credentials or payloads are logged.'); process.exitCode = 1; }
finally { await broker?.close(); await client.close(); }
