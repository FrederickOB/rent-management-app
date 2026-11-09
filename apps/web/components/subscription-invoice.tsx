'use client';

import type { ReactNode } from 'react';
import { formatBusinessDate } from '@/lib/business-dates';
import { formatTime } from '@/lib/format';
import { monthLabel } from '@/lib/rent-tax';
import {
  bandLabel,
  bandRows,
  invoiceLineText,
  invoiceStateText,
  totalUnits,
} from '@/lib/subscription';
import { formatMinor } from '@/lib/tenancy-format';
import type { api } from '@/lib/api';
import { DocumentDownload } from './document-download';
import { Alert } from './ui/alert';
import { Card, CardBody, CardHeader } from './ui/card';
import { Table, Td, Th } from './ui/table';

type Invoice = Awaited<ReturnType<ReturnType<typeof api>['subscription']['invoice']>>;
type Snapshot = Awaited<ReturnType<ReturnType<typeof api>['subscription']['snapshot']>>;
type Download = () => Promise<{ readonly url: string }>;

/**
 * A subscription invoice with its lines, its credit notes and the snapshot it was made from
 * (PB-02, founder answer Q2), as the subscriber and the console both show it (review WEB-11 and
 * WEB-17). Each side passes its own document routes and VAT wording.
 */
export function SubscriptionInvoiceCards({
  invoice,
  snapshot,
  timeZone,
  vatNote,
  invoiceDocument,
  creditNoteDocument,
  children,
}: {
  readonly invoice: Invoice;
  readonly snapshot: Snapshot;
  readonly timeZone: string;
  /** Shown while the VAT lines read an unverified rule. */
  readonly vatNote: string;
  readonly invoiceDocument: Download;
  readonly creditNoteDocument: (creditNoteId: string) => Download;
  /** The console's credit form. */
  readonly children?: ReactNode;
}) {
  const hasVat = invoice.lines.some((line) => ['vat', 'nhil', 'getfund'].includes(line.kind));
  return (
    <>
      <Card data-testid="subscription-invoice">
        <CardHeader
          title={invoiceStateText(invoice)}
          actions={
            invoice.hasDocument ? (
              <DocumentDownload
                label="Download the PDF"
                name={`Download the PDF of invoice ${invoice.number}`}
                load={invoiceDocument}
              />
            ) : null
          }
        />
        <CardBody className="space-y-3">
          {hasVat && invoice.vatUnverified ? <Alert tone="warning">{vatNote}</Alert> : null}
          <Table caption="Invoice lines">
            <thead>
              <tr>
                <Th>Line</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.lines.map((line, index) => (
                <tr key={`${line.kind}-${index}`} data-testid="subscription-invoice-line">
                  <Td>{invoiceLineText(line)}</Td>
                  <Td className="text-right tabular-nums">{formatMinor(line.amountMinor)}</Td>
                </tr>
              ))}
              <tr>
                <Td className="font-semibold">Total</Td>
                <Td className="text-right font-semibold tabular-nums">
                  {formatMinor(invoice.totalMinor)}
                </Td>
              </tr>
            </tbody>
          </Table>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-slate-600">Credited</dt>
              <dd className="tabular-nums" data-testid="invoice-credited">
                {formatMinor(invoice.creditedMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">From prepaid credit</dt>
              <dd className="tabular-nums">{formatMinor(invoice.prepaidMinor)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">Paid</dt>
              <dd className="tabular-nums">{formatMinor(invoice.paidMinor)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">Left to pay</dt>
              <dd className="font-semibold tabular-nums" data-testid="invoice-outstanding">
                {formatMinor(invoice.outstandingMinor)}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>
      {invoice.creditNotes.length > 0 || children ? (
        <Card data-testid="subscription-credit-notes">
          <CardHeader
            title="Credit notes"
            description="A credit note takes part or all of the invoice off; what was already paid on it is kept as credit for the next invoice."
          />
          <CardBody className="space-y-3">
            {invoice.creditNotes.length > 0 ? (
              <Table caption="Credit notes on this invoice">
                <thead>
                  <tr>
                    <Th>Credit note</Th>
                    <Th>Issued</Th>
                    <Th>Reason</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>PDF</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoice.creditNotes.map((note) => (
                    <tr key={note.id} data-testid="credit-note-row">
                      <Td className="font-medium">{note.number}</Td>
                      <Td>{formatBusinessDate(note.issuedOn)}</Td>
                      <Td>{note.reason}</Td>
                      <Td className="text-right tabular-nums">{formatMinor(note.amountMinor)}</Td>
                      <Td>
                        {note.hasDocument ? (
                          <DocumentDownload
                            label="Download"
                            name={`Download credit note ${note.number}`}
                            load={creditNoteDocument(note.id)}
                          />
                        ) : (
                          '—'
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-sm text-slate-600">No credit note on this invoice.</p>
            )}
            {children}
          </CardBody>
        </Card>
      ) : null}
      <Card data-testid="subscription-snapshot">
        <CardHeader
          title={`The units billed: ${monthLabel(snapshot.month)}`}
          description={`Recorded ${formatTime(snapshot.takenAt, timeZone)} and never changed: every unit with a lease on any day of the month. Vacant units are not billed.`}
        />
        <CardBody className="space-y-3">
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {bandRows(snapshot.countsByBand).map((row) => (
              <li key={row.band}>
                {row.label}: <span className="font-medium tabular-nums">{row.value}</span>
              </li>
            ))}
            <li>
              Every band:{' '}
              <span className="font-medium tabular-nums">{totalUnits(snapshot.countsByBand)}</span>
            </li>
          </ul>
          <Table caption="Units billed, one by one">
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Band</Th>
                <Th className="text-right">Days with a lease</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {snapshot.units.map((unit) => (
                <tr key={`${unit.unitId}-${unit.leaseId}`} data-testid="snapshot-unit">
                  <Td className="font-medium">{unit.unitCode}</Td>
                  <Td>{bandLabel(unit.band)}</Td>
                  <Td className="text-right tabular-nums">{unit.daysLeased}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
}
