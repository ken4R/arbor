import { useState } from 'react';

export interface PromptState {
  title: string;
  message?: string;
  label?: string; // absent = simple confirmation
  optional?: boolean; // le champ peut rester vide
  initial?: string;
  confirm: string;
  danger?: boolean;
  checkbox?: { label: string; initial: boolean };
  onSubmit: (value: string, checked: boolean) => void;
}

export function PromptDialog({ prompt, onClose }: { prompt: PromptState; onClose: () => void }) {
  const [value, setValue] = useState(prompt.initial ?? '');
  const [checked, setChecked] = useState(prompt.checkbox?.initial ?? false);
  const invalid = prompt.label !== undefined && !prompt.optional && !value.trim();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    onClose();
    prompt.onSubmit(value.trim(), checked);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{prompt.title}</h2>
        {prompt.message && <p className="dialog-msg">{prompt.message}</p>}
        {prompt.label !== undefined && (
          <label className="field">
            <span>{prompt.label}</span>
            <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
          </label>
        )}
        {prompt.checkbox && (
          <label className="check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {prompt.checkbox.label}
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" autoFocus={prompt.label === undefined} className={`btn ${prompt.danger ? 'btn-danger' : 'btn-primary'}`} disabled={invalid}>
            {prompt.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
