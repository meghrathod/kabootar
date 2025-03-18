/**
 * Checks if the current browser is Safari
 */
export function isSafari(): boolean {
  const ua = navigator.userAgent;
  return ua.indexOf("Safari") !== -1 && ua.indexOf("Chrome") === -1;
}

/**
 * Checks if the current device is running iOS
 */
export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
}

/**
 * Checks if the browser is Safari or iOS
 */
export function isSafariOrIOS(): boolean {
  return isSafari() || isIOS();
}

/**
 * Safari and iOS have a 2GB file size limitation
 */
export const MAX_SAFARI_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * Validates if a file can be transferred based on browser limitations
 * @param file The file to validate
 * @returns An object containing validation result and error message if any
 */
export function validateFileSize(file: File): { valid: boolean; message?: string } {
  if (isSafariOrIOS() && file.size > MAX_SAFARI_FILE_SIZE) {
    return {
      valid: false,
      message: `File size (${formatFileSize(file.size)}) exceeds Safari/iOS limit of 2GB.`,
    };
  }
  return { valid: true };
}

/**
 * Formats file size in human-readable format
 * @param bytes File size in bytes
 * @returns Formatted file size string
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}