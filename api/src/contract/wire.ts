// What a value becomes once res.json() has sent it: a Date is its ISO string,
// a field that is undefined drops out, a function vanishes. The contract
// describes this, the shape a page receives, not the object the API built.
//
// Pure types, no imports: the frontend compiles this folder too.

export type Wire<T> = T extends Date
  ? string
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends bigint
      ? never // JSON.stringify throws on a bigint: send it as a string or a number
      : T extends readonly unknown[]
        ? { -readonly [K in keyof T]: Wire<T[K]> }
        : T extends object
          ? { -readonly [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: Wire<T[K]> }
          : T;

/** What an async service function sends, when it sends something (a null is the route's 404). */
export type Sends<F extends (...args: never[]) => Promise<unknown>> = Wire<NonNullable<Awaited<ReturnType<F>>>>;

/** Compiles only when what the API sends (Actual) fits what the contract promises (Promised). */
export type Fits<Actual extends Promised, Promised> = [Actual, Promised];
