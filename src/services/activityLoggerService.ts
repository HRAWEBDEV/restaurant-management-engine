import type { DBExecutor } from "../db/connect";

/**
 * Writes append-only activity/audit rows. Construct it with the caller's
 * executor (`db` or a transaction) so a log is committed or rolled back with
 * the state change it describes.
 */
class ActivityLoggerService {
  constructor(private readonly db: DBExecutor) {}
}

export { ActivityLoggerService };
