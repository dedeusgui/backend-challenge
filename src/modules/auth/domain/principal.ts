/**
 * Who is calling. A PROVIDER key acts for one provider id. An OPERATOR key runs the back office:
 * it opens wallets, reads them, reconciles them, and may act for any provider.
 */
export const API_CLIENT_ROLES = ['PROVIDER', 'OPERATOR'] as const;

export type ApiClientRole = (typeof API_CLIENT_ROLES)[number];

export interface Principal {
  readonly clientId: string;
  readonly name: string;
  readonly role: ApiClientRole;
  /** Set for a PROVIDER, absent for an OPERATOR. */
  readonly providerId?: string;
}

export function isOperator(principal: Principal): boolean {
  return principal.role === 'OPERATOR';
}

/** Whether the caller may submit, read or look up the operations of this provider. */
export function canOperateFor(principal: Principal, providerId: string): boolean {
  return isOperator(principal) || principal.providerId === providerId;
}
