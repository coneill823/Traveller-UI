/** Small shared building blocks: modal, tabs, fields, toasts, confirmations. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, useApp } from '../store';
import { Icon, type IconName } from './Icon';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  size,
}: {
  title: ReactNode;
  icon?: IconName;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'wide' | 'xwide';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // Move focus into the dialog so keyboard users start in the right place.
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button.primary');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', size)} role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          {icon && <Icon name={icon} size={18} style={{ color: 'var(--accent)' }} />}
          <h2 className="grow">{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('field', className)}>
      <label>{label}</label>
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; hidden?: boolean }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === value} className={cx('tab', t.id === value && 'on')} onClick={() => onChange(t.id)}>
            {t.label}
          </button>
        ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  gm,
}: {
  options: { id: T; label: ReactNode; title?: string }[];
  value: T | undefined;
  onChange: (id: T) => void;
  gm?: boolean;
}) {
  return (
    <div className={cx('segmented', gm && 'gm')}>
      {options.map((o) => (
        <button key={o.id} type="button" title={o.title} className={cx(o.id === value && 'on')} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)} onClick={() => dismissToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: IconName; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={30} />}
      <strong>{title}</strong>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

/** A button that asks "are you sure?" in place before doing something destructive. */
export function ConfirmButton({
  label,
  confirm = 'Confirm',
  onConfirm,
  className = 'btn danger sm',
  icon,
  title,
}: {
  label: ReactNode;
  confirm?: string;
  onConfirm: () => void;
  className?: string;
  icon?: IconName;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(timer);
  }, [armed]);
  if (armed) {
    return (
      <button
        className={cx(className, 'on')}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        <Icon name="warning" size={13} /> {confirm}
      </button>
    );
  }
  return (
    <button className={className} title={title} onClick={() => setArmed(true)}>
      {icon && <Icon name={icon} size={13} />} {label}
    </button>
  );
}

/**
 * Text that turns into an input when clicked (GM editing in place). Commits on Enter or blur,
 * cancels on Escape.
 */
export function EditableText({
  value,
  onCommit,
  placeholder,
  className,
  inputClassName,
  disabled,
  multiline,
}: {
  value: string | undefined;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);
  if (disabled) return <span className={className}>{value || <span className="faint">{placeholder}</span>}</span>;
  if (!editing) {
    return (
      <span className={cx(className, 'editable')} tabIndex={0} role="button" title="Click to edit" onClick={() => setEditing(true)} onKeyDown={(e) => e.key === 'Enter' && setEditing(true)}>
        {value || <span className="faint">{placeholder ?? 'Click to add'}</span>}
      </span>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== (value ?? '')) onCommit(draft.trim());
  };
  const common = {
    autoFocus: true,
    value: draft,
    placeholder,
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
  };
  if (multiline) {
    return (
      <textarea
        {...common}
        className={cx('textarea', inputClassName)}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
        }}
      />
    );
  }
  return (
    <input
      {...common}
      className={cx('input', inputClassName)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

export function GmOnly({ children }: { children: ReactNode }) {
  return (
    <span className="chip gm" title="Only the GM can see this">
      <Icon name="eyeOff" size={11} /> {children}
    </span>
  );
}
