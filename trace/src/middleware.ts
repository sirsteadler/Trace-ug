/**
 * Session refresh and route protection.
 *
 * Two jobs. It keeps the Supabase session cookie fresh, without which a server
 * component would intermittently see a signed-in user as anonymous. And it keeps
 * unauthenticated callers out of the dispatch surfaces.
 *
 * This is a convenience, not a security boundary. Every table is protected by
 * RLS and every write by a SECURITY DEFINER function, so a caller who bypassed
 * this middleware entirely would still see nothing and change nothing. It exists
 * so people get a login screen instead of an empty dashboard.
 */
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED = ['/dashboard', '/wall'];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet) {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser, not getSession: it revalidates against the auth server rather than
  // trusting a cookie the caller controls.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const needsAuth = PROTECTED.some((p) => pathname.startsWith(p));

  if (needsAuth && !user) {
    const to = request.nextUrl.clone();
    to.pathname = '/login';
    // So a dispatcher who bookmarked a delivery lands back on it after signing in.
    to.searchParams.set('next', pathname);
    return NextResponse.redirect(to);
  }

  if (pathname === '/login' && user) {
    const to = request.nextUrl.clone();
    to.pathname = '/dashboard';
    to.search = '';
    return NextResponse.redirect(to);
  }

  return response;
}

export const config = {
  // The tracking link is excluded on purpose: recipients arrive with no session
  // and sign in anonymously on the page itself.
  matcher: ['/dashboard/:path*', '/wall/:path*', '/login'],
};
