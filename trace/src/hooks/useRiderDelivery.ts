'use client';

/**
 * Loads the rider's current delivery and keeps it current. NFR-REL-003: the
 * row is validated before it is trusted, because it arrived over a wire.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';
import { riderDeliverySchema, safeParse, type RiderDelivery } from '@/lib/contract';

const RIDER_COLUMNS =
  'id,trace_id,status,recipient_name,recipient_phone,pickup_address,destination_address,' +
  'pickup_lat,pickup_lng,destination_lat,destination_lng,geofence_radius_m,' +
  'item_description,eta_at,promised_at,assigned_rider_id,created_at';

export function useRiderDelivery(deliveryId: string | null): {
  delivery: RiderDelivery | null;
  loading: boolean;
  problem: string | null;
  reload: () => void;
} {
  const [delivery, setDelivery] = useState<RiderDelivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!deliveryId) {
      setDelivery(null);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase()
      .from('deliveries')
      .select(RIDER_COLUMNS)
      .eq('id', deliveryId)
      .maybeSingle();

    if (error) {
      setProblem("Couldn't load this delivery. Pull down to try again.");
      setLoading(false);
      return;
    }
    if (data === null) {
      // RLS returned nothing: either it does not exist or it is not ours.
      // The rider is told the same thing either way. NFR-SEC-009.
      setDelivery(null);
      setProblem('This delivery is not assigned to you any more.');
      setLoading(false);
      return;
    }

    const parsed = safeParse(riderDeliverySchema, data);
    if (!parsed.ok) {
      setProblem("This delivery's details look wrong. Tell dispatch.");
      setDelivery(null);
    } else {
      setDelivery(parsed.value);
      setProblem(null);
    }
    setLoading(false);
  }, [deliveryId]);

  useEffect(() => {
    // setState here happens after an await, i.e. in a callback from an
    // external system (Supabase), which this rule permits. The compiler
    // cannot see across the await boundary and flags it conservatively.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    if (!deliveryId) return;

    // NFR-REL-009: resynchronise on reconnect rather than assuming continuity.
    const channel = supabase()
      .channel(`delivery:${deliveryId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'deliveries', filter: `id=eq.${deliveryId}` },
        () => void load(),
      )
      .subscribe();

    return () => {
      void supabase().removeChannel(channel);
    };
  }, [deliveryId, load]);

  return { delivery, loading, problem, reload: () => void load() };
}
