import { AuthService, BrokerTransport, ConversationService, OutboxRelay, createMongoClient, eventReference } from '@chat/domain';
import type { ControlEvent } from '@chat/domain';
import { loadConfig } from '@chat/config';
const config = loadConfig();
if (config.NODE_ENV !== 'test' || !config.MONGODB_DATABASE.startsWith('delivery_test_')) throw new Error('Crash harness requires isolated test database');
const client = createMongoClient(config); await client.connect();
const service = new ConversationService(new AuthService(config, client, client.db(config.MONGODB_DATABASE))), broker = await BrokerTransport.open(config);
const row = await new OutboxRelay(service, broker).claim(); if (!row) throw new Error('No crash candidate');
const event = await service.db.collection<ControlEvent>('conversationEvents').findOne({ _id: row.eventId }); if (!event) throw new Error('Missing event');
await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(eventReference(event))), { messageId: event._id });
// Deliberately terminate without cleanup or marking published: broker confirm has completed.
process.exit(73);
