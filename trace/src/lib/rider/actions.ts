/**
 * The rider's write path. FR-OFF-002: local first, network second.
 *
 * Every action here returns as soon as the local write lands, so the interface
 * acknowledges within 200 ms (NFR-PER-001) whether or not there is signal.
 * Synchronisation is the sync module's problem, not the caller's.
 */
import { enqueueAction } from '@/lib/queue/queue';
import { syncOnce } from '@/lib/sync/sync';
import type {
  ConfirmationMethod,
  DeliveryStatus,
  FailureReason,
  Position,
  TransitionRequest,
} from '@/lib/contract';
import type { Fix } from '@/lib/geo/geofence';

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toPosition(fix: Fix | null): Position | null {
  if (!fix) return null;
  return {
    lat: fix.lat,
    lng: fix.lng,
    accuracy_m: fix.accuracy_m,
    device_time: fix.device_time,
    ...(fix.is_mock === undefined ? {} : { is_mock: fix.is_mock }),
  };
}

export interface RequestOptions {
  readonly deliveryId: string;
  readonly to: DeliveryStatus;
  readonly fix: Fix | null;
  readonly confirmation?: {
    readonly method: ConfirmationMethod;
    readonly pin?: string;
    readonly artifactRef?: string;
  };
  readonly reason?: FailureReason;
  readonly note?: string;
}

/**
 * Queue a transition and opportunistically try to send it. The caller gets
 * control back after the IndexedDB write; the network attempt is fire-and-
 * forget because its failure is already handled by the queue.
 */
export async function requestStatus(options: RequestOptions): Promise<void> {
  const key = uuid();
  const deviceTime = new Date().toISOString();

  const request: TransitionRequest = {
    delivery_id: options.deliveryId,
    to_status: options.to,
    idempotency_key: key,
    device_time: deviceTime,
    position: toPosition(options.fix),
    confirmation: options.confirmation
      ? {
          method: options.confirmation.method,
          pin: options.confirmation.pin ?? null,
          artifact_ref: options.confirmation.artifactRef ?? null,
        }
      : null,
    reason: options.reason ?? null,
    note: options.note ?? null,
    // Set optimistically. The server records its own view; what matters is
    // that a replayed action is honestly marked. FR-STM-013.
    was_offline: typeof navigator !== 'undefined' && !navigator.onLine,
  };

  await enqueueAction({ idempotency_key: key, request, device_time: deviceTime });

  // Not awaited: a rider must never watch a spinner for the network.
  void syncOnce();
}

/**
 * PIN submission is the one action that must NOT be optimistic. The rider is
 * standing in front of the recipient; telling them the code was accepted when
 * the server has not seen it is a lie the rider discovers later. This goes
 * straight to the server and surfaces the real answer.
 */
export { requestTransition as submitPinNow } from '@/lib/supabase/rpc';
