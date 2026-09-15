import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useLiveQuery } from '@tanstack/react-db';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { todoCollection, type Todo } from '@/collections/todos';
import { auth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/_authed/todos')({
  component: TodosPage,
});

/**
 * `<input type="date">` speaks 'YYYY-MM-DD' in the viewer's local calendar,
 * while the collection holds a real Date. Convert through local midnight in
 * both directions: `new Date('2026-09-15')` would parse as UTC midnight and
 * shift the day for anyone west of Greenwich.
 */
function toDateInputValue(date: Date | null): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDateInputValue(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function TodosPage() {
  const { data } = useLiveQuery((q) => q.from({ todo: todoCollection }));
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  // Which row is open for editing, plus its uncommitted draft. Kept as local
  // component state so an in-progress edit is never written to the collection
  // (and so never reaches the CRUD queue) until it is saved.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDue, setDraftDue] = useState('');

  const todos = [...(data ?? [])].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );

  function addTodo(e: React.FormEvent) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    // The collection speaks rich types; the serializer encodes them to the
    // SQLite integer/text representation on write.
    todoCollection.insert({
      id: crypto.randomUUID(),
      user_id: auth.user?.id ?? '',
      title: value,
      completed: false,
      due_date: fromDateInputValue(due),
      created_at: new Date(),
    });
    setTitle('');
    setDue('');
  }

  function toggle(todo: Todo) {
    // The draft holds the same rich types the collection reads out.
    todoCollection.update(todo.id, (draft) => {
      draft.completed = !todo.completed;
    });
  }

  function startEdit(todo: Todo) {
    setEditingId(todo.id);
    setDraftTitle(todo.title);
    setDraftDue(toDateInputValue(todo.due_date));
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftTitle('');
    setDraftDue('');
  }

  function saveEdit(todo: Todo) {
    const value = draftTitle.trim();
    // An empty title is rejected by applyTodoInsert on the server; refuse it
    // here too rather than queueing a write that can only come back as an error.
    if (!value) return;
    const nextDue = fromDateInputValue(draftDue);

    // Both fields are assigned, but PowerSync's update trigger diffs the row in
    // SQLite, so the uploaded PATCH carries only the columns that actually
    // changed — editing just the title does not also re-send the due date.
    todoCollection.update(todo.id, (draft) => {
      draft.title = value;
      draft.due_date = nextDue;
    });
    cancelEdit();
  }

  function onEditKeyDown(e: React.KeyboardEvent, todo: Todo) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit(todo);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  const today = startOfToday();

  return (
    <Card>
      <CardHeader>
        <CardTitle>My todos</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={addTodo} className="flex flex-wrap gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            className="min-w-48 flex-1"
          />
          <Input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Due date"
            className="w-40"
          />
          <Button type="submit">Add</Button>
        </form>

        <ul className="flex flex-col divide-y">
          {todos.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">No todos yet.</li>
          )}
          {todos.map((todo) => {
            const overdue = !todo.completed && todo.due_date !== null && todo.due_date < today;

            if (editingId === todo.id) {
              return (
                <li key={todo.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <Input
                    autoFocus
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onKeyDown={(e) => onEditKeyDown(e, todo)}
                    aria-label="Edit title"
                    className="min-w-48 flex-1"
                  />
                  <Input
                    type="date"
                    value={draftDue}
                    onChange={(e) => setDraftDue(e.target.value)}
                    onKeyDown={(e) => onEditKeyDown(e, todo)}
                    aria-label="Edit due date"
                    className="w-40"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => saveEdit(todo)}
                    disabled={!draftTitle.trim()}
                    aria-label="Save todo"
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={cancelEdit}
                    aria-label="Cancel editing"
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              );
            }

            return (
              <li key={todo.id} className="flex items-center gap-3 py-2.5">
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggle(todo)}
                  className="size-4 accent-primary"
                />
                <button
                  type="button"
                  onClick={() => startEdit(todo)}
                  className={
                    todo.completed
                      ? 'flex-1 cursor-text text-left text-muted-foreground line-through'
                      : 'flex-1 cursor-text text-left'
                  }
                >
                  {todo.title}
                </button>
                {todo.due_date && (
                  <span
                    className={
                      overdue
                        ? 'shrink-0 text-xs font-medium text-destructive'
                        : 'shrink-0 text-xs text-muted-foreground'
                    }
                  >
                    {todo.due_date.toLocaleDateString()}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => startEdit(todo)}
                  aria-label="Edit todo"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => todoCollection.delete(todo.id)}
                  aria-label="Delete todo"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
