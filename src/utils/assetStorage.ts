import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import slugify from "slugify";

/**
 * Root directory that static assets are served from (`app.use("static/*", ...)`
 * in src/index.ts). Paths returned by this class are relative to this root.
 */
const STATIC_ROOT = "static";

/** Suffix length used to make saved file names unique. */
const FILE_NAME_SUFFIX_LENGTH = 8;

/** Fallback base name when the uploaded file has a usable name. */
const DEFAULT_FILE_NAME = "file";

/**
 * Successful save: `path` is the stored location relative to `static/`
 * (pass this back to `remove`), `url` is the publicly served URL.
 */
type SavedAsset = {
  path: string;
  url: string;
};

/**
 * `save` never throws for expected failures (missing/invalid file, unsupported
 * type, size limit) so routes can map the error message to a client response.
 */
type SaveAssetResult =
  | {
      ok: true;
      asset: SavedAsset;
    }
  | {
      ok: false;
      error: string;
    };

type AssetStorageProps = {
  /** Sub directory under `static/` assets are stored in, e.g. "organizations/logos". */
  subPath: string;
  /** Allowed MIME types, e.g. ["image/png", "image/jpeg"]. Exact match. */
  fileTypes: Array<string>;
  /** Maximum accepted file size in bytes. No limit when omitted. */
  maxSize?: number;
};

/**
 * Saves and removes static assets (organization logos, user images, ...) under
 * `static/<subPath>`. Instantiate one per storage location:
 *
 * ```ts
 * const logoStorage = new AssetStorage({
 *   subPath: "organizations/logos",
 *   fileTypes: ["image/png", "image/jpeg", "image/webp"],
 *   maxSize: 2 * 1024 * 1024,
 * });
 * ```
 */
class AssetStorage {
  private readonly subPath: string;
  private readonly fileTypes: ReadonlyArray<string>;
  private readonly maxSize?: number;

  constructor({ subPath, fileTypes, maxSize }: AssetStorageProps) {
    const normalizedSubPath = this.normalizeSubPath(subPath);

    if (normalizedSubPath === null) {
      throw new Error("AssetStorage: subPath must be a non-empty relative path");
    }

    if (fileTypes.length === 0) {
      throw new Error("AssetStorage: fileTypes must not be empty");
    }

    this.subPath = normalizedSubPath;
    this.fileTypes = fileTypes.map((fileType) => fileType.trim().toLowerCase());
    this.maxSize = maxSize;
  }

  /**
   * Validates and writes the file to `static/<subPath>` with a unique,
   * slugified name. Returns the stored path (relative to `static/`) and its
   * public URL.
   */
  async save(file: File): Promise<SaveAssetResult> {
    if (!(file instanceof File)) {
      return { ok: false, error: "no file provided" };
    }

    const fileType = this.getFileType(file);
    if (!this.fileTypes.includes(fileType)) {
      return { ok: false, error: `unsupported file type: ${fileType || "unknown"}` };
    }

    if (this.maxSize !== undefined && file.size > this.maxSize) {
      return { ok: false, error: `file exceeds the maximum size of ${this.maxSize} bytes` };
    }

    const directory = path.join(STATIC_ROOT, this.subPath);
    const fileName = this.buildFileName(file.name);

    await mkdir(directory, { recursive: true });
    await Bun.write(path.join(directory, fileName), file);

    const storedPath = path.posix.join(this.subPath, fileName);

    return {
      ok: true,
      asset: {
        path: storedPath,
        url: `/static/${storedPath}`,
      },
    };
  }

  /**
   * Deletes a previously saved asset from `static/<subPath>`. Returns `false`
   * when the path is invalid, outside this instance's sub path, or the file no
   * longer exists.
   */
  async remove(storedPath: string): Promise<boolean> {
    const target = path.resolve(STATIC_ROOT, storedPath);
    const root = path.resolve(STATIC_ROOT, this.subPath);

    // keep removals confined to this instance's sub path
    if (!target.startsWith(`${root}${path.sep}`)) {
      return false;
    }

    try {
      await unlink(target);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  /**
   * Normalized MIME type of the file: lowercased, with parameters such as
   * "; charset=utf-8" stripped so matching stays exact but predictable.
   */
  private getFileType(file: File): string {
    return file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  }

  /**
   * Normalizes the configured sub path: relative, forward slashes, no
   * traversal segments. Returns `null` for unusable values.
   */
  private normalizeSubPath(subPath: string): string | null {
    const normalized = path.posix
      .normalize(subPath.replaceAll("\\", "/").trim())
      .replaceAll(/^\.?\/?|\/+$/g, "");

    if (normalized.length === 0 || normalized.split("/").includes("..")) {
      return null;
    }

    return normalized;
  }

  /**
   * Builds `<slug>-<random>.<ext>` from the original file name, falling back
   * to a default base when the name is empty or unusable.
   */
  private buildFileName(originalName: string): string {
    const extension = path.posix.extname(originalName).toLowerCase();
    const baseName = slugify(
      path.posix.basename(originalName, extension),
      { lower: true, strict: true, trim: true },
    );

    const slug = baseName.length > 0 ? baseName : DEFAULT_FILE_NAME;
    return `${slug}-${nanoid(FILE_NAME_SUFFIX_LENGTH)}${extension}`;
  }
}

export { AssetStorage };
export type { AssetStorageProps, SaveAssetResult, SavedAsset };
