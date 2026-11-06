import { motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

const MAX = 900;
const y = (v: number) => 222 - (v / MAX) * 176;

const typical = [
  { v: 40, label: '1 file' },
  { v: 170, label: '4 files' },
  { v: 430, label: '9 files' },
  { v: 900, label: '20 files' },
];
const ours = [
  { v: 40, label: '' },
  { v: 52, label: 'Merged' },
];

function path(points: { v: number }[], X: number[]) {
  return points
    .map((p, i) => {
      const px = X[i], py = y(p.v);
      if (i === 0) return `M${px} ${py}`;
      const prevX = X[i - 1], prevY = y(points[i - 1].v);
      const cx = (prevX + px) / 2;
      return `C${cx} ${prevY} ${cx} ${py} ${px} ${py}`;
    })
    .join(' ');
}

export default function LoopChart() {
  const [W, setW] = useState(560);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setW(mq.matches ? 400 : 560);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const X = [0, 1, 2, 3].map((i) => 76 + (i * (W - 146)) / 3);
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const reduce = useReducedMotion();
  const show = inView || !!reduce;
  const t = (delay: number, duration = 1.4) => (reduce ? { duration: 0 } : { delay, duration, ease: [0.65, 0, 0.35, 1] as const });

  return (
    <svg ref={ref} viewBox={`0 0 ${W} 284`} className="w-full" role="img" aria-label="Lines changed per review round. A typical AI review grows a 40 line change to 900 lines over four rounds. Mergelight merges after round two at 52 lines.">
      <defs>
        <linearGradient id="lc-typical" x1="0" x2="1">
          <stop offset="0" stopColor="#9b98b0" />
          <stop offset="1" stopColor="#ff6b7a" />
        </linearGradient>
        <linearGradient id="lc-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ff6b7a" stopOpacity="0.18" />
          <stop offset="1" stopColor="#ff6b7a" stopOpacity="0" />
        </linearGradient>
      </defs>

      {[0, 300, 600, 900].map((v) => (
        <g key={v}>
          <line x1="46" x2={W - 20} y1={y(v)} y2={y(v)} stroke="rgb(255 255 255 / 0.06)" />
          <text x="38" y={y(v) + 4} textAnchor="end" className="fill-faint font-mono text-[12px]">{v}</text>
        </g>
      ))}
      {X.map((x, i) => (
        <text key={x} x={x} y="272" textAnchor="middle" className="fill-faint text-[14px]">Round {i + 1}</text>
      ))}

      <motion.path
        d={`${path(typical, X)} L${X[3]} 222 L${X[0]} 222 Z`}
        fill="url(#lc-fill)"
        initial={{ opacity: 0 }}
        animate={{ opacity: show ? 1 : 0 }}
        transition={t(1.2, 0.8)}
      />
      <motion.path
        d={path(typical, X)}
        fill="none"
        stroke="url(#lc-typical)"
        strokeWidth="2.5"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: show ? 1 : 0 }}
        transition={t(0.2, 1.8)}
      />
      {typical.map((p, i) => (
        <motion.g key={i} initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: show ? 1 : 0, scale: show ? 1 : 0.5 }} transition={t(0.2 + i * 0.5, 0.35)} style={{ transformOrigin: `${X[i]}px ${y(p.v)}px` }}>
          <circle cx={X[i]} cy={y(p.v)} r="4" fill="#0d0b18" stroke={i === 3 ? '#ff6b7a' : '#9b98b0'} strokeWidth="2" />
          <text x={X[i] + (i === 3 ? -10 : 0)} y={y(p.v) - 12} textAnchor={i === 3 ? 'end' : 'middle'} className={`text-[14px] ${i === 3 ? 'fill-bug font-medium' : 'fill-muted'}`}>
            {i === 3 ? '900 lines, 20 files' : p.label}
          </text>
        </motion.g>
      ))}

      <motion.path
        d={path(ours, X)}
        fill="none"
        stroke="#3fe8b8"
        strokeWidth="3"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: show ? 1 : 0 }}
        transition={t(0.2, 0.9)}
      />
      <motion.g initial={{ opacity: 0, y: 6 }} animate={{ opacity: show ? 1 : 0, y: show ? 0 : 6 }} transition={t(1.0, 0.4)}>
        <circle cx={X[1]} cy={y(52)} r="6" fill="#3fe8b8" />
        <rect x={X[1] + 20} y={y(52) - 15} width="156" height="30" rx="15" fill="#1d1b23" stroke="rgb(63 232 184 / 0.35)" />
        <text x={X[1] + 98} y={y(52) + 5} textAnchor="middle" className="fill-mint text-[14px] font-medium">Merged at 52 lines</text>
      </motion.g>
    </svg>
  );
}
