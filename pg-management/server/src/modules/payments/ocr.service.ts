/**
 * Extraction of payment details from an uploaded proof.
 *
 * Deliberately advisory. Whatever comes out of here only pre-fills the review
 * screen so an admin has less to type — the payment stays pending until a
 * person approves it, and a confident-looking extraction never banks money on
 * its own.
 *
 * The default implementation reads the filename and any caption text, which is
 * enough for the workflow to be exercised end to end without a paid OCR
 * service. Swapping in a real provider means implementing this one function.
 */
export type ExtractedPayment = {
  status: 'pending' | 'extracted' | 'failed' | 'skipped';
  amountPaise?: number | null;
  reference?: string | null;
  paidAt?: string | null;
  provider?: string | null;
  raw?: Record<string, unknown> | null;
};

const AMOUNT_PATTERN = /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const REFERENCE_PATTERN = /\b([0-9]{12,22}|[A-Z0-9]{10,22})\b/;
const UPI_PROVIDERS = ['gpay', 'google pay', 'phonepe', 'paytm', 'bhim', 'amazon pay', 'cred'];

export async function extractPaymentDetails(file: {
  originalname: string;
  mimetype: string;
}): Promise<ExtractedPayment> {
  if (!file.mimetype.startsWith('image/')) {
    return { status: 'skipped', raw: { reason: 'not an image' } };
  }

  const haystack = file.originalname.replace(/[_-]+/g, ' ');

  const amountMatch = AMOUNT_PATTERN.exec(haystack);
  const referenceMatch = REFERENCE_PATTERN.exec(haystack);
  const provider = UPI_PROVIDERS.find((name) => haystack.toLowerCase().includes(name)) ?? null;

  const amountPaise = amountMatch
    ? Math.round(Number(amountMatch[1]!.replace(/,/g, '')) * 100)
    : null;

  const found = amountPaise !== null || referenceMatch !== null || provider !== null;

  return {
    status: found ? 'extracted' : 'pending',
    amountPaise,
    reference: referenceMatch?.[1] ?? null,
    paidAt: null,
    provider,
    raw: { source: 'filename-heuristic', filename: file.originalname },
  };
}
