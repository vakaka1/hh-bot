import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------- выбор модели

export default function ModelSelect({
  value,
  options,
  onChange,
  dropUp = false,
  wide = false,
  title,
}: {
  value: string;
  options: string[];
  onChange: (m: string) => void;
  dropUp?: boolean;
  wide?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const all = options.includes(value) || !value ? options : [value, ...options];

  return (
    <div className={"ms-root" + (wide ? " wide" : "")} ref={rootRef}>
      <button
        type="button"
        className={"ms-btn" + (open ? " open" : "")}
        onClick={() => setOpen((o) => !o)}
        title={title}
      >
        <span className="ms-label">{value || "Выберите модель"}</span>
        <svg className="ms-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className={"ms-menu" + (dropUp ? " up" : "")}>
          {all.map((m) => (
            <button
              type="button"
              key={m}
              className={"ms-item" + (m === value ? " selected" : "")}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
            >
              <span className="ms-item-label">{m}</span>
              {m === value && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
