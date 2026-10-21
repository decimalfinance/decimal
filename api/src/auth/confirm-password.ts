// The organisation's policies change only behind the changer's password. One
// check for every one of them, so turning a protection off, turning it back on
// and moving the bill ceiling can't drift apart.
import { ApiError, badRequest } from '../infra/api-errors.js';
import { prisma } from '../infra/prisma.js';
import { verifyPassword } from './passwords.js';

/**
 * Checks the person's password before a policy changes, and says how they
 * confirmed who they are, for the record. An account with no password (one
 * made with Google) has nothing to check, so its session stands in.
 *
 * A wrong password is a 403, never a 401: a 401 signs the person out.
 */
export async function confirmPassword(userId: string, password: string | undefined): Promise<'password' | 'session'> {
  const user = await prisma.user.findUnique({ where: { userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) return 'session';
  if (!password) throw badRequest('Enter your password.');
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new ApiError(403, 'wrong_password', 'That password isn’t right.');
  }
  return 'password';
}
