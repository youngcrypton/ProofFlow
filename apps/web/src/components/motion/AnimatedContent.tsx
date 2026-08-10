import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import "./animated-content.css";

type AnimatedContentProps = { children: ReactNode; className?: string; delay?: number };

export default function AnimatedContent({ children, className = "", delay = 0 }: AnimatedContentProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { node.classList.add("is-visible"); return; }
    requestAnimationFrame(() => node.classList.add("is-visible"));
  }, []);
  return <div ref={ref} className={`pf-animated-content ${className}`} style={{ "--pf-animation-delay": `${delay}ms` } as CSSProperties}>{children}</div>;
}
