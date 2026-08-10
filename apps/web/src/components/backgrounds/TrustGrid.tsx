import type { ReactNode } from "react";
import "./trust-grid.css";

export default function TrustGrid({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <div className={`pf-trust-grid ${className}`} aria-hidden={children ? undefined : true}>{children}</div>;
}
