/**
 * Dispatch shell. SRS §5.1.2.
 *
 * Responsive by requirement, not by habit: §5.1.2 has this read on a laptop at a
 * desk, a tablet in a warehouse and a phone in a corridor. The navigation
 * collapses to a row on narrow screens rather than hiding behind a menu — three
 * destinations do not warrant a drawer.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentProfile } from '@/lib/supabase/server';

const NAV = [
  { href: '/dashboard', label: 'Deliveries' },
  { href: '/dashboard/new', label: 'New delivery' },
  { href: '/wall', label: 'Wallboard' },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await currentProfile();

  // Middleware already redirected anonymous callers. This catches the other
  // case: signed in, but with no profile row — a rider who reached /dashboard,
  // or an account created before its profile was provisioned.
  if (!profile) redirect('/login');

  const isAdmin = profile.role === 'sub_admin' || profile.role === 'super_admin';
  if (!isAdmin) redirect('/rider');

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-600">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight text-mist-100">
            TRACE
          </Link>

          <nav className="flex flex-1 flex-wrap gap-x-5 gap-y-2">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-mist-400 transition-colors hover:text-mist-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <span className="text-sm text-mist-400">{profile.full_name}</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}
