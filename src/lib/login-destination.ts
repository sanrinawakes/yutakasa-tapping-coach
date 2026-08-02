export function safeLoginDestination(value: string | null): string {
  if (!value || !value.startsWith("/")) {
    return "/chat";
  }

  const base = new URL("https://local.invalid");
  const destination = new URL(value, base);
  if (destination.origin !== base.origin) {
    return "/chat";
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}
