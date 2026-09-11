import { useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useLiveQuery } from '@tanstack/react-db';
import { Trash2 } from 'lucide-react';
import type { Role } from '@app/db/types';
import { auth } from '@/lib/auth';
import { userCollection } from '@/collections/users';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export const Route = createFileRoute('/_authed/admin')({
  beforeLoad: ({ context }) => {
    if (!context.auth.isAdmin) {
      throw redirect({ to: '/todos' });
    }
  },
  component: AdminPage,
});

function AdminPage() {
  const { data } = useLiveQuery((q) => q.from({ user: userCollection }));
  const users = [...(data ?? [])].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
  const currentUserId = auth.user?.id;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Users</CardTitle>
        <CreateUserDialog />
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>
                  <select
                    value={user.role}
                    onChange={(e) => {
                      const role = e.target.value as Role;
                      userCollection.update(user.id, (draft) => {
                        draft.role = role;
                      });
                    }}
                    className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={user.id === currentUserId}
                    onClick={() => userCollection.delete(user.id)}
                    aria-label="Delete user"
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CreateUserDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // The write-only `pin` is not a synced column — pass it as PowerSync
    // operation metadata so it rides along on the CrudEntry to the backend.
    const tx = userCollection.insert(
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        role,
        created_at: new Date(),
      },
      { metadata: { pin } },
    );
    try {
      // Resolves once the write is committed to the local PowerSync database.
      await tx.isPersisted.promise;
      setName('');
      setPin('');
      setRole('user');
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Add user</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-name">Name</Label>
            <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-pin">PIN</Label>
            <Input
              id="new-pin"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-role">Role</Label>
            <select
              id="new-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-md border border-input bg-transparent px-2 py-2 text-sm"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
