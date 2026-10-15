import type { FieldInput, FieldType, Rect } from '@sign-pdf/spec';
import { describe, expect, it } from 'vitest';
import { findCandidatesInPdf, resolveRequest, validateRequestAgainstPdf, type PlacementCandidate } from '../index.ts';
import { requestFor } from '../test-helpers.ts';
import { candidateEvalCorpus, type CandidateEvalCase } from './corpus.ts';

/** Minimum overlap required for an expected field and suggestion to count as a hit. */
const IOU_THRESHOLD = 0.5;
const RECALL_FLOOR = 14 / 14;
const PRECISION_FLOOR = 14 / 14;
const HIGH_PRECISION_FLOOR = 0.95;
const CONFIDENCE_TIERS = ['high', 'medium', 'low'] as const;
type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

interface ScoredCandidate {
  rect: Rect;
  truthKind: 'expected' | 'acceptable-extra';
  fieldType?: FieldType;
  index: number;
}

interface CaseScore {
  name: string;
  expected: number;
  hits: number;
  candidates: number;
  truePositives: number;
  recall: number;
  precision: number;
  tiers: Record<ConfidenceTier, { candidates: number; truePositives: number; hits: number }>;
}

function intersectionOverUnion(a: Rect, b: Rect): number {
  if (a.page !== b.page) return 0;
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function fieldFor(candidate: PlacementCandidate, index: number): FieldInput {
  return {
    id: `eval-${index + 1}`,
    type: candidate.suggested.type ?? 'text',
    assignee: 'human',
    placement: candidate.suggested.placement,
  } as FieldInput;
}

async function scoreCase(testCase: CandidateEvalCase, clearUnderscoreCases = false): Promise<CaseScore> {
  const pdf = await testCase.pdf();
  const found = await findCandidatesInPdf(pdf);
  // Scorer negative control: clear candidates for underscore-named cases to
  // prove that the scorer rejects missing output. This does not mutate or prove
  // anything about the production underscore detector rule.
  const clearCandidates = clearUnderscoreCases || process.env.SIGN_PDF_EVAL_NEGATIVE_CONTROL === '1';
  const candidates = clearCandidates && testCase.name.includes('underscore') ? [] : found.candidates;
  const resolved = candidates.length === 0
    ? { fields: [] }
    : await resolveRequest(pdf, await requestFor(pdf, candidates.map(fieldFor)));
  const truths: ScoredCandidate[] = [
    ...testCase.expected.map((field, index) => ({
      rect: { ...field.rect, page: field.page },
      fieldType: field.type,
      truthKind: 'expected' as const,
      index,
    })),
    ...(testCase.acceptableExtras ?? []).map((rect, index) => ({ rect, truthKind: 'acceptable-extra' as const, index })),
  ];
  const pairs = resolved.fields.flatMap((field, candidateIndex) =>
    truths.flatMap((truth) => {
      if (truth.truthKind === 'expected' && truth.fieldType !== field.type) return [];
      const iou = intersectionOverUnion(field.rect, truth.rect);
      return iou >= IOU_THRESHOLD ? [{ candidateIndex, truth, iou }] : [];
    }),
  );
  pairs.sort((a, b) => b.iou - a.iou || a.candidateIndex - b.candidateIndex || a.truth.index - b.truth.index);
  const usedCandidates = new Set<number>();
  const usedTruths = new Set<string>();
  let hits = 0;
  let truePositives = 0;
  const tiers: CaseScore['tiers'] = {
    high: { candidates: candidates.filter((candidate) => candidate.confidence === 'high').length, truePositives: 0, hits: 0 },
    medium: { candidates: candidates.filter((candidate) => candidate.confidence === 'medium').length, truePositives: 0, hits: 0 },
    low: { candidates: candidates.filter((candidate) => candidate.confidence === 'low').length, truePositives: 0, hits: 0 },
  };
  for (const pair of pairs) {
    const truthKey = `${pair.truth.truthKind}:${pair.truth.index}`;
    if (usedCandidates.has(pair.candidateIndex) || usedTruths.has(truthKey)) continue;
    usedCandidates.add(pair.candidateIndex);
    usedTruths.add(truthKey);
    const tier = candidates[pair.candidateIndex]?.confidence;
    if (tier) tiers[tier].truePositives++;
    if (pair.truth.truthKind === 'expected') {
      hits++;
      truePositives++;
      if (tier) tiers[tier].hits++;
    } else {
      truePositives++;
    }
  }
  return {
    name: testCase.name,
    expected: testCase.expected.length,
    hits,
    candidates: resolved.fields.length,
    truePositives,
    recall: testCase.expected.length === 0 ? 1 : hits / testCase.expected.length,
    precision: resolved.fields.length === 0 ? 1 : truePositives / resolved.fields.length,
    tiers,
  };
}

function totals(scores: CaseScore[]) {
  const expected = scores.reduce((total, score) => total + score.expected, 0);
  const hits = scores.reduce((total, score) => total + score.hits, 0);
  const candidates = scores.reduce((total, score) => total + score.candidates, 0);
  const truePositives = scores.reduce((total, score) => total + score.truePositives, 0);
  const tiers = Object.fromEntries(
    CONFIDENCE_TIERS.map((tier) => [
      tier,
      scores.reduce(
        (total, score) => ({
          candidates: total.candidates + score.tiers[tier].candidates,
          truePositives: total.truePositives + score.tiers[tier].truePositives,
          hits: total.hits + score.tiers[tier].hits,
        }),
        { candidates: 0, truePositives: 0, hits: 0 },
      ),
    ]),
  ) as CaseScore['tiers'];
  return {
    expected,
    hits,
    candidates,
    truePositives,
    recall: expected === 0 ? 1 : hits / expected,
    precision: candidates === 0 ? 1 : truePositives / candidates,
    tiers,
  };
}

function report(scores: CaseScore[]): void {
  for (const score of scores) {
    console.info(
      `[candidate eval] ${score.name}: ${score.hits}/${score.expected} recall; ` +
        `${score.truePositives}/${score.candidates} precision ` +
        `(recall ${score.recall.toFixed(3)}, precision ${score.precision.toFixed(3)}; ` +
        `high ${score.tiers.high.hits}/${score.expected} recall, ` +
        `${score.tiers.high.truePositives}/${score.tiers.high.candidates} precision)`,
    );
  }
  const total = totals(scores);
  console.info(
      `[candidate eval] total: ${total.hits}/${total.expected} recall; ` +
      `${total.truePositives}/${total.candidates} precision ` +
      `(recall ${total.recall.toFixed(3)}, precision ${total.precision.toFixed(3)})`,
  );
  for (const tier of CONFIDENCE_TIERS) {
    const score = total.tiers[tier];
    console.info(
      `[candidate eval] ${tier}: ${score.hits}/${total.expected} recall; ` +
        `${score.truePositives}/${score.candidates} precision ` +
        `(recall ${(total.expected === 0 ? 1 : score.hits / total.expected).toFixed(3)}, ` +
        `precision ${(score.candidates === 0 ? 1 : score.truePositives / score.candidates).toFixed(3)})`,
    );
  }
}

describe('candidate evaluation corpus', () => {
  it('meets the dated recall and precision floors across synthetic cases', async () => {
    const scores = await Promise.all(candidateEvalCorpus.map((testCase) => scoreCase(testCase)));
    report(scores);
    const total = totals(scores);

    // Baseline measured on 2026-10-12: 11/14 recall and 11/13 precision.
    // After #97/#111: 14/14 recall, 14/14 overall precision, and 12/12 high-tier precision.
    // Raise these floors with corpus improvements; lowering either needs an issue comment.
    expect(total.recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
    expect(total.precision).toBeGreaterThanOrEqual(PRECISION_FLOOR);
    expect(total.tiers.high.candidates).toBeGreaterThan(0);
    expect(total.tiers.high.truePositives / total.tiers.high.candidates).toBeGreaterThanOrEqual(HIGH_PRECISION_FLOOR);
    expect(candidateEvalCorpus).toHaveLength(13);
  });

  it('keeps all four negative cases clear of false-positive candidates', async () => {
    const negatives = candidateEvalCorpus.filter((testCase) => testCase.expected.length === 0);
    expect(negatives).toHaveLength(4);
    for (const testCase of negatives) {
      const { candidates } = await findCandidatesInPdf(await testCase.pdf());
      expect(candidates, testCase.name).toEqual([]);
    }
  });

  it('turns candidate placements into a validation-clean agent flow', async () => {
    const testCase = candidateEvalCorpus.find((item) => item.name === 'caption below a signature blank')!;
    const pdf = await testCase.pdf();
    const { candidates } = await findCandidatesInPdf(pdf);
    // This is the deterministic agent stub: choose every suggested placement.
    // A future draft builder can replace this mapping without changing scoring.
    const request = await requestFor(pdf, candidates.map(fieldFor));
    const { report: validation, resolved } = await validateRequestAgainstPdf(pdf, request);
    expect(validation.errors).toEqual([]);
    expect(resolved).toBeDefined();
    expect(resolved?.fields).toHaveLength(candidates.length);
    for (const blank of testCase.expected) {
      const rect = { ...blank.rect, page: blank.page };
      expect(resolved?.fields.some((field) => field.type === blank.type && intersectionOverUnion(field.rect, rect) >= IOU_THRESHOLD)).toBe(true);
    }
  });

  it('uses a scorer negative control to reject missing underscore-case candidates', async () => {
    const underscoreCases = candidateEvalCorpus.filter((testCase) => testCase.name.includes('underscore'));
    const underscoreScores = await Promise.all(
      candidateEvalCorpus.filter((testCase) => testCase.name.includes('underscore')).map((testCase) => scoreCase(testCase)),
    );
    const expected = underscoreCases.reduce((count, testCase) => count + testCase.expected.length, 0);
    const underscoreHits = underscoreScores.reduce((count, score) => count + score.hits, 0);
    expect(underscoreHits).toBe(expected);
    // This negative control clears underscore-case candidates by case name.
    // It only proves the scorer rejects missing output; it does not test the
    // production underscore rule.
    const negativeControl = totals(await Promise.all(candidateEvalCorpus.map((testCase) => scoreCase(testCase, true))));
    expect(negativeControl.recall).toBeLessThan(RECALL_FLOOR);
  });
});
