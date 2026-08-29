// Confirmation for the one irreversible act in the room.
//
// `requestUserInteraction()` is discussed in the WebMCP draft and named in our
// own dispatch — and it does not exist in the pinned packages. Zero occurrences
// in `webmcp-types@0.1.5`, zero in `@mcp-b/webmcp-polyfill@5.0.1`. That is the
// third feature in this build that is present in the spec conversation and
// absent at runtime (`exposedTo` and cross-document exposure being the others).
//
// So this does what the rest of the project does: attempt the strong path,
// fall back to one we control, and RECORD WHICH HAPPENED. The confirmation
// method travels with the act, because "a human confirmed this" means something
// different depending on what did the asking.
//
// The property that matters is not which dialog appeared. It is that the agent
// cannot ratify. It can only ask. The act that lands on the chain is the
// human's click, attributed to the human's seat through the UI door — a
// separate entry from the agent's request, which is attributed to the agent.

/** True if the browser offers the draft elicitation API. Checked at call time,
 *  never assumed: a browser shipping native WebMCP may have it when the
 *  polyfilled one does not. */
export function hasNativeElicitation() {
  const mc = globalThis.document?.modelContext;
  return typeof mc?.requestUserInteraction === 'function';
}

/** Ask the human. Resolves to what actually happened, including which mechanism
 *  did the asking, so the record can say so rather than implying a stronger
 *  ceremony than occurred. */
export async function confirmWithHuman({ title, detail }) {
  if (hasNativeElicitation()) {
    try {
      const result = await document.modelContext.requestUserInteraction({ title, detail });
      return {
        confirmed: Boolean(result?.confirmed ?? result),
        method: 'requestUserInteraction',
        note: 'the browser asked, out of the page\'s control',
      };
    } catch (err) {
      // Fall through to the in-page dialog rather than failing the act: a
      // confirmation that errors must not become an implicit "yes".
      return inPageConfirm({ title, detail, note: `native elicitation failed: ${err?.message ?? err}` });
    }
  }
  return inPageConfirm({
    title,
    detail,
    note: 'requestUserInteraction() is not available in this browser; the page asked instead',
  });
}

/** A real modal the host must actually click. Not `window.confirm` — that
 *  cannot be styled, cannot be screenshotted usefully, and in some embedded
 *  browsers is suppressed entirely, which would turn a missing dialog into a
 *  silent refusal nobody could see. */
// There is ONE dialog element, so there can be one confirmation at a time.
//
// Two overlapping `ratify_ruling` calls actually happened in the judge
// environment: the first blocked on the modal, the agent's harness timed it out,
// and it called again. Without this guard both would `showModal()` on the same
// element and both would attach listeners — so a single click could resolve two
// pending ratifications, and the room would record a decision the human made
// once as though they had made it twice.
//
// A second request is REFUSED rather than queued. Queueing an irreversible act
// behind a dialog the human has already answered is how one deliberate click
// becomes two acts; refusing is the answer that cannot surprise anyone, and the
// refusal lands on the chain like any other outcome.
let confirmationOpen = false;

function inPageConfirm({ title, detail, note }) {
  if (confirmationOpen) {
    return Promise.resolve({
      confirmed: false,
      method: 'refused',
      note: 'another confirmation is already open — a second request cannot be answered by the same click',
    });
  }
  confirmationOpen = true;
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirm-dialog');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-detail').textContent = detail;
    document.getElementById('confirm-note').textContent = note;

    const done = (confirmed) => {
      confirmationOpen = false;
      dialog.close();
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      dialog.removeEventListener('cancel', onCancel);
      resolve({ confirmed, method: 'in-page dialog', note });
    };

    const yes = document.getElementById('confirm-yes');
    const no = document.getElementById('confirm-no');
    const onYes = () => done(true);
    const onNo = () => done(false);
    // Dismissing with Escape is a refusal, never a default yes.
    const onCancel = () => done(false);

    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
  });
}
