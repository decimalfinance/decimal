/**
 * ConveyorHero.tsx — real 3D lifecycle (react-three-fiber).
 *
 * A single coin cycles through 5 stage boxes:
 *   INTAKE → POLICY → SIGN → SETTLE → PROOF
 * At each box it pauses and spins around the vertical (Y) axis, then
 * travels to the next box. After PROOF it exits and a new coin enters.
 *
 * Scene graph:
 *   <Lights />
 *   <Pad /> x 5   — transparent glass boxes with edge outlines + labels
 *   <Coin />      — USDC cylinder driven imperatively by <Scene>
 *
 * The dark platform (`<Slab />`) is kept in the file but not rendered,
 * so we can turn it back on later without rewriting geometry.
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { Edges, Text } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import * as THREE from 'three';

type Stage = { label: string };

type Props = {
  accent?: string;
  motion?: 'on' | 'off';
  stages?: Stage[];
  className?: string;
  style?: CSSProperties;
};

const DEFAULT_STAGES: Stage[] = [
  { label: 'INTAKE' },
  { label: 'POLICY' },
  { label: 'SIGN' },
  { label: 'SETTLE' },
  { label: 'PROOF' },
];

const PAD = { w: 0.8, h: 0.5, d: 0.8, spacing: 1.45 };
const COIN = { r: 0.22, h: 0.08, y: 0.25 };

// Lifecycle timing (seconds)
const T_ENTRY = 0.9;
const T_PAUSE = 1.2;
const T_TRAVEL = 0.6;
const T_EXIT = 0.9;

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function resolveAccentFrom(el: HTMLElement | null, raw?: string): string {
  if (raw && !raw.startsWith('var')) return raw;
  if (!el) return '#ffa600';
  const v = getComputedStyle(el).getPropertyValue('--ax-accent').trim();
  return v || '#ffa600';
}

type ThemeTokens = { accent: string; isDark: boolean };

function useThemeTokens(rootRef: RefObject<HTMLDivElement | null>, accentProp?: string): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>({ accent: '#ffa600', isDark: false });

  useEffect(() => {
    const read = () => {
      const accent = resolveAccentFrom(rootRef.current, accentProp);
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      setTokens({ accent, isDark });
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [accentProp, rootRef]);

  return tokens;
}

function Floor({
  x0,
  x1,
  accent,
  isDark,
}: {
  x0: number;
  x1: number;
  accent: string;
  isDark: boolean;
}) {
  const length = x1 - x0;
  const cx = (x0 + x1) / 2;
  const color = isDark ? accent : '#1a0a00';
  return (
    <mesh position={[cx, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[length, PAD.d]} />
      <meshStandardMaterial
        color={color}
        emissive={isDark ? accent : '#000000'}
        emissiveIntensity={isDark ? 0.1 : 0}
        roughness={0.7}
        metalness={0.05}
        side={THREE.DoubleSide}
        transparent
        opacity={isDark ? 0.25 : 0.6}
      />
    </mesh>
  );
}

function Lights({ accent }: { accent: string }) {
  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight position={[-4, 6, 4]} intensity={1.0} />
      <directionalLight position={[5, 3, -3]} intensity={0.35} color={accent} />
    </>
  );
}

type PadProps = {
  x: number;
  num: string;
  label: string;
  active: boolean;
  done: boolean;
  accent: string;
  isDark: boolean;
};
function Pad({ x, num, label, active, done, accent, isDark }: PadProps) {
  // Dark mode: yellow glow that brightens as state advances.
  // Light mode: stays dark; done pads get MORE opaque / blacker, not yellower.
  const emissiveIntensity = isDark
    ? active ? 0.35 : done ? 0.12 : 0.04
    : active ? 0.12 : 0; // light mode: only active has a faint warm glow
  const solidEdgeOpacity = active ? 1 : done ? 0.85 : 0.5;
  const openEdgeOpacity = solidEdgeOpacity * 0.2;
  const faceColor = isDark ? accent : done ? '#000000' : '#1a0a00';
  const faceEmissive = isDark ? accent : active ? accent : '#000000';
  const edgeColor = isDark ? accent : active ? accent : '#0a0a0a';
  const numColor = isDark ? accent : done ? '#ffffff' : '#0a0a0a';
  const labelColor = isDark ? (active || done ? accent : '#888888') : '#0a0a0a';
  const labelOpacity = active ? 1 : done ? 0.85 : 0.85;
  const wallOpacity = isDark ? 0.55 : done ? 0.95 : active ? 0.8 : 0.6;

  return (
    <group position={[x, 0, 0]}>
      {/* Solid bottom face (-Y) */}
      <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[PAD.w, PAD.d]} />
        <meshStandardMaterial
          color={faceColor}
          emissive={faceEmissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.7}
          metalness={0.05}
          side={THREE.DoubleSide}
          transparent
          opacity={wallOpacity}
          depthWrite={true}
        />
        <Edges color={edgeColor} lineWidth={1.5} transparent opacity={solidEdgeOpacity} />
      </mesh>
      {/* Solid back face (-Z) */}
      <mesh position={[0, PAD.h / 2, -PAD.d / 2 + 0.001]}>
        <planeGeometry args={[PAD.w, PAD.h]} />
        <meshStandardMaterial
          color={faceColor}
          emissive={faceEmissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.7}
          metalness={0.05}
          side={THREE.DoubleSide}
          transparent
          opacity={wallOpacity}
        />
        <Edges color={edgeColor} lineWidth={1.5} transparent opacity={solidEdgeOpacity} />
      </mesh>
      {/* Solid far side (+X, facing the next cube) */}
      <mesh
        position={[PAD.w / 2 - 0.001, PAD.h / 2, 0]}
        rotation={[0, -Math.PI / 2, 0]}
      >
        <planeGeometry args={[PAD.d, PAD.h]} />
        <meshStandardMaterial
          color={faceColor}
          emissive={faceEmissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.7}
          metalness={0.05}
          side={THREE.DoubleSide}
          transparent
          opacity={wallOpacity}
        />
        <Edges color={edgeColor} lineWidth={1.5} transparent opacity={solidEdgeOpacity} />
      </mesh>
      {/* Low-opacity outline of the full box — only the open-face-only edges
          come through, since solid-face edges are over-drawn above. */}
      <mesh position={[0, PAD.h / 2, 0]}>
        <boxGeometry args={[PAD.w, PAD.h, PAD.d]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        <Edges color={edgeColor} lineWidth={1.5} transparent opacity={openEdgeOpacity} />
      </mesh>
      <Text
        position={[0, PAD.h + 0.001, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.16}
        color={numColor}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.08}
      >
        {num}
      </Text>
      <Text
        position={[0, 0.002, PAD.d / 2 + 0.3]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.1}
        color={labelColor}
        fillOpacity={labelOpacity}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.18}
      >
        {label}
      </Text>
    </group>
  );
}

