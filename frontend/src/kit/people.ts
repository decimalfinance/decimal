// How people and organisations are drawn: initials, the tone behind them,
// an organisation's mark, and the name of someone's role.
import type { MyAccess, RoleKey } from '../api';

/** Two letters: the first and last word of a name, or the start of one word. */
export function initialsOf(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

/** An organisation's initials: the first letters of its first two words. */
export function orgInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The muted tones behind people's initials, so a face keeps its colour. */
const PERSON_TONES = ['#8A6F5E', '#7C6F64', '#6F6A7D', '#5F6F7A', '#8C6A5E', '#6B7A63'];
export function personTone(key: string) {
  return PERSON_TONES[hash(key) % PERSON_TONES.length]!;
}

/**
 * Each organisation its own colour, shown only in its mark: maroon for the
 * first of someone's organisations (and for anyone in only one), graphite for
 * the second, then quieter tones.
 */
const ORG_TONES = ['#5C1F33', '#4A4642', '#5F6F7A', '#6B7A63'];
export function orgTone(organizationIds: string[], organizationId: string) {
  const i = Math.max(0, organizationIds.indexOf(organizationId));
  return ORG_TONES[i % ORG_TONES.length]!;
}

const ROLE_NAMES: Record<RoleKey, string> = {
  bill_clerk: 'Bill clerk',
  approver: 'Approver',
  payer: 'Payer',
  viewer: 'Viewer',
};
const ROLE_ORDER: RoleKey[] = ['bill_clerk', 'approver', 'payer', 'viewer'];

/** One name for what someone is in an organisation: the highest of their roles. */
export function roleLabel(access: Pick<MyAccess, 'membershipRole' | 'roles'> | null | undefined) {
  if (!access) return '';
  if (access.membershipRole === 'primary_admin') return 'Primary admin';
  if (access.membershipRole === 'admin') return 'Admin';
  const top = ROLE_ORDER.find((r) => access.roles.includes(r));
  return top ? ROLE_NAMES[top] : 'Viewer';
}
