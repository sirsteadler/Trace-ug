'use client';

/**
 * Shift lifecycle. FR-RDR-002, FR-RDR-003, FR-AUT-008, FR-AUT-009, NFR-PRV-001.
 *
 * The shift is the privacy boundary: GPS exists inside it and nowhere else,
 * and that is enforced by the RLS policy on rider_positions, not by this hook
 * remembering to behave.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { pendingActions, purgeAll } from '@/lib/queue/queue';
import { safeParse, shiftSchema, type Shift } from '@/lib/contract';

export type ShiftBlock =
  | { readonly kind: 'unsynced'; readonly count: number }
  | { readonly kind: 'custody'; readonly traceId: string };

export function useShift(): {
  shift: Shift | null;
  loading: boolean;
  blocked: ShiftBlock | null;
  goOnShift: () => Promise<void>;
  goOffShift: () => Promise<boolean>;
} {
  const [shift, setShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState<ShiftBlock | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const { data } = await supabase()
      .from('shifts')
      .select('id,rider_id,started_at,ended_at')
      .is('ended_at', null)
      .maybeSingle();

    const parsed = data ? safeParse(shiftSchema, data) : null;
    setShift(parsed?.ok ? parsed.value : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    // setState here happens after an await, i.e. in a callback from an
    // external system (Supabase), which this rule permits. The compiler
    // cannot see across the await boundary and flags it conservatively.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const goOnShift = useCallback(async (): Promise<void> => {
    const { data: auth } = await supabase().auth.getUser();
    if (!auth.user) return;
    const { data } = await supabase()
      .from('shifts')
      .insert({ rider_id: auth.user.id })
      .select('id,rider_id,started_at,ended_at')
      .single();
    const parsed = data ? safeParse(shiftSchema, data) : null;
    if (parsed?.ok) setShift(parsed.value);
  }, []);

  /**
   * FR-AUT-009 and FR-OFF-010 are both refusals, and both are checked HERE
   * rather than after the shift row is closed — a rider must never end up off
   * shift holding a package or holding unsent work.
   */
  const goOffShift = useCallback(async (): Promise<boolean> => {
    const pending = await pendingActions();
    if (pending.length > 0) {
      setBlocked({ kind: 'unsynced', count: pending.length });
      return false;
    }

    const { data: held } = await supabase()
      .from('deliveries')
      .select('trace_id')
      .in('status', ['PICKED_UP', 'IN_TRANSIT', 'ARRIVED'])
      .limit(1);

    const first = held?.[0];
    if (first && typeof first.trace_id === 'string') {
      setBlocked({ kind: 'custody', traceId: first.trace_id });
      return false;
    }

    if (!shift) return true;

    await supabase().from('shifts').update({ ended_at: new Date().toISOString() }).eq('id', shift.id);

    // FR-RDR-003 / FR-RET-003: delete the live position row, do not mark it
    // inactive. The rider is told this happened — an invisible privacy
    // guarantee is worth nothing.
    const { data: auth } = await supabase().auth.getUser();
    if (auth.user) {
      await supabase().from('rider_positions').delete().eq('rider_id', auth.user.id);
    }

    // FR-AUT-008: clear sensitive local caches — recipient names, phone
    // numbers, destination addresses.
    await purgeAll();

    setShift(null);
    setBlocked(null);
    return true;
  }, [shift]);

  return { shift, loading, blocked, goOnShift, goOffShift };
}
