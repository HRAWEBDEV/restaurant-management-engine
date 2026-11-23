/**
 * Postgres reports unique-constraint violations with SQLSTATE 23505. Drizzle
 * wraps driver errors in `DrizzleQueryError`, so the `errno` may sit on the
 * error itself or on its `cause`.
 */
function isUniqueViolation(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("errno" in error) {
    return error.errno === "23505";
  }

  const cause = "cause" in error ? error.cause : null;

  return (
    typeof cause === "object" &&
    cause !== null &&
    "errno" in cause &&
    cause.errno === "23505"
  );
}

export { isUniqueViolation };
