/** The keyboard shortcut list for the Prepare view, in the shared dialog. */
import { Fragment } from 'react';
import { Dialog } from './Dialog.tsx';
import { PREPARE_SHORTCUTS } from '../lib/placementKeys.ts';

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      testId="shortcuts-dialog"
      footer={
        <button type="button" className="button primary" data-autofocus onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="hint">
        Letter and number keys work while the page or a field on it has focus. They do nothing while you type in a box.
      </p>
      <dl className="shortcut-list">
        {PREPARE_SHORTCUTS.map((row) => (
          <div className="shortcut-row" key={row.action}>
            <dt>
              {row.keys.map((chord) => (
                <span className="shortcut-chord" key={chord}>
                  {chord.split('+').map((key, index) => (
                    <Fragment key={key}>
                      {index > 0 && <span aria-hidden="true">+</span>}
                      <kbd>{key}</kbd>
                    </Fragment>
                  ))}
                </span>
              ))}
            </dt>
            <dd>{row.action}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
