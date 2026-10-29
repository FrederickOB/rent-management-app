'use client';

import type { TemplateRowView } from '@rent/contracts';
import type { TemplateClause } from '@rent/domain/tenancy';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { PageHeader } from '@/components/page-header';
import { ReasonForm } from '@/components/reason-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  addClause,
  addSection,
  contentProblem,
  forApi,
  moveClause,
  placeholderToken,
  removeClause,
  removeSection,
  renameSection,
  sameContent,
  unknownPlaceholders,
  updateClause,
  type Content,
} from '@/lib/template-editor';
import { TEMPLATE_KIND_LABELS } from '../template-kinds';

/** The counsel-review note the API asks for: at least 10 characters (decision 3). */
const REVIEW_NOTE_MIN = 10;

type Placeholder = Awaited<
  ReturnType<ReturnType<typeof api>['leaseTemplates']['placeholders']>
>[number];

/**
 * The clause editor (TL-05; plan 4.5): edit clauses, publish a new version with a note, and record
 * that counsel reviewed a version. Required clauses stay; wording that comes from the lease's data
 * or is held for counsel cannot be edited here. Earlier versions never change.
 */
export function TemplateEditor({
  initial,
  canManage,
}: {
  readonly initial: TemplateRowView;
  readonly canManage: boolean;
}) {
  const { timeZone } = useApp();
  const [template, setTemplate] = useState(initial);
  const [content, setContent] = useState<Content>(initial.latest.content);
  const [note, setNote] = useState('');
  const [newSection, setNewSection] = useState('');
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [placeholders, setPlaceholders] = useState<readonly Placeholder[]>([]);
  const changed = !sameContent(content, template.latest.content);
  const problem = changed ? contentProblem(content) : null;
  const next = template.latest.version + 1;
  const review = template.latest.counselReview;

  useEffect(() => {
    let current = true;
    api()
      .leaseTemplates.placeholders()
      .then(
        (list) => {
          if (current) setPlaceholders(list);
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (!changed || problem) return;
    setPending(true);
    try {
      const saved = await api().leaseTemplates.publish({
        templateId: template.id,
        content: forApi(content),
        changeNote: note.trim() || null,
        baseVersion: template.latest.version,
      });
      setTemplate(saved);
      setContent(saved.latest.content);
      setNote('');
      setNotice({
        tone: 'success',
        text: `Published version ${saved.latest.version}. New leases use it; leases already drafted keep theirs.`,
      });
    } catch (failure) {
      setNotice({ tone: 'error', text: toProblem(failure).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/lease-templates" className="underline underline-offset-2">
          Lease templates
        </Link>{' '}
        <span aria-hidden="true">›</span> <span>{template.name}</span>
      </nav>
      <div className="space-y-2">
        <PageHeader
          title={template.name}
          description={`${TEMPLATE_KIND_LABELS[template.kind]} · version ${template.latest.version}`}
        />
        <div className="flex flex-wrap gap-2">
          {template.starterKind ? <Badge>Starter</Badge> : null}
          {review ? (
            <Badge tone="green">Version {template.latest.version} reviewed by counsel</Badge>
          ) : (
            <Badge tone="amber">Version {template.latest.version} not reviewed by counsel</Badge>
          )}
        </div>
      </div>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {!review ? (
        <Alert tone="warning" title="Not reviewed by a lawyer">
          Until your lawyer has reviewed this version, every lease built from it shows a warning.
          Clauses marked &ldquo;Wording to be supplied by your lawyer&rdquo; are placeholders, not
          legal text.
        </Alert>
      ) : null}

      <Card data-testid="template-versions">
        <CardHeader
          title="Versions"
          description="A published version never changes. Record a review only when a lawyer has read that version."
        />
        <CardBody>
          <ul className="divide-y divide-slate-100 text-sm">
            {template.versions.map((v) => (
              <li
                key={v.id}
                data-testid="template-version"
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="font-medium">Version {v.version}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {v.counselReviewed ? (
                    <Badge tone="green">Reviewed by counsel</Badge>
                  ) : (
                    <Badge tone="amber">Not reviewed</Badge>
                  )}
                  {canManage && !v.counselReviewed && reviewing !== v.id ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Record the counsel review of version ${v.version}`}
                      onClick={() => setReviewing(v.id)}
                    >
                      Record a review
                    </Button>
                  ) : null}
                </span>
                {reviewing === v.id ? (
                  <div className="w-full">
                    <ReasonForm
                      label={`Counsel review of version ${v.version}`}
                      intro="Say who reviewed it and when, as their written note says. This is recorded once and cannot be changed."
                      reasonLabel="Review note"
                      minLength={REVIEW_NOTE_MIN}
                      maxLength={1000}
                      submitText="Record the review"
                      onSubmit={async (text) => {
                        const saved = await api().leaseTemplates.review({
                          versionId: v.id,
                          note: text,
                        });
                        setTemplate(saved);
                        setReviewing(null);
                        setNotice({
                          tone: 'success',
                          text: `Recorded the counsel review of version ${v.version}.`,
                        });
                      }}
                      onCancel={() => setReviewing(null)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {review ? (
            <p className="text-sm text-slate-700">
              Version {template.latest.version} was reviewed{' '}
              {formatTime(review.reviewedAt, timeZone)}: {review.note}
            </p>
          ) : null}
          {template.latest.changeNote ? (
            <p className="text-sm text-slate-600">
              What changed in version {template.latest.version}: {template.latest.changeNote}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="space-y-6">
        {content.sections.map((section) => (
          <Card key={section.key} data-testid="template-section">
            <CardHeader
              title={section.heading || 'Untitled section'}
              actions={
                canManage && !section.clauses.some((c) => c.required) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setContent((c) => removeSection(c, section.key))}
                  >
                    Remove section
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {canManage ? (
                <TextField
                  label="Section heading"
                  maxLength={200}
                  value={section.heading}
                  onChange={(event) =>
                    setContent((c) => renameSection(c, section.key, event.target.value))
                  }
                />
              ) : null}
              <ol className="space-y-4">
                {section.clauses.map((clause, index) => (
                  <ClauseItem
                    key={clause.key}
                    clause={clause}
                    canManage={canManage}
                    first={index === 0}
                    last={index === section.clauses.length - 1}
                    onChange={(patch) => setContent((c) => updateClause(c, clause.key, patch))}
                    onMove={(by) => setContent((c) => moveClause(c, clause.key, by))}
                    onRemove={() => setContent((c) => removeClause(c, clause.key))}
                  />
                ))}
              </ol>
              {canManage ? (
                <AddClause onAdd={(title) => setContent((c) => addClause(c, section.key, title))} />
              ) : null}
            </CardBody>
          </Card>
        ))}

        {canManage ? (
          <div className="flex flex-wrap items-end gap-2">
            <TextField
              label="New section (optional)"
              maxLength={200}
              value={newSection}
              onChange={(event) => setNewSection(event.target.value)}
            />
            <Button
              variant="secondary"
              disabled={!newSection.trim()}
              onClick={() => {
                setContent((c) => addSection(c, newSection));
                setNewSection('');
              }}
            >
              Add section
            </Button>
          </div>
        ) : null}
      </div>

      {canManage ? (
        <Card>
          <CardHeader title="Publish" />
          <CardBody>
            <form
              onSubmit={publish}
              noValidate
              aria-label="Publish a version"
              className="space-y-4"
            >
              <TextAreaField
                label="What changed"
                hint="Kept with the version, such as “Repairs clause from our lawyer, 28 October”."
                rows={2}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="[&_textarea]:font-sans"
              />
              {problem ? <Alert tone="error">{problem}</Alert> : null}
              {!changed ? (
                <p className="text-sm text-slate-600">Change a clause to publish a new version.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" pending={pending} disabled={!changed || problem !== null}>
                  Publish version {next}
                </Button>
                {changed ? (
                  <Button variant="ghost" onClick={() => setContent(template.latest.content)}>
                    Undo my changes
                  </Button>
                ) : null}
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {placeholders.length ? (
        <Card>
          <CardHeader
            title="Placeholders"
            description="Filled in from each lease when its document is made. Any other {{…}} is refused."
          />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {placeholders.map((p) => (
                <div key={p.name} className="min-w-0">
                  <dt className="font-mono text-xs break-all">{placeholderToken(p.name)}</dt>
                  <dd className="text-slate-700">{p.description}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

function ClauseItem({
  clause,
  canManage,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  readonly clause: TemplateClause;
  readonly canManage: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly onChange: (patch: { readonly title?: string; readonly body?: string }) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const unknown = unknownPlaceholders(clause.body);
  const editable = canManage && clause.editable;
  const name = clause.title ?? clause.key;
  return (
    <li data-testid="template-clause" className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{name}</h3>
        {clause.required ? <Badge>Required</Badge> : null}
        {!clause.editable ? <Badge tone="dark">Wording fixed</Badge> : null}
      </div>
      {editable ? (
        <>
          <TextField
            label={`Title of “${name}”`}
            maxLength={200}
            value={clause.title ?? ''}
            onChange={(event) => onChange({ title: event.target.value })}
          />
          <TextAreaField
            label={`Wording of “${name}”`}
            hint="Plain text. Leave a blank line between paragraphs; start list lines with 1. or -."
            rows={5}
            maxLength={6000}
            value={clause.body}
            error={
              unknown.length
                ? `Not known placeholders: ${unknown.map(placeholderToken).join(', ')}`
                : undefined
            }
            onChange={(event) => onChange({ body: event.target.value })}
            className="[&_textarea]:font-sans"
          />
        </>
      ) : (
        <p className="text-sm whitespace-pre-wrap text-slate-800">{clause.body}</p>
      )}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={first}
            aria-label={`Move “${name}” up`}
            onClick={() => onMove(-1)}
          >
            Move up
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={last}
            aria-label={`Move “${name}” down`}
            onClick={() => onMove(1)}
          >
            Move down
          </Button>
          {!clause.required ? (
            <Button size="sm" variant="ghost" aria-label={`Remove “${name}”`} onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function AddClause({ onAdd }: { readonly onAdd: (title: string) => void }) {
  const [title, setTitle] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField
        label="New clause title"
        maxLength={200}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Button
        variant="secondary"
        disabled={title.trim().length < 2}
        onClick={() => {
          onAdd(title);
          setTitle('');
        }}
      >
        Add clause
      </Button>
    </div>
  );
}
