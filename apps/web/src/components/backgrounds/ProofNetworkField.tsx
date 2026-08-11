import { useRef, useEffect, useCallback, useMemo } from 'react';
import type { CSSProperties, FC } from 'react';

import './ProofNetworkField.css';

interface Dot {
  cx: number;
  cy: number;
}

export interface ProofNetworkFieldProps {
  dotSize?: number;
  gap?: number;
  baseColor?: string;
  activeColor?: string;
  proximity?: number;
  className?: string;
  style?: CSSProperties;
}

function hexToRgb(hex: string) {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1] ?? '0', 16), g: parseInt(m[2] ?? '0', 16), b: parseInt(m[3] ?? '0', 16) };
}

const ProofNetworkField: FC<ProofNetworkFieldProps> = ({
  dotSize = 2,
  gap = 32,
  baseColor = '#5227FF',
  activeColor = '#5227FF',
  proximity = 150,
  className = '',
  style
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Dot[]>([]);
  const pointerRef = useRef({ x: 0, y: 0 });
  const dirtyRef = useRef(true);
  const baseRgb = useMemo(() => hexToRgb(baseColor), [baseColor]);
  const activeRgb = useMemo(() => hexToRgb(activeColor), [activeColor]);
  const lowPower = typeof window !== 'undefined' && (window.innerWidth < 768 || window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const buildGrid = useCallback(() => {
    const wrap = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const rect = wrap.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = dotSize + gap;
    const cols = Math.max(1, Math.floor((width + gap) / cell));
    const rows = Math.max(1, Math.floor((height + gap) / cell));
    const startX = (width - (cell * cols - gap)) / 2 + dotSize / 2;
    const startY = (height - (cell * rows - gap)) / 2 + dotSize / 2;
    dotsRef.current = Array.from({ length: cols * rows }, (_, index) => {
      const x = index % cols;
      const y = Math.floor(index / cols);
      return { cx: startX + x * cell, cy: startY + y * cell };
    });
    dirtyRef.current = true;
  }, [dotSize, gap, lowPower]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const { x: px, y: py } = pointerRef.current;
    const proximitySq = proximity * proximity;
    for (const dot of dotsRef.current) {
      const dx = dot.cx - px;
      const dy = dot.cy - py;
      const distanceSq = dx * dx + dy * dy;
      let color = baseColor;
      if (distanceSq <= proximitySq) {
        const amount = 1 - Math.sqrt(distanceSq) / proximity;
        const r = Math.round(baseRgb.r + (activeRgb.r - baseRgb.r) * amount);
        const g = Math.round(baseRgb.g + (activeRgb.g - baseRgb.g) * amount);
        const b = Math.round(baseRgb.b + (activeRgb.b - baseRgb.b) * amount);
        color = `rgb(${r},${g},${b})`;
      }
      ctx.fillStyle = color;
      ctx.fillRect(dot.cx - dotSize / 2, dot.cy - dotSize / 2, dotSize, dotSize);
    }
  }, [activeRgb, baseColor, baseRgb, dotSize, proximity]);

  useEffect(() => {
    buildGrid();
    const wrapper = wrapperRef.current;
    const observer = wrapper && 'ResizeObserver' in window ? new ResizeObserver(buildGrid) : null;
    if (observer && wrapper) observer.observe(wrapper);
    let rafId: number | null = null;
    let lastFrame = 0;
    const scheduleDraw = () => {
      if (document.hidden || rafId !== null) return;
      rafId = requestAnimationFrame((time) => {
        rafId = null;
        if (dirtyRef.current && time - lastFrame > 32) {
          draw();
          dirtyRef.current = false;
          lastFrame = time;
        }
      });
    };
    const onMove = (event: PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      dirtyRef.current = true;
      scheduleDraw();
    };
    const onLeave = () => {
      pointerRef.current = { x: -proximity * 2, y: -proximity * 2 };
      dirtyRef.current = true;
      scheduleDraw();
    };
    const onVisibility = () => {
      dirtyRef.current = true;
      scheduleDraw();
    };
    if (!lowPower) {
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerleave', onLeave, { passive: true });
    } else {
      onLeave();
    }
    document.addEventListener('visibilitychange', onVisibility);
    scheduleDraw();
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer?.disconnect();
      if (!lowPower) {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerleave', onLeave);
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [buildGrid, draw, proximity]);

  return <section className={`proof-network-field ${className}`} style={style} aria-hidden="true"><div ref={wrapperRef} className="proof-network-field__wrap"><canvas ref={canvasRef} className="proof-network-field__canvas" /></div></section>;
};

export default ProofNetworkField;
