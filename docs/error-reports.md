# Error reports

Every error screen has a collapsed "Technical details" section. It holds a plain-text report and a "Copy details" button. A person can send the report to whoever helps them. The report is built in the browser and is never sent anywhere.

## What the report holds

- The error code, a filtered message and up to 20 stack frames.
- The app version (the commit it was built from), the user agent, the platform, the viewport and the pixel ratio.
- The browser features that are missing (see below).
- The time, and the view, document state and sign step.
- The file's extension and size.
- The last error that nothing caught since the person last went to the start page, if there was one.

## What it never holds

The PDF, the request, field values, labels, signer names, signatures, packet text and file names.

- For `value-does-not-fit`, `unsupported-characters`, `missing-required-field` and `invalid-request`, only the field id and the code are kept.
- In every other message, quoted text, long hex strings, long base64 or token runs and e-mail addresses are cut.
- A thrown value that is not an error (such as a string) is reported by its type only.
- The builder (`packages/web/src/lib/errorReport.ts`) copies only the keys it knows from flat records of primitives.

Tests: `errorReport.test.ts`, the sentinel tests in `Sign.test.tsx`, and `e2e/errors.spec.ts`.

## Browser support

`packages/web/src/lib/browserSupport.ts` probes the browser before any shim runs. When a required feature is missing and nothing supplies it, a banner says: "This browser is out of date. Update it, then open this page again." On plain http (not localhost) the browser turns off `crypto.subtle` on purpose, so the banner asks for an https address instead.
