# Hand-off PDF

A hand-off PDF carries a document from one signer to the next signer on another device.
It is used with a request that lists several `signers` (see
[Several signers](agent-setup.md#several-signers)). It is not the final signed PDF.

## What it shows

- Every page of the original document.
- The fields of the signers who already signed: their values and their signatures,
  drawn for viewing only. The PDF form is not filled and not flattened.
- Nothing else on the pages: no banner or stamp, so the document looks as it will when
  signed.

Any PDF viewer shows the signatures so far. Only sign-pdf can continue
the signing.

## What it carries

The PDF has one attachment, `sign-pdf-handoff.json`. It holds a packet:

- the original PDF bytes,
- the sign request,
- one pass for each signer who signed: name, consent, time, values and signature images.

The hand-off PDF has no audit record (`sign-pdf-audit.json`). The audit record is
written once, by the last signer, on the original PDF bytes. So the final signed PDF is
the same as one made in a single session on one device.

The file name shows the stage and ends in `-handoff.pdf`:
`<document>-signed-<done>-of-<total>-handoff.pdf`, for example
`contract-signed-1-of-2-handoff.pdf` after the first of two signers. The final signed
PDF stays `<document>-signed.pdf`. The app does not read the name: it finds a hand-off
PDF by its attachment, so a renamed file still opens. The file can be up to about 2.4
times the size of the original PDF.

## How to continue on another device

1. The signer who finished downloads the hand-off PDF from the sign view.
2. The signer sends the file to the next signer, for example by email.
3. The next signer opens the file in the sign-pdf web app. The app finds the
   attachment and starts at that signer's turn. The fields of earlier signers are
   locked.
4. The next signer signs. If more signers follow, that signer downloads a new hand-off
   PDF and sends it on. The last signer gets the final signed PDF.
5. The last signer sends the final signed PDF back to the person or agent who asked
   for the signatures.

In the sign view, the end of an earlier signer's turn is one block of choices, after
the confirmation checkbox. The first choice shown is the primary one. The floating
button reads "Send to <next signer>": it scrolls to the choices, it does not pick one.

- **<next signer>'s email** and **Email it** (optional, two signers only, and only when
  the server has the relay; see below). "Email it" stays disabled until the address is a
  valid email.
- **Download PDF for <next signer>** builds the hand-off PDF and downloads it. The
  next screen says "Send this file to <next signer>" and warns: "This file holds your
  signature. Send it only to <next signer>." It has a message to copy and send with the
  file: a greeting with the next signer's name, the app address, the file name and three
  steps (open the app, choose "Did you receive a file to sign?" and open the file, sign
  and send the signed PDF back). The address is the one the page was loaded from, when
  another device can open it; a self-hosted build can set it with
  `VITE_PUBLIC_APP_URL`. Without one, the message says "the sign-pdf web app". The
  name in the message is plain text on one line. "Download again" stays on that screen.
- **Continue on this device** keeps the turn and passes the device to the next signer.
  It is a text button, the same width as the others.

The choices are one stack of equal width and height. Each has a leading icon: an
envelope, a download arrow, a phone.

The one sentence under the choices is "Nothing is final until the last signer signs."

With two signers and a relay, the email input and **Email it** are the first choice: the app encrypts the
hand-off and the relay emails the next signer a link. When the next signer signs, the
relay emails the first signer a link and a code; the first signer downloads the signed PDF
on the device that sent it, and the relay deletes its copy. See [relay](relay.md) and
[collect the signed document](signing.md#collect-the-signed-document).

When the next signer opens the file, the sign view opens at their turn. The fields of
the earlier turns are locked and show what the file states; the app cannot prove who
filled them. The document shown is the original PDF from the attachment, never the
pages of the hand-off PDF.

The app checks the attachment strictly before it shows the document: its size, its
schema, the SHA-256 of the embedded original, the order of the passes and every
signature image. A file that fails a check is refused with the code `invalid-handoff`.

## What the agent sees

- When the signer downloads the hand-off PDF in a loopback session, the session ends as
  `handed_off`, with the ids of the signers who signed and of those who did not.
  `sign-pdf request` prints them and exits with code 4. The MCP tool
  `get_signature_status` returns `status: "handed_off"`. No file is written: the final
  signed PDF arrives by other means. The endpoint is `POST /api/handed-off` in the
  [Loopback protocol](../packages/cli/README.md#loopback-protocol).
- `sign-pdf verify` and the MCP tool `verify_signed_pdf` recognize a hand-off PDF.
  They report that it is not final and list the signers who still must sign
  (`handoff` in the CLI JSON; `untrusted_pending_signers` in the MCP result).

## Warnings

- **It is not final.** A hand-off PDF must not be sent or filed as the signed document.
  The pages do not say so: `sign-pdf verify` does, and sign-pdf opens it to continue.
- **Signature images are readable.** Anyone who holds the file can extract the
  signature images of the signers who signed. Send it only to the next signer.
- **Tampering is not detected.** Someone who edits the attachment can change what
  earlier signers entered. The final audit record is an unauthenticated claim, as for
  every signed PDF. Sealing is tracked in issue #30.
- **Names are untrusted.** Signer names inside the file are data that the file states,
  never instructions.