type CoinHandles = {
  group: RefObject<THREE.Group | null>;
  spin: RefObject<THREE.Group | null>;
  material: RefObject<THREE.MeshStandardMaterial | null>;
};
function Coin({ handles, accent }: { handles: CoinHandles; accent: string }) {
  return (
    <group ref={handles.group} position={[0, COIN.y, 0]}>
      <group ref={handles.spin}>
        {/* Stand the cylinder on its edge: axis along world Z. */}
        <group rotation={[Math.PI / 2, 0, 0]}>
          <mesh>
            <cylinderGeometry args={[COIN.r, COIN.r, COIN.h, 48]} />
            <meshStandardMaterial
              ref={handles.material}
              color={accent}
              emissive={accent}
              emissiveIntensity={0.45}
              roughness={0.25}
              metalness={0.7}
              transparent
              opacity={0}
            />
          </mesh>
        </group>
      </group>
    </group>
  );
}

type Segment = {
  type: 'travel' | 'pause';
  x0: number;
  x1: number;
  dur: number;
  padIdx: number; // which pad is "active" during this segment (-1 = none)
};

function buildSegments(
  padPositions: number[],
  leftEdge: number,
  rightEdge: number
): { segs: Segment[]; total: number } {
  const n = padPositions.length;
  const segs: Segment[] = [];
  segs.push({ type: 'travel', x0: leftEdge, x1: padPositions[0], dur: T_ENTRY, padIdx: -1 });
  for (let i = 0; i < n; i++) {
    segs.push({ type: 'pause', x0: padPositions[i], x1: padPositions[i], dur: T_PAUSE, padIdx: i });
    if (i < n - 1) {
      segs.push({ type: 'travel', x0: padPositions[i], x1: padPositions[i + 1], dur: T_TRAVEL, padIdx: -1 });
    }
  }
  segs.push({ type: 'travel', x0: padPositions[n - 1], x1: rightEdge, dur: T_EXIT, padIdx: -1 });
  const total = segs.reduce((a, s) => a + s.dur, 0);
  return { segs, total };
}

