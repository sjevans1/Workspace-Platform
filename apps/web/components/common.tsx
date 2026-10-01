"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const previous =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      focusable = () =>
        panel.current
          ? Array.from(
              panel.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
              ),
            ).filter(
              (element) =>
                element.getAttribute("aria-hidden") !== "true" &&
                element.offsetParent !== null,
            )
          : [],
      initial = focusable()[0] || panel.current;
    initial?.focus();

    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;

      const items = focusable();
      if (!items.length) {
        e.preventDefault();
        panel.current.focus();
        return;
      }

      const active =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
        first = items[0],
        last = items[items.length - 1];

      if (!active || !panel.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", fn);
    return () => {
      document.removeEventListener("keydown", fn);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <section
        ref={panel}
        tabIndex={-1}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span>✧</span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
export function Spinner() {
  return (
    <div className="loading" role="status">
      Loading your workspace…
    </div>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
