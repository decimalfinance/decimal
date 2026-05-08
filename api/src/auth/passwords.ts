import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_VERSION = 's1';

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt);
  return `${HASH_VERSION}$${salt}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, encodedHash: string) {
  const [version, salt, expectedHex] = encodedHash.split('$');

  if (version !== HASH_VERSION || !salt || !expectedHex) {
    return false;
  }

  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await scrypt(password, salt);

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

function scrypt(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(Buffer.from(derivedKey));
      },
    );
  });
}
