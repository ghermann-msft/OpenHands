export function requireAbsoluteHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Expected an absolute HTTPS URL.");
  }
  return url.href;
}
