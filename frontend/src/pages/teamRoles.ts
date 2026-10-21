// Team members' words for the roles an admin gives, how the page groups
// people and invitations into its tabs, and what is waiting on each person.
import type { MemberWithRoles, OrganizationInvite, RoleKey, WorkbenchBill } from '../api';
import { daysPast, firstName } from '../kit/format';

/** The four roles this page gives: Admin is a tier, the rest are job roles. */
export type Choice = 'admin' | 'bill_clerk' | 'approver' | 'viewer';
export const CHOICES: Choice[] = ['admin', 'bill_clerk', 'approver', 'viewer'];

export const CHOICE_NAMES: Record<Choice, string> = {
  admin: 'Admin',
  bill_clerk: 'Bill clerk',
  approver: 'Approver',
  viewer: 'Viewer',
};

/** Under each name in the role menu and the invitation. */
export const CHOICE_SUMMARIES: Record<Choice, string> = {
  admin: 'Everything a bill clerk does, plus settling flags that need authority and managing team members and approval rules.',
  bill_clerk: 'Enters bills, checks them against the document, sets categories and sends them for approval.',
  approver: 'Approves or sends back the bills waiting on them.',
  viewer: 'Reads everything they can see and changes nothing.',
};

/** "As a bill clerk, Marcus can …" */
export const CHOICE_CAN: Record<Choice, string> = {
  admin: 'can do everything a bill clerk does, settle flags that need authority, and manage team members and approval rules',
  bill_clerk: 'can enter bills, check them against the document, set categories and send them for approval',
  approver: 'can approve or send back the bills waiting on them',
  viewer: 'can read everything they can see and change nothing',
};

/** "a bill clerk", "an admin". */
export function withArticle(roleName: string) {
  const name = roleName.toLowerCase();
  return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`;
}

const ROLE_ORDER: RoleKey[] = ['bill_clerk', 'approver', 'payer', 'viewer'];

/** The highest of someone's job roles, as the roster's label picks it. */
export function topRole(roles: RoleKey[]) {
  return ROLE_ORDER.find((r) => roles.includes(r)) ?? null;
}

/**
 * Which of the four someone is: Admin for both admin tiers, else their
 * highest job role, Viewer with none. A payer, from before payments were
 * frozen, is none of the four.
 */
export function choiceOf(member: Pick<MemberWithRoles, 'access' | 'roles'>): Choice | null {
  if (member.access === 'primary_admin' || member.access === 'admin') return 'admin';
  const top = topRole(member.roles);
  if (top === 'payer') return null;
  return top ?? 'viewer';
}

/** The role an invitation gives. */
export function inviteChoice(invite: OrganizationInvite): Choice | null {
  if (invite.role === 'admin') return 'admin';
  if (invite.jobRole === 'payer') return null;
  return invite.jobRole ?? 'viewer';
}

export type Tab = 'all' | 'admins' | 'bill_clerk' | 'approver' | 'viewer';
export const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'admins', label: 'Admins' },
  { key: 'bill_clerk', label: 'Bill clerks' },
  { key: 'approver', label: 'Approvers' },
  { key: 'viewer', label: 'Viewers' },
];

/** The tab a role is filed under; a payer is only under All. */
export function tabOf(choice: Choice | null): Tab | null {
  if (!choice) return null;
  return choice === 'admin' ? 'admins' : choice;
}

export type Waiting = { count: number; overdue: number; sharedWith: string[] };

/**
 * The bills waiting on each person's approval, by user: open at the step
 * they are on, overdue once the bill's due day has passed, and who else at
 * that step could act on them.
 */
export function waitingByUser(bills: WorkbenchBill[], now = new Date()) {
  const byUser = new Map<string, Waiting>();
  for (const bill of bills) {
    if (bill.bucket !== 'in_approval') continue;
    const late = bill.dueAt ? daysPast(bill.dueAt, now) > 0 : false;
    for (const person of bill.waitingOn) {
      if (!person.userId) continue;
      const entry = byUser.get(person.userId) ?? { count: 0, overdue: 0, sharedWith: [] };
      entry.count += 1;
      if (late) entry.overdue += 1;
      for (const other of bill.waitingOn) {
        const name = firstName(other.name);
        if (other.userId !== person.userId && !entry.sharedWith.includes(name)) entry.sharedWith.push(name);
      }
      byUser.set(person.userId, entry);
    }
  }
  return byUser;
}

/** "shared with Tom", "shared with Tom and Ines", "shared with Tom, Ines and 2 more". */
export function sharedLine(names: string[]) {
  if (names.length === 0) return null;
  if (names.length === 1) return `shared with ${names[0]}`;
  if (names.length === 2) return `shared with ${names[0]} and ${names[1]}`;
  return `shared with ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
