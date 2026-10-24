import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ConversationSnapshot } from '@chat/contracts';
import type { SyncEngine } from './sync-engine.js';
export function useReadReceipts(engine: SyncEngine, conversationId: string, snapshot: ConversationSnapshot | undefined, scroller: RefObject<HTMLElement | null>, enabled: boolean) {
  const lastQueued = useRef('');
  const min = snapshot?.messages.at(-1)?.creationSequence ?? '0', max = snapshot?.messages[0]?.creationSequence ?? '0';
  const own = snapshot?.receipts.find(row => row.userId === engine.account.user.id), delivered = own?.delivered ?? '0', read = own?.read ?? '0';
  useEffect(() => {
    const root = scroller.current;
    if (!enabled || !snapshot || !root || !engine.durable || max === '0') return;
    let timer: ReturnType<typeof setTimeout> | undefined, active = true;
    function inspect() {
      if (!active || !root) return;
      let visible = BigInt(read);
      const bounds = root.getBoundingClientRect(), top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      if (document.visibilityState === 'visible' && document.hasFocus() && engine.selectedId === conversationId && bottom > top && root.clientWidth > 0 && !document.querySelector('dialog:modal')) {
        for (const node of root.querySelectorAll<HTMLElement>('.message-list > li[data-sequence]')) {
          const rect = node.getBoundingClientRect(), overlap = Math.min(bottom, rect.bottom) - Math.max(top, rect.top);
          if (overlap >= Math.min(rect.height, bottom - top) * 0.5 && overlap > 0) {
            const left = Math.max(0, bounds.left, rect.left), right = Math.min(innerWidth, bounds.right, rect.right);
            if (right <= left) continue;
            const hit = document.elementFromPoint((left + right) / 2, (Math.max(top, rect.top) + Math.min(bottom, rect.bottom)) / 2);
            if (!hit || !node.contains(hit)) continue;
            const sequence = BigInt(node.dataset['sequence'] ?? '0'); if (sequence > visible) visible = sequence;
          }
        }
      }
      const targetDelivery = BigInt(max) > BigInt(delivered) ? max : delivered, targetRead = visible.toString();
      if (targetDelivery === delivered && targetRead === read) return;
      const signature = `${conversationId}:${targetDelivery}:${targetRead}`;
      if (signature === lastQueued.current || engine.pending.some(row => row.conversationId === conversationId && row.state !== 'failed' && row.command.type === 'mutation' && row.command.body.kind === 'receipt' && BigInt(row.command.body.delivered) >= BigInt(targetDelivery) && BigInt(row.command.body.read) >= visible)) return;
      lastQueued.current = signature;
      void engine.queue({ type: 'mutation', body: { kind: 'receipt', appliedFrom: min, commandId: crypto.randomUUID(), conversationId, delivered: targetDelivery, read: targetRead } }).catch(() => { if (active) lastQueued.current = ''; });
    }
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(inspect, 200); };
    const observer = new IntersectionObserver(schedule, { root, threshold: [0, 0.5, 1] });
    for (const node of root.querySelectorAll('.message-list > li')) observer.observe(node);
    root.addEventListener('scroll', schedule, { passive: true }); document.addEventListener('visibilitychange', schedule); document.addEventListener('focusin', schedule); window.addEventListener('focus', schedule); window.addEventListener('resize', schedule);
    schedule(); return () => { active = false; observer.disconnect(); if (timer) clearTimeout(timer); root.removeEventListener('scroll', schedule); document.removeEventListener('visibilitychange', schedule); document.removeEventListener('focusin', schedule); window.removeEventListener('focus', schedule); window.removeEventListener('resize', schedule); };
  }, [engine, conversationId, snapshot, scroller, enabled, min, max, delivered, read]);
}
