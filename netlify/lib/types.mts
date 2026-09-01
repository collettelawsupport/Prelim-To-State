export type RegistrationValues = Record<string, string>;

export type RegistrationStatus =
  | 'submitted'
  | 'invoice_error'
  | 'invoice_created'
  | 'paid'
  | 'paperwork_complete'
  | 'invoice_updated';

export type RegistrationRecord = {
  id: string;
  submissionKey: string;
  statusToken: string;
  workflowToken: string;
  createdAt: string;
  updatedAt: string;
  status: RegistrationStatus;
  values: RegistrationValues;
  entryFeeCents: number;
  depositCents: number;
  qbo?: {
    customerId?: string;
    invoiceId?: string;
    invoiceNumber?: string;
    invoiceUrl?: string;
  };
  paidAt?: string;
  bigFormInvitationSentAt?: string;
  bigFormInvitationMethod?: 'gmail' | 'resend' | 'quickbooks';
  bigFormSubmissionId?: string;
  invoiceUpdatedAt?: string;
  lastError?: string;
};

export type BigFormFeeLine = {
  category?: string;
  item: string;
  description?: string;
  sourceField?: string;
  quantity: number;
  rate: number | null;
  amount: number | null;
  status: 'known' | 'free' | 'pending';
};

export type BigFormFeeSummary = {
  lines: BigFormFeeLine[];
  knownTotal: number;
  pendingCount: number;
};
