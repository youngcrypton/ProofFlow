import { type CSSProperties, type MouseEvent, type ReactNode } from "react";
import "./spotlight-card.css";

type SpotlightCardProps = { children: ReactNode; className?: string; interactive?: boolean; onClick?: () => void; ariaLabel?: string };

export default function SpotlightCard({ children, className = "", interactive = false, onClick, ariaLabel }: SpotlightCardProps) {
  function move(event: MouseEvent<HTMLElement>) {
    if (!interactive || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--pf-spotlight-x", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--pf-spotlight-y", `${event.clientY - rect.top}px`);
  }
  const classNames = `pf-spotlight-card ${interactive ? "is-interactive" : ""} ${className}`;
  const style = { "--pf-spotlight-color": "var(--pf-spotlight-color)", "--pf-spotlight-opacity": "var(--pf-spotlight-opacity)" } as CSSProperties;
  if (interactive) return <button type="button" onMouseMove={move} onClick={onClick} aria-label={ariaLabel} className={classNames} style={style}>{children}</button>;
  return <div className={classNames} style={style}>{children}</div>;
}
