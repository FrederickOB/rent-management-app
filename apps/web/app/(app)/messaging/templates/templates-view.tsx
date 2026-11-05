'use client';

import type { MessageTemplate } from '@rent/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/components/app-context';
import { Empty, LoadFailed, Loading } from '@/components/load-state';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import {
  namedBody,
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_KEY_LABELS,
  templateStatusText,
  usableOnSendingNumber,
} from '@/lib/templates';

const STATUS_TONES: Record<string, BadgeTone> = {
  approved: 'green',
  pending: 'amber',
  rejected: 'red',
  paused: 'amber',
  disabled: 'dark',
};

export function TemplatesView() {
  const { timeZone } = useApp();
  const [templates, setTemplates] = useState<readonly MessageTemplate[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await api().templates.list());
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (problem) return <LoadFailed message={problem} onRetry={() => void load()} />;
  if (templates === null) return <Loading what="templates" />;
  if (templates.length === 0) return <Empty>No template is set up yet.</Empty>;

  return (
    <ul className="space-y-4" aria-label="Templates">
      {templates.map((template) => (
        <li key={`${template.key}-${template.version}`}>
          <Card data-testid="template-card">
            <CardHeader
              level={2}
              title={TEMPLATE_KEY_LABELS[template.key]}
              description={`${template.whatsappName} · version ${template.version} · ${TEMPLATE_CATEGORY_LABELS[template.category]} · ${template.language}`}
              actions={
                usableOnSendingNumber(template) ? (
                  <Badge tone="green">Can go now</Badge>
                ) : (
                  <Badge tone="amber">Not usable on your number yet</Badge>
                )
              }
            />
            <CardBody>
              <p className="rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap text-slate-900">
                {namedBody(template)}
              </p>
              <p className="text-xs text-slate-600">
                The first value is always your company’s name, so tenants know who it is from on a
                shared number.
              </p>
              <Table caption={`Approval of ${TEMPLATE_KEY_LABELS[template.key]} by number`}>
                <thead>
                  <tr>
                    <Th>Number</Th>
                    <Th>Status</Th>
                    <Th>Checked</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {template.statuses.map((status) => (
                    <tr
                      key={`${status.number.kind}-${status.number.displayPhone}`}
                      data-testid="template-status"
                    >
                      <Td>
                        <p className="font-medium">{status.number.displayName}</p>
                        <p className="text-xs text-slate-600">
                          {status.number.displayPhone} ·{' '}
                          {status.number.kind === 'shared' ? 'shared number' : 'your own number'}
                          {status.sending ? ' · sends your messages' : ''}
                        </p>
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            status.status ? (STATUS_TONES[status.status] ?? 'neutral') : 'neutral'
                          }
                        >
                          {templateStatusText(status.status)}
                        </Badge>
                        {status.reason ? (
                          <p className="text-xs text-slate-600">{status.reason}</p>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {status.checkedAt ? formatTime(status.checkedAt, timeZone) : 'Not yet'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}
