import { initialsOf, personTone } from './people';

/** Someone's face: their picture, or their initials on their own muted tone. */
export function Avatar({
  name,
  src,
  size = 16,
  className,
  tone,
  fontSize,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
  /** In place of their own tone: someone drawn pale, not yet reached. */
  tone?: string | null;
  /** The initials' size when the design sets it; otherwise in step with `size`. */
  fontSize?: number;
}) {
  return (
    <span
      className={`avatar${className ? ` ${className}` : ''}`}
      title={name}
      style={{
        width: size,
        height: size,
        background: src ? undefined : tone ?? personTone(name),
        fontSize: fontSize ?? Math.round(size * 0.44),
      }}
    >
      {src ? <img src={src} alt="" /> : initialsOf(name)}
    </span>
  );
}
