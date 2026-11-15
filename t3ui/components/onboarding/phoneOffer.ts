// WelcomePage's Phone band: the phone joins through T3 Connect (a Clerk sign-in and the relay), offered when the build carries the
// public T3 Connect configuration (cloud/publicConfig.ts hasCloudPublicConfig, the reference's committed values) and the rule below.
export { hasCloudPublicConfig } from "../../cloud/publicConfig";
export const MOBILE_APP_URL = "https://t3.codes/mobile";

export interface PhoneOfferInput {
  isPrimary: boolean;
  cloud: boolean;
  /** Relay read and write access, which sharing this computer through T3 Connect needs. */
  canShare: boolean;
  /** The managed policy's limits: `clients` (which clients may connect) and `connect` (T3 Connect), both permissive when absent. */
  policy: { limits?: { clients?: string[]; connect?: boolean } } | undefined | null;
}

/** The phone joins by signing in to T3 Connect, which shares the primary computer; another computer, a build without it, or a policy that turns it off gets no band. */
export function welcomeOffersPhone(input: PhoneOfferInput): boolean {
  const limits = input.policy?.limits;
  const remoteDenied = limits?.clients !== undefined && !limits.clients.includes("remote");
  const connectDenied = limits?.connect === false;
  return input.isPrimary && input.cloud && input.canShare && !remoteDenied && !connectDenied;
}
