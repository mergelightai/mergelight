// Types for the React Bits DitherVeil (JavaScript + CSS variant in DitherVeil.jsx),
// taken from its props table so TypeScript files can import it.
import type { CSSProperties, FC } from 'react';

export interface DitherVeilProps {
  src?: string;
  fit?: 'contain' | 'cover';
  pattern?: 'bayer' | 'noise' | 'atkinson' | 'floyd' | 'lines';
  palette?: 'duotone' | 'rgb';
  pixelSize?: number;
  levels?: number;
  inkColor?: string;
  paperColor?: string;
  contrast?: number;
  brightness?: number;
  revealRadius?: number;
  softness?: number;
  linger?: number;
  rimColor?: string;
  rim?: number;
  reverse?: boolean;
  wander?: boolean;
  clickBurst?: boolean;
  className?: string;
  style?: CSSProperties;
}

declare const DitherVeil: FC<DitherVeilProps>;
export default DitherVeil;
