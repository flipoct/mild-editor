import type { ReactNode } from "react";

/** The small modal every yes/no question and one-field prompt uses: a heading, a body, Cancel and the actions. */
export function ConfirmDialog({ id, eyebrow, title, cancel, onCancel, actions, children }: {
  id: string;
  eyebrow: ReactNode;
  title: ReactNode;
  cancel: string;
  onCancel: () => void;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return <div className="modal-backdrop close-confirm" role="presentation">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={id}>
      <span className="eyebrow">{eyebrow}</span>
      <h2 id={id}>{title}</h2>
      {children}
      <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={onCancel}>{cancel}</button>{actions}</footer>
    </section>
  </div>;
}
