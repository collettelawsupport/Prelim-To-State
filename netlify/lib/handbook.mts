import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const BIG_FORM_HANDBOOK_FILENAME = 'Handbook Texas State Beauty 2026.pdf';
export const BIG_FORM_HANDBOOK_CONTENT_TYPE = 'application/pdf';

const HANDBOOK_ASSET_PATH = ['netlify', 'assets', 'handbook-texas-state-beauty-2026.pdf'];

export async function loadBigFormHandbookAttachment() {
  let content: Buffer;
  try {
    content = await readFile(resolve(process.cwd(), ...HANDBOOK_ASSET_PATH));
  } catch {
    throw new Error('The 2026 Texas State Handbook email attachment is unavailable.');
  }

  if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('The 2026 Texas State Handbook email attachment is invalid.');
  }

  return {
    filename: BIG_FORM_HANDBOOK_FILENAME,
    content,
    contentType: BIG_FORM_HANDBOOK_CONTENT_TYPE,
  };
}
