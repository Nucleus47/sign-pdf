/**
 * Sign view: the human reviews every value, adjusts misplaced fields, fills
 * their own fields and signs. This is the only view that produces a signature.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Email, isSigningField, RELAY_TTL_DAYS, type PageInfo, type Rect, type ResolvedField, type ResolvedRequest, type Signer } from '@sign-pdf/spec';
import type { DocState, SignJob } from '../app/open.ts';
import { CheckMark, FieldCanvas, FieldKeyboardHelp, type CanvasField, type FieldTone } from '../components/FieldCanvas.tsx';
import { EmailHandoff, type EmailSent } from '../components/EmailHandoff.tsx';
import { Icon } from '../components/Icon.tsx';
import { ErrorDetails } from '../components/ErrorDetails.tsx';
import { PdfViewer } from '../components/PdfViewer.tsx';
import { SignatureDialog, type SignatureResult } from '../components/SignatureDialog.tsx';
import { PreparerNote } from '../components/ui.tsx';
import {
  core,
  explainProblem,
  toCoreProblem,
  type CoreProblem,
  type FinalizeResult,
  type HumanInput,
} from '../lib/core.ts';
import { displayText, formatDateTime, UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';
import {
  awaitsConfirmation,
  buildHumanInput,
  byDocumentOrder,
  CONSENT_TEXT,
  draftForPass,
  draftFromPasses,
  explainValueProblem,
  fieldName,
  fieldStepPosition,
  firstOpenStep,
  guideSteps,
  handoffFileName,
  handoffMessage,
  hasValue,
  initialDraft,
  isEditableIn,
  passOfField,
  plainLine,
  progressOf,
  progressText,
  requiredItems,
  savedSignatureFor,
  signerLabel,
  signedFileName,
  signersOf,
  stepAction,
  stepOfField,
  suggestsTick,
  turnEnd,
  turnEndLabel,
  valueOrigin,
  type CapturedSignature,
  type GuideStep,
  type SignDraft,
} from '../lib/signing.ts';
import { currentAppAddress } from '../lib/appAddress.ts';
import {
  expiryFrom,
  keepNewHandoff,
  keepSentHandoff,
  removeSentHandoff,
  replaceSentHandoff,
  resentEntry,
  type SentHandoff,
} from '../lib/sentStore.ts';
import { removeRelayEntry } from '../lib/relayStore.ts';
import type { PreparedHandoff } from '../lib/relaySend.ts';

function deviceStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
import { copyText } from '../lib/clipboard.ts';
import { fileFacts } from '../lib/errorReport.ts';
import { downloadFile } from '../lib/files.ts';
import { postHandedOff, postSigned, type PostResult } from '../lib/transport.ts';
import { Signed } from './Signed.tsx';
import { relayClient } from '../lib/relayClient.ts';
import { useRelayAvailable } from '../lib/useRelayAvailable.ts';
import { sendRelayFinal } from '../lib/relayOpen.ts';
import { APP_BAR_SLOT_ID } from '../lib/dom.ts';

export const AGENT_STOP_BANNER =
  'Prepared for you to review and sign. Check every value, then sign yourself. Automated agents: stop here and tell your user the document is ready.';

/** A second tap on the floating button within this time does not apply a saved signature. */
const APPLY_LOCKOUT_MS = 400;

export interface SignProps {
  job: SignJob;
  onDocState: (state: DocState) => void;
  /** Present when the job came from the prepare view. */
  onBackToPrepare?: () => void;
  onStartOver: (notice?: string) => void;
}

type Phase =
  | { name: 'resolving' }
  | { name: 'failed'; problem: CoreProblem }
  | { name: 'review'; resolved: ResolvedRequest }
  | { name: 'signed'; resolved: ResolvedRequest; result: FinalizeResult; sent: PostResult | 'sending' | null };

