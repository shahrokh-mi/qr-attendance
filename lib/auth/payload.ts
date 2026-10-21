import type { SessionUser } from './session';

/**
 * The authenticated-user payload returned to the browser. Deliberately explicit:
 * password hashes, session token hashes and display credentials never leave the
 * server.
 */
export interface AuthUserPayload {
  id: string;
  username: string;
  employee_code: string;
  display_name: string;
  role: 'admin' | 'employee';
  active: boolean;
  default_password_pending: boolean;
  authenticated_at: string;
  session_expires_at: string;
  permissions: { admin: boolean };
}

export function authUserPayload(user: SessionUser): AuthUserPayload {
  return {
    id: user.id,
    username: user.username,
    employee_code: user.employeeCode,
    display_name: user.displayName,
    role: user.role,
    active: user.active,
    default_password_pending: user.defaultPasswordPending,
    authenticated_at: user.authenticatedAt,
    session_expires_at: user.sessionExpiresAt,
    permissions: { admin: user.role === 'admin' },
  };
}
