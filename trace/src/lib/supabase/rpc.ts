/**
 * The sole state write path from the client.
 *
 * ARCHITECTURE NOTE (deviates from SRS §6.1, pending ratification as v1.2):
 * the transition is a Postgres SECURITY DEFINER function invoked over RPC, not
 * an Edge Function. FR-STM-005 requires the status update and the audit insert
 * to be one atomic transaction; in Postgres that is free, and in an Edge
 * Function it is a distributed transaction you have to fake. SECURITY DEFINER
 * also delivers CON-002 structurally — no client role holds a grant on
 * deliveries.status, and this function is the only thing that does.
 *
 * Edge Functions remain for work needing network egress: SMS, SAP write-back.
 */
import { supabase } from './client';
import {
  TraceError,
  isErrorCode,
  safeParse,
  transitionResultSchema,
  type TransitionRequest,
  type TransitionResult,
} from '@/lib/contract';

interface RpcFailure {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
}

/**
 * Postgres raises our machine codes through RAISE EXCEPTION ... USING
 * ERRCODE. Anything we do not recognise becomes UNKNOWN rather than being
 * rendered raw at a rider — NFR-SEC-009 forbids leaking internals into
 * displayable text.
 */
function toTraceError(error: RpcFailure): TraceError {
  const raw = typeof error.message === 'string' ? error.message : '';
  const code = raw.split(':', 1)[0]?.trim();
  if (isErrorCode(code)) {
    let detail: Record<string, unknown> | null = null;
    if (typeof error.details === 'string' && error.details.length > 0) {
      try {
        const parsed: unknown = JSON.parse(error.details);
        if (parsed !== null && typeof parsed === 'object') {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        detail = null;
      }
    }
    return new TraceError(code, detail);
  }
  return new TraceError('UNKNOWN');
}

export async function requestTransition(
  request: TransitionRequest,
): Promise<TransitionResult> {
  const { data, error } = await supabase().rpc('delivery_transition', { payload: request });

  if (error) throw toTraceError(error);

  const parsed = safeParse(transitionResultSchema, data);
  if (!parsed.ok) {
    // The server answered in a shape we do not understand. Treat it as a
    // failure rather than guessing — NFR-REL-003.
    throw new TraceError('UNKNOWN', { issues: parsed.issues });
  }
  return parsed.value;
}

export interface BatchOutcome {
  readonly committed: readonly string[];
  readonly rejected: { readonly keys: readonly string[]; readonly reason: string } | null;
}

/**
 * FR-STM-011: the batch is validated in full before any part of it commits.
 * A rejection returns nothing committed and a plain-language reason the rider
 * can act on (FR-STM-012).
 */
export async function replayBatch(
  batchId: string,
  actions: readonly TransitionRequest[],
): Promise<BatchOutcome> {
  if (actions.length === 0) return { committed: [], rejected: null };

  const { data, error } = await supabase().rpc('sync_queue', {
    batch_id: batchId,
    actions,
  });

  if (error) {
    const traceError = toTraceError(error);
    if (traceError.code === 'CHAIN_CONFLICT') {
      return {
        committed: [],
        rejected: {
          keys: actions.map((a) => a.idempotency_key),
          reason: traceError.message,
        },
      };
    }
    throw traceError;
  }

  const committed = Array.isArray(data)
    ? data.filter((k): k is string => typeof k === 'string')
    : [];
  return { committed, rejected: null };
}
