import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import type { Config } from '@chat/config';
export interface MediaParticipant { identity: string; tracks: { source: number; type: number; muted: boolean }[] }
export interface CallProvider {
  health(): Promise<boolean>; create(name: string): Promise<void>; removeRoom(name: string): Promise<void>;
  participants(name: string): Promise<MediaParticipant[] | null>;
  token(name: string, identity: string, mode: 'voice' | 'video', ttl: number): Promise<string>;
}
export class LiveKitProvider implements CallProvider {
  readonly client: RoomServiceClient; readonly receiver: WebhookReceiver;
  constructor(readonly config: Config) {
    this.client = new RoomServiceClient(config.LIVEKIT_API_URL, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { requestTimeout: 3, failover: false });
    this.receiver = new WebhookReceiver(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
  }
  async health() { try { await this.client.listRooms(['__commonroom_health_probe__']); return true; } catch { return false; } }
  async create(name: string) { await this.client.createRoom({ name, maxParticipants: this.config.MAX_CALL_PARTICIPANTS, emptyTimeout: 90, departureTimeout: 60 }); }
  async removeRoom(name: string) { try { await this.client.deleteRoom(name); } catch (e) { if (!notFound(e)) throw e; } }
  async participants(name: string) {
    // Self-hosted ListParticipants returns an empty list for an absent room too.
    // Distinguish a vanished incarnation from an existing, temporarily empty room.
    try {
      if (!(await this.client.listRooms([name])).some(room => room.name === name)) return null;
      return (await this.client.listParticipants(name)).map(p => ({ identity: p.identity, tracks: p.tracks.map(t => ({ source: t.source, type: t.type, muted: t.muted })) }));
    }
    catch (e) { if (notFound(e)) return null; throw e; }
  }
  async token(name: string, identity: string, mode: 'voice' | 'video', ttl: number) {
    const token = new AccessToken(this.config.LIVEKIT_API_KEY, this.config.LIVEKIT_API_SECRET, { identity, ttl });
    token.addGrant({ roomJoin: true, room: name, roomCreate: false, roomAdmin: false, roomList: false, roomRecord: false,
      canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, ...(mode === 'video' ? [TrackSource.CAMERA] : [])] });
    return token.toJwt();
  }
}
function notFound(error: unknown) { return typeof error === 'object' && error !== null && ('status' in error && error.status === 404 || 'code' in error && error.code === 'not_found'); }
