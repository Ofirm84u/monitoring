/**
 * Email normalization + allowlist/owner checks (FR-AUTH-3/-5, NFR-SEC-4).
 *
 * Gmail/Googlemail treat dots and "+tags" in the local part as insignificant
 * and the two domains as equivalent, so `f.o.o+x@googlemail.com` ==
 * `foo@gmail.com`. Normalizing prevents invites/owner-checks from missing the
 * same Google account spelled differently.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return null;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (!local || !domain) return null;

  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0].replace(/\./g, "");
  } else {
    local = local.split("+")[0];
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

function normalizedSet(csv: string | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => !!e),
  );
}

/** Owner is the single privileged account (OWNER_EMAIL). */
export function isOwnerEmail(email: string | null | undefined): boolean {
  const n = normalizeEmail(email);
  const owner = normalizeEmail(process.env.OWNER_EMAIL);
  return !!n && !!owner && n === owner;
}

/** Allowed = on ALLOWED_EMAILS, or the owner. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const n = normalizeEmail(email);
  if (!n) return false;
  if (isOwnerEmail(n)) return true;
  return normalizedSet(process.env.ALLOWED_EMAILS).has(n);
}
