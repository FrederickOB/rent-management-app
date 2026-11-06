import type { MaintenanceJob } from '@rent/contracts';
import {
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_JOB_STATUS_LABELS,
  MAINTENANCE_PRIORITY_LABELS,
  type MaintenanceJobStatus,
} from '@rent/domain/maintenance';
import { isEmergency, isOverdue } from '@/lib/maintenance';
import { Badge, type BadgeTone } from './ui/badge';

const STATUS_TONES: Record<MaintenanceJobStatus, BadgeTone> = {
  reported: 'amber',
  triaged: 'blue',
  assigned: 'blue',
  in_progress: 'blue',
  work_done: 'green',
  closed: 'dark',
  cancelled: 'dark',
};

export function JobStatusBadge({ status }: { readonly status: MaintenanceJobStatus }) {
  return (
    <span data-testid="job-status">
      <Badge tone={STATUS_TONES[status]}>{MAINTENANCE_JOB_STATUS_LABELS[status]}</Badge>
    </span>
  );
}

/**
 * The priority, with emergencies marked so they stand out without colour too: the word
 * "Emergency" in capitals and a warning sign. A tenant's flag shows until the job is triaged.
 */
export function PriorityBadge({
  job,
}: {
  readonly job: Pick<MaintenanceJob, 'priority' | 'emergencyFlag'>;
}) {
  if (isEmergency(job))
    return (
      <span data-testid="job-emergency">
        <Badge tone="red" className="font-bold uppercase">
          <span aria-hidden="true">⚠&nbsp;</span>
          Emergency{job.priority === null ? ' (tenant flagged)' : ''}
        </Badge>
      </span>
    );
  if (!job.priority) return <Badge>Not triaged</Badge>;
  return (
    <Badge tone={job.priority === 'urgent' ? 'amber' : 'neutral'}>
      {MAINTENANCE_PRIORITY_LABELS[job.priority]}
    </Badge>
  );
}

export function CategoryBadge({ job }: { readonly job: Pick<MaintenanceJob, 'category'> }) {
  return job.category ? <Badge>{MAINTENANCE_CATEGORY_LABELS[job.category]}</Badge> : null;
}

export function OverdueBadge({ job }: { readonly job: Pick<MaintenanceJob, 'targets'> }) {
  if (!isOverdue(job)) return null;
  return (
    <span data-testid="job-overdue">
      <Badge tone="red">
        {job.targets?.overdue === 'respond' ? 'Response overdue' : 'Completion overdue'}
      </Badge>
    </span>
  );
}
