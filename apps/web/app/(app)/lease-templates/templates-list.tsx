'use client';

import type { TemplateRowView } from '@rent/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { TEMPLATE_KIND_LABELS, TEMPLATE_KINDS, type TemplateKind } from './template-kinds';

/** The templates, with a way to start a company's own from any of them (TL-05). */
export function TemplatesList({
  initial,
  canManage,
}: {
  readonly initial: readonly TemplateRowView[];
  readonly canManage: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const live = initial.filter((t) => !t.archived);
  return (
    <>
      {canManage && adding ? (
        <NewTemplate templates={live} onCancel={() => setAdding(false)} />
      ) : null}
      <Card>
        <CardHeader
          title="Templates"
          description="The three starters come with the platform; legal clauses in them wait for your lawyer’s wording."
          actions={
            canManage && !adding ? (
              <Button onClick={() => setAdding(true)}>New template</Button>
            ) : null
          }
        />
        <CardBody>
          <ul className="divide-y divide-slate-100">
            {live.map((t) => (
              <li
                key={t.id}
                data-testid="template-row"
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="space-y-1">
                  <Link
                    href={`/lease-templates/${t.id}`}
                    className="font-medium underline underline-offset-2"
                  >
                    {t.name}
                  </Link>
                  <p className="text-sm text-slate-600">
                    {TEMPLATE_KIND_LABELS[t.kind]} · version {t.latest.version}
                    {t.starterKind ? ' · starter' : ''}
                  </p>
                </div>
                {t.latest.counselReview ? (
                  <Badge tone="green">Reviewed by counsel</Badge>
                ) : (
                  <Badge tone="amber">Not reviewed by counsel</Badge>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </>
  );
}

function NewTemplate({
  templates,
  onCancel,
}: {
  readonly templates: readonly TemplateRowView[];
  readonly onCancel: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TemplateKind>('custom');
  const [from, setFrom] = useState(templates[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const source = templates.find((t) => t.id === from);
    if (name.trim().length < 2) {
      setError('Name the template.');
      return;
    }
    if (!source) {
      setError('Choose the template to start from.');
      return;
    }
    setPending(true);
    try {
      const created = await api().leaseTemplates.create({
        name: name.trim(),
        kind,
        content: source.latest.content,
        changeNote: `Started from ${source.name}, version ${source.latest.version}`,
      });
      router.push(`/lease-templates/${created.id}`);
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="New template"
        description="It starts as a copy of another template; change its clauses and publish new versions from there."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="New template" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Name"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <SelectField
              label="Kind"
              value={kind}
              options={TEMPLATE_KINDS.map((k) => ({ value: k, label: TEMPLATE_KIND_LABELS[k] }))}
              onChange={(event) =>
                setKind(TEMPLATE_KINDS.find((k) => k === event.target.value) ?? 'custom')
              }
            />
            <SelectField
              label="Start from"
              value={from}
              options={templates.map((t) => ({
                value: t.id,
                label: `${t.name} (version ${t.latest.version})`,
              }))}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              Create template
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