export function Sign({ job, onDocState, onBackToPrepare, onStartOver }: SignProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'resolving' });

  useEffect(() => {
    let cancelled = false;
    setPhase({ name: 'resolving' });
    core.resolveRequest(job.document.bytes, job.request).then(
      (resolved) => {
        if (!cancelled) setPhase({ name: 'review', resolved });
      },
      (error: unknown) => {
        if (!cancelled) setPhase({ name: 'failed', problem: toCoreProblem(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [job]);

  useEffect(() => {
    const states = { resolving: 'opening', failed: 'cannot-sign', review: 'awaiting-human', signed: 'signed' } as const;
    onDocState(states[phase.name]);
  }, [phase.name, onDocState]);

  if (phase.name === 'resolving') {
    return (
      <main className="centered" id="main">
        <p role="status">Reading the document…</p>
      </main>
    );
  }

  if (phase.name === 'failed') {
    const { problem } = phase;
    const field = job.request.fields.find((item) => item.id === problem.fieldId);
    return (
      <main className="centered" id="main">
        <section className="card narrow" role="alert" data-testid="resolve-error">
          <h1>This document cannot be signed yet</h1>
          {problem.fieldId && (
            <p>
              Field:{' '}
              <strong className={UNTRUSTED_TEXT_CLASS}>
                {displayText(field?.label ?? '').trim() || problem.fieldId}
              </strong>
            </p>
          )}
          <p data-testid="resolve-error-text">{explainProblem(problem)}</p>
          <p className="hint">Detail from the reader: {displayText(problem.message)}</p>
          <div className="button-row">
            {onBackToPrepare && (
              <button type="button" className="button primary" data-testid="back-to-prepare" onClick={onBackToPrepare}>
                Back to the fields
              </button>
            )}
            <button type="button" className="button" data-testid="start-over" onClick={() => onStartOver()}>
              Open another document
            </button>
          </div>
          <ErrorDetails failure={problem} file={fileFacts(job.document.name, job.document.bytes.length)} />
        </section>
      </main>
    );
  }

  // Hand the signed PDF back to the local app. The token and the bytes stay in
  // memory, so a failed hand-back can be sent again as it is.
  const sendBack = (token: string, resolved: ResolvedRequest, result: FinalizeResult) => {
    setPhase({ name: 'signed', resolved, result, sent: 'sending' });
    void postSigned(token, result.pdf, result.sha256).then((sent) =>
      setPhase({ name: 'signed', resolved, result, sent }),
    );
  };

  // An emailed document: encrypt the signed PDF and upload it for the first
  // signer. The download does not wait for it, and a failure can be tried again.
  const sendToRelay = (relay: NonNullable<SignJob['relay']>, resolved: ResolvedRequest, result: FinalizeResult) => {
    setPhase({ name: 'signed', resolved, result, sent: 'sending' });
    const requester = signerLabel(signersOf(resolved), 0);
    void sendRelayFinal(relayClient(), { ...relay, requester }, result.pdf).then((sent) =>
      setPhase({ name: 'signed', resolved, result, sent }),
    );
  };

  if (phase.name === 'signed') {
    const { resolved, result } = phase;
    const token = job.sessionToken;
    const relay = job.relay;
    return (
      <Signed
        documentName={job.document.name}
        resolved={resolved}
        result={result}
        sent={phase.sent}
        {...(relay ? { sentTo: signerLabel(signersOf(resolved), 0) } : {})}
        {...(token ? { onSendAgain: () => sendBack(token, resolved, result) } : {})}
        {...(relay ? { onSendAgain: () => sendToRelay(relay, resolved, result) } : {})}
        onStartOver={() => onStartOver()}
      />
    );
  }

  const onSigned = (result: FinalizeResult) => {
    const { resolved } = phase;
    // A relay job has no loopback session: it never posts to /api.
    if (job.relay) sendToRelay(job.relay, resolved, result);
    else if (job.sessionToken) sendBack(job.sessionToken, resolved, result);
    else setPhase({ name: 'signed', resolved, result, sent: null });
  };

  return (
    <Review
      job={job}
      resolved={phase.resolved}
      onSigned={onSigned}
      onStartOver={onStartOver}
      {...(onBackToPrepare ? { onBackToPrepare } : {})}
    />
  );
}

// ---------------------------------------------------------------------------

/** The hand-off PDF a signer downloaded for the next one, and what the local app answered. */
interface HandedOver {
  fileName: string;
  pdf: Uint8Array;
  input: HumanInput;
  next: string;
  sent: PostResult | null;
  /** Set when the relay emailed the next signer instead of a download. */
  emailed?: { id: string; to: string; expiresAt: string; stored: boolean };
  /** True once the hand-off PDF was downloaded on this screen or before it. */
  downloaded: boolean;
}

interface ReviewProps {
  job: SignJob;
  resolved: ResolvedRequest;
  onSigned: (result: FinalizeResult) => void;
  onBackToPrepare?: () => void;
  onStartOver: (notice?: string) => void;
}

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 5);
}

function Review({ job, resolved, onSigned, onBackToPrepare, onStartOver }: ReviewProps) {
  const ids = useId();
  const previewUrls = useRef(new Set<string>());
  // A job from a hand-off PDF carries the turns earlier signers finished elsewhere.
  const resumed = job.handoff?.passes ?? [];
  const [draft, setDraft] = useState<SignDraft>(() =>
    resumed.length > 0
      ? draftFromPasses(resolved, resumed, new Date(), (png) => {
          const url = URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' }));
          previewUrls.current.add(url);
          return url;
        })
      : initialDraft(resolved, new Date()),
  );
  const [pages, setPages] = useState<PageInfo[]>(resolved.pages);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why signing or the hand-off PDF failed, and the field it names. */
  const [error, setError] = useState<{ problem: CoreProblem; field?: string } | null>(null);
  // Several signers sign in turn on this device. `pass` is the current turn;
  // `completed` holds the finished turns' input until the last turn signs.
  const signers = signersOf(resolved);
  const multi = signers.length > 0;
  const [pass, setPass] = useState(resumed.length);
  const [completed, setCompleted] = useState<HumanInput[]>(() => [...resumed]);
  // After "Download the PDF for <next>": the file, kept to download again, and what the local app was told.
  const [handedOver, setHandedOver] = useState<HandedOver | null>(null);
  const [handoff, setHandoff] = useState(false);
  // "Email it to <next>": this turn's input while the email panel is open.
  const [emailing, setEmailing] = useState<HumanInput | null>(null);
  // The hand-off the email panel built, kept for "Download the hand-off PDF instead".
  const emailBuilt = useRef<{ input: HumanInput; pdf: Uint8Array; packet: string } | null>(null);
  // The emailed hand-off as this device keeps it, to email it again (lib/sentStore.ts).
  const kept = useRef<SentHandoff | null>(null);
  // "Email it again" from the sent screen.
  const [resending, setResending] = useState(false);
  // After the hand-off file is made, the signer can look back at the document, read-only.
  const [viewing, setViewing] = useState(false);
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setBarSlot(document.getElementById(APP_BAR_SLOT_ID)), []);
  const end = turnEnd(resolved, pass);
  const editable = (field: ResolvedField) => !handedOver && isEditableIn(field, signers, pass);
  // The turns whose fields are settled: with the hand-off made, this turn's too.
  const settled = handedOver ? pass + 1 : pass;
  // The hand-off file's name says how far the signing got: this turn is signed too.
  const handoffName = handoffFileName(plainLine(job.document.name), pass + 1, signers.length);

  // Guided signing: the turn is a list of steps and one is current. `showAll`
  // opens the full list of fields. `opened` counts guided moves: each one
  // opens the input of the step it lands on, after that step has rendered.
  const steps = useMemo(() => guideSteps(resolved, pass), [resolved, pass]);
  const [stepIndex, setStepIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState(0);
  const [viewFocus, setViewFocus] = useState<{ rect: Rect; seq: number } | null>(null);
  const focusSeq = useRef(0);
  // When the floating button was last tapped: a second tap this soon (a double
  // tap) never puts a saved signature on the next field.
  const lastPrimaryTap = useRef(0);
  const autoCaptured = useRef(new Set<string>());
  const finishIndex = steps.length - 1;
  const step: GuideStep = steps[stepIndex] ?? { kind: 'finish' };

  // Signature previews are object URLs: release them when the view goes away.
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const fields = useMemo(() => [...resolved.fields].sort(byDocumentOrder), [resolved.fields]);
  const fieldById = (id: string) => fields.find((field) => field.id === id);
  const items = useMemo(() => requiredItems(resolved, draft, pass), [resolved, draft, pass]);
  const progress = progressOf(items);

  // Live check, shortly after the person stops typing or resizing: can each
  // text and date value be drawn inside its box? The core applies the same
  // rules when signing; asking early puts the message next to the field.
  const [problems, setProblems] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const found: Record<string, string> = {};
        for (const field of resolved.fields) {
          const value = draft.values[field.id];
          if ((field.type !== 'text' && field.type !== 'date') || typeof value !== 'string' || value === '') continue;
          try {
            const result = await core.checkFieldValue(field, draft.rects[field.id] ?? field.rect, value);
            if (!result.ok) found[field.id] = explainValueProblem(result.code, result.message);
          } catch {
            // The check is advisory; signing reports the problem if it is real.
          }
        }
        if (!cancelled) setProblems(found);
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resolved.fields, draft.values, draft.rects]);
  // Earlier turns' fields are settled; only this turn's problems block it.
  const problemNames = fields.filter((field) => problems[field.id] && editable(field)).map(fieldName);
  const canSign = progress.complete && problemNames.length === 0;
  const signerName = draft.signerName.trim();

  // ------------------------------------------------------------- moving between steps

  const showOnPage = (id: string) => {
    const field = fieldById(id);
    if (!field) return;
    setSelectedId(id);
    focusSeq.current += 1;
    setViewFocus({ rect: draft.rects[id] ?? field.rect, seq: focusSeq.current });
  };

  /** Make a step current, bring its field into view and open its input. */
  const goTo = (index: number) => {
    const target = steps[index];
    if (!target) return;
    setStepIndex(index);
    const id = target.kind === 'field' ? target.fieldId : target.kind === 'prefilled' ? target.fieldIds[0] : undefined;
    if (id) showOnPage(id);
    else setSelectedId(null);
    setOpened((count) => count + 1);
  };

  const advanceFrom = (index: number) => goTo(Math.min(index + 1, finishIndex));

  // The step a guided move landed on: open its input. A first signature opens
  // capture once. A field whose value only needs confirming keeps focus on
  // the floating button, so the next tap confirms it.
  useEffect(() => {
    if (opened === 0) return;
    if (step.kind !== 'field') {
      document.getElementById(`${ids}-step-title`)?.focus();
      return;
    }
    const field = fieldById(step.fieldId);
    if (!field) return;
    const action = stepAction(resolved, draft, step, pass);
    if (action === 'capture' && !autoCaptured.current.has(field.id)) {
      autoCaptured.current.add(field.id);
      setCapturing(field.id);
      return;
    }
    if (action !== 'next' || isSigningField(field)) return;
    const control = document.getElementById(`${ids}-control-${field.id}`);
    control?.focus({ preventScroll: true });
    control?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per guided move
  }, [opened]);

  // A new turn starts with a guided move to its first step.
  useEffect(() => {
    if (pass > resumed.length) goTo(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per new turn
  }, [pass]);

  // ------------------------------------------------------------- values

  // An edit is the human's own answer, so it also settles a suggested value.
  const setValue = (id: string, value: string | boolean) =>
    setDraft((previous) => ({
      ...previous,
      values: { ...previous.values, [id]: value },
      reviewed: { ...previous.reviewed, [id]: true },
    }));

  const keepValue = (id: string) =>
    setDraft((previous) => ({ ...previous, reviewed: { ...previous.reviewed, [id]: true } }));

  const storeSignature = (id: string, result: Pick<SignatureResult, 'png' | 'method'>) => {
    // A fresh copy of the bytes per field; the preview URL is for this session only.
    const png = result.png.slice();
    const previewUrl = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    previewUrls.current.add(previewUrl);
    const first = draft.signatures[id] === undefined;
    setDraft((previous) => ({
      ...previous,
      signatures: { ...previous.signatures, [id]: { png, method: result.method, previewUrl } },
    }));
    setCapturing(null);
    // In the guided walk, a new signature on the current step finishes that step.
    if (first && !showAll && step.kind === 'field' && step.fieldId === id) advanceFrom(stepIndex);
  };

  const removeSignature = (id: string) =>
    setDraft((previous) => {
      const { [id]: _removed, ...rest } = previous.signatures;
      return { ...previous, signatures: rest };
    });

  // ------------------------------------------------------------- the end of a turn

  /**
   * The one place a turn ends. The last signer signs and the PDF is written;
   * an earlier signer's input is kept and the device passes to the next one.
   */
  const endTurn = async () => {
    if (!canSign || busy) return;
    const input = buildHumanInput(resolved, draft, new Date(), pass);
    if (end.kind === 'handoff') {
      await downloadHandoff(input);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSigned(await core.finalizeDocument(job.document.bytes, resolved, multi ? [...completed, input] : input));
    } catch (failure) {
      const problem = toCoreProblem(failure);
      const field = resolved.fields.find((item) => item.id === problem.fieldId);
      setError(field ? { problem, field: fieldName(field) } : { problem });
      setBusy(false);
    }
  };

  /** The next signer signs on this device: keep this turn and pass the device. */
  const continueHere = (input: HumanInput = buildHumanInput(resolved, draft, new Date(), pass)) => {
    if (!canSign || busy) return;
    setCompleted((previous) => [...previous, input]);
    setSelectedId(null);
    setHandedOver(null);
    setHandoff(true);
  };

  /**
   * The default end of an earlier signer's turn: a PDF for the next signer to
   * open on their own device. It shows the signatures so far and carries the
   * original PDF and the finished turns. In a session, the local app is told.
   */
  const downloadHandoff = async (input: HumanInput) => {
    if (end.kind !== 'handoff') return;
    setBusy(true);
    setError(null);
    try {
      const result = await core.buildHandoffPdf(job.document.bytes, resolved, [...completed, input]);
      downloadFile(handoffName, result.pdf, 'application/pdf');
      const signerId = signers[pass]?.id;
      setHandedOver({ fileName: handoffName, pdf: result.pdf, input, next: end.next, sent: null, downloaded: true });
      setBusy(false);
      await tellHandedOff(signerId);
    } catch (failure) {
      setError({ problem: toCoreProblem(failure) });
      setBusy(false);
    }
  };

  /** In a session, the local app is told that this signer handed the document on. */
  const tellHandedOff = async (signerId: string | undefined) => {
    if (!job.sessionToken || signerId === undefined) return;
    const sent = await postHandedOff(job.sessionToken, signerId);
    setHandedOver((previous) => (previous ? { ...previous, sent } : previous));
  };

  // Email goes to one next signer only: the relay's v1 is two signers (docs/relay.md).
  const emailFits = end.kind === 'handoff' && signers.length === 2;
  // The email choice shows only when this server has the relay on (lib/useRelayAvailable.ts).
  const canEmail = useRelayAvailable(emailFits);
  /** The next signer's address, typed in the block of choices before "Email it". */
  const [nextEmail, setNextEmail] = useState('');
  const emailValid = Email.safeParse(nextEmail).success;

  /** The packet the email panel encrypts. The hand-off PDF is kept as the fallback download. */
  const buildEmailPacket = async (input: HumanInput): Promise<string> => {
    const result = await core.buildHandoffPdf(job.document.bytes, resolved, [...completed, input]);
    const packet = await core.encodePacket(result.packet);
    emailBuilt.current = { input, pdf: result.pdf, packet };
    return packet;
  };

  /** Keep the encrypted hand-off and its key on this device under its new relay id, before the upload. */
  const keepPrepared = async (prepared: PreparedHandoff): Promise<boolean> => {
    if (end.kind !== 'handoff') return false;
    const previous = kept.current;
    const now = Date.now();
    const signedName = signedFileName(displayText(job.document.name));
    const entry: SentHandoff = {
      id: prepared.id,
      blob: prepared.blob,
      document: plainLine(job.document.name),
      next: end.next,
      fileName: handoffName,
      signedName,
      createdAt: new Date(now).toISOString(),
      exp: expiryFrom(now, RELAY_TTL_DAYS),
      prev: [],
    };
    kept.current = entry;
    const stored = await keepNewHandoff(entry, { k: prepared.key, p: prepared.password, to: prepared.to, n: signedName }, deviceStorage());
    // An earlier id of this send that never went out (a new address or password).
    if (previous && !previous.sentAt && previous.id !== prepared.id) {
      removeRelayEntry(deviceStorage(), previous.id);
      await removeSentHandoff(previous.id);
    }
    return stored;
  };

  const emailSent = (input: HumanInput, sent: EmailSent) => {
    if (end.kind !== 'handoff') return;
    const built = emailBuilt.current;
    setEmailing(null);
    if (!built || built.input !== input) return;
    setHandedOver({
      fileName: handoffName,
      pdf: built.pdf,
      input,
      next: end.next,
      sent: null,
      emailed: { id: sent.id, to: sent.to, expiresAt: sent.expiresAt, stored: sent.stored },
      downloaded: false,
    });
    const entry = kept.current;
    if (entry && entry.id === sent.id) {
      kept.current = { ...entry, to: sent.to, exp: sent.expiresAt, sentAt: new Date().toISOString() };
      void keepSentHandoff(kept.current);
    }
    void tellHandedOff(signers[pass]?.id);
  };

  /** "Email it again" went out under a new id. The old link still works until it expires. */
  const emailedAgain = async (sent: EmailSent) => {
    setResending(false);
    setHandedOver((previous) =>
      previous ? { ...previous, emailed: { id: sent.id, to: sent.to, expiresAt: sent.expiresAt, stored: sent.stored } } : previous,
    );
    const old = kept.current;
    if (!old) return;
    const update = { id: sent.id, to: sent.to, exp: sent.expiresAt, blob: sent.blob };
    kept.current = (await replaceSentHandoff(old, update)) ?? resentEntry(old, update);
  };

  const startNextPass = () => {
    setDraft((previous) => draftForPass(resolved, previous, pass + 1));
    setPass(pass + 1);
    setStepIndex(0);
    setShowAll(false);
    setHandoff(false);
  };

  // ------------------------------------------------------------- the floating button

  const action = stepAction(resolved, draft, step, pass);
  const stepField = step.kind === 'field' ? fieldById(step.fieldId) : undefined;
  const saved = stepField ? savedSignatureFor(resolved, draft, stepField.id, pass) : undefined;

  // The floating button on a field or prefilled step. (On the last step it is the end-of-turn button.)
  const primary = () => {
    const now = Date.now();
    const tooSoon = now - lastPrimaryTap.current < APPLY_LOCKOUT_MS;
    lastPrimaryTap.current = now;
    if (stepField && action === 'apply' && saved) {
      if (tooSoon) return;
      storeSignature(stepField.id, saved);
      return;
    }
    if (stepField && action === 'capture') {
      setCapturing(stepField.id);
      return;
    }
    if (stepField && action === 'confirm') keepValue(stepField.id);
    advanceFrom(stepIndex);
  };

  const primaryLabel =
    action === 'apply' || action === 'capture'
      ? stepField?.type === 'initials'
        ? 'Initial here'
        : 'Sign here'
      : action === 'confirm' || step.kind === 'prefilled'
        ? 'Confirm'
        : stepIndex + 1 === finishIndex
          ? 'Finish'
          : 'Next';
  const position = fieldStepPosition(steps, stepIndex);
  const openIndex = firstOpenStep(steps, resolved, draft);
  const openStep = steps[openIndex];
  const openField = openStep?.kind === 'field' ? fieldById(openStep.fieldId) : undefined;

  // ------------------------------------------------------------- page overlay

  const capturingField = fields.find((field) => field.id === capturing);
  // Only this turn's own signatures are offered again: never another signer's.
  const reusable = capturingField ? savedSignatureFor(resolved, draft, capturingField.id, pass) : undefined;

  const toneOf = (field: ResolvedField): FieldTone => {
    if (!editable(field)) return 'other';
    if (awaitsConfirmation(field, draft)) return 'todo';
    if (hasValue(field, draft)) return valueOrigin(field, draft) === 'prefilled' ? 'prefilled' : 'done';
    return field.required ? 'todo' : 'neutral';
  };

  const canvasFields: CanvasField[] = fields.map((field) => {
    const canvasField: CanvasField = {
      id: field.id,
      type: field.type,
      name: fieldName(field),
      rect: draft.rects[field.id] ?? field.rect,
      tone: toneOf(field),
    };
    if (!editable(field)) {
      canvasField.locked = true;
      canvasField.lockedReason = `filled in the turn of ${signerLabel(signers, passOfField(field, signers))}`;
    } else {
      if (hasValue(field, draft)) canvasField.done = true;
      if (isSigningField(field) && !draft.signatures[field.id]) {
        canvasField.flag = field.type === 'initials' ? 'Initial here' : 'Sign here';
      }
    }
    return canvasField;
  });

  // A tap on a field makes its step current, so the floating button acts on the
  // field the signer chose. Nothing opens until the person asks.
  const selectField = (id: string | null) => {
    setSelectedId(id);
    if (id === null) return;
    const index = stepOfField(steps, id);
    if (index >= 0 && index !== stepIndex) setStepIndex(index);
    // A field the walk skips (a date that started filled) is edited from the full list.
    else if (index < 0 && fieldById(id) && editable(fieldById(id)!)) setShowAll(true);
  };

  // Enter or a double click on a field: make its step current and open its input.
  const activate = (id: string) => {
    const field = fieldById(id);
    if (!field || !editable(field)) return;
    selectField(id);
    if (isSigningField(field)) setCapturing(id);
    // Focus after the step's row has rendered (it may be hidden until then).
    else window.setTimeout(() => document.getElementById(`${ids}-control-${id}`)?.focus(), 0);
  };

  const renderContent = (canvasField: CanvasField) => {
    const signature = draft.signatures[canvasField.id];
    if (signature) return <img className="field-signature" src={signature.previewUrl} alt="" />;
    const value = draft.values[canvasField.id];
    if (canvasField.type === 'checkbox') return value === true ? '✓' : '';
    if (typeof value === 'string' && value !== '') return value;
    return canvasField.name;
  };

  // Top right of the app bar: the way between the hand-off screen and the document.
  const barControl =
    handedOver && barSlot
      ? createPortal(
          <button type="button" className="button quiet" data-testid="toggle-view" onClick={() => {
              setShowAll(true);
              setSelectedId(null);
              setViewing((open) => !open);
            }}>
            {viewing ? '← Back to sending' : '📄 View my fields'}
          </button>,
          barSlot,
        )
      : null;

  if (handedOver && !viewing) {
    const address = currentAppAddress();
    const { next, emailed } = handedOver;
    return (
      <main className="centered" id="main" data-view="sign">
        {barControl}
        <section className="card narrow handoff" data-testid="handoff-sent" aria-labelledby={`${ids}-sent`}>
          <TurnList signers={signers} pass={pass + 1} />
          {emailed ? (
            <>
              <h1 id={`${ids}-sent`} tabIndex={-1} ref={(heading) => heading?.focus()}>
                Sent to <span className={UNTRUSTED_TEXT_CLASS}>{next}</span>
              </h1>
              <dl className="sent-slip" data-testid="handoff-emailed-to">
                <div>
                  <dt>To</dt>
                  <dd>{emailed.to}</dd>
                </div>
                <div>
                  <dt>Link works until</dt>
                  <dd>{formatDateTime(emailed.expiresAt)}</dd>
                </div>
              </dl>
              {emailed.stored ? (
                <p className="hint">
                  When <span className={UNTRUSTED_TEXT_CLASS}>{next}</span> signs, you get an email. Open it on this
                  device to get the signed PDF.
                </p>
              ) : (
                <p className="notice warning" role="note" data-testid="handoff-not-stored">
                  This device could not keep the key to open the signed PDF. Ask{' '}
                  <span className={UNTRUSTED_TEXT_CLASS}>{next}</span> to send you the signed PDF.
                </p>
              )}
              <p className="hint" data-testid="handoff-not-arrived">
                Did it not arrive? Send it again or download the PDF.
              </p>
            </>
          ) : (
            <>
              <h1 id={`${ids}-sent`} tabIndex={-1} ref={(heading) => heading?.focus()}>
                Send this file to <span className={UNTRUSTED_TEXT_CLASS}>{next}</span>
              </h1>
              <CopyMessage
                label="Copy this message. Send it with the file attached."
                text={handoffMessage(next, address?.url ?? null, handedOver.fileName)}
              />
            </>
          )}
          {handedOver.downloaded && (
            <p className="notice warning" role="note" data-testid="handoff-warning">
              This file holds your signature. Send it only to <span className={UNTRUSTED_TEXT_CLASS}>{next}</span>.
            </p>
          )}
          {handedOver.sent && handedOver.sent.ok && (
            <p className="hint" role="status" data-testid="handoff-told">
              The requesting app was told that you handed the document on.
            </p>
          )}
          {handedOver.sent && !handedOver.sent.ok && handedOver.sent.status !== 404 && (
            <p className="hint" role="status" data-testid="handoff-not-told">
              The requesting app was not told: {handedOver.sent.error} The file is still yours to send.
            </p>
          )}
          <div className="sent-choices">
            {emailed && (
              <button type="button" className="button" data-testid="email-again" onClick={() => setResending(true)}>
                Email it again
              </button>
            )}
            <button
              type="button"
              className="button"
              data-testid="download-handoff-again"
              onClick={() => {
                downloadFile(handedOver.fileName, handedOver.pdf, 'application/pdf');
                setHandedOver((previous) => (previous ? { ...previous, downloaded: true } : previous));
              }}
            >
              {handedOver.downloaded ? 'Download again' : 'Download the hand-off PDF instead'}
            </button>
            {/* Once the local app has been told (or while it is being told), the session is settled:
                signing here would be refused, so the only way on is the file. */}
            {!(job.sessionToken && (handedOver.sent === null || handedOver.sent.ok)) && (
              <button
                type="button"
                className="button quiet"
                data-testid="continue-here"
                onClick={() => continueHere(handedOver.input)}
              >
                Continue on this device instead
              </button>
            )}
          </div>
        </section>
        {resending && emailed && (
          <EmailHandoff
            next={next}
            initialTo={emailed.to}
            buildPacket={() => {
              const packet = emailBuilt.current?.packet;
              return packet ? Promise.resolve(packet) : Promise.reject(new TypeError('No hand-off is kept.'));
            }}
            fileName={signedFileName(displayText(job.document.name))}
            onSent={(sent) => void emailedAgain(sent)}
            onDownloadInstead={() => {
              setResending(false);
              downloadFile(handedOver.fileName, handedOver.pdf, 'application/pdf');
              setHandedOver((previous) => (previous ? { ...previous, downloaded: true } : previous));
            }}
            onClose={() => setResending(false)}
          />
        )}
      </main>
    );
  }

  if (handoff) {
    const done = signerLabel(signers, pass);
    const next = signerLabel(signers, pass + 1);
    return (
      <main className="centered" id="main" data-view="sign">
        <section className="card narrow handoff" data-testid="handoff" aria-labelledby={`${ids}-handoff`}>
          <TurnList signers={signers} pass={pass + 1} />
          <h1 id={`${ids}-handoff`} tabIndex={-1} ref={(heading) => heading?.focus()}>
            <span className={UNTRUSTED_TEXT_CLASS}>{done}</span> is done
          </h1>
          <p>
            Hand this device to <strong className={UNTRUSTED_TEXT_CLASS}>{next}</strong>. They review the
            document, fill their own fields and sign. Nothing is signed until the last signer signs.
          </p>
          <button type="button" className="button primary" data-testid="handoff-continue" onClick={startNextPass}>
            Continue as {next}
          </button>
        </section>
      </main>
    );
  }

  // The one button that ends the turn. #41 can change what it does in endTurn().
  const endTurnButton = (placement?: 'guide-next', primary = true) => (
    <button
      type="button"
      className={`button${primary ? ' primary' : ''} sign-button${placement ? ` ${placement}` : ''}`}
      data-testid="sign-button"
      disabled={!canSign || busy}
      aria-describedby={`${ids}-why`}
      onClick={() => void endTurn()}
    >
      {end.kind === 'handoff' && <Icon name="download" />}
      {turnEndLabel(end, signerName, busy)}
    </button>
  );

  // The floating button at the end of a hand-off turn: it shows the choices, it does not pick one.
  const showChoices = () => {
    const block = document.getElementById(`${ids}-choices`);
    block?.scrollIntoView?.({ block: 'nearest' });
    block?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
  };

  const inStep = (field: ResolvedField) =>
    (step.kind === 'field' && step.fieldId === field.id) || (step.kind === 'prefilled' && step.fieldIds.includes(field.id));

  return (
    <main
      className="workspace sign-workspace"
      id="main"
      data-view="sign"
      data-pass={multi ? pass + 1 : undefined}
      data-expanded={showAll ? 'true' : undefined}
    >
      <PdfViewer
        pdf={job.document.bytes}
        label={`Document: ${displayText(job.document.name)}`}
        onPages={setPages}
        focus={viewFocus}
        renderOverlay={(page, scale) => (
          <FieldCanvas
            page={page}
            scale={scale}
            fields={canvasFields}
            selectedId={selectedId}
            onSelect={selectField}
            onChangeRect={(id, rect) =>
              setDraft((previous) => ({ ...previous, rects: { ...previous.rects, [id]: rect } }))
            }
            onActivate={activate}
            renderContent={renderContent}
            helpId={`${ids}-keys`}
          />
        )}
      />

      {barControl}
      <aside className="panel sign-panel" aria-label="Review and sign" data-viewing={viewing ? 'true' : undefined}>
        <FieldKeyboardHelp id={`${ids}-keys`} canDelete={false} />
        <h1 className="visually-hidden">Review and sign</h1>
        {viewing && (
          <p className="notice" data-testid="viewing-note">
            Your part is done and in the file. This view is read-only.
          </p>
        )}

        {/* One line of progress; the current field is the panel's main content. */}
        <div className="progress sheet-extra" data-complete={progress.complete ? 'true' : undefined}>
          <p role="status" aria-live="polite" data-testid="progress-text">
            {progressText(progress)}
          </p>
          <progress max={progress.total} value={progress.done} aria-label="Required items done" />
        </div>

        <section className="guide-step" aria-labelledby={`${ids}-step-title`} data-testid="guide-step" data-step={step.kind}>
          <div className="guide-head">
            <p className="guide-eyebrow" data-testid="guide-position">
              {multi && (
                <>
                  <span className={UNTRUSTED_TEXT_CLASS}>{signerLabel(signers, pass)}</span>:{' '}
                </>
              )}
              {position
                ? `${multi ? 'field' : 'Field'} ${position.number} of ${position.total}`
                : step.kind === 'prefilled'
                  ? `${multi ? 'before' : 'Before'} your fields`
                  : `${multi ? 'last' : 'Last'} step`}
            </p>
            <button
              type="button"
              className="link-button all-fields-toggle"
              aria-expanded={showAll}
              aria-controls={`${ids}-list`}
              data-testid="show-all-fields"
              onClick={() => setShowAll((open) => !open)}
            >
              {showAll ? 'Show less' : `All fields (${fields.length})`}
            </button>
          </div>
          <h2
            id={`${ids}-step-title`}
            // With every field shown the list marks the step; a title that changes would move the rows under the pointer.
            className={showAll ? 'guide-title visually-hidden' : 'guide-title'}
            tabIndex={-1}
            data-testid="guide-step-title"
          >
            {stepField ? (
              <>
                <span className={UNTRUSTED_TEXT_CLASS}>{fieldName(stepField)}</span>
                {hasValue(stepField, draft) && (
                  <span className="done-mark" data-testid="guide-step-done">
                    <CheckMark className="check-icon" />
                    <span className="visually-hidden">, done</span>
                  </span>
                )}
              </>
            ) : step.kind === 'prefilled' ? (
              'Check the prefilled values'
            ) : end.kind === 'handoff' ? (
              'Confirm your part'
            ) : (
              'Confirm and sign'
            )}
          </h2>
          {step.kind === 'prefilled' && !showAll && (
            <p className="hint">The preparer filled these values. Change any value that is wrong, then confirm.</p>
          )}
          {step.kind === 'finish' && openIndex >= 0 && (
            <button type="button" className="button" data-testid="go-to-open" onClick={() => goTo(openIndex)}>
              Go to what is left:&nbsp;
              <span className={UNTRUSTED_TEXT_CLASS}>{openField ? fieldName(openField) : 'the prefilled values'}</span>
            </button>
          )}
        </section>

        <section className="all-fields" aria-labelledby={`${ids}-fields`} data-expanded={showAll ? 'true' : undefined}>
          <h2 id={`${ids}-fields`} className={showAll ? undefined : 'visually-hidden'}>
            All fields
          </h2>
          {showAll && !viewing && (
            <p className="hint">
              If a field sits in the wrong place on the page, drag it, or focus it and use the arrow keys.
            </p>
          )}
          <ol className="review-list" id={`${ids}-list`} data-testid="review-list">
            {fields.map((field) =>
              !editable(field) ? (
                <LockedRow
                  key={field.id}
                  field={field}
                  draft={draft}
                  owner={signerLabel(signers, passOfField(field, signers))}
                  earlier={passOfField(field, signers) < settled}
                  selected={selectedId === field.id}
                  hidden={!showAll}
                  pageCount={pages.length}
                  onShow={() => showOnPage(field.id)}
                />
              ) : (
                <ReviewRow
                  key={field.id}
                  field={field}
                  draft={draft}
                  controlId={`${ids}-control-${field.id}`}
                  selected={selectedId === field.id}
                  current={inStep(field)}
                  guided={!showAll && inStep(field)}
                  hidden={!showAll && !inStep(field)}
                  pageCount={pages.length}
                  problem={problems[field.id]}
                  saved={savedSignatureFor(resolved, draft, field.id, pass)}
                  onValue={(value) => setValue(field.id, value)}
                  onKeep={() => keepValue(field.id)}
                  onCapture={() => setCapturing(field.id)}
                  onRemoveSignature={() => removeSignature(field.id)}
                  onShow={() => showOnPage(field.id)}
                  onFocusRow={() => selectField(field.id)}
                />
              ),
            )}
          </ol>
        </section>

        <section
          className="panel-section sign-off"
          aria-labelledby={`${ids}-signoff`}
          hidden={step.kind !== 'finish' && !showAll}
          data-testid="sign-off"
        >
          <h2 id={`${ids}-signoff`} className={step.kind === 'finish' ? 'visually-hidden' : undefined}>
            Sign
          </h2>
          <div className="form-item">
            <label htmlFor={`${ids}-name`}>
              Your full name <span className="required-mark">required</span>
            </label>
            <input
              id={`${ids}-name`}
              className="input"
              type="text"
              autoComplete="name"
              maxLength={200}
              required
              data-testid="signer-name"
              value={draft.signerName}
              onChange={(event) => setDraft((previous) => ({ ...previous, signerName: event.target.value }))}
            />
          </div>
          <label className="check-row consent">
            <input
              type="checkbox"
              required
              data-testid="consent"
              checked={draft.consent}
              onChange={(event) => setDraft((previous) => ({ ...previous, consent: event.target.checked }))}
            />
            <span data-testid="consent-text">{CONSENT_TEXT}</span>
          </label>

          {/* The end of an earlier signer's turn: one block of choices, the first one primary. */}
          {end.kind === 'handoff' && (
            <div className="turn-choices" id={`${ids}-choices`} role="group" aria-label={`Send to ${end.next}`} data-testid="turn-choices">
              {canEmail && (
                <form
                  className="turn-email"
                  noValidate
                  data-testid="turn-email"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!canSign || busy || !emailValid) return;
                    setError(null);
                    setEmailing(buildHumanInput(resolved, draft, new Date(), pass));
                  }}
                >
                  <div className="form-item">
                    <label htmlFor={`${ids}-next-email`}>
                      <span className={UNTRUSTED_TEXT_CLASS}>{end.next}</span>'s email
                    </label>
                    <input
                      id={`${ids}-next-email`}
                      className="input"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={254}
                      placeholder="name@example.com"
                      data-testid="next-email"
                      value={nextEmail}
                      onChange={(event) => setNextEmail(event.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="button primary"
                    data-testid="email-handoff"
                    disabled={!canSign || busy || !emailValid}
                    aria-describedby={`${ids}-why`}
                  >
                    <Icon name="email" />
                    Email it
                  </button>
                </form>
              )}
              {endTurnButton(undefined, !canEmail)}
              <button
                type="button"
                className="button quiet"
                data-testid="continue-here"
                disabled={!canSign || busy}
                aria-describedby={`${ids}-why`}
                onClick={() => continueHere()}
              >
                <Icon name="device" />
                Continue on this device
              </button>
            </div>
          )}

          {error && (
            <div className="form-error" role="alert" data-testid="sign-error">
              <p>
                {explainProblem(error.problem)}
                {error.field ? ` Field: ${error.field}.` : ''} ({error.problem.message})
              </p>
              <ErrorDetails failure={error.problem} file={fileFacts(job.document.name, job.document.bytes.length)} />
            </div>
          )}

          {/* With every field shown, the end-of-turn button sits at the end of the list. */}
          {showAll && end.kind === 'sign' && endTurnButton()}
          <p className="hint" id={`${ids}-why`} data-testid="sign-explanation">
            {!progress.complete
              ? `You can sign when these are done: ${progress.missing.join(', ')}.`
              : problemNames.length > 0
                ? `You can sign when these are fixed: ${problemNames.join(', ')}.`
                : end.kind === 'handoff'
                  ? 'Nothing is final until the last signer signs.'
                  : 'Signing writes the values and your signature into a new PDF on this device.'}
          </p>
        </section>

        {/* Everything else about the document, folded away. The notice for agents stays in the page text. */}
        <details className="sign-details sheet-extra" data-testid="sign-details">
          <summary>Details</summary>
          <div className="sign-details-body">
            <p className="agent-banner" data-testid="agent-banner">
              {AGENT_STOP_BANNER}
            </p>
            {multi && <TurnList signers={signers} pass={pass} />}
            <p className={`doc-name ${UNTRUSTED_TEXT_CLASS}`} data-testid="document-name">
              {displayText(job.document.name)}
            </p>
            <PreparerNote title={resolved.request.title} note={resolved.request.note} />
          </div>
        </details>

        <div className="button-row secondary sheet-extra">
          {onBackToPrepare && (
            <button type="button" className="button quiet" data-testid="back-to-prepare" onClick={onBackToPrepare}>
              Back to the fields
            </button>
          )}
        </div>

        <nav className="guide-bar" aria-label="Guided signing" data-testid="guide-bar">
          <button
            type="button"
            className="button guide-back"
            data-testid="guide-back"
            disabled={stepIndex === 0}
            onClick={() => goTo(stepIndex - 1)}
          >
            <span aria-hidden="true">←</span>
            <span className="visually-hidden">Previous step</span>
          </button>
          {/* At the finish step the button says it all: no position label. */}
          {step.kind !== 'finish' && (
            <p className="guide-count" data-testid="guide-count">
              {position ? `${position.number} of ${position.total}` : 'Check'}
            </p>
          )}
          {step.kind === 'finish' ? (
            showAll ? null : end.kind === 'handoff' ? (
              <button
                type="button"
                className="button primary guide-next"
                data-testid="guide-send"
                disabled={!canSign || busy}
                aria-describedby={`${ids}-why`}
                onClick={showChoices}
              >
                Send to {end.next}
              </button>
            ) : (
              endTurnButton('guide-next')
            )
          ) : (
            <button
              type="button"
              className="button primary guide-next"
              data-testid="guide-next"
              data-action={step.kind === 'prefilled' ? 'confirm' : action}
              onKeyDown={(event) => {
                // A held key repeats: it never walks on, and never signs, by itself.
                if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
              }}
              onClick={primary}
            >
              {primaryLabel}
            </button>
          )}
        </nav>
      </aside>

      {capturingField && isSigningField(capturingField) && (
        <SignatureDialog
          kind={capturingField.type}
          fieldName={fieldName(capturingField)}
          suggestedText={capturingField.type === 'initials' ? initialsOf(draft.signerName) : draft.signerName}
          {...(reusable
            ? {
                reusePreviewUrl: reusable.previewUrl,
                onReuse: () => storeSignature(capturingField.id, reusable),
              }
            : {})}
          onDone={(result) => storeSignature(capturingField.id, result)}
          onClose={() => setCapturing(null)}
        />
      )}

      {emailing && end.kind === 'handoff' && (
        <EmailHandoff
          next={end.next}
          address={nextEmail}
          buildPacket={() => buildEmailPacket(emailing)}
          fileName={signedFileName(displayText(job.document.name))}
          onPrepared={keepPrepared}
          onSent={(sent) => emailSent(emailing, sent)}
          onDownloadInstead={() => {
            const input = emailing;
            setEmailing(null);
            void downloadHandoff(input);
          }}
          onClose={() => setEmailing(null)}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

/** Where a field is, and a link that scrolls the page to it. */
function RowMeta(props: { page: number; pageCount: number; name: string; testId: string; onShow: () => void }) {
  return (
    <p className="review-meta">
      <span>
        Page {props.page}
        {props.pageCount > 0 ? ` of ${props.pageCount}` : ''}
      </span>
      <button type="button" className="link-button" data-testid={props.testId} aria-label={`Jump to ${props.name}`} onClick={props.onShow}>
        <span aria-hidden="true">📍</span> Jump to
      </button>
    </p>
  );
}

/**
 * Plain text to paste into an email or a message, with a Copy button. When the
 * Clipboard API is missing or refuses, the text is selected for the person to copy.
 */
function CopyMessage({ label, text }: { label: string; text: string }) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="handoff-copy">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        ref={field}
        className={`handoff-copy-text ${UNTRUSTED_TEXT_CLASS}`}
        readOnly
        // Lines wrap on a phone; where `field-sizing` is missing, a few spare rows avoid a scroll bar.
        rows={text.split('\n').length + 3}
        value={text}
        data-testid="handoff-copy-text"
        onFocus={(event) => event.currentTarget.select()}
      />
      <button
        type="button"
        className="button primary"
        data-testid="handoff-copy"
        onClick={() => void copyText(text, field.current).then((ok) => setCopied(ok))}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="visually-hidden" role="status">
        {copied ? 'The message is copied.' : ''}
      </span>
    </div>
  );
}

/** The signers in order, with the current turn marked. A real sequence, so it is numbered. */
function TurnList({ signers, pass }: { signers: readonly Signer[]; pass: number }) {
  return (
    <ol className="turns" aria-label="Signers, in turn" data-testid="signer-turns">
      {signers.map((signer, index) => {
        const state = index < pass ? 'done' : index === pass ? 'current' : 'next';
        return (
          <li key={signer.id} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className={UNTRUSTED_TEXT_CLASS}>{signerLabel(signers, index)}</span>
            <span className="turn-state">{state === 'done' ? 'done' : state === 'current' ? 'signing now' : 'waiting'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A field that belongs to another turn: shown, never editable here. */
function LockedRow(props: {
  field: ResolvedField;
  draft: SignDraft;
  owner: string;
  earlier: boolean;
  selected: boolean;
  hidden: boolean;
  pageCount: number;
  onShow: () => void;
}) {
  const { field, draft, owner, earlier, selected, hidden, pageCount, onShow } = props;
  const name = fieldName(field);
  const value = draft.values[field.id];
  const shown = isSigningField(field)
    ? draft.signatures[field.id]
      ? 'Signed'
      : 'Not signed'
    : field.type === 'checkbox'
      ? value === true
        ? 'Ticked'
        : 'Not ticked'
      : typeof value === 'string' && value !== ''
        ? displayText(value)
        : 'Empty';
  return (
    <li
      className="review-row"
      data-testid={`review-row-${field.id}`}
      data-locked="true"
      data-selected={selected ? 'true' : undefined}
      data-type={field.type}
      hidden={hidden}
    >
      <p className="review-label">
        <span className={UNTRUSTED_TEXT_CLASS}>{name}</span>{' '}
        <span className="badge" data-kind="other" data-testid={`owner-${field.id}`}>
          <span className={UNTRUSTED_TEXT_CLASS}>{owner}</span>
        </span>
      </p>
      {earlier ? (
        <p className={`locked-value ${UNTRUSTED_TEXT_CLASS}`} data-testid={`locked-value-${field.id}`}>
          {shown}
        </p>
      ) : (
        <p className="hint" data-testid={`locked-value-${field.id}`}>
          <span className={UNTRUSTED_TEXT_CLASS}>{owner}</span> fills this in their turn.
        </p>
      )}
      <RowMeta page={(draft.rects[field.id] ?? field.rect).page} pageCount={pageCount} name={name} testId={`show-${field.id}`} onShow={onShow} />
    </li>
  );
}

interface ReviewRowProps {
  field: ResolvedField;
  draft: SignDraft;
  controlId: string;
  selected: boolean;
  /** The row belongs to the current step. */
  current: boolean;
  /** The row is shown as the guided step: the floating button confirms a suggestion. */
  guided: boolean;
  hidden: boolean;
  pageCount: number;
  /** Why the current value cannot be drawn in the box, if it cannot. */
  problem: string | undefined;
  /** This signer's signature (or initials) from another field, offered here. */
  saved: CapturedSignature | undefined;
  onValue: (value: string | boolean) => void;
  /** The human keeps the value the request suggested. */
  onKeep: () => void;
  onCapture: () => void;
  onRemoveSignature: () => void;
  onShow: () => void;
  onFocusRow: () => void;
}

function ReviewRow({
  field,
  draft,
  controlId,
  selected,
  current,
  guided,
  hidden,
  pageCount,
  problem,
  saved,
  onValue,
  onKeep,
  onCapture,
  onRemoveSignature,
  onShow,
  onFocusRow,
}: ReviewRowProps) {
  const name = fieldName(field);
  const done = hasValue(field, draft);
  const origin = valueOrigin(field, draft);
  const pending = awaitsConfirmation(field, draft);
  const signature = draft.signatures[field.id];
  const value = draft.values[field.id];
  const noun = field.type === 'initials' ? 'initials' : 'signature';

  const badges = (
    <span className="badges">
      <span className="badge" data-kind={field.required ? 'required' : 'optional'}>
        {field.required ? 'required' : 'optional'}
      </span>
      {origin === 'prefilled' && (
        <span className="badge" data-kind="prefilled" data-testid={`prefilled-${field.id}`}>
          prefilled
        </span>
      )}
      {origin === 'prefilled' && field.assignee === 'human' && !pending && (
        <span className="badge" data-kind="done" data-testid={`kept-${field.id}`}>
          kept by you
        </span>
      )}
      {origin === 'changed' && (
        <span className="badge" data-kind="changed" data-testid={`changed-${field.id}`}>
          changed by you
        </span>
      )}
      {/* A value the request filled is left out of the count, so it is never marked done here:
          the row would say "done" while the progress line does not count it. */}
      {done && origin !== 'prefilled' && (
        <span className="badge" data-kind="done" data-testid={`done-${field.id}`}>
          <CheckMark className="check-icon" />
          done
        </span>
      )}
    </span>
  );

  return (
    <li
      className="review-row"
      data-testid={`review-row-${field.id}`}
      data-done={done ? 'true' : 'false'}
      data-pending={pending ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-current={current ? 'true' : undefined}
      data-type={field.type}
      hidden={hidden}
      onFocusCapture={onFocusRow}
    >
      {isSigningField(field) ? (
        <div className="review-signature" role="group" aria-label={`${name}, ${noun}`}>
          <p className="review-label">
            <span className={UNTRUSTED_TEXT_CLASS}>{name}</span> {badges}
          </p>
          {signature ? (
            <>
              <img
                className="signature-preview"
                src={signature.previewUrl}
                alt={`Your ${noun}, ${signature.method}`}
                data-testid={`signature-preview-${field.id}`}
              />
              <div className="button-row">
                <button type="button" id={controlId} className="button" data-testid={`capture-${field.id}`} onClick={onCapture}>
                  Replace {noun}
                </button>
                <button type="button" className="button quiet" data-testid={`remove-signature-${field.id}`} onClick={onRemoveSignature}>
                  Remove
                </button>
              </div>
            </>
          ) : saved ? (
            <>
              <img
                className="signature-preview saved"
                src={saved.previewUrl}
                alt={`Your saved ${noun}`}
                data-testid={`saved-signature-${field.id}`}
              />
              <p className="hint">
                {field.type === 'initials' ? 'Initial here' : 'Sign here'} puts your saved {noun} on this field.
              </p>
              <button type="button" id={controlId} className="button quiet" data-testid={`capture-${field.id}`} onClick={onCapture}>
                {field.type === 'initials' ? 'Draw different initials' : 'Draw a different one'}
              </button>
            </>
          ) : (
            <button type="button" id={controlId} className="button capture" data-testid={`capture-${field.id}`} onClick={onCapture}>
              {field.type === 'initials' ? 'Add your initials' : 'Add your signature'}
            </button>
          )}
        </div>
      ) : field.type === 'checkbox' ? (
        <div className="review-check">
          <label className="check-row">
            <input
              id={controlId}
              type="checkbox"
              data-testid={`value-${field.id}`}
              checked={value === true}
              onChange={(event) => onValue(event.target.checked)}
            />
            <span className={`review-label-text ${UNTRUSTED_TEXT_CLASS}`}>{name}</span>
          </label>
          {badges}
          {suggestsTick(field) && (
            <p className="hint suggestion" data-testid={`suggested-${field.id}`}>
              The preparer suggested ticking this. It is ticked only if you tick it.
            </p>
          )}
        </div>
      ) : (
        <div className="form-item">
          <label className="review-label" htmlFor={controlId}>
            <span className={UNTRUSTED_TEXT_CLASS}>{name}</span> {badges}
          </label>
          {field.type === 'text' && field.multiline ? (
            <textarea
              id={controlId}
              className="input"
              rows={3}
              maxLength={5000}
              required={field.required}
              data-testid={`value-${field.id}`}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => onValue(event.target.value)}
            />
          ) : (
            <input
              id={controlId}
              className="input"
              type={field.type === 'date' ? 'date' : 'text'}
              maxLength={field.type === 'text' ? 5000 : undefined}
              required={field.required}
              autoComplete="off"
              data-testid={`value-${field.id}`}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => onValue(event.target.value)}
            />
          )}
          {pending && (
            <div className="suggestion" data-testid={`suggested-${field.id}`}>
              {guided ? (
                <p className="hint">The preparer suggested this value. Confirm keeps it. You can also change it.</p>
              ) : (
                <>
                  <p className="hint">
                    The preparer suggested this value. It counts only when you keep it or change it.
                  </p>
                  <button type="button" className="button" data-testid={`keep-${field.id}`} onClick={onKeep}>
                    Keep this value
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {problem && (
        <p className="form-error" role="alert" data-testid={`value-problem-${field.id}`}>
          {problem}
        </p>
      )}
      <RowMeta page={(draft.rects[field.id] ?? field.rect).page} pageCount={pageCount} name={name} testId={`show-${field.id}`} onShow={onShow} />
    </li>
  );
}

// ---------------------------------------------------------------------------

