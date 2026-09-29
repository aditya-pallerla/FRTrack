/**
 * Gemini evidence extraction for free-text flood reports (any of English / Hindi / Marathi).
 *
 * Gemini ONLY turns text into structured evidence. It never sets a warning level, a priority or a
 * location used as ground truth, and its self-reported confidence is stored as a hint only.
 * If GEMINI_API_KEY is missing or the call fails, the deterministic keyword extractor is used.
 */
import type { FloodReportKind, ReportEvidence } from '../../../shared/types.js';
import { detectLanguage, keywordExtract } from './keyword.js';

const KINDS: FloodReportKind[] = [
  'water_in_homes', 'road_flooded', 'bridge_submerged', 'people_trapped', 'rescue_needed', 'water_rising',
  'vehicles_cannot_pass', 'shelter_inaccessible', 'road_open', 'no_flooding',
];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    kinds: { type: 'ARRAY', items: { type: 'STRING', enum: KINDS } },
    road_blocked: { type: 'BOOLEAN' },
    people_trapped: { type: 'INTEGER', description: '0 if none mentioned, -1 if trapped people mentioned without a number, otherwise the number' },
    injured: { type: 'INTEGER', description: '0 if none, -1 if mentioned without a number, otherwise the number' },
    vulnerable_present: { type: 'BOOLEAN', description: 'children, elderly, pregnant or disabled people mentioned' },
    place_text: { type: 'STRING', nullable: true, description: 'place / landmark words exactly as written, or null' },
    language: { type: 'STRING', enum: ['en', 'hi', 'mr', 'mixed', 'unknown'] },
    confidence: { type: 'NUMBER', description: '0..1 how clearly the text states these facts' },
  },
  required: ['kinds', 'road_blocked', 'people_trapped', 'injured', 'vulnerable_present', 'language', 'confidence'],
};

const PROMPT = `You extract facts from a citizen flood report from Kolhapur district, Maharashtra, India.
The report may be English, Hindi, Marathi or mixed, in Devanagari or romanised script.
Extract ONLY what the text states. Do not infer severity, do not guess numbers, do not invent places.
Use "road_open" or "no_flooding" only when the reporter says a road is passable or there is no flooding.
Report:
"""
{TEXT}
"""`;

export interface ExtractResult { evidence: ReportEvidence; model: string | null; fallback_reason: string | null }

export async function extractEvidence(text: string): Promise<ExtractResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return { evidence: keywordExtract(text), model: null, fallback_reason: 'GEMINI_API_KEY not set' };
  const models = [process.env.GEMINI_MODEL ?? 'gemini-3.8-flash', ...(process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-3.5-flash-lite').split(',')]
    .map((m) => m.trim()).filter(Boolean);
  let lastError = 'unknown error';
  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT.replace('{TEXT}', text.slice(0, 2000)) }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: SCHEMA },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { lastError = `${model}: HTTP ${res.status}`; if (res.status === 429 || res.status >= 500) continue; break; }
      const body = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw = JSON.parse(body.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}');
      return { evidence: validate(raw, text), model, fallback_reason: null };
    } catch (err) {
      lastError = `${model}: ${(err as Error).message}`;
    }
  }
  return { evidence: keywordExtract(text), model: null, fallback_reason: `Gemini unavailable (${lastError})` };
}

/** Clamps and checks the model output; anything invalid falls back to the keyword result for that field. */
function validate(raw: Record<string, unknown>, text: string): ReportEvidence {
  const kw = keywordExtract(text);
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter((k): k is FloodReportKind => KINDS.includes(k as FloodReportKind)) : kw.kinds;
  const int = (v: unknown, fb: number) => (Number.isInteger(v) && (v as number) >= -1 && (v as number) < 10_000 ? (v as number) : fb);
  const conf = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : null;
  return {
    kinds,
    road_blocked: typeof raw.road_blocked === 'boolean' ? raw.road_blocked : kw.road_blocked,
    people_trapped: int(raw.people_trapped, kw.people_trapped),
    injured: int(raw.injured, kw.injured),
    vulnerable_present: typeof raw.vulnerable_present === 'boolean' ? raw.vulnerable_present : kw.vulnerable_present,
    place_text: typeof raw.place_text === 'string' && raw.place_text.trim() ? raw.place_text.trim().slice(0, 120) : null,
    language: ['en', 'hi', 'mr', 'mixed', 'unknown'].includes(raw.language as string) ? raw.language as ReportEvidence['language'] : detectLanguage(text),
    extractor: 'gemini',
    extractor_confidence_hint: conf,
  };
}
