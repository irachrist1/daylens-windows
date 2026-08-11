import { withBasePath } from "./basePath";

/** Resolves to the latest macOS installer via the release proxy. */
export const MAC_DOWNLOAD_HREF = withBasePath("/api/download/mac");
/** Resolves to the latest Windows installer via the release proxy. */
export const WINDOWS_DOWNLOAD_HREF = withBasePath("/api/download/windows");
export const LINUX_STATUS_HREF = withBasePath("/linux");
