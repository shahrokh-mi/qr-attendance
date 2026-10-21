import { getConfig } from '@/lib/config';

/** Cookie serialisation without a framework dependency (route handlers build raw Responses). */

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  secure?: boolean;
  expires?: Date;
}

function serialise(name: string, value: string, options: CookieOptions): string {
  const config = getConfig();
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`HttpOnly=${options.httpOnly === false ? 'false' : 'true'}`);
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure ?? config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function appendCookie(
  response: Response,
  name: string,
  value: string,
  options: CookieOptions = {},
): void {
  response.headers.append('Set-Cookie', serialise(name, value, options));
}

export function clearCookie(response: Response, name: string): void {
  appendCookie(response, name, '', { maxAge: 0, expires: new Date(0) });
}

export function readCookie(
  cookies: { get(name: string): { value: string } | undefined },
  name: string,
): string | undefined {
  const found = cookies.get(name);
  return found?.value || undefined;
}
