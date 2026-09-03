import { useId, type InputHTMLAttributes } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
};

export function Field({ label, hint, ...input }: Props) {
  const id = useId();
  return (
    <label htmlFor={id} className="block">
      <span className="mono-label block">{label}</span>
      <input id={id} className="input mt-1.5" {...input} />
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}
