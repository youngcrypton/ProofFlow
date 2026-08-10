import { useEffect, useRef, type ReactNode } from "react";
import "./blur-text.css";

type BlurTextProps = { children: ReactNode; className?: string };

export default function BlurText({ children, className = "" }: BlurTextProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { node.classList.add("is-visible"); return; }
    requestAnimationFrame(() => node.classList.add("is-visible"));
  }, []);
  return <span ref={ref} className={`pf-blur-text ${className}`}>{children}</span>;
}
