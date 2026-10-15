# The sign view: guided signing

The sign view walks each signer through their own fields, one at a time, in document order (page, then top to bottom, then left to right).

## Steps of one turn

1. **Check the prefilled values.** The first signer sees every value the preparer filled, as one step. Each value can be changed.
2. **One step for each of the signer's fields**, required and optional. The step scrolls the page to the field, selects it, and opens its input. On a phone the page also zooms in on the field.
3. **Confirm and sign.** The signer types their name, accepts the confirmation, and signs. With several signers, an earlier signer ends with one block of choices after the confirmation checkbox, in this order: the input "<next signer>'s email" with "Email it" under it (only with two signers and a relay on the server; see [Email the next signer](#email-the-next-signer)), "Download PDF for <next signer>" (a [hand-off PDF](handoff-pdf.md) to send yourself; no server), and "Continue on this device". The choices are one stack of equal width and height, each with a leading icon (envelope, download arrow, phone). The first choice shown is the primary one. One sentence follows: "Nothing is final until the last signer signs."

## The floating button

One button drives the walk. It sits over the document on a wide screen and at the bottom of the screen on a phone.

| The step has | The button reads | One tap |
|---|---|---|
| The signer's first signature (or first initials) | Sign here (Initial here) | Opens signature capture. A guided move to this step opens capture once by itself. |
| A later signature or initials of the same signer | Sign here (Initial here) | Puts the saved signature or initials on the field and moves on. "Draw a different one" captures a new one. |
| A date filled with today, or a value the preparer suggested | Confirm | Keeps the value and moves on. |
| Anything else | Next, or Finish on the last field | Moves on. Next never blocks: a skipped field stays open, and the last step offers "Go to what is left". |
| The last step | Sign as <name> | Ends the turn. |
| The last step of an earlier signer | Send to <next signer> | Scrolls to the choices and focuses the first one (the email input when it shows). It picks none. |

At the last step the bar shows no position label next to the button.

A signature is never put on a field without the signer's tap. One signer's signature is never offered to another signer.

## Email the next signer

With exactly two signers, the first signer can email the document instead of downloading it. The choice shows only when the server has the relay: the page reads `GET /relay/config` when the turn opens, and any other answer (a 404, or the page a static host or the local app sends instead) hides it. The signer types the next signer's address in "<next signer>'s email" in the block of choices, so they see it before they send. "Email it" stays disabled until the address is a valid email. "Email it" opens a panel titled "Email it to <next signer>":

1. The panel shows the address ("To <address>") and asks for an optional passphrase of at least 8 characters. The hint says: "B needs this passphrase; tell them separately. At least 8 characters. It makes the document unreadable to anyone else, including this service. It also lets you collect the signed PDF on another device." A shorter passphrase says "The passphrase needs at least 8 characters. Leave it empty for none." and sends nothing.
2. Without a sign-in in this tab, the signer enters their own email address, passes the Turnstile check and enters the 6-digit code from the email. The sign-in lasts 24 hours in this tab.
3. The page encrypts the hand-off on the device, uploads it and asks the relay to email the link. Each step shows its own waiting text, and a failed step offers "Try again".

The next screen says "Sent to <next signer>" and shows the email address and "Link works until" with the date and time (7 days). It offers "Download the hand-off PDF instead". Over 40 MiB encrypted, the panel says "Too large to email. Download the PDF for <next signer> instead." The protocol and what the server can see: [relay](relay.md). The panel is `packages/web/src/components/EmailHandoff.tsx`.

### Send it again

The browser keeps an encrypted copy of each emailed hand-off, so the first signer can send it again when the email did not arrive, the send failed, the page was reloaded, or the link expired. The protocol side: [relay](relay.md#send-it-again).

- The sent screen says "Did it not arrive? Send it again or download the PDF." and offers **Email it again** and "Download the hand-off PDF instead".
- A failed send says "A copy stays on this device. You can email it again later from “Documents you sent” on the start page."
- When the browser keeps a copy, the start page shows the link **Documents you sent**. The page says: "This browser keeps an encrypted copy of each document you emailed, so you can send it again. The copy is removed 7 days after its link expires, or when you collect the signed PDF." Each document shows the next signer, the address, the date sent ("Not sent" after a failed send) and "Link works until" (or "Expired"). Each has three actions:
  - A copy sent with a password shows a password field: the copy opens only with it.
  - **Email it again** opens the same panel with the address filled in. The new email has a new link. The old link works until it expires.
  - **Download the PDF for <next signer>** builds the [hand-off PDF](handoff-pdf.md) again from the kept copy.
  - **Remove** deletes the copy in this browser.

The view is `packages/web/src/views/SentList.tsx`; the store is `packages/web/src/lib/sentStore.ts`.

### Open an emailed document

The link opens a card "Open the document" with one button, **Open**, and a password field when the first signer set a password. The page fetches nothing before the tap. On **Open** the page downloads the encrypted hand-off, decrypts it on the device and opens the sign view at the next signer's turn, the same as a [hand-off PDF](handoff-pdf.md). A wrong password or a changed file says "Could not open. Check the password."; the page keeps the download, so a second try does not fetch again. An expired or used link says "This link has expired or was already used." The card is `packages/web/src/views/RelayOpen.tsx`; the decrypt and the final upload are `packages/web/src/lib/relayOpen.ts`.

When the next signer signs, the page encrypts the signed PDF and uploads it for the first signer. The signed screen says "Sent back to <first signer>" and offers the usual download. The download never waits for the upload. A failed upload says why and offers "Try again"; a PDF over 40 MiB encrypted cannot be sent back, so the signer downloads it and sends it themselves.

### Collect the signed document

The relay emails the first signer a link and a 6-digit code. The link has no key: the device that sent the email kept it, with the signed file name, in `localStorage` (`packages/web/src/lib/relayStore.ts`).

- On that device, the link opens a card "Your signed document is ready" with a code field ("The code is in the email.") and **Download**. When the first signer set a password, the card asks for it too. The page fetches nothing before **Download**.
- On **Download** the page fetches the encrypted signed PDF with the code, decrypts it on the device and downloads it as `<document>-signed.pdf`. Then it deletes the copy on the server and the kept key, and says "Downloaded. The copy on the server is deleted." with **Download again** (from memory). If the delete fails, it says the server deletes the copy when it expires. The page cannot see whether the browser saved the file: keep the page open until the file is saved, because after a reload the key is gone.
- A wrong code says "Wrong code."; after five wrong codes the server deletes the document. An expired or deleted document says "The signed PDF is no longer on the server." A wrong password says "Could not open. Check the password."; the page keeps the download, so a second try uses no code attempt.
- On any other device, or after the key expired, the link opens the same card with a code field and a passphrase field ("The passphrase you set when you sent it."). A line above the form says: "If you set no passphrase, open this link on the device you sent from, or ask the other signer for the PDF." The page fetches nothing before **Download**. On **Download** the page fetches the signed PDF and the wrapped key with the code, unwraps the key on the device with the passphrase, decrypts, downloads it as `signed.pdf` and deletes the copy on the server. A wrong passphrase says "Wrong passphrase. Check it, then try again. This does not use a code attempt."; the page keeps the download. When the server has no wrapped key (no passphrase was set), the card "Open this link on the device you sent from" says to open the link there or ask the other signer for the PDF. How the key is wrapped: [collect on any device](relay.md#collect-on-any-device).

The download also removes the copy kept to [send it again](#send-it-again). The card is `packages/web/src/views/RelayCollect.tsx`; the fetch and decrypt are `packages/web/src/lib/relayCollect.ts`.

## Done marks

A field that has what it needs shows a green check on the page and in the list, and is read as "done" to assistive technology. A date filled with today counts as done; the Confirm tap records that the signer looked at it. In the list, a value the request filled shows "prefilled" and no "done" badge: the progress line leaves such values out of its count.

## The full list

"All fields" opens every field, the name and the confirmation at once. In this view the step does not change when the signer clicks a field, so nothing moves under the pointer.

## Where the code is

- Step order, button actions and the end of a turn: `packages/web/src/lib/signing.ts` (`guideSteps`, `stepAction`, `savedSignatureFor`, `turnEnd`).
- The view: `packages/web/src/views/Sign.tsx`. The end of a turn is in one function, `endTurn`, so a later change (#41) can make the hand-over a download.
- Zoom to a field and pinch zoom: `packages/web/src/components/PdfViewer.tsx`.
