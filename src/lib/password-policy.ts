/**
 * Password rules, shared by the server (enforcement) and the setup page (live
 * checklist). Pure — no Node APIs — so it can ship in the client bundle.
 */

export const PASSWORD_MIN_LENGTH = 9;
// Upper bound keeps scrypt input reasonable; far beyond any real password.
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordRule {
  id: string;
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (pw) => pw.length >= PASSWORD_MIN_LENGTH },
  { id: "upper", label: "An uppercase letter (A–Z)", test: (pw) => /[A-Z]/.test(pw) },
  { id: "lower", label: "A lowercase letter (a–z)", test: (pw) => /[a-z]/.test(pw) },
  { id: "digit", label: "A number (0–9)", test: (pw) => /\d/.test(pw) },
  { id: "symbol", label: "A symbol (e.g. ! @ # $ %)", test: (pw) => /[^A-Za-z0-9\s]/.test(pw) },
];

/** Labels of the rules the password fails; empty means it's acceptable. */
export function unmetPasswordRules(password: string): string[] {
  const unmet = PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.label);
  if (password.length > PASSWORD_MAX_LENGTH) unmet.push(`At most ${PASSWORD_MAX_LENGTH} characters`);
  return unmet;
}
