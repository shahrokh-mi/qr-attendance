'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Spinner,
  inputClass,
} from '@/components/ui';
import { api, errorCode, errorMessage } from '@/lib/api-client';
import { useHydrated } from '@/components/use-hydrated';

interface UserRow {
  id: string;
  username: string;
  employee_code: string;
  display_name: string;
  role: 'admin' | 'employee';
  active: boolean;
  default_password_pending: boolean;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  items: UserRow[];
  total: number;
}

const emptyCreate = {
  username: '',
  employee_code: '',
  display_name: '',
  password: '',
  role: 'employee' as 'admin' | 'employee',
};

/**
 * User administration. Every action calls the API — the UI never assumes success, and
 * server-side rules (last active admin, unique codes, session revocation) are the ones
 * that matter.
 */
export function UsersClient() {
  const hydrated = useHydrated();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState(emptyCreate);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ display_name: '', employee_code: '', username: '' });

  const [resetId, setResetId] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState('');

  const load = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<ListResponse>(
        `/api/v1/admin/users?page_size=100${query ? `&search=${encodeURIComponent(query)}` : ''}`,
      );
      setUsers(result.items);
      setTotal(result.total);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  async function run(action: () => Promise<string>) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load(search);
    } catch (cause) {
      const code = errorCode(cause);
      setError(
        code === 'last_admin'
          ? 'This is the last active administrator — promote another user first.'
          : errorMessage(cause),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert tone="error" title="Action failed">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" title={notice}>
          The change is saved to the database snapshot.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Users"
          description="Employees sign in with these credentials. Deactivating a user revokes their sessions immediately; password resets do the same."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void load(search);
                }}
                className="flex items-center gap-2"
              >
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, code or username"
                  className={`${inputClass} h-8 w-56 py-1 text-xs`}
                />
                <button
                  type="submit"
                  className="h-8 rounded-md border border-ink-600 px-3 text-xs text-mist-200 transition-colors hover:border-teal-600 hover:text-teal-200"
                >
                  Search
                </button>
              </form>
              <Button
                size="sm"
                disabled={!hydrated}
                onClick={() => setCreateOpen((open) => !open)}
                variant={createOpen ? 'secondary' : 'primary'}
              >
                {createOpen ? 'Close' : 'New user'}
              </Button>
            </div>
          }
        />

        {createOpen ? (
          <form
            className="grid gap-3 border-b border-ink-700/70 bg-ink-900/40 px-5 py-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api('/api/v1/admin/users', { method: 'POST', body: createDraft });
                setCreateDraft(emptyCreate);
                setCreateOpen(false);
                return `User ${createDraft.username} created`;
              });
            }}
          >
            <Field label="Username" htmlFor="new-username">
              <input
                id="new-username"
                required
                value={createDraft.username}
                onChange={(event) =>
                  setCreateDraft({ ...createDraft, username: event.target.value })
                }
                className={inputClass}
                autoCapitalize="none"
              />
            </Field>
            <Field label="Employee code" htmlFor="new-code">
              <input
                id="new-code"
                required
                value={createDraft.employee_code}
                onChange={(event) =>
                  setCreateDraft({ ...createDraft, employee_code: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Display name" htmlFor="new-name">
              <input
                id="new-name"
                required
                value={createDraft.display_name}
                onChange={(event) =>
                  setCreateDraft({ ...createDraft, display_name: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Initial password" htmlFor="new-password" hint="at least 8 characters">
              <input
                id="new-password"
                type="password"
                required
                minLength={8}
                value={createDraft.password}
                onChange={(event) =>
                  setCreateDraft({ ...createDraft, password: event.target.value })
                }
                className={inputClass}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Role" htmlFor="new-role">
              <select
                id="new-role"
                value={createDraft.role}
                onChange={(event) =>
                  setCreateDraft({
                    ...createDraft,
                    role: event.target.value as 'admin' | 'employee',
                  })
                }
                className={inputClass}
              >
                <option value="employee">employee</option>
                <option value="admin">admin</option>
              </select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={saving || !hydrated}>
                {saving ? 'Creating…' : 'Create user'}
              </Button>
            </div>
          </form>
        ) : null}

        {loading ? (
          <div className="px-5 py-8">
            <Spinner label="Loading users…" />
          </div>
        ) : users.length === 0 ? (
          <EmptyState title="No users">Create the first employee account above.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-mist-500">
                  <th className="px-4 py-2.5 font-medium">Employee</th>
                  <th className="px-4 py-2.5 font-medium">Username</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/60">
                {users.map((user) => (
                  <UserRowView
                    key={user.id}
                    user={user}
                    saving={saving}
                    editing={editingId === user.id}
                    editDraft={editDraft}
                    setEditDraft={setEditDraft}
                    onEdit={() => {
                      setEditingId(editingId === user.id ? null : user.id);
                      setEditDraft({
                        display_name: user.display_name,
                        employee_code: user.employee_code,
                        username: user.username,
                      });
                    }}
                    onSaveEdit={() => {
                      void run(async () => {
                        await api(`/api/v1/admin/users/${user.id}`, {
                          method: 'PATCH',
                          body: editDraft,
                        });
                        setEditingId(null);
                        return `User ${editDraft.username} updated`;
                      });
                    }}
                    onToggleActive={() => {
                      void run(async () => {
                        await api(`/api/v1/admin/users/${user.id}`, {
                          method: 'PATCH',
                          body: { active: !user.active },
                        });
                        return `${user.display_name} ${user.active ? 'deactivated' : 'reactivated'}`;
                      });
                    }}
                    onToggleRole={() => {
                      void run(async () => {
                        const role = user.role === 'admin' ? 'employee' : 'admin';
                        await api(`/api/v1/admin/users/${user.id}`, {
                          method: 'PATCH',
                          body: { role },
                        });
                        return `${user.display_name} is now ${role}`;
                      });
                    }}
                    resetOpen={resetId === user.id}
                    resetValue={resetValue}
                    setResetValue={setResetValue}
                    onToggleReset={() => {
                      setResetId(resetId === user.id ? null : user.id);
                      setResetValue('');
                    }}
                    onReset={() => {
                      void run(async () => {
                        if (resetValue.length < 8) {
                          throw new Error('Password must be at least 8 characters.');
                        }
                        await api(`/api/v1/admin/users/${user.id}/reset-password`, {
                          method: 'POST',
                          body: { password: resetValue },
                        });
                        setResetId(null);
                        setResetValue('');
                        return `Password reset for ${user.display_name}`;
                      });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="border-t border-ink-700/70 px-5 py-3 text-[11px] text-mist-500">
          {total} {total === 1 ? 'user' : 'users'} · users with attendance history are never
          deleted, only deactivated.
        </p>
      </Card>
    </div>
  );
}

function UserRowView({
  user,
  saving,
  editing,
  editDraft,
  setEditDraft,
  onEdit,
  onSaveEdit,
  onToggleActive,
  onToggleRole,
  resetOpen,
  resetValue,
  setResetValue,
  onToggleReset,
  onReset,
}: {
  user: UserRow;
  saving: boolean;
  editing: boolean;
  editDraft: { display_name: string; employee_code: string; username: string };
  setEditDraft: (draft: { display_name: string; employee_code: string; username: string }) => void;
  onEdit: () => void;
  onSaveEdit: () => void;
  onToggleActive: () => void;
  onToggleRole: () => void;
  resetOpen: boolean;
  resetValue: string;
  setResetValue: (value: string) => void;
  onToggleReset: () => void;
  onReset: () => void;
}) {
  const hydrated = useHydrated();
  return (
    <>
      <tr className="align-middle transition-colors hover:bg-ink-800/40">
        <td className="px-4 py-2.5">
          <span className="block text-xs font-medium text-mist-100">{user.display_name}</span>
          <span className="font-mono text-[11px] text-mist-500">{user.employee_code}</span>
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-mist-300">{user.username}</td>
        <td className="px-4 py-2.5">
          <Badge tone={user.role === 'admin' ? 'teal' : 'neutral'}>{user.role}</Badge>
        </td>
        <td className="px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={user.active ? 'teal' : 'danger'}>
              {user.active ? 'active' : 'inactive'}
            </Badge>
            {user.default_password_pending ? <Badge tone="warning">default pwd</Badge> : null}
          </div>
        </td>
        <td className="px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={onEdit} disabled={!hydrated}>
              {editing ? 'Cancel' : 'Edit'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleReset} disabled={!hydrated}>
              {resetOpen ? 'Close' : 'Reset password'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleRole} disabled={saving}>
              {user.role === 'admin' ? 'Demote' : 'Promote'}
            </Button>
            <Button
              size="sm"
              variant={user.active ? 'danger' : 'secondary'}
              onClick={onToggleActive}
              disabled={saving}
            >
              {user.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        </td>
      </tr>

      {editing ? (
        <tr className="bg-ink-900/50">
          <td colSpan={5} className="px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Display name" htmlFor={`edit-name-${user.id}`}>
                <input
                  id={`edit-name-${user.id}`}
                  value={editDraft.display_name}
                  onChange={(event) =>
                    setEditDraft({ ...editDraft, display_name: event.target.value })
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Employee code" htmlFor={`edit-code-${user.id}`}>
                <input
                  id={`edit-code-${user.id}`}
                  value={editDraft.employee_code}
                  onChange={(event) =>
                    setEditDraft({ ...editDraft, employee_code: event.target.value })
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Username" htmlFor={`edit-username-${user.id}`}>
                <input
                  id={`edit-username-${user.id}`}
                  value={editDraft.username}
                  onChange={(event) =>
                    setEditDraft({ ...editDraft, username: event.target.value })
                  }
                  className={inputClass}
                  autoCapitalize="none"
                />
              </Field>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" onClick={onSaveEdit} disabled={saving || !hydrated}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </td>
        </tr>
      ) : null}

      {resetOpen ? (
        <tr className="bg-ink-900/50">
          <td colSpan={5} className="px-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Field
                  label="New password"
                  htmlFor={`reset-password-${user.id}`}
                  hint="signs the user out everywhere"
                >
                  <input
                    id={`reset-password-${user.id}`}
                    type="password"
                    minLength={8}
                    autoComplete="new-password"
                    value={resetValue}
                    onChange={(event) => setResetValue(event.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>
              <Button size="sm" onClick={onReset} disabled={saving || !hydrated}>
                Set password
              </Button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
