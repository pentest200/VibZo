import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import type { LocalTrack, RemoteTrack } from 'livekit-client';
import { joinCallSchema } from '@chat/contracts';
import type { AuthSession, CallView } from '@chat/contracts';
import { api, RequestError } from './api.js';

export default function CallMedia({ account, call, wanted }: { account: AuthSession; call: CallView; wanted: boolean }) {
  const [room, setRoom] = useState<Room | null>(null), [revision, setRevision] = useState(0), [state, setState] = useState('Media stopped'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [setupMs, setSetupMs] = useState<number | null>(null), [failures, setFailures] = useState(0);
  const sessionRoom = useRef<Room | null>(null);
  const pendingTicket = useRef<{ key: string; result: Promise<unknown> } | null>(null);
  const nextTicketAt = useRef(0);
  useEffect(() => {
    if (!wanted || !call.ready) { pendingTicket.current = null; return; }
    // Keep publisher bitrate hints out of the subscriber's BUNDLE. The pinned
    // SDK's single-PC mode can reject differing VP8 parameters during rejoin.
    let active = true; const started = performance.now(), current = new Room({ singlePeerConnection: false, adaptiveStream: true, dynacast: true, publishDefaults: { simulcast: true }, videoCaptureDefaults: { resolution: { width: 640, height: 360, frameRate: 20 } } });
    setSetupMs(null);
    sessionRoom.current = current; setRoom(current); setError(''); setState('Connecting');
    const refresh = () => { if (active) { setRevision(value => value + 1); setState(current.state); } };
    for (const event of [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ConnectionStateChanged, RoomEvent.AudioPlaybackStatusChanged, RoomEvent.ConnectionQualityChanged]) current.on(event, refresh);
    const failed = () => { if (active) { setState('Disconnected'); setError('Media connection ended. Check access and retry the media connection.'); } };
    current.on(RoomEvent.Disconnected, failed);
    void (async () => {
      try {
        // Share only this in-memory request across StrictMode's effect replay.
        // A replay must not consume two issuance slots and discard the accepted token.
        const key = `${call.id}:${call.generation}:${retry}:${account.csrfToken}`;
        if (pendingTicket.current?.key !== key) {
          const wait = Math.max(0, nextTicketAt.current - Date.now());
          if (wait) { setState('Waiting to rejoin'); await new Promise(resolve => setTimeout(resolve, wait)); if (!active) return; }
          // Recheck after a wait: another live effect may already own this request.
          if (pendingTicket.current?.key !== key) {
            nextTicketAt.current = Date.now() + 5100;
            pendingTicket.current = { key, result: api(`/calls/${call.id}/join`, { method: 'POST', body: {}, csrf: account.csrfToken }).then(value => { nextTicketAt.current = Date.now() + 5100; return value; }) };
          }
        }
        const ticket = joinCallSchema.parse(await pendingTicket.current.result);
        if (!active || ticket.generation !== call.generation) return;
        await current.connect(ticket.url, ticket.token, { autoSubscribe: true, rtcConfig: { iceTransportPolicy: import.meta.env.VITE_ICE_TRANSPORT_POLICY as RTCIceTransportPolicy } });
        if (!active) { await current.disconnect(); return; }
        setSetupMs(Math.round(performance.now() - started));
        try { await current.localParticipant.setMicrophoneEnabled(true); if (!active) { for (const p of current.localParticipant.trackPublications.values()) p.track?.stop(); await current.disconnect(); return; } } catch { if (active) setError('Microphone unavailable or permission denied. You can listen and try enabling it again.'); }
        if (call.mode === 'video') try { await current.localParticipant.setCameraEnabled(true); if (!active) { for (const p of current.localParticipant.trackPublications.values()) p.track?.stop(); await current.disconnect(); return; } } catch { if (active) setError('Camera unavailable or permission denied. Audio can continue.'); }
        refresh();
      } catch (error) { if (active) {
        const reason = error && typeof error === 'object' && 'reason' in error && typeof error.reason === 'number' ? error.reason : null;
        console.warn('Call transport failure', { kind: error instanceof RequestError ? 'http' : error instanceof TypeError ? 'type' : 'media', reason });
        setFailures(value => value + 1); setError(error instanceof RequestError ? error.message : 'Could not connect to the call. Check your connection, access, and devices, then retry.'); setState('Disconnected');
      } }
    })();
    return () => {
      active = false; for (const publication of current.localParticipant.trackPublications.values()) publication.track?.stop();
      current.removeAllListeners(); void current.disconnect().catch(() => {}); if (sessionRoom.current === current) sessionRoom.current = null;
    };
  }, [account.csrfToken, call.id, call.generation, call.ready, wanted, retry]);
  useEffect(() => { if (!wanted || !call.ready) { setRoom(null); setState('Media stopped'); } }, [wanted, call.ready]);
  async function control(operation: () => Promise<unknown>) { setBusy(true); setError(''); try { await operation(); setRevision(value => value + 1); } catch { setError('Device or permission unavailable. Check your browser permissions and try again.'); } finally { setBusy(false); } }
  const local = room?.localParticipant;
  const tracks: { key: string; track: LocalTrack | RemoteTrack; local: boolean; name: string; source: string }[] = [];
  if (room) for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) for (const publication of participant.trackPublications.values()) {
    if (!publication.track || publication.isMuted || publication.track.kind === Track.Kind.Audio && participant === room.localParticipant) continue;
    tracks.push({ key: `${participant.identity}:${publication.trackSid}`, track: publication.track, local: participant === room.localParticipant, name: call.participants.find(p => participant.identity.startsWith(`${p.userId}:`))?.displayName ?? 'Participant', source: publication.source });
  }
  return <div className="call-media" data-media-revision={revision}><p role="status" aria-label="Media connection">{state}</p>{error && <p className="notice error" role="alert">{error}</p>}
    {wanted && <button className="button-secondary" onClick={() => setRetry(value => value + 1)}>Retry media connection</button>}
    {room?.canPlaybackAudio === false && <button onClick={() => { void control(() => room.startAudio()); }}>Play call audio</button>}
    {local && wanted && <div className="control-row"><button disabled={busy || state !== 'connected'} aria-pressed={local.isMicrophoneEnabled} onClick={() => { void control(() => local.setMicrophoneEnabled(!local.isMicrophoneEnabled)); }}>{local.isMicrophoneEnabled ? 'Mute microphone' : 'Enable microphone'}</button>
      {call.mode === 'video' && <button disabled={busy || state !== 'connected'} aria-pressed={local.isCameraEnabled} onClick={() => { void control(() => local.setCameraEnabled(!local.isCameraEnabled)); }}>{local.isCameraEnabled ? 'Turn camera off' : 'Enable camera'}</button>}
      <button disabled={busy || state !== 'connected'} aria-pressed={local.isScreenShareEnabled} onClick={() => { void control(() => local.setScreenShareEnabled(!local.isScreenShareEnabled)); }}>{local.isScreenShareEnabled ? 'Stop sharing screen' : 'Share screen'}</button>
      <DeviceChoice kind="audioinput" label="Microphone" room={room} /><DeviceChoice kind="videoinput" label="Camera" room={room} /></div>}
    <div className="call-tracks">{tracks.map(({ key, ...item }) => <MediaElement key={key} {...item} />)}</div>
    {room && <p className="hint">Connection quality: {room.localParticipant.connectionQuality}. Media is not recorded.</p>}
    {room && <CallDiagnostics room={room} setupMs={setupMs} failures={failures} />}
  </div>;
}
function CallDiagnostics({ room, setupMs, failures }: { room: Room; setupMs: number | null; failures: number }) {
  const [sample, setSample] = useState('Waiting for media statistics');
  useEffect(() => {
    let active = true;
    async function measure() {
      try {
        let bytes = 0, lost = 0, bitrate = 0, jitter: number | null = null, rtt: number | null = null;
        const routes = new Set<string>(), seen = new Set<string>();
        for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) for (const publication of participant.trackPublications.values()) {
          if (!publication.track) continue;
          bitrate += publication.track.currentBitrate;
          const report = await publication.track.getRTCStatsReport(); if (!report) continue;
          for (const item of report.values()) {
            const key = `${item.type}:${item.id}`; if (seen.has(key)) continue; seen.add(key);
            if (item.type === 'inbound-rtp') {
              bytes += item.bytesReceived ?? 0; lost += Math.max(0, item.packetsLost ?? 0);
              if (typeof item.jitter === 'number') jitter = Math.max(jitter ?? 0, item.jitter);
            }
            if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) {
              if (typeof item.currentRoundTripTime === 'number') rtt = Math.max(rtt ?? 0, item.currentRoundTripTime);
              const candidate = report.get(item.localCandidateId); if (candidate?.candidateType) routes.add(candidate.candidateType === 'relay' ? 'relay' : 'direct');
            }
          }
        }
        if (active) setSample(`Received ${Math.round(bytes / 1024)} KiB · ${Math.round(bitrate / 1000)} kbit/s · lost ${lost} packets · jitter ${jitter === null ? 'unavailable' : `${Math.round(jitter * 1000)} ms`} · RTT ${rtt === null ? 'unavailable' : `${Math.round(rtt * 1000)} ms`} · route ${routes.size ? [...routes].sort().join('/') : 'unavailable'}`);
      } catch { if (active) setSample('Media statistics unavailable in this browser'); }
    }
    void measure(); const timer = setInterval(() => { void measure(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [room]);
  return <details className="call-diagnostics"><summary>Connection details</summary><p>Setup: {setupMs === null ? 'pending' : `${setupMs} ms`} · failed attempts on this device: {failures} · {room.remoteParticipants.size + 1} participants</p><p>{sample}</p></details>;
}
function MediaElement({ track, local, name, source }: { track: LocalTrack | RemoteTrack; local: boolean; name: string; source: string }) {
  const element = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => { const node = element.current; if (!node) return; track.attach(node); return () => { track.detach(node); node.srcObject = null; }; }, [track]);
  return <figure data-source={source} data-local={local ? 'true' : 'false'}>{track.kind === Track.Kind.Video ? <video ref={element} autoPlay playsInline muted={local} aria-label={`${name} ${source}`} /> : <audio ref={element} autoPlay aria-label={`${name} audio`} />}<figcaption>{name} · {source === Track.Source.ScreenShare ? 'Screen' : track.kind === Track.Kind.Video ? 'Camera' : 'Audio'}</figcaption></figure>;
}
function DeviceChoice({ kind, label, room }: { kind: MediaDeviceKind; label: string; room: Room }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [error, setError] = useState('');
  useEffect(() => { let live = true; const update = () => { void Room.getLocalDevices(kind, false).then(rows => { if (live) setDevices(rows); }).catch(() => {}); }; update(); navigator.mediaDevices?.addEventListener('devicechange', update); return () => { live = false; navigator.mediaDevices?.removeEventListener('devicechange', update); }; }, [kind]);
  return <label>{label} device<select aria-label={`${label} device`} onChange={event => { setError(''); void room.switchActiveDevice(kind, event.target.value).catch(() => setError('Could not switch device.')); }}><option value="default">Default</option>{devices.filter(device => device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${label} ${index + 1}`}</option>)}</select>{error && <span role="alert">{error}</span>}</label>;
}
