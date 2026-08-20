'use client';

/**
 * Create a delivery. SRS §5.1.1, concept note §5.1.
 *
 * One column, no sections, no wizard. A dispatcher entering a job while someone
 * waits on the phone should be able to type down the page without deciding
 * anything about the form itself.
 *
 * The delivery is created through create_delivery(), which assigns the trace_id
 * and the organisation. Nothing here chooses either.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

interface Fields {
  recipient_name: string;
  recipient_phone: string;
  destination_address: string;
  pickup_address: string;
  item_description: string;
}

const EMPTY: Fields = {
  recipient_name: '',
  recipient_phone: '',
  destination_address: '',
  pickup_address: '',
  item_description: '',
};

export default function NewDeliveryPage() {
  const router = useRouter();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const set = (key: keyof Fields) => (value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const ready =
    fields.recipient_name.trim() !== '' &&
    fields.recipient_phone.trim() !== '' &&
    fields.destination_address.trim() !== '';

  async function create() {
    setBusy(true);
    setProblem(null);

    const { data, error } = await supabase().rpc('create_delivery', {
      payload: {
        recipient_name: fields.recipient_name.trim(),
        recipient_phone: fields.recipient_phone.trim(),
        destination_address: fields.destination_address.trim(),
        pickup_address: fields.pickup_address.trim(),
        item_description: fields.item_description.trim() || null,
      },
    });

    setBusy(false);

    if (error) {
      setProblem(
        error.message.includes('FORBIDDEN_ACTOR')
          ? 'Your account cannot create deliveries.'
          : 'Could not create the delivery. Check the details and try again.',
      );
      return;
    }

    const created = data as { id: string };
    router.push(`/dashboard/${created.id}`);
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold text-mist-100">New delivery</h1>
      <p className="mt-1 text-mist-400">
        The reference is assigned automatically. Assign a rider on the next screen.
      </p>

      <div className="mt-8 space-y-5">
        <Field
          label="Recipient name"
          value={fields.recipient_name}
          onChange={set('recipient_name')}
          autoComplete="name"
        />
        <Field
          label="Recipient phone"
          value={fields.recipient_phone}
          onChange={set('recipient_phone')}
          type="tel"
          placeholder="+256 7XX XXX XXX"
          hint="The tracking link and confirmation code go to this number."
        />
        <Field
          label="Destination address"
          value={fields.destination_address}
          onChange={set('destination_address')}
          hint="Geocoded on save. A delivery cannot be closed until it has a location to measure against."
        />
        <Field
          label="Pickup address"
          value={fields.pickup_address}
          onChange={set('pickup_address')}
          optional
        />
        <Field
          label="What is being delivered"
          value={fields.item_description}
          onChange={set('item_description')}
          optional
        />

        {problem && (
          <p role="alert" className="rounded-xl bg-ink-800 px-4 py-3 text-stop-500">
            {problem}
          </p>
        )}

        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void create()}
          className="min-h-tap w-full rounded-2xl bg-go-600 px-6 font-semibold text-ink-900 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create delivery'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  optional,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-mist-200">
        {label}
        {optional && <span className="ml-2 text-mist-400">optional</span>}
      </span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 min-h-tap w-full rounded-xl border border-ink-500 bg-ink-800 px-4 text-mist-100 placeholder:text-mist-400/60"
      />
      {hint && <span className="mt-1.5 block text-sm text-mist-400">{hint}</span>}
    </label>
  );
}
