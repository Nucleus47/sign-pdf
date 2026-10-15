# Candidate evaluation corpus

`eval.test.ts` measures candidate placement recall and precision against small
PDFs generated in code. It runs with the core unit tests. To add a case:

1. Add one `syntheticPdf` builder call to `corpus.ts`.
2. Draw the labels, rules, or widgets for one behavior.
3. Add each expected field's type, page, and rectangle in display coordinates.
4. Add any known acceptable extra rectangles.
5. Run `pnpm --filter @sign-pdf/core test` and keep the measured floors intact.

Do not add PDF files, real forms, network calls, or model calls here. The test
uses an IoU threshold of 0.5 and prints per-case plus corpus totals. Confidence
tiers are not scored until the candidate API provides them; precision split by
confidence tier remains with #111.

To run the scorer negative control, use
`SIGN_PDF_EVAL_NEGATIVE_CONTROL=1 pnpm --filter @sign-pdf/core exec vitest run src/eval/eval.test.ts`.
It clears candidates for underscore-named cases and proves the scorer rejects
missing output. It does not remove or test the production underscore rule.
