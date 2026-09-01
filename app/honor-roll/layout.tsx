import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '2026 Honor Roll State Registration — Texas Our Little Miss',
  description: 'Honor Roll and Winner’s Circle registration for the 2026 Texas Our Little Miss State Universal Beauty Competition.',
};

export default function HonorRollLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