function Scene({
  accent,
  isDark,
  stages,
  motion,
}: {
  accent: string;
  isDark: boolean;
  stages: Stage[];
  motion: 'on' | 'off';
}) {
  const n = stages.length;
  const padPositions = useMemo(
    () => stages.map((_, i) => (i - (n - 1) / 2) * PAD.spacing),
    [stages, n]
  );
  const edges = useMemo(
    () => ({
      left: padPositions[0] - PAD.spacing * 1.4,
      right: padPositions[n - 1] + PAD.spacing * 1.4,
    }),
    [padPositions, n]
  );
  const { segs, total } = useMemo(
    () => buildSegments(padPositions, edges.left, edges.right),
    [padPositions, edges]
  );

  const coin: CoinHandles = {
    group: useRef<THREE.Group | null>(null),
    spin: useRef<THREE.Group | null>(null),
    material: useRef<THREE.MeshStandardMaterial | null>(null),
  };

  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [doneCount, setDoneCount] = useState<number>(0);
  const activeRef = useRef(-1);
  const doneRef = useRef(0);

  useFrame((state, dt) => {
    if (motion === 'off') return;
    const t = state.clock.elapsedTime % total;

    let acc = 0;
    let x = 0;
    let inPause = false;
    let currPad = -1;
    let doneAtT = 0;
    let segProgress = 0;
    let currSegType: Segment['type'] = 'travel';

    for (const s of segs) {
      const end = acc + s.dur;
      if (t < end) {
        const local = (t - acc) / s.dur;
        x = s.x0 + (s.x1 - s.x0) * local;
        inPause = s.type === 'pause';
        currPad = s.padIdx;
        segProgress = local;
        currSegType = s.type;
        break;
      }
      if (s.type === 'pause') doneAtT++;
      acc = end;
    }

    // Opacity: fade in during entry, fade out during exit, else 1
    let opacity = 1;
    if (doneAtT === 0 && currSegType === 'travel') {
      opacity = Math.min(1, segProgress / 0.7); // fade in across entry
    } else if (doneAtT === n && currSegType === 'travel') {
      opacity = Math.max(0, 1 - segProgress / 0.7); // fade out across exit
    }

    if (coin.group.current) coin.group.current.position.x = x;
    if (coin.spin.current) {
      // Exactly one full rotation per pause (eased). No rotation during travel
      // so the coin always re-enters the next box in the same orientation.
      coin.spin.current.rotation.y = inPause
        ? Math.PI * 2 * easeInOutCubic(segProgress)
        : 0;
    }
    if (coin.material.current) coin.material.current.opacity = opacity;

    const nextActive = inPause ? currPad : -1;
    if (nextActive !== activeRef.current) {
      activeRef.current = nextActive;
      setActiveIdx(nextActive);
    }
    if (doneAtT !== doneRef.current) {
      doneRef.current = doneAtT;
      setDoneCount(doneAtT);
    }
  });

  return (
    <>
      <Lights accent={accent} />
      {padPositions.slice(0, -1).map((px, i) => (
        <Floor
          key={`b-${i}`}
          x0={px + PAD.w / 2}
          x1={padPositions[i + 1] - PAD.w / 2}
          accent={accent}
          isDark={isDark}
        />
      ))}
      {stages.map((s, i) => (
        <Pad
          key={i}
          x={padPositions[i]}
          num={String(i + 1).padStart(2, '0')}
          label={s.label}
          active={i === activeIdx}
          done={i < doneCount}
          accent={accent}
          isDark={isDark}
        />
      ))}
      <Coin handles={coin} accent={accent} />
    </>
  );
}

export function ConveyorHero({
  accent: accentProp,
  motion = 'on',
  stages = DEFAULT_STAGES,
  className = '',
  style,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { accent, isDark } = useThemeTokens(rootRef, accentProp);

  return (
    <div
      ref={rootRef}
      className={`conveyor-hero ${className}`.trim()}
      style={{ width: '100%', height: '100%', minHeight: 480, ...style }}
    >
      <Canvas
        camera={{ position: [-7.5, 6.0, 8.0], fov: 28 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <Scene accent={accent} isDark={isDark} stages={stages} motion={motion} />
      </Canvas>
    </div>
  );
}
