export type RegistrationValues = Record<string, string>;
export type RegistrationWorkflow = 'prelim' | 'honor_roll';

export type RegistrationStatus =
  | 'submitted'
  | 'invoice_error'
  | 'invoice_created'
  | 'invoice_expired'
  | 'payment_waived'
  | 'paid'
  | 'paperwork_complete'
  | 'invoice_updated';

export type RegistrationRecord = {
  id: string;
  workflow: RegistrationWorkflow;
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
  invoiceCreatedAt?: string;
  paymentWindowStartedAt?: string;
  invoiceExpiresAt?: string;
  invoiceVoidedAt?: string;
  quickBooksInvoiceEmailedAt?: string;
  paymentLinkEmailSentAt?: string;
  paymentLinkEmailMethod?: 'gmail' | 'resend';
  waiver?: {
    creditCents: number;
    appliedAt: string;
  };
  paidAt?: string;
  bigFormInvitationSentAt?: string;
  bigFormInvitationMethod?: 'gmail' | 'resend' | 'quickbooks';
  bigFormInvitationAttempt?: number;
  bigFormInvitationLastAttemptAt?: string;
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
